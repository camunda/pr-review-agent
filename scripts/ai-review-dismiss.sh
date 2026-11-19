#!/usr/bin/env bash
# Dismisses approvals that pr-review-agent made through the GitHub bot account
# (vault.github_bot_token). Such an approval counts toward branch protection, so
# it must never outlive the commit and base branch it was given for. The repo
# setting "Dismiss stale pull request approvals" is not required for this.
#
# Only reviews that match ALL of these are touched:
#   - author is $BOT_LOGIN,
#   - state is APPROVED,
#   - the body carries the pr-review-agent verdict marker. The bot account can be
#     shared with other automation (for example backport PRs), and its other
#     approvals are not ours to dismiss.
#
# The head and base are read live from the API, never from the event payload:
# a re-run of an old run carries an old head SHA and must not dismiss the
# approval that a newer run gave to the current head.
#
# MODE:
#   stale  dismiss approvals of another commit than the current head, or of
#          another base than the current base (approved-base marker missing or
#          different). Runs for every event, also when no review follows.
#   all    dismiss every one of our approvals (this run's verdict is not an
#          approval). Only when RUN_HEAD_SHA is still the head: otherwise a newer
#          run owns the PR, and its `stale` pass already cleaned up.
#   one    dismiss only review $REVIEW_ID (the head moved during the approval).
#
# Requires (env): GH_TOKEN (the bot token), GITHUB_REPOSITORY, PR, BOT_LOGIN,
# MODE, plus RUN_HEAD_SHA for all and REVIEW_ID for one. Optional: REASON
# (shown in the dismissal message).
# Fails (exit 1) when the PR or its reviews cannot be read or a dismissal fails:
# a stale approval that still counts must not go unnoticed.
set -euo pipefail

: "${GITHUB_REPOSITORY:?}" "${PR:?}" "${BOT_LOGIN:?}" "${MODE:?}"
case "$MODE" in
  stale) ;;
  all) : "${RUN_HEAD_SHA:?RUN_HEAD_SHA is required for MODE=all}" ;;
  one) : "${REVIEW_ID:?REVIEW_ID is required for MODE=one}" ;;
  *) echo "::error::ai-review-dismiss: MODE must be stale, all or one, got '${MODE}'"; exit 1 ;;
esac

head="" base=""
if [ "$MODE" != one ]; then
  if ! pr=$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR}") \
     || ! head=$(jq -er '.head.sha' <<<"$pr") || ! base=$(jq -er '.base.ref' <<<"$pr"); then
    echo "::error::pr-review-agent: could not read PR #${PR}, so stale bot approvals may still count."
    exit 1
  fi
  if [ "$MODE" = all ] && [ "$head" != "$RUN_HEAD_SHA" ]; then
    echo "PR head is now ${head}, not this run's ${RUN_HEAD_SHA}: the newer run decides. Not dismissing."
    exit 0
  fi
fi

if ! reviews=$(gh api --paginate --slurp "repos/${GITHUB_REPOSITORY}/pulls/${PR}/reviews?per_page=100"); then
  echo "::error::pr-review-agent: could not read the reviews of PR #${PR}, so stale bot approvals may still count."
  exit 1
fi

ids=$(jq -r --arg login "$BOT_LOGIN" --arg mode "$MODE" \
  --arg head "$head" --arg base "$base" --arg id "${REVIEW_ID:-}" '
  [ .[][]
    | select(.user.login == $login and .state == "APPROVED")
    | select((.body // "") | contains("<!-- ai-review verdict="))
    | select(
        if $mode == "all" then true
        elif $mode == "one" then (.id | tostring) == $id
        else .commit_id != $head
             or ((.body // "") | contains("<!-- ai-review approved-base=\($base) -->") | not)
        end)
    | .id ] | .[]' <<<"$reviews")

if [ -z "$ids" ]; then
  echo "No pr-review-agent approval by ${BOT_LOGIN} to dismiss (mode ${MODE})."
  exit 0
fi

message="pr-review-agent: ${REASON:-this approval is no longer valid}"
failed=0
for id in $ids; do
  if gh api -X PUT "repos/${GITHUB_REPOSITORY}/pulls/${PR}/reviews/${id}/dismissals" \
      -f message="$message" -f event=DISMISS >/dev/null; then
    echo "Dismissed approval ${id} by ${BOT_LOGIN}."
  else
    echo "::error::pr-review-agent: could not dismiss approval ${id} by ${BOT_LOGIN} on PR #${PR}. It may still count toward branch protection. Dismiss it by hand."
    failed=1
  fi
done
exit "$failed"
