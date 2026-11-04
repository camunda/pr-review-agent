#!/usr/bin/env bash
# Posts the one-sentence PR comment that explains why an automatic review did
# not run because the PR reached triggers.max_auto_reviews. The comment is
# posted once per PR: a hidden marker lets later runs find it and stay quiet.
# Best effort: this is a courtesy notice, so any failure is a warning and the
# script still exits 0.
#
# Requires (env): GH_TOKEN (pull-requests: write), GITHUB_REPOSITORY, PR,
# OPT_IN_LABEL, REVIEW_COUNT, MAX_AUTO_REVIEWS.
set -uo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}" "${PR:?PR is required}"
: "${OPT_IN_LABEL:?OPT_IN_LABEL is required}" "${REVIEW_COUNT:?REVIEW_COUNT is required}"
: "${MAX_AUTO_REVIEWS:?MAX_AUTO_REVIEWS is required}"

marker='<!-- ai-review-cap-notice -->'
comments_url="repos/${GITHUB_REPOSITORY}/issues/${PR}/comments"

if ! existing=$(gh api --paginate "$comments_url" \
    --jq ".[] | select(.user.login == \"github-actions[bot]\") | select(.body | contains(\"${marker}\")) | .id"); then
  echo "::warning::pr-review-agent: could not list PR comments; not posting the review-cap notice"
  exit 0
fi
if [ -n "$existing" ]; then
  echo "review-cap notice already posted on PR ${PR}; not repeating it"
  exit 0
fi

body="The automatic AI review was skipped because this PR already has ${REVIEW_COUNT} AI review(s) (the limit is ${MAX_AUTO_REVIEWS}); to request another, remove (if present) and re-add the \`${OPT_IN_LABEL}\` label.

${marker}"

if gh api -X POST "$comments_url" -f body="$body" >/dev/null; then
  echo "posted the review-cap notice on PR ${PR}"
else
  echo "::warning::pr-review-agent: failed to post the review-cap notice"
fi
exit 0
