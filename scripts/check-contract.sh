#!/usr/bin/env bash
# CI check (not part of the review workflow): a change that breaks callers of
# the reusable workflow needs "!" in the PR title, so that release-please makes
# a major release. The baseline is the PR base commit, never a release tag.
#
# Interface part: compares the caller contract of the workflow at BASE_SHA with
# the working tree.
#   - inputs:  removed; new required input; optional -> required; type changed;
#              default added, removed or changed.
#   - secrets: removed; new required secret; optional -> required.
#   - outputs: removed. A changed description is only a ::warning::.
#   - permissions: the union over all jobs (per scope the highest level,
#              none < read < write). A job without a `permissions` key
#              inherits the workflow-level block. A new scope or a higher
#              level is breaking, because the calling job must grant it.
#
# Config part: runs each team config fixture in scripts/__tests__/fixtures/contract/
# (read from BASE_SHA, never from the working tree) through the base and the
# head scripts/load-config.sh, and compares the resolved JSON. The head must
# accept every fixture, and every leaf value of the base result (arrays compare
# whole) must be equal in the head result. New keys in the head are allowed.
# A stub `gh` serves the fixture, so the check needs no network and no token.
#
# Env: BASE_SHA, PR_TITLE, CONTRACT_WORKFLOW (default .github/workflows/pr-review.yml).
# Runs in the repo root. Each break prints ::error:: (no "!" in the title) or
# ::notice:: (with "!"). Exit 1 only when a break is found and the title has no "!".
set -euo pipefail

: "${BASE_SHA:?BASE_SHA is required}"
: "${PR_TITLE:?PR_TITLE is required}"
workflow=${CONTRACT_WORKFLOW:-.github/workflows/pr-review.yml}

bang_re='^[a-z]+(\([^)]*\))?!: '
title_breaking=false
[[ $PR_TITLE =~ $bang_re ]] && title_breaking=true

breaks=0
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# report_break <item> <reason>: record one breaking change.
report_break() {
  breaks=$((breaks + 1))
  if $title_breaking; then
    echo "::notice title=Breaking change::$1: $2"
  else
    echo "::error title=Breaking change::$1: $2"
  fi
}

# interface_json <yaml-text> <file>: print the caller contract of a workflow as
# {inputs:{name:{type,required,default,has_default}}, secrets:{name:{required}},
#  outputs:{name:{description}}, permissions:{scope:level}}.
interface_json() {
  local json
  # Effective permissions per job: its own block, else the workflow-level one.
  local defs='def job_perms: (.permissions // {}) as $top
    | [(.jobs // {})[] | (if has("permissions") then .permissions else $top end) // {}];'
  json=$(yq -o=json '.' <<< "$1" 2> /dev/null) || {
    echo "::error::$2: cannot parse YAML" >&2
    exit 1
  }
  if jq -e "$defs"'job_perms | map(strings) | length > 0' <<< "$json" > /dev/null; then
    echo "::error::$2: a job sets 'permissions' to a string (read-all or write-all). The contract check does not support it; list the scopes." >&2
    exit 1
  fi
  jq "$defs"'
    {"none": 0, "read": 1, "write": 2} as $rank
    | (.on.workflow_call // {}) as $c
    | {
        inputs: (($c.inputs // {}) | map_values((. // {}) | {
          type, required: (.required // false), default, has_default: has("default")})),
        secrets: (($c.secrets // {}) | map_values({required: ((. // {}).required // false)})),
        outputs: (($c.outputs // {}) | map_values({description: (. // {}).description})),
        permissions: (
          [job_perms[] | to_entries[]]
          | group_by(.key)
          | map({key: .[0].key, value: (map(.value) | max_by($rank[.] // 0))})
          | from_entries)
      }' <<< "$json"
}

check_interface() {
  local base head breaks_tsv item reason
  base=$(interface_json "$base_workflow" "$BASE_SHA:$workflow")
  head=$(interface_json "$head_workflow" "$workflow")

  breaks_tsv=$(jq -rn --argjson b "$base" --argjson h "$head" '
    {"none": 0, "read": 1, "write": 2} as $rank
    | (
        ($b.inputs | to_entries[] | .key as $k | .value as $o | $h.inputs[$k] as $n
          | if $n == null then "inputs.\($k)\tremoved"
            else
              (if ($o.required | not) and $n.required then "inputs.\($k)\tchanged from optional to required" else empty end),
              (if $o.type != $n.type then "inputs.\($k)\ttype changed from \($o.type) to \($n.type)" else empty end),
              (if $o.has_default and ($n.has_default | not) then "inputs.\($k)\tdefault \($o.default | tojson) removed"
               elif ($o.has_default | not) and $n.has_default then "inputs.\($k)\tdefault \($n.default | tojson) added"
               elif $o.default != $n.default then "inputs.\($k)\tdefault changed from \($o.default | tojson) to \($n.default | tojson)"
               else empty end)
            end),
        ($h.inputs | to_entries[] | select($b.inputs[.key] == null and .value.required)
          | "inputs.\(.key)\tnew required input"),
        ($b.secrets | to_entries[] | .key as $k | $h.secrets[$k] as $n
          | if $n == null then "secrets.\($k)\tremoved"
            elif (.value.required | not) and $n.required then "secrets.\($k)\tchanged from optional to required"
            else empty end),
        ($h.secrets | to_entries[] | select($b.secrets[.key] == null and .value.required)
          | "secrets.\(.key)\tnew required secret"),
        ($b.outputs | keys[] | select($h.outputs[.] == null) | "outputs.\(.)\tremoved"),
        ($h.permissions | to_entries[]
          | select(($rank[.value] // 0) > ($rank[$b.permissions[.key] // "none"] // 0))
          | "permissions.\(.key)\t\(.value) (was \($b.permissions[.key] // "not granted"); the calling job must grant it)")
      )')
  while IFS=$'\t' read -r item reason; do
    if [[ -n $item ]]; then report_break "$item" "$reason"; fi
  done <<< "$breaks_tsv"

  jq -rn --argjson b "$base" --argjson h "$head" '
    $b.outputs | to_entries[]
    | select($h.outputs[.key] != null and $h.outputs[.key].description != .value.description)
    | "::warning title=Output description changed::outputs.\(.key)"'
}

# load_config <root> <fixture> <out-json> <err-file>: resolve a fixture with
# <root>/scripts/load-config.sh. A stub `gh` prints the fixture (no network).
load_config() {
  mkdir -p "$tmp/bin"
  printf '#!/usr/bin/env bash\ncat %q\n' "$2" > "$tmp/bin/gh"
  chmod +x "$tmp/bin/gh"
  env -u GITHUB_OUTPUT -u GH_TOKEN PATH="$tmp/bin:$PATH" \
    CONFIG_NAME=contract GITHUB_REPOSITORY=contract/check DEFAULT_BRANCH=main \
    AGENT_DIR="$1" RESOLVED_CONFIG="$3" \
    bash "$1/scripts/load-config.sh" > /dev/null 2> "$4"
}

check_config() {
  local dir=scripts/__tests__/fixtures/contract
  local fixtures f name diffs item reason
  fixtures=$(git ls-tree --name-only "$BASE_SHA" "$dir/" | grep '\.yml$' || true)
  if [[ -z $fixtures ]]; then
    echo "::notice::No config fixtures in $dir at the base commit; skipping the config check."
    return
  fi

  mkdir -p "$tmp/base"
  git archive "$BASE_SHA" scripts prompts | tar -x -C "$tmp/base"

  while IFS= read -r f; do
    name=$(basename "$f")
    git show "$BASE_SHA:$f" > "$tmp/$name"
    # Never compare a result left over from the previous fixture.
    rm -f "$tmp/base.json" "$tmp/head.json"
    if ! load_config "$tmp/base" "$tmp/$name" "$tmp/base.json" "$tmp/err"; then
      echo "::error::config $name: the base load-config.sh rejects this fixture, so the fixture or the base is broken: $(head -n 1 "$tmp/err" | sed 's/^::error:://')"
      exit 1
    fi
    if ! load_config "$PWD" "$tmp/$name" "$tmp/head.json" "$tmp/err"; then
      report_break "config $name" "rejected: $(head -n 1 "$tmp/err" | sed 's/^::error:://')"
      continue
    fi
    # Every leaf path of the base result (arrays compare whole) must be equal
    # in the head result. Extra keys in the head are allowed.
    # escalation.builtin_rules and .effective_rules come from code (review
    # behaviour), not from the caller's config, so they are not compared.
    diffs=$(jq -rn --slurpfile b "$tmp/base.json" --slurpfile h "$tmp/head.json" '
      def caller: del(.escalation.builtin_rules, .escalation.effective_rules);
      def leaves(p): if type == "object" and length > 0
        then to_entries[] as $e | $e.value | leaves(p + [$e.key]) else p end;
      ($b[0] | caller) as $base | ($h[0] | caller) as $head
      | $base | leaves([]) as $p
      | ($base | getpath($p)) as $o | ($head | try getpath($p) catch null) as $n
      | select($o != $n)
      | "\($p | join("."))\tchanged from \($o | tojson) to \($n | tojson)"')
    while IFS=$'\t' read -r item reason; do
      if [[ -n $item ]]; then report_break "config $name" "$item $reason"; fi
    done <<< "$diffs"
  done <<< "$fixtures"
}

if ! base_workflow=$(git show "$BASE_SHA:$workflow" 2> /dev/null); then
  echo "::error::cannot read $workflow at the base commit $BASE_SHA (is it fetched, and does the file exist there?)" >&2
  exit 1
fi
head_workflow=$(cat "$workflow")

check_interface
check_config

if (( breaks > 0 )) && ! $title_breaking; then
  echo "Found $breaks breaking change(s) for callers. Add '!' to the PR title (for example 'feat!: …') and a 'BREAKING CHANGE:' paragraph to the description (see AGENTS.md)."
  exit 1
fi
if (( breaks > 0 )); then
  echo "Breaking changes are marked with '!' in the title."
else
  echo "No breaking change in the caller contract."
fi
