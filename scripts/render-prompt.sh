#!/usr/bin/env bash
# Renders prompts/review-prompt.md from the pr-review-agent checkout into the
# "text" step output. Every substituted value is trusted (central config, the
# loaded policy list, the PR number from the event), never PR content.
#
# Placeholders: __PR_NUMBER__, __REPOSITORY__, __SKILLS_LIST__,
# __EXTRA_INSTRUCTIONS__.
#
# Requires (env): PR_NUMBER, GITHUB_REPOSITORY, AGENT_DIR, CONFIG_FILE, and
# .policy/skills.txt (from load-policy.sh) in the working directory.
set -euo pipefail

: "${PR_NUMBER:?}" "${GITHUB_REPOSITORY:?}" "${AGENT_DIR:?}" "${CONFIG_FILE:?}"
[[ "$PR_NUMBER" =~ ^[0-9]+$ ]] || { echo "::error::PR_NUMBER must be numeric"; exit 1; }

SKILLS_LIST=$(cat .policy/skills.txt)
EXTRA_INSTRUCTIONS=$(jq -r '.policy.instructions' "$CONFIG_FILE")
[ -n "$EXTRA_INSTRUCTIONS" ] || EXTRA_INSTRUCTIONS="_(none)_"
export SKILLS_LIST EXTRA_INSTRUCTIONS PR_NUMBER GITHUB_REPOSITORY

# Values are read from %ENV inside perl, so no quoting of their content applies.
rendered=$(perl -pe '
  s/__PR_NUMBER__/$ENV{PR_NUMBER}/g;
  s/__REPOSITORY__/$ENV{GITHUB_REPOSITORY}/g;
  s/__SKILLS_LIST__/$ENV{SKILLS_LIST}/g;
  s/__EXTRA_INSTRUCTIONS__/$ENV{EXTRA_INSTRUCTIONS}/g;
' "${AGENT_DIR}/prompts/review-prompt.md")

# Random per-run delimiter so the prompt can never contain a colliding line.
delimiter="PR_REVIEW_PROMPT_EOF_${RANDOM}${RANDOM}_$$"
while printf '%s' "$rendered" | grep -qF "$delimiter"; do
  delimiter="PR_REVIEW_PROMPT_EOF_${RANDOM}${RANDOM}_$$"
done

{
  echo "text<<${delimiter}"
  printf '%s\n' "$rendered"
  echo "$delimiter"
} >> "$GITHUB_OUTPUT"
