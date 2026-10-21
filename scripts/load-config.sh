#!/usr/bin/env bash
# Loads and validates a team config (.github/pr-review-agent/<name>.yml) from the
# calling repository's DEFAULT BRANCH and resolves it into a single JSON document
# with every default applied.
#
# The config is trusted because it is read from the default branch, never from
# the PR head, so a PR under review can never change the rules it is judged by
# (a PR that edits the config also escalates via a built-in rule). Validation
# still runs strictly so a typo fails loudly instead of silently weakening the
# gate: an unknown key at ANY level (e.g. `escalation.rule`) or a malformed glob
# is an error, not a warning.
#
# Requires (env):
#   CONFIG_NAME        entry name, e.g. "operate" -> .github/pr-review-agent/operate.yml
#   GITHUB_REPOSITORY  the calling repository (owner/repo)
#   DEFAULT_BRANCH     its default branch, the only ref the config is read from
#   GH_TOKEN           token that can read the calling repository's contents
# Optional (env):
#   AGENT_DIR          root of the pr-review-agent checkout (default: repo root
#                      derived from this script's location)
#   RESOLVED_CONFIG    where to write the resolved JSON
#                      (default: $RUNNER_TEMP/pr-review-agent-config.json)
#   GITHUB_OUTPUT      when set, scalar settings are exported as step outputs
set -euo pipefail

AGENT_DIR="${AGENT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
OUT="${RESOLVED_CONFIG:-${RUNNER_TEMP:-/tmp}/pr-review-agent-config.json}"
CONFIG_DIR=".github/pr-review-agent"

die() { echo "::error::pr-review-agent config: $*" >&2; exit 1; }

command -v yq >/dev/null 2>&1 || die "yq (mikefarah, v4) is required"
command -v jq >/dev/null 2>&1 || die "jq is required"

name="${CONFIG_NAME:-}"
[[ "$name" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] && [[ "$name" != *..* ]] \
  || die "invalid config name '${name}' (lowercase letters, digits, '.', '_', '-')"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}" "${DEFAULT_BRANCH:?DEFAULT_BRANCH is required}"
src="${CONFIG_DIR}/${name}.yml"

ref=$(jq -rn --arg b "$DEFAULT_BRANCH" '$b | @uri')
err=$(mktemp)
if ! yaml=$(gh api -H 'Accept: application/vnd.github.raw+json' \
     "repos/${GITHUB_REPOSITORY}/contents/${src}?ref=${ref}" 2>"$err"); then
  # Not merged yet (e.g. the onboarding PR adds config and caller together):
  # skip the review instead of failing. Any other error still fails.
  if grep -q 'HTTP 404' "$err"; then
    echo "::notice::pr-review-agent: no config '${src}' on ${GITHUB_REPOSITORY}@${DEFAULT_BRANCH} yet; skipping the review until it is merged"
    [ -z "${GITHUB_OUTPUT:-}" ] || echo "found=false" >> "$GITHUB_OUTPUT"
    exit 0
  fi
  die "could not read '${src}' from ${GITHUB_REPOSITORY}@${DEFAULT_BRANCH}: $(cat "$err")"
fi
echo "pr-review-agent: read ${src} from ${GITHUB_REPOSITORY}@${DEFAULT_BRANCH}"

raw=$(yq -o=json '.' <<<"$yaml") || die "${src} is not valid YAML"

jq -e 'type == "object"' <<<"$raw" >/dev/null 2>&1 || die "${src} must be a mapping"
not_maps=$(jq -r '[("vault","agent","triggers","labels","policy","escalation","notifications") as $k
  | select(.[$k] != null and (.[$k] | type) != "object") | $k] | join(", ")' <<<"$raw")
[ -z "$not_maps" ] || die "${src}: must be mappings: ${not_maps}"

# Apply defaults, then validate. Any failed check yields a list of messages.
resolved=$(jq --arg name "$name" '
  def dflt(v): if . == null then v else . end;
  {
    schema_version: (.schema_version | dflt(1)),
    name: $name,
    shadow_mode: (.shadow_mode | dflt(true)),
    vault: {
      anthropic_api_key: {
        path: .vault.anthropic_api_key.path,
        field: (.vault.anthropic_api_key.field | dflt("ANTHROPIC_API_KEY"))
      }
    },
    agent: {
      model: (.agent.model | dflt("")),
      dedup_model: (.agent.dedup_model | dflt("claude-sonnet-5")),
      allowed_bots: (.agent.allowed_bots | dflt([])),
      timeout_minutes: (.agent.timeout_minutes | dflt(15))
    },
    triggers: {
      opt_in_label: (.triggers.opt_in_label | dflt("ai-review")),
      review_drafts: (.triggers.review_drafts | dflt(false)),
      skip_authors: (.triggers.skip_authors | dflt(["renovate[bot]", "dependabot[bot]"]))
    },
    labels: {
      needs_human: (.labels.needs_human | dflt(""))
    },
    policy: {
      rubric: (.policy.rubric | dflt({from: "agent", path: "prompts/rubric-default.md"})
               | .from |= dflt("agent")),
      skills: ((.policy.skills | dflt([])) | map(.from |= dflt("repo"))),
      instructions: (.policy.instructions | dflt(""))
    },
    escalation: {
      rules: (.escalation.rules | dflt([]))
    },
    notifications: {
      capture_alert_mentions: (.notifications.capture_alert_mentions | dflt([]))
    },
    _unknown: [
      def unknown(where; allowed):
        if type == "object" then (keys - allowed)[] | "\(where).\(.)" else empty end;
      ((keys - ["schema_version","shadow_mode","vault","agent",
                "triggers","labels","policy","escalation","notifications"])[]),
      (.vault | unknown("vault"; ["anthropic_api_key"])),
      (.vault.anthropic_api_key? | unknown("vault.anthropic_api_key"; ["path","field"])),
      (.agent | unknown("agent"; ["model","dedup_model","allowed_bots","timeout_minutes"])),
      (.triggers | unknown("triggers"; ["opt_in_label","review_drafts","skip_authors"])),
      (.labels | unknown("labels"; ["needs_human"])),
      (.policy | unknown("policy"; ["rubric","skills","instructions"])),
      (.policy.rubric? | unknown("policy.rubric"; ["from","path"])),
      (.policy.skills? | if type == "array" then to_entries[] | .key as $i | .value
                         | unknown("policy.skills[\($i)]"; ["from","path"]) else empty end),
      (.escalation | unknown("escalation"; ["rules"])),
      (.escalation.rules? | if type == "array" then to_entries[] | .key as $i | .value
                            | unknown("escalation.rules[\($i)]"; ["reason","paths"]) else empty end),
      (.notifications | unknown("notifications"; ["capture_alert_mentions"]))
    ]
  }' <<<"$raw") || die "${src} must be a mapping"

errors=$(jq -r '
  def s(re): type == "string" and test(re);
  def is_path: type == "string" and test("^[A-Za-z0-9._@+/-][A-Za-z0-9._@+/ -]*$")
               and (test("(^|/)\\.\\.(/|$)") | not) and (startswith("/") | not);
  def is_glob: type == "string" and length > 0 and length <= 200
               and test("^[A-Za-z0-9._@+/*?\\[\\] -]+$");
  def policy_file(where):
    if (type != "object") then "\(where) must be a mapping {from, path}"
    elif (.from | IN("agent","repo") | not) then "\(where).from must be \"agent\" or \"repo\""
    elif (.path | is_path | not) then "\(where).path must be a relative path without .."
    else empty end;
  [
    (if .schema_version != 1 then "schema_version must be 1" else empty end),
    (if (._unknown | length) > 0 then "unknown key(s): \(._unknown | join(", "))" else empty end),
    (if (.shadow_mode | type) != "boolean" then "shadow_mode must be true or false" else empty end),
    (if (.vault.anthropic_api_key.path | type) != "string"
       or (.vault.anthropic_api_key.path | s("^[A-Za-z0-9_./-]+$") | not)
     then "vault.anthropic_api_key.path is required (e.g. secret/data/products/<team>/ci/common)" else empty end),
    (if (.vault.anthropic_api_key.field | s("^[A-Za-z0-9_-]+$") | not)
     then "vault.anthropic_api_key.field must be an identifier" else empty end),
    (if (.agent.model | s("^[A-Za-z0-9._:-]*$") | not) then "agent.model has invalid characters" else empty end),
    (if (.agent.dedup_model | s("^[A-Za-z0-9._:-]+$") | not) then "agent.dedup_model has invalid characters" else empty end),
    (if (.agent.allowed_bots | type) != "array" or any(.agent.allowed_bots[]; (. == "*") or (s("^[A-Za-z0-9_-]+$") | not))
     then "agent.allowed_bots must be a list of bot names (no \"*\")" else empty end),
    (if (.agent.timeout_minutes | type) != "number" or .agent.timeout_minutes < 5 or .agent.timeout_minutes > 60
     then "agent.timeout_minutes must be a number between 5 and 60" else empty end),
    (if (.triggers.opt_in_label | s("^[A-Za-z0-9 ._:/-]{1,50}$") | not) then "triggers.opt_in_label is invalid" else empty end),
    (if (.triggers.review_drafts | type) != "boolean" then "triggers.review_drafts must be true or false" else empty end),
    (if (.triggers.skip_authors | type) != "array" or any(.triggers.skip_authors[]; (s("^[A-Za-z0-9_\\[\\]-]+$") | not))
     then "triggers.skip_authors must be a list of logins" else empty end),
    (if (.labels.needs_human | s("^[A-Za-z0-9 ._:/-]{0,50}$") | not) then "labels.needs_human is invalid" else empty end),
    (.policy.rubric | policy_file("policy.rubric")),
    (if (.policy.skills | type) != "array" then "policy.skills must be a list"
     else (.policy.skills | to_entries[] | .key as $i | .value | policy_file("policy.skills[\($i)]")) end),
    (if (.policy.instructions | type) != "string" then "policy.instructions must be a string" else empty end),
    (if (.escalation.rules | type) != "array" then "escalation.rules must be a list"
     else (.escalation.rules | to_entries[] |
       .key as $i | .value |
       if type != "object" then "escalation.rules[\($i)] must be a mapping {reason, paths}"
       elif (.reason | type) != "string" or (.reason | s("^[A-Za-z0-9 ._/()-]{1,60}$") | not)
         then "escalation.rules[\($i)].reason must be 1-60 plain characters"
       elif (.paths | type) != "array" or (.paths | length) == 0
         then "escalation.rules[\($i)].paths must be a non-empty list"
       elif any(.paths[]; is_glob | not)
         then "escalation.rules[\($i)].paths contains an invalid glob"
       else empty end) end),
    (if (.notifications.capture_alert_mentions | type) != "array"
       or any(.notifications.capture_alert_mentions[]; (s("^@[A-Za-z0-9-]+(/[A-Za-z0-9._-]+)?$") | not))
     then "notifications.capture_alert_mentions must be a list of @user or @org/team" else empty end)
  ] | .[]' <<<"$resolved")

if [ -n "$errors" ]; then
  while IFS= read -r e; do echo "::error::${src}: $e" >&2; done <<<"$errors"
  exit 1
fi

# Agent-sourced policy files must exist in this checkout; repo-sourced ones are
# resolved later against the PR base commit (load-policy.sh).
while IFS= read -r p; do
  [ -f "${AGENT_DIR}/${p}" ] || die "policy file '${p}' (from: agent) does not exist in pr-review-agent"
done < <(jq -r '[.policy.rubric] + .policy.skills | .[] | select(.from == "agent") | .path' <<<"$resolved")

# Built-in escalation rules every team gets and cannot remove:
#  - the caller workflow and the team config decide which agent version runs and
#    with which rules, so a PR editing them must never be auto-approved by the
#    run it just reconfigured (the config is read from the default branch, so
#    such a PR is reviewed with the old rules, but a human must still look);
#  - review policy files read from the reviewed repo (skills, rubric) must not be
#    rewritten and approved in the same PR.
resolved=$(jq '
  .escalation.builtin_rules = [
    {reason: "reviewer workflow", paths: [".github/workflows/*"]},
    {reason: "reviewer config", paths: [".github/pr-review-agent/*"]}
  ] + (
    [ [.policy.rubric] + .policy.skills | .[] | select(.from == "repo") | .path ]
    | if length > 0 then [{reason: "review policy change", paths: .}] else [] end
  )
  | .escalation.effective_rules = (.escalation.builtin_rules + .escalation.rules)
  | del(._unknown)' <<<"$resolved")

mkdir -p "$(dirname "$OUT")"
printf '%s\n' "$resolved" > "$OUT"
echo "pr-review-agent: loaded config '${name}' -> ${OUT}"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "found=true"
    echo "config_file=${OUT}"
    echo "shadow_mode=$(jq -r '.shadow_mode' <<<"$resolved")"
    echo "vault_anthropic_secret=$(jq -r '.vault.anthropic_api_key | "\(.path) \(.field) | ANTHROPIC_API_KEY ;"' <<<"$resolved")"
    echo "model=$(jq -r '.agent.model' <<<"$resolved")"
    echo "dedup_model=$(jq -r '.agent.dedup_model' <<<"$resolved")"
    echo "allowed_bots=$(jq -r '.agent.allowed_bots | join(",")' <<<"$resolved")"
    echo "timeout_minutes=$(jq -r '.agent.timeout_minutes' <<<"$resolved")"
    echo "opt_in_label=$(jq -r '.triggers.opt_in_label' <<<"$resolved")"
    echo "needs_human_label=$(jq -r '.labels.needs_human' <<<"$resolved")"
    echo "capture_alert_mentions=$(jq -r '.notifications.capture_alert_mentions | join(" ")' <<<"$resolved")"
    echo "rubric_ref=$(jq -r '.policy.rubric | if .from == "agent" then "Rubric: `\(.path)` in pr-review-agent." else "Rubric: `\(.path)`." end' <<<"$resolved")"
  } >> "$GITHUB_OUTPUT"
fi
