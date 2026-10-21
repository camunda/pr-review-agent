#!/usr/bin/env bash
# Posts the agent's line-anchored findings (review.json) as inline PR review
# comments. Prior runs' inline comments are intentionally NOT removed: a
# submitted review and its inline comments are the AI-review history the team
# keeps (see ai-review-post-summary.sh), so successive runs are additive on both
# the shadow and the live approval path.
#
# Best-effort by design: this script must NEVER fail its caller. Its only caller
# (ai-review-approve.sh, the live approval path) invokes it under `set -e`, so
# any non-zero exit here would abort the whole posting step and no review would
# be posted. Every step is therefore guarded, and an unexpected failure is
# caught by the ERR trap, which records inline_ok=false (so the caller folds the
# findings into the review body instead) and exits 0.
#
# GitHub rejects (422) an inline comment on any line not in the PR diff, and a
# single bad line 422s the ENTIRE review — that expected case sets
# inline_ok=false without erroring.
#
# Requires (env): GH_TOKEN, GITHUB_REPOSITORY, PR.
# Requires (files, from ai-review-compute-verdict.sh): review.json.
# Writes: inline-post-ok.txt containing `true` or `false` — the caller
# (ai-review-approve.sh) reads it to decide whether to fold the findings into
# the approval review body.
#
# Each inline comment body carries a hidden `<!-- ai-review-inline -->` marker
# that identifies it as one of ours (provenance for future tooling); it no
# longer gates deletion, since prior comments are now kept as history.
set -euo pipefail

# Any UNEXPECTED failure (a network error listing/parsing, etc.) must not abort
# the caller: record "not posted" so the summary keeps the findings, and exit 0.
trap 'printf false > inline-post-ok.txt; echo "post-inline: unexpected error; leaving findings for the summary"; exit 0' ERR

# Post the new inline comments, if any. review.json is
# {event, comments[], commit_id?} with no top-level body — on the approval path
# its only caller (ai-review-approve.sh) posts the summary as a separate approval
# review body. commit_id anchors the comments to the reviewed sha (and is what
# makes this inline post 422 if that commit was force-pushed out of the PR).
# review.json is produced by this repo's compute step (trusted), but guard the
# parse anyway so a surprise never trips the trap.
inline_ok=true
n=$(jq '.comments | length' review.json 2>/dev/null || echo 0)
if [ "$n" -gt 0 ]; then
  if gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR}/reviews" \
       --input review.json >/dev/null 2>inline-err.txt; then
    echo "Posted $n inline finding(s)."
  else
    inline_ok=false
    echo "Inline review not posted; findings will be folded into the summary. Details:"
    cat inline-err.txt || true
  fi
else
  echo "No line-anchored findings to post inline."
fi

printf '%s' "$inline_ok" > inline-post-ok.txt
