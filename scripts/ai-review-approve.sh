#!/usr/bin/env bash
# Approves the PR when the verdict is AUTO_APPROVE in live mode. First waits for
# required checks (so we honor the rubric's "CI passes" criterion), then posts
# any line-anchored findings as inline comments, folds rejected findings into
# the approval body, appends the trusted calibration marker LAST, and submits
# the approval.
#
# Expects: PR, GITHUB_REPOSITORY and HEAD_SHA (the commit the agent reviewed)
# env vars (and GH_REPO when run outside the reviewed repo), plus body.md, summary-marker.md, inline-fallback.md, and
# optionally dropped-duplicates.md in the working directory.
set -euo pipefail

: "${HEAD_SHA:?HEAD_SHA (the reviewed commit) is required}"

# The verdict is for HEAD_SHA only. Skip approval if the PR has moved on: a push
# that landed during the run (or while waiting for checks) has NOT been
# reviewed, and its own run will decide. Fail closed if the head can't be read.
head_unchanged() {
  local cur
  cur="$(gh pr view "$PR" --json headRefOid --jq '.headRefOid' 2>/dev/null || echo unknown)"
  if [ "$cur" != "$HEAD_SHA" ]; then
    echo "PR head is now ${cur}, not the reviewed ${HEAD_SHA} — skipping approval."
    return 1
  fi
}

# Re-read the PR's CURRENT draft state before approving. The workflow-level
# `if` on this step gates on `github.event.pull_request.draft`, which is the
# immutable snapshot from when the run started; a ready PR converted back to
# draft mid-run (this step can wait many minutes on required checks below)
# would otherwise still be approved, violating the never-approve-drafts rule.
# Fail closed: skip approval if the PR is a draft now, or if the state cannot
# be read.
is_draft="$(gh pr view "$PR" --json isDraft --jq '.isDraft' 2>/dev/null || echo unknown)"
if [ "$is_draft" != "false" ]; then
  echo "PR is a draft now (isDraft=$is_draft) — skipping approval."
  exit 0
fi

head_unchanged || exit 0

# Honor the rubric's "CI passes" criterion before approving. Gate on
# REQUIRED checks only (defined by branch protection, which a PR author
# cannot change) — a PR can add its own always-green checks but cannot
# satisfy a failing required one. On opened/synchronize, required checks
# are typically still running, so WAIT for them rather than checking
# once — a one-shot check would almost always see "pending" and skip
# approval, and (unlike a push-triggered re-run) nothing would ever
# retry it. --fail-fast stops as soon as any required check fails.
# Fails closed: a non-zero exit (a failing required check, no required
# checks, or an API error under `set -e`) skips the approval rather
# than approving blindly. The job's 45-minute timeout accommodates a
# typical full CI run; the watch loop itself has no separate limit.
# Note: keep `ai-pr-review` itself a NON-required check, or this waits
# on the in-progress run that is calling it and never approves.
if ! gh pr checks "$PR" --required --watch --fail-fast --interval 30; then
  echo "Required checks did not all pass — skipping approval."
  exit 0
fi

# Post any line-anchored findings as inline comments first (an
# auto-approve can still carry non-blocking 🔧/❓ findings), then fold
# them into the approval body if the inline review was rejected.
# AGENT_SCRIPTS_DIR lets tests substitute a stub; in CI it is this directory.
bash "${AGENT_SCRIPTS_DIR:-$(dirname "${BASH_SOURCE[0]}")}/ai-review-post-inline.sh"
cp body.md body-final.md
if [ "$(cat inline-post-ok.txt)" = "false" ] && [ -s inline-fallback.md ]; then
  {
    echo ""
    echo "---"
    echo ""
    echo "<details>"
    echo "<summary>⚠️ Some finding(s) that couldn't be posted inline (click to expand)</summary>"
    echo ""
    echo "> These line-specific findings could not be posted as inline comments (e.g. a line outside the diff, or a transient GitHub API error), so they are listed here instead:"
    echo ""
    cat inline-fallback.md
    echo ""
    echo "</details>"
  } >> body-final.md
fi

if [ -s dropped-duplicates.md ]; then
  {
    echo ""
    echo "---"
    echo ""
    echo "<details>"
    echo "<summary>♻️ Finding(s) already raised in an earlier review round (click to expand)</summary>"
    echo ""
    echo "> These findings duplicate comments already posted on this PR, so they were not re-posted inline. The emoji is **this round's** severity; the linked earlier comment may have been raised at a different one (the bot matches on the underlying problem, not severity). Full suppressed content is in this run's logs:"
    echo ""
    cat dropped-duplicates.md
    echo ""
    echo "</details>"
  } >> body-final.md
fi

# Append the trusted calibration marker LAST (see the comment path).
cat summary-marker.md >> body-final.md

# Note: an approval from the built-in GITHUB_TOKEN (github-actions[bot])
# does NOT count toward required-reviewer branch protection — this is
# intentional. Auto-merge for the narrow auto-approve categories should
# be handled by a separate, auditable rule, not by widening this token.
#
# Re-check the head after the (possibly long) checks wait, then approve through
# the Reviews API with commit_id = the reviewed commit, so the approval can never
# attach to a newer, unreviewed head even if one lands between the two calls.
head_unchanged || exit 0
jq -n --rawfile body body-final.md --arg sha "$HEAD_SHA" \
  '{event: "APPROVE", body: $body, commit_id: $sha}' > approve.json
gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR}/reviews" --input approve.json >/dev/null
echo "Approved ${HEAD_SHA}."
