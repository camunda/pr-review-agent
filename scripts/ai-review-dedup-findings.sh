#!/usr/bin/env bash
# LLM dedup pass for AI-review findings.
#
# Runs in the read-only `review` job. Given the new inline findings and this
# bot's inline comments from earlier rounds, it asks the model which new findings
# semantically duplicate an already-posted one (tolerant to rewording or code
# that moved a few lines) and writes ai-review/dedup.json for the privileged
# `decide` job — this script never posts or drops anything itself.
#
# Fail-open: any problem yields an empty duplicate set, so the worst case is
# nothing de-duplicated, never a lost finding.
#
# Requires (env): ANTHROPIC_API_KEY, GH_TOKEN (or GITHUB_TOKEN), GITHUB_REPOSITORY, PR.
# Optional (env): ANTHROPIC_DEDUP_MODEL (default claude-sonnet-5),
#                 ANTHROPIC_BASE_URL   (default https://api.anthropic.com).
# Reads: ai-review/verdict.json. Writes: ai-review/dedup.json.
set -uo pipefail

OUT="ai-review/dedup.json"
MODEL="${ANTHROPIC_DEDUP_MODEL:-claude-sonnet-5}"
BASE_URL="${ANTHROPIC_BASE_URL:-https://api.anthropic.com}"
INLINE_MARKER='<!-- ai-review-inline -->'

# Write an empty (no-duplicates) result and exit 0. Every early-out and every
# error path funnels through here (the sole exception is the jq-missing guard
# below, which writes the same JSON literally because emit_empty itself needs
# jq) so the decide job always finds a well-formed dedup.json and treats it as
# "drop nothing".
emit_empty() {
  local reason="$1"
  mkdir -p "$(dirname "$OUT")"
  jq -n --arg reason "$reason" '{duplicates: [], skipped: $reason}' > "$OUT"
  echo "ai-review dedup: no duplicates (${reason})."
  exit 0
}

# jq is unavailable here, so emit_empty (which uses jq) can't run — write the
# well-formed empty result literally instead, keeping the invariant above true.
command -v jq >/dev/null 2>&1 || {
  echo "dedup: jq missing" >&2
  mkdir -p "$(dirname "$OUT")"
  printf '%s\n' '{"duplicates":[],"skipped":"jq-missing"}' > "$OUT"
  exit 0
}
command -v curl >/dev/null 2>&1 || emit_empty "curl-missing"
[ -f ai-review/verdict.json ]   || emit_empty "no-verdict"
[ -n "${ANTHROPIC_API_KEY:-}" ] || emit_empty "no-api-key"
# GITHUB_REPOSITORY/PR are expanded unguarded in the gh call below; under set -u
# an unset one would abort the script there, before any emit_empty writes
# dedup.json — guard here so that early-out keeps the invariant too.
[ -n "${GITHUB_REPOSITORY:-}" ] && [ -n "${PR:-}" ] || emit_empty "no-pr-context"

# The new inline findings, indexed. The LLM is asked to return the INDICES it
# considers duplicates; we carry each finding's index THROUGH to dedup.json
# (alongside {path,line,side}) so the decide job can distinguish a specific
# finding even when two findings share the same path:line:side.
new_findings=$(jq -c '
  [ (.inline_findings // [])[]
    | select(type == "object" and (.path | type == "string") and (.line | type == "number")) ]
  | to_entries
  | map({
      index: .key,
      path:  (.value.path | tostring),
      line:  (.value.line | floor),
      side:  ((.value.side // "RIGHT") | tostring | ascii_upcase),
      body:  ((.value.body // "") | tostring | .[0:1500])
    })
' ai-review/verdict.json 2>/dev/null || echo '[]')

n_new=$(printf '%s' "$new_findings" | jq 'length' 2>/dev/null || echo 0)
[ "$n_new" -gt 0 ] || emit_empty "no-new-findings"

# The AI-review inline comments already on this PR from earlier rounds, scoped by
# our provenance marker to this bot's own findings, not human comments. We scope
# by marker rather than author login on purpose: a hard-coded posting identity is
# brittle (change it and dedup silently sees zero prior comments). A forged
# marker can at most suppress a finding's inline RE-POST, never its effect: every
# suppressed duplicate is recapped as a link and logged in full, and the verdict
# is gate-independent of the inline set (see ai-review-compute-verdict.sh).
#
# gh REJECTS `--slurp` with `--jq`/`--template`, so keep `--paginate --slurp` in
# gh (one array-of-pages, flattened by `.[][]`) and do the marker filtering in a
# jq PIPE. Carry each comment's commit sha so the model can anchor "same code"
# across rounds even when the line moved.
# Capture gh's stderr rather than discarding it: on a non-zero gh exit (auth,
# rate limit, a future flag incompatibility) log a truncated diagnostic and still
# fail-open, so the fetch can't fall silently to "no-prior-comments". Never log
# tokens/secrets.
gh_out=$(mktemp)
gh_err=$(mktemp)
# -X GET is required because adding a field (-f) otherwise flips gh to POST;
# per_page=100 (the endpoint defaults to 30) cuts the paginated call count on a
# comment-heavy PR without changing the result set that --slurp flattens.
if gh api -X GET --paginate --slurp -f per_page=100 "repos/${GITHUB_REPOSITORY}/pulls/${PR}/comments" >"$gh_out" 2>"$gh_err"; then
  existing=$(jq -c "[ .[][]
               | select((.body // \"\") | contains(\"${INLINE_MARKER}\"))
               | { path: (.path // \"\"),
                   line: (.line // .original_line // 0),
                   sha:  ((.original_commit_id // .commit_id // \"\") | .[0:12]),
                   url:  ((.html_url // \"\") | tostring),
                   body: ((.body // \"\") | .[0:1500]) } ]
               | to_entries
               | map({index: .key} + .value)" "$gh_out" 2>/dev/null || echo '[]')
else
  gh_msg=$(tr '\n' ' ' < "$gh_err" | cut -c1-200)
  echo "ai-review dedup: prior-comment fetch failed (gh: ${gh_msg})." >&2
  existing='[]'
fi
rm -f "$gh_out" "$gh_err"

# Guard against any unexpected multi-value output regardless (belt-and-suspenders):
# slurp the stream so `$existing` is always exactly one JSON array before use.
existing=$(printf '%s' "$existing" | jq -c -s 'if length == 1 then .[0] else (add // []) end' 2>/dev/null || echo '[]')

n_existing=$(printf '%s' "$existing" | jq 'length' 2>/dev/null || echo 0)
[ "$n_existing" -gt 0 ] || emit_empty "no-prior-comments"

system_prompt='You are a deduplication filter for an automated code-review bot. You are given NEW review findings (each with an integer "index", a file path, a line, and a body) and EXISTING review comments already posted to this pull request in earlier rounds (each with an integer "index", a file path, a line, the commit sha it was posted on, a URL, and a body). Decide which NEW findings are semantic DUPLICATES of an EXISTING comment: the same underlying issue about the same code, even if the wording differs or the code moved by a few lines (the sha and line help you judge whether two refer to the same code). A finding that raises a genuinely different concern is NOT a duplicate, even in the same file. Respond with ONLY a compact JSON object of the form {"duplicates":[{"index":<new finding index>,"existing":<existing comment index>}]} where "existing" is the 0-based index in the EXISTING comments list of the prior comment that the NEW finding duplicates. If none duplicate, respond {"duplicates":[]}. Output JSON only, no prose, no code fences.'

user_content=$(jq -n --argjson new "$new_findings" --argjson existing "$existing" '
  "NEW findings:\n" + ($new | tostring) + "\n\nEXISTING comments:\n" + ($existing | tostring)
' 2>/dev/null || echo '""')

# NB on the request shape:
#  • no `temperature` — current Claude models (sonnet-5 et al.) use adaptive
#    thinking and reject an explicit temperature (invalid_request_error).
#  • max_tokens 64000 — a safety ceiling, not expected usage. Thinking tokens
#    count against max_tokens, so a small ceiling can yield a successful reply
#    with no text block. 64K stays under sonnet-5's 128K output cap and leaves
#    headroom for a heavy round.
request=$(jq -n \
  --arg model "$MODEL" \
  --arg system "$system_prompt" \
  --argjson user "$user_content" '
  {
    model: $model,
    max_tokens: 64000,
    system: $system,
    messages: [ { role: "user", content: $user } ]
  }' 2>/dev/null || echo '')
[ -n "$request" ] || emit_empty "request-build-failed"

# Capture curl's stderr so a transport failure (DNS, TLS, connect, or the
# --max-time timeout) leaves a diagnostic instead of vanishing into an empty
# `no-response`. HTTP errors still arrive on stdout (curl has no --fail) and are
# handled by the error-object diagnostic below. Never log tokens/secrets.
# --max-time 180 bounds the wall-clock budget with headroom for a heavy round;
# on timeout curl exits 28 and the pass fail-opens.
curl_err=$(mktemp)
response=$(printf '%s' "$request" | curl -sS --max-time 180 \
  "${BASE_URL}/v1/messages" \
  -H "x-api-key: ${ANTHROPIC_API_KEY}" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  --data-binary @- 2>"$curl_err")
curl_status=$?
if [ "$curl_status" -ne 0 ]; then
  curl_msg=$(tr '\n' ' ' < "$curl_err" | cut -c1-200)
  echo "ai-review dedup: LLM request transport failed (curl exit ${curl_status}: ${curl_msg})." >&2
fi
rm -f "$curl_err"
[ -n "$response" ] || emit_empty "no-response"

# Extract the assistant's TEXT block. Not `.content[0]`: models with adaptive
# thinking (sonnet-5 et al.) can return a `thinking` block first, so the text
# lives at a later index — pick the first block whose type is "text". Tolerate a
# stray code fence or surrounding prose downstream by extracting the {...} block.
text=$(printf '%s' "$response" | jq -r 'first(.content[]? | select(.type == "text") | .text) // ""' 2>/dev/null || echo '')
if [ -z "$text" ]; then
  # A response with no assistant text is one of two things, and they need
  # different diagnostics (never print the request or the api key):
  #   1. an API error object ({"type":"error","error":{type,message}}) — surface
  #      the error TYPE and a short message.
  #   2. a SUCCESSFUL Messages response ("type":"message") that carried only
  #      non-text blocks: adaptive thinking can spend the whole max_tokens budget
  #      before emitting text → stop_reason "max_tokens" and no text block. Here
  #      `.type` is the useless literal "message", so log `.stop_reason` instead
  #      so a truncation is visible rather than a silent fail-open.
  if printf '%s' "$response" | jq -e 'has("error")' >/dev/null 2>&1; then
    err_type=$(printf '%s' "$response" | jq -r '.error.type // "unknown"' 2>/dev/null || echo unknown)
    err_msg=$(printf '%s' "$response" | jq -r '(.error.message // "") | .[0:160]' 2>/dev/null || echo '')
    echo "ai-review dedup: LLM call failed (api error type: ${err_type}; ${err_msg})." >&2
  else
    stop_reason=$(printf '%s' "$response" | jq -r '.stop_reason // "unknown"' 2>/dev/null || echo unknown)
    echo "ai-review dedup: LLM response had no text block (stop_reason: ${stop_reason})." >&2
  fi
  emit_empty "empty-completion"
fi

dup_pairs=$(printf '%s' "$text" \
  | tr '\n' ' ' \
  | grep -o '{.*}' \
  | jq -c '[ (.duplicates // [])[]
      | select(type == "object" and (.index | type) == "number")
      | { index: (.index | floor),
          existing: (if (.existing | type) == "number" then (.existing | floor) else null end) } ]
    | unique_by(.index, .existing)' \
  2>/dev/null || echo '[]')
[ -n "$dup_pairs" ] || dup_pairs='[]'

warnings=$(jq -nr --argjson findings "$new_findings" --argjson existing "$existing" --argjson dups "$dup_pairs" '
  def original($idx):
    if ($idx | type) == "number" and $idx >= 0 and $idx < ($existing | length)
    then $existing[$idx]
    else null
    end;
  $dups[] as $d
  | ($findings[]? | select(.index == $d.index)) as $f
  | original($d.existing) as $orig
  | select(
      ($orig == null)
      or (($orig.url // null) | type != "string")
      or (($orig.url // "") == "")
    )
  | "ai-review dedup: no linkable original for \($f.path):\($f.line); keeping it inline."
' 2>/dev/null || true)
[ -n "$warnings" ] && printf '%s\n' "$warnings" >&2

# Resolve indices back to the identities the decide job matches against the
# normalised finding set: keep each finding's INDEX (unique per finding) plus
# {path,line,side} as a location guard, so two findings on the same line are
# distinguished instead of dropped together.
mkdir -p "$(dirname "$OUT")"
jq -n --argjson findings "$new_findings" --argjson existing "$existing" --argjson dups "$dup_pairs" --arg model "$MODEL" '
  def original($idx):
    if ($idx | type) == "number" and $idx >= 0 and $idx < ($existing | length)
    then $existing[$idx]
    else null
    end;
  {
    model: $model,
    checked: ($findings | length),
    existing_comments: '"$n_existing"',
    duplicates: [
      $dups[] as $d
      | ($findings[] | select(.index == $d.index)) as $f
      | original($d.existing) as $orig
      | select(($orig != null) and (($orig.url // null) | type == "string") and (($orig.url // "") != ""))
      | { dedup_index: $f.index, path: $f.path, line: $f.line, side: $f.side, url: $orig.url }
    ]
  }
' > "$OUT" 2>/dev/null || emit_empty "resolve-failed"

echo "ai-review dedup: flagged $(jq '.duplicates | length' "$OUT") of ${n_new} new finding(s) as duplicates of ${n_existing} prior comment(s) (model ${MODEL})."
