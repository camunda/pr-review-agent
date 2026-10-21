#!/usr/bin/env bash
# Mask secrets out of a COPY of the AI review agent's session transcript before
# it is uploaded as an artifact. Actions masks secrets in run LOGS but not in
# ARTIFACT contents; this reaches the same parity by redacting known secret
# values plus common plaintext token shapes.
#
# Scope: this seals ACCIDENTAL leakage (a secret the agent incidentally read
# into its transcript). It is NOT a defense against a prompt-injected agent that
# emits a reversible encoding (base64, hex, …) of a secret — see the threat
# model on PR #27880 / issue #28219.
#
# Inputs (env):
#   EXECUTION_FILE     path to the agent's raw transcript (claude-code-action
#                      `execution_file` output); may be empty or missing.
#   MASKED_FILE        where to write the masked copy; defaults to
#                      $RUNNER_TEMP/ai-review-session-masked.json.
#   ANTHROPIC_API_KEY  literal values redacted; read from %ENV, never passed on
#   GITHUB_TOKEN       argv (which would expose them via the process list).
#
# On any problem (no transcript, masking failure, empty output) it removes the
# output file and exits 0: capture is reported by a separate step and must never
# fail the read-only review.
set -uo pipefail

out="${MASKED_FILE:-${RUNNER_TEMP:-/tmp}/ai-review-session-masked.json}"
f="${EXECUTION_FILE:-}"

if [ -z "$f" ] || [ ! -s "$f" ]; then
  echo "::warning::No session transcript to mask (execution_file='${f}')"
  exit 0
fi

# The token-shape rules are deliberately over-eager (e.g. `sk-` matches any
# 20+ char token with that prefix): over-redaction is the safe direction, at the
# cost of occasionally masking an unrelated identifier in the saved transcript.
if perl -0777 -pe '
  for my $k (qw(ANTHROPIC_API_KEY GITHUB_TOKEN)) {
    my $v = $ENV{$k};
    next unless defined $v && length($v) >= 8;
    my $q = quotemeta($v);
    s/$q/***REDACTED***/g;
  }
  s/\bgithub_pat_[A-Za-z0-9_]{20,}/***REDACTED***/g;
  s/\bgh[pousr]_[A-Za-z0-9]{20,}/***REDACTED***/g;
  s/\bsk-ant-[A-Za-z0-9_-]{16,}/***REDACTED***/g;
  s/\bsk-[A-Za-z0-9]{20,}/***REDACTED***/g;
  s/\bAKIA[0-9A-Z]{16}\b/***REDACTED***/g;
  s/(Bearer\s+)[A-Za-z0-9._~+\/-]{16,}=*/${1}***REDACTED***/gi;
  s/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/***REDACTED***/g;
  s/(AUTHORIZATION:\s*basic\s+)[A-Za-z0-9+\/=]+/${1}***REDACTED***/gi;
' "$f" > "$out"; then
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
