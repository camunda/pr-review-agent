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

# report_break <item> <reason>: record one breaking change.
report_break() {
  breaks=$((breaks + 1))
  if $title_breaking; then
    echo "::notice title=Breaking change::$1: $2"
  else
    echo "::error title=Breaking change::$1: $2"
  fi
}

# interface_json <yaml-text>: print the caller contract of a workflow as
# {inputs:{name:{type,required,default,has_default}}, secrets:{name:{required}},
#  outputs:{name:{description}}, permissions:{scope:level}}.
interface_json() {
  local json
  # Effective permissions per job: its own block, else the workflow-level one.
  local defs='def job_perms: (.permissions // {}) as $top
    | [(.jobs // {})[] | (if has("permissions") then .permissions else $top end) // {}];'
  json=$(yq -o=json '.' <<< "$1")
  if jq -e "$defs"'job_perms | map(strings) | length > 0' <<< "$json" > /dev/null; then
    echo "::error::$workflow: a job sets 'permissions' to a string (read-all or write-all). The contract check does not support it; list the scopes." >&2
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
  base=$(interface_json "$(git show "$BASE_SHA:$workflow")")
  head=$(interface_json "$(cat "$workflow")")

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

check_interface

if (( breaks > 0 )) && ! $title_breaking; then
  echo "Found $breaks breaking change(s) for callers. Add '!' to the PR title (for example 'feat!: …') and a 'BREAKING CHANGE:' paragraph to the description (see AGENTS.md)."
  exit 1
fi
if (( breaks > 0 )); then
  echo "Breaking changes are marked with '!' in the title."
else
  echo "No breaking change in the caller contract."
fi
