#!/usr/bin/env bash
# Decides whether this pull_request event should be reviewed at all. Pure
# function of the event payload and the resolved config, so it is unit-tested
# rather than living in a job-level `if:` expression.
#
# Review when ALL hold:
#   - the event is `pull_request` (never pull_request_target: the review job
#     checks out PR code while holding the Anthropic key);
#   - the PR is ready for review, OR it carries the opt-in label, OR the config
#     sets triggers.review_drafts;
#   - the PR comes from the same repository (fork PRs get no Vault secrets);
#   - the PR author is not in triggers.skip_authors (matched on the PR author,
#     not github.actor, so a human pushing to a bot's PR keeps it skipped);
#   - a `labeled` event is for the opt-in label (any other label is ignored, so
#     adding e.g. the needs-human label does not trigger a second review);
#   - the PR has not reached triggers.max_auto_reviews (when set). The count is
#     the number of earlier agent reviews on the PR, read from the
#     `<!-- ai-review verdict= -->` marker on github-actions[bot] reviews. A
#     manual request (a `labeled` event for the opt-in label) and an Actions
#     re-run (GITHUB_RUN_ATTEMPT > 1) are never capped. If the reviews cannot be
#     listed the cap is not enforced: a broken lookup must not block a review.
#
# Requires (env): GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_REPOSITORY,
# CONFIG_FILE. Needs GH_TOKEN (pull-requests: read) only when a cap is set.
# Writes run=true|false and skip_reason to $GITHUB_OUTPUT, plus cap_reached=true
# and review_count when the cap is what stopped the run.
set -euo pipefail

: "${CONFIG_FILE:?CONFIG_FILE is required}"

out() {
  echo "run=$1" >> "$GITHUB_OUTPUT"
  echo "skip_reason=$2" >> "$GITHUB_OUTPUT"
  if [ "$1" = true ]; then echo "should-review: yes"; else echo "should-review: skipping ($2)"; fi
  exit 0
}

[ "${GITHUB_EVENT_NAME:-}" = "pull_request" ] || out false "unsupported event '${GITHUB_EVENT_NAME:-}' (only pull_request)"

decision=$(jq -r --slurpfile cfg "$CONFIG_FILE" --arg repo "$GITHUB_REPOSITORY" '
  ($cfg[0].triggers) as $t
  | .pull_request as $pr
  | ([$pr.labels[]?.name] | index($t.opt_in_label) != null) as $opted_in
  | if (.action == "labeled") and (.label.name != $t.opt_in_label) then
      "false\tlabeled with a label other than \($t.opt_in_label)"
    elif ($pr.head.repo.full_name // "") != $repo then
      "false\tfork pull request"
    elif ($t.skip_authors | index($pr.user.login)) != null then
      "false\tauthor \($pr.user.login) is in skip_authors"
    elif ($pr.draft == true) and ($opted_in | not) and ($t.review_drafts | not) then
      "false\tdraft without the \($t.opt_in_label) label"
    else
      "true\t"
    end' "$GITHUB_EVENT_PATH")

run="${decision%%$'\t'*}"
reason="${decision#*$'\t'}"

if [ "$run" = true ]; then
  cap=$(jq -r '.triggers.max_auto_reviews // 0' "$CONFIG_FILE")
  manual=$(jq -r '.action == "labeled"' "$GITHUB_EVENT_PATH")
  if [ "$cap" -gt 0 ] && [ "$manual" != true ] && [ "${GITHUB_RUN_ATTEMPT:-1}" -le 1 ]; then
    pr=$(jq -r '.pull_request.number' "$GITHUB_EVENT_PATH")
    reviews_err=$(mktemp)
    if reviews=$(gh api --paginate --slurp -H 'Accept: application/vnd.github+json' \
        "repos/${GITHUB_REPOSITORY}/pulls/${pr}/reviews?per_page=100" 2>"$reviews_err"); then
      count=$(jq '[.[][] | select(.user.login == "github-actions[bot]")
                   | select((.body // "") | contains("<!-- ai-review verdict="))] | length' <<<"$reviews") || count=""
    else
      count=""
    fi
    if [ -z "$count" ]; then
      echo "::warning::pr-review-agent: could not count earlier reviews, so triggers.max_auto_reviews is not enforced for this run: $(head -c 300 "$reviews_err")"
    elif [ "$count" -ge "$cap" ]; then
      {
        echo "cap_reached=true"
        echo "review_count=$count"
      } >> "$GITHUB_OUTPUT"
      out false "auto-review cap reached (${count}/${cap})"
    fi
  fi
fi

out "$run" "$reason"
