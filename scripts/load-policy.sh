#!/usr/bin/env bash
# Materialises the review policy (rubric + review skills) into .policy/ BEFORE
# the agent runs, from trusted sources only:
#   from: agent -> the pr-review-agent checkout (central, PR-immune)
#   from: repo  -> the reviewed repo at the PR's BASE commit, never the PR head,
#                  so a PR cannot edit the rules or conventions it is judged by.
#                  Only when the file does not exist at the base commit (a PR
#                  whose stored base predates the file) it is read from the
#                  repo's DEFAULT branch instead, the same trust level as the
#                  team config. The PR head and the checked-out merge ref are
#                  never used.
#
# `git show <rev>:<path>` does not follow a symlinked directory, so repo paths
# must point at the real file (e.g. .agents/skills/x/SKILL.md, not a
# .claude/skills symlink into it).
#
# Requires (env): CONFIG_FILE, AGENT_DIR, BASE_SHA. Run from the reviewed repo's
# checkout root. Optional (env): DEFAULT_BRANCH, enables the fallback above.
# Writes .policy/rubric.md, .policy/skills/NN-<name>.md and
# .policy/skills.txt (the list rendered into the prompt).
set -euo pipefail

: "${CONFIG_FILE:?}" "${AGENT_DIR:?}" "${BASE_SHA:?}"

rm -rf .policy
mkdir -p .policy/skills

git fetch --quiet --depth=1 origin "$BASE_SHA" 2>/dev/null || true

# Resolve the default branch tip once, lazily, only if a repo file is missing at
# the base commit. Stays empty (no fallback) when unset, invalid or unfetchable.
DEFAULT_SHA=""
DEFAULT_RESOLVED=0
resolve_default() {
  [ "$DEFAULT_RESOLVED" = 0 ] || return 0
  DEFAULT_RESOLVED=1
  local b="${DEFAULT_BRANCH:-}"
  { [ -n "$b" ] && [[ "$b" != -* ]] && git check-ref-format "refs/heads/$b" 2>/dev/null; } || return 0
  git fetch --quiet origin "refs/heads/$b" 2>/dev/null || return 0
  DEFAULT_SHA=$(git rev-parse --verify --quiet "FETCH_HEAD^{commit}") || DEFAULT_SHA=""
}

# Copies "$1:$2" (rev:path) to $3. A read or write error is NOT "file missing":
# it removes the partial destination and aborts the whole run (fail closed), so
# no caller `||` chain or `if` can turn it into a skipped or half-loaded policy.
show_to() {
  if ! git show "$1:$2" > "$3" 2>/dev/null; then
    rm -f "$3"
    echo "::error::could not read repo file '$2' at $1 or write it to '$3'; failing closed"
    exit 1
  fi
}

# $1 from, $2 path, $3 destination. Returns non-zero only if the source is
# missing. Anything else that goes wrong exits the script.
fetch() {
  case "$1" in
    agent) [ -f "${AGENT_DIR}/$2" ] && cp "${AGENT_DIR}/$2" "$3" ;;
    repo)  # A missing base commit (failed fetch) is not a missing file: without
           # this check the fallback would silently replace a rubric that may
           # exist at the PR base. Fail closed instead.
           if ! git cat-file -e "${BASE_SHA}^{commit}" 2>/dev/null; then
             echo "::error::PR base commit ${BASE_SHA} is not available locally (fetch failed?); cannot read repo file '$2' from it, failing closed"
             exit 1
           fi
           if git cat-file -e "${BASE_SHA}:$2" 2>/dev/null; then
             show_to "${BASE_SHA}" "$2" "$3"
             return 0
           fi
           # Missing at the PR base (e.g. the PR was opened before the file was
           # added): use the default branch, never the PR head or the merge ref.
           resolve_default
           { [ -n "$DEFAULT_SHA" ] && git cat-file -e "${DEFAULT_SHA}:$2" 2>/dev/null; } || return 1
           show_to "${DEFAULT_SHA}" "$2" "$3"
           echo "::warning::repo file '$2' not found at PR base ${BASE_SHA}; read it from the default branch '${DEFAULT_BRANCH}' (${DEFAULT_SHA}) instead"
           ;;
    *)     return 1 ;;
  esac
}

# Where a missing file was looked for, for error messages.
searched() {
  if [ "$1" = repo ]; then echo "PR base ${BASE_SHA} and default branch '${DEFAULT_BRANCH:-<unknown>}'"; else echo "${AGENT_DIR}"; fi
}

read -r rfrom rpath < <(jq -r '.policy.rubric | "\(.from) \(.path)"' "$CONFIG_FILE")
fetch "$rfrom" "$rpath" .policy/rubric.md \
  || { echo "::error::rubric '${rpath}' (from: ${rfrom}) not found at $(searched "$rfrom")"; exit 1; }
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
    echo "::warning::review skill '${spath}' (from: ${sfrom}) not found at $(searched "$sfrom"); reviewing without it"
  fi
done < <(jq -r '.policy.skills[] | [.from, .path] | @tsv' "$CONFIG_FILE")

[ -s .policy/skills.txt ] || echo "- _(no review skills configured — apply general code-review judgement)_" > .policy/skills.txt
