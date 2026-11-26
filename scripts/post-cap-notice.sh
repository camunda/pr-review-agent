#!/usr/bin/env bash
# Posts the one-sentence PR comment that explains why an automatic review did
# not run because the PR reached triggers.max_auto_reviews. The comment is
# posted once per PR and config: hidden markers let later runs find it and stay
# quiet. Each config has its own cap, so each posts its own notice.
# Best effort: this is a courtesy notice, so any failure is a warning and the
# script still exits 0.
#
# The body ends with two markers. The first, `<!-- ai-review-cap-notice -->`, is
# unchanged so consumers that look for it keep working. The second,
# `<!-- ai-review-cap-notice-config config=NAME -->`, names the config. A notice
# without the second marker was posted before configs were named: it counts as
# the notice for every config, so a PR with an old notice never gets a second one.
#
# Requires (env): GH_TOKEN (pull-requests: write), GITHUB_REPOSITORY, PR,
# OPT_IN_LABEL, REVIEW_COUNT, MAX_AUTO_REVIEWS.
# Optional (env): CONFIG_NAME, the name of the team config. When it is empty the
# notice is once per PR and carries no config marker, as before.
set -uo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}" "${PR:?PR is required}"
: "${OPT_IN_LABEL:?OPT_IN_LABEL is required}" "${REVIEW_COUNT:?REVIEW_COUNT is required}"
: "${MAX_AUTO_REVIEWS:?MAX_AUTO_REVIEWS is required}"

marker='<!-- ai-review-cap-notice -->'
comments_url="repos/${GITHUB_REPOSITORY}/issues/${PR}/comments"

# The name is a validated config name (lowercase letters, digits, . _ -). Check
# it again because it is spliced into a jq program and a hidden marker.
config_marker=""
config_filter=""
if [ -n "${CONFIG_NAME:-}" ]; then
  if ! [[ "$CONFIG_NAME" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] || [[ "$CONFIG_NAME" == *..* ]]; then
    echo "::warning::pr-review-agent: invalid config name; not posting the review-cap notice"
    exit 0
  fi
  config_marker="<!-- ai-review-cap-notice-config config=${CONFIG_NAME} -->"
  # A notice counts as ours when it names this config, or names none (legacy).
  config_filter=" | select((.body | contains(\"<!-- ai-review-cap-notice-config config=\") | not) or (.body | contains(\"${config_marker}\")))"
fi

if ! existing=$(gh api --paginate "$comments_url" \
    --jq ".[] | select(.user.login == \"github-actions[bot]\") | select(.body | contains(\"${marker}\"))${config_filter} | .id"); then
  echo "::warning::pr-review-agent: could not list PR comments; not posting the review-cap notice"
  exit 0
fi
if [ -n "$existing" ]; then
  echo "review-cap notice already posted on PR ${PR}${CONFIG_NAME:+ for config ${CONFIG_NAME}}; not repeating it"
  exit 0
fi

body="The automatic AI review was skipped because this PR already has ${REVIEW_COUNT} AI review(s)${CONFIG_NAME:+ that count toward the cap of config \`${CONFIG_NAME}\`} (the limit is ${MAX_AUTO_REVIEWS}); to request another, remove (if present) and re-add the \`${OPT_IN_LABEL}\` label.

${marker}${config_marker:+
${config_marker}}"

if gh api -X POST "$comments_url" -f body="$body" >/dev/null; then
  echo "posted the review-cap notice on PR ${PR}"
else
  echo "::warning::pr-review-agent: failed to post the review-cap notice"
fi
exit 0
