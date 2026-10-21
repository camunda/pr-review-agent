#!/usr/bin/env bash
# Deterministic escalation gate. Re-derives the hard escalation rules from the
# PR's changed-file list, independently of the agent: the agent's verdict can
# only ever be DOWNGRADED to NEEDS_HUMAN here, never upgraded. No LLM involved.
#
# Rules come from the resolved central config (`escalation.effective_rules`:
# built-in rules first, then the team's own). Patterns use bash glob semantics
# matched against the repo-relative path — `*` also matches `/`, so
# `restapi/db/*` covers every file below restapi/db/. The first matching rule
# wins.
#
# Both the new and the OLD path of a renamed file are checked: moving a file out
# of a protected path (e.g. a review skill or the caller workflow) is a change
# to that path. The PR files API caps at 3000 files, so a PR at that cap fails
# closed instead of being checked against a truncated list.
#
# Requires (env): PR, CONFIG_FILE (resolved config JSON), GH_TOKEN; GH_REPO when
# the working directory is not a checkout of the reviewed repo.
# Writes escalate/reason/match to $GITHUB_OUTPUT.
set -euo pipefail

: "${PR:?PR is required}"
: "${CONFIG_FILE:?CONFIG_FILE is required}"

# Fail closed: unreadable rules or an unreadable diff must escalate, not pass.
fail_closed() {
  echo "::warning::gate: $1 — escalating to a human."
  {
    echo "escalate=true"
    echo "reason=gate error"
    echo "match="
  } >> "$GITHUB_OUTPUT"
  exit 0
}

rules_tsv=$(jq -r '.escalation.effective_rules[] | .reason as $r | .paths[] | [$r, .] | @tsv' "$CONFIG_FILE") \
  || fail_closed "could not read escalation rules"
# One line per changed file: "<path>\t<previous path or empty>".
pairs=$(gh api --paginate "repos/{owner}/{repo}/pulls/${PR}/files" \
  --jq '.[] | [.filename, (.previous_filename // "")] | @tsv') \
  || fail_closed "could not list changed files"
[ "$(grep -c . <<<"$pairs")" -lt 3000 ] || fail_closed "PR has 3000+ changed files (API limit)"
files=$(cut -f1 <<<"$pairs"; cut -f2 <<<"$pairs")

escalate=false
reason=""
match=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  while IFS=$'\t' read -r r pat; do
    [ -z "$pat" ] && continue
    # Unquoted $pat on the right of == is a glob match (intended); $f is data.
    # shellcheck disable=SC2053
    if [[ "$f" == $pat ]]; then
      escalate=true; reason="$r"; match="$f"
      break 2
    fi
  done <<<"$rules_tsv"
done <<<"$files"

[ "$escalate" = true ] && echo "gate: escalating on '$match' ($reason)"
# reason is a trusted label from the central config; match is a PR filename
# (attacker-controlled): strip newlines so it cannot inject into $GITHUB_OUTPUT.
match=$(printf '%s' "$match" | tr -d '\n\r')
{
  echo "escalate=$escalate"
  echo "reason=$reason"
  echo "match=$match"
} >> "$GITHUB_OUTPUT"
