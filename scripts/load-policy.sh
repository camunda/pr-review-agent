#!/usr/bin/env bash
# Materialises the review policy (rubric + review skills) into .policy/ BEFORE
# the agent runs, from trusted sources only:
#   from: agent -> the pr-review-agent checkout (central, PR-immune)
#   from: repo  -> the reviewed repo at the PR's BASE commit, never the PR head,
#                  so a PR cannot edit the rules or conventions it is judged by.
#
# `git show <rev>:<path>` does not follow a symlinked directory, so repo paths
# must point at the real file (e.g. .agents/skills/x/SKILL.md, not a
# .claude/skills symlink into it).
#
# Requires (env): CONFIG_FILE, AGENT_DIR, BASE_SHA. Run from the reviewed repo's
# checkout root. Writes .policy/rubric.md, .policy/skills/NN-<name>.md and
# .policy/skills.txt (the list rendered into the prompt).
set -euo pipefail

: "${CONFIG_FILE:?}" "${AGENT_DIR:?}" "${BASE_SHA:?}"

rm -rf .policy
mkdir -p .policy/skills

git fetch --quiet --depth=1 origin "$BASE_SHA" 2>/dev/null || true

# $1 from, $2 path, $3 destination. Returns non-zero if the source is missing.
fetch() {
  case "$1" in
    agent) [ -f "${AGENT_DIR}/$2" ] && cp "${AGENT_DIR}/$2" "$3" ;;
    repo)  git cat-file -e "${BASE_SHA}:$2" 2>/dev/null && git show "${BASE_SHA}:$2" > "$3" ;;
    *)     return 1 ;;
  esac
}

read -r rfrom rpath < <(jq -r '.policy.rubric | "\(.from) \(.path)"' "$CONFIG_FILE")
fetch "$rfrom" "$rpath" .policy/rubric.md \
  || { echo "::error::rubric '${rpath}' (from: ${rfrom}) not found (repo files are read at base ${BASE_SHA})"; exit 1; }
echo "Loaded rubric ${rpath} (from: ${rfrom})"

: > .policy/skills.txt
i=0
while IFS=$'\t' read -r sfrom spath; do
  [ -z "$spath" ] && continue
  i=$((i + 1))
  dest=$(printf '.policy/skills/%02d-%s.md' "$i" "$(basename "$(dirname "$spath")")-$(basename "$spath" .md)")
  if fetch "$sfrom" "$spath" "$dest"; then
    echo "Loaded skill ${spath} (from: ${sfrom}) -> ${dest}"
    printf -- '- `%s` (source: `%s`, from: %s)\n' "$dest" "$spath" "$sfrom" >> .policy/skills.txt
  else
    # A missing skill must not block every review (e.g. the PR that introduces
    # it), but it must be visible.
    echo "::warning::review skill '${spath}' (from: ${sfrom}) not found; reviewing without it"
  fi
done < <(jq -r '.policy.skills[] | [.from, .path] | @tsv' "$CONFIG_FILE")

[ -s .policy/skills.txt ] || echo "- _(no review skills configured — apply general code-review judgement)_" > .policy/skills.txt
