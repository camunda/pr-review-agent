#!/usr/bin/env bash
# Mask secrets out of files the AI review agent produced before they leave the
# review job (the only job that holds the Anthropic key). Actions masks secrets
# in run LOGS but not in ARTIFACT contents; this reaches the same parity by
# redacting known secret values plus common plaintext token shapes.
#
# Two modes:
#   - No arguments: masks a COPY of the session transcript (EXECUTION_FILE ->
#     MASKED_FILE). On any problem (no transcript, masking failure, empty
#     output) it removes the output file and exits 0: capture is reported by a
#     separate step and must never fail the read-only review.
#   - FILE...: masks each file IN PLACE (verdict.json, dedup.json). A missing
#     file is skipped. Each file must hold exactly one JSON value. Fail closed:
#     a symlink, a directory or any other non-regular file, content that is
#     not one JSON value, or a masking failure makes the script exit non-zero,
#     so the step fails and nothing unmasked is uploaded.
#
# Scope: this seals ACCIDENTAL leakage (a secret the agent incidentally read
# into its output). It is NOT a defense against a prompt-injected agent that
# emits a reversible encoding (base64, hex, …) of a secret — see
# docs/security-model.md.
#
# Inputs (env):
#   EXECUTION_FILE     path to the agent's raw transcript (claude-code-action
#                      `execution_file` output); may be empty or missing.
#   MASKED_FILE        where to write the masked copy; defaults to
#                      $RUNNER_TEMP/ai-review-session-masked.json.
#   ANTHROPIC_API_KEY  literal values redacted; read from %ENV, never passed on
#   GITHUB_TOKEN       argv (which would expose them via the process list).
set -uo pipefail

# redact(TEXT) — the masking rules, shared by both passes below.
# The token-shape rules are deliberately over-eager (e.g. `sk-` matches any
# 20+ char token with that prefix): over-redaction is the safe direction, at the
# cost of occasionally masking an unrelated identifier. No rule emits a quote
# or backslash, so masked JSON stays valid JSON.
# shellcheck disable=SC2016  # Perl code, expanded by Perl, not the shell.
REDACT='
  sub redact {
    my ($s) = @_;
    for my $k (qw(ANTHROPIC_API_KEY GITHUB_TOKEN)) {
      my $v = $ENV{$k};
      next unless defined $v && length($v) >= 8;
      my $q = quotemeta($v);
      $s =~ s/$q/***REDACTED***/g;
    }
    $s =~ s/\bgithub_pat_[A-Za-z0-9_]{20,}/***REDACTED***/g;
    $s =~ s/\bgh[pousr]_[A-Za-z0-9]{20,}/***REDACTED***/g;
    $s =~ s/\bsk-ant-[A-Za-z0-9_-]{16,}/***REDACTED***/g;
    $s =~ s/\bsk-[A-Za-z0-9]{20,}/***REDACTED***/g;
    $s =~ s/\bAKIA[0-9A-Z]{16}\b/***REDACTED***/g;
    $s =~ s/(Bearer\s+)[A-Za-z0-9._~+\/-]{16,}=*/${1}***REDACTED***/gi;
    $s =~ s/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/***REDACTED***/g;
    $s =~ s/(AUTHORIZATION:\s*basic\s+)[A-Za-z0-9+\/=]+/${1}***REDACTED***/gi;
    return $s;
  }
'

# mask SRC DST — write a masked copy of SRC to DST, as plain text.
mask() {
  perl -0777 -ne "$REDACT"' print redact($_);' "$1" > "$2"
}

# mask_json SRC DST — decode SRC as ONE JSON value, mask every string and
# key, and encode it again. Plain-text masking would let a `\uXXXX`-escaped
# secret through, and `decide` (`jq -r`) would decode it into the posted review.
# Fails (exit 1) when SRC is not exactly one JSON value: `jq` also reads JSON
# streams such as `{...} {}`, so no plain-text fallback is safe.
mask_json() {
  perl -MJSON::PP -0777 -ne "$REDACT"'
    my $data = eval { JSON::PP->new->utf8->allow_nonref->decode($_) };
    if ($@) { print STDERR "not a single JSON value: $@"; exit 1 }
    sub walk {
      my ($v) = @_;
      return $v if JSON::PP::is_bool($v);
      return { map { redact($_) => walk($v->{$_}) } keys %$v } if ref $v eq "HASH";
      return [ map { walk($_) } @$v ] if ref $v eq "ARRAY";
      return $v unless defined $v;
      my $r = redact($v);
      return $r eq $v ? $v : $r;  # keeps numbers numbers
    }
    print JSON::PP->new->utf8->canonical->allow_nonref->encode(walk($data));
  ' "$1" > "$2"
}

if [ "$#" -gt 0 ]; then
  for f in "$@"; do
    # A symlink could point the masked output (or the upload) at a file outside
    # ai-review/, for example a trusted script that a later step runs.
    if [ -L "$f" ]; then
      echo "::error::$f is a symlink; refusing to mask or upload it"
      exit 1
    fi
    [ -e "$f" ] || { echo "Nothing to mask at $f"; continue; }
    # A directory would be uploaded recursively, with unmasked files inside.
    if [ ! -f "$f" ]; then
      echo "::error::$f is not a regular file; refusing to mask or upload it"
      exit 1
    fi
    # The temp file lives outside the workspace, so no entry the PR or the agent
    # placed next to $f can redirect the write. mv replaces the entry for $f.
    tmp="$(mktemp "${RUNNER_TEMP:-/tmp}/ai-review-mask.XXXXXX")" || {
      echo "::error::Cannot create a temp file to mask $f; refusing to continue"
      exit 1
    }
    if mask_json "$f" "$tmp" && mv -f "$tmp" "$f"; then
      echo "Masked $f"
    else
      rm -f "$tmp"
      echo "::error::Masking pass failed for $f; refusing to continue"
      exit 1
    fi
  done
  exit 0
fi

out="${MASKED_FILE:-${RUNNER_TEMP:-/tmp}/ai-review-session-masked.json}"
f="${EXECUTION_FILE:-}"

if [ -z "$f" ] || [ ! -s "$f" ]; then
  echo "::warning::No session transcript to mask (execution_file='${f}')"
  exit 0
fi

if mask "$f" "$out"; then
  echo "Masked session transcript -> $out"
else
  # Masking failed — drop the partial file; never upload it half-masked.
  rm -f "$out"
  echo "::warning::Masking pass failed; session transcript will not be uploaded"
  exit 0
fi

if [ ! -s "$out" ]; then
  echo "::warning::Masked transcript is empty; not uploading"
  rm -f "$out"
fi
