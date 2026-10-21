#!/usr/bin/env bash
# Computes the final verdict (merging the agent's verdict.json with the
# deterministic gate result and the confidence floor) and writes four files the
# workflow's post step consumes — all four are required; a missing one aborts
# posting:
#   - body.md            the review body (verdict card + non-line findings)
#   - review.json        the GitHub Reviews API payload with the agent's
#                        line-anchored findings as inline comments
#   - inline-fallback.md the same inline findings rendered as markdown, used by
#                        the post step only if GitHub rejects the inline review
#                        (a finding on a line outside the diff 422s the whole
#                        review) so no finding is ever silently dropped
#   - summary-marker.md  the trusted calibration marker, appended by the post
#                        step as the LAST line of the review body
#
# Requires: ai-review/verdict.json (downloaded agent artifact);
# GATE_ESCALATE / GATE_REASON / GATE_MATCH (from the gate step);
# SHADOW_MODE (job env). Optional: RUBRIC_REF (trusted footer text naming the
# rubric, from the central config). Writes verdict/escalation_type to $GITHUB_OUTPUT.
set -euo pipefail

verdict=$(jq -r '.verdict // ""' ai-review/verdict.json)
esc=$(jq -r '.escalation_type // "NONE"' ai-review/verdict.json)
confidence=$(jq -r '.confidence // ""' ai-review/verdict.json)
reason=$(jq -r '.reason // ""' ai-review/verdict.json)
tcov=$(jq -r '.test_coverage // ""' ai-review/verdict.json)
tnote=$(jq -r '.test_coverage_note // ""' ai-review/verdict.json)
findings=$(jq -r '.findings_markdown // ""' ai-review/verdict.json)

escalation_paths=$(jq -r '
  if (.escalation_paths | type) == "array" then
    ([.escalation_paths[] | select(type == "string" and (test("\\S")))]) as $all
    | ($all[0:20][]),
      (if ($all | length) > 20
       then "\u2026(\(($all | length) - 20) more truncated)"
       else empty end)
  else
    empty
  end
' ai-review/verdict.json | paste -sd ';' -)

# Allowlist confidence to a bounded 0-1 value (max 4 decimals); anything else
# (injected text, out-of-range, huge digit string) collapses to "0", which also
# fails the 0.85 floor below so a malformed confidence can never approve.
confidence=$(printf '%s' "$confidence" | tr -d '\r\n')
printf '%s' "$confidence" | grep -Eq '^(0(\.[0-9]{1,4})?|1(\.0{1,4})?)$' || confidence="0"

case "$tcov" in PASS|NEEDS_IMPROVEMENT|MISSING) ;; *) tcov="UNKNOWN";; esac

# Agent free-text is posted verbatim by the privileged job. Insert a zero-width
# space after each @ (breaks GitHub mention parsing, renders invisibly) so
# injected "@org/team" can't fire mass notifications.
zwsp=$(printf '\342\200\213')
reason=${reason//@/@$zwsp}
tnote=${tnote//@/@$zwsp}
findings=${findings//@/@$zwsp}
escalation_paths=${escalation_paths//@/@$zwsp}

# Split "<!--" the same way: the body ends with a trusted machine-readable
# marker (<!-- ai-review verdict=... -->) that a scraper reads, so a counterfeit
# marker in agent text must not survive.
reason=${reason//<!--/<!-$zwsp-}
tnote=${tnote//<!--/<!-$zwsp-}
findings=${findings//<!--/<!-$zwsp-}
escalation_paths=${escalation_paths//<!--/<!-$zwsp-}

[ "${#reason}"   -gt 1000  ] && reason="${reason:0:1000} …(truncated)"
[ "${#tnote}"    -gt 1000  ] && tnote="${tnote:0:1000} …(truncated)"
[ "${#findings}" -gt 20000 ] && findings="${findings:0:20000}"$'\n\n'"…(findings truncated)"
[ "${#escalation_paths}" -gt 1000 ] && escalation_paths="${escalation_paths:0:1000} …(truncated)"

case "$verdict" in AUTO_APPROVE|NEEDS_HUMAN) ;; *) verdict="NEEDS_HUMAN";; esac
case "$esc"     in NONE|POLICY|FINDINGS|BOTH) ;; *) esc="POLICY";;        esac

approve_contradiction_note=""
if [ "$verdict" = "AUTO_APPROVE" ] && [ -n "$escalation_paths" ]; then
  verdict="NEEDS_HUMAN"
  approve_contradiction_note="> ⚠️ Overridden to NEEDS_HUMAN: verdict was AUTO_APPROVE but carried a non-empty escalation path, which is inconsistent — failing closed to human review."
fi

# Rubric confidence floor: an AUTO_APPROVE below 0.85 (or non-numeric) fails
# closed to NEEDS_HUMAN.
conf_note=""
if [ "$verdict" = "AUTO_APPROVE" ]; then
  if printf '%s' "$confidence" | grep -Eq '^[0-9]+(\.[0-9]+)?$' \
     && awk -v c="$confidence" 'BEGIN{exit !(c>=0.85)}'; then
    :
  else
    verdict="NEEDS_HUMAN"
    esc="POLICY"
    conf_note="> ⚠️ Overridden to NEEDS_HUMAN: confidence \`${confidence}\` is below the 0.85 approval threshold (or not a valid number)."
    escalation_paths="${escalation_paths:+${escalation_paths};}confidence below approval threshold"
  fi
fi

# Deterministic gate can only escalate, never approve. It is a POLICY escalation
# (changed-file path rule); a pre-existing FINDINGS objection becomes BOTH.
gate_note=""
if [ "$GATE_ESCALATE" = "true" ]; then
  # GATE_MATCH is an attacker-controlled filename, so @-/<!-- neutralise it;
  # GATE_REASON is a trusted fixed label from the gate script, used raw.
  gmatch=${GATE_MATCH//@/@$zwsp}
  gmatch=${gmatch//<!--/<!-$zwsp-}
  gate_path="gate: ${GATE_REASON} (${gmatch})"
  if [ "$verdict" = "AUTO_APPROVE" ]; then
    gate_note="> ⚠️ Overridden to NEEDS_HUMAN by the deterministic gate: ${GATE_REASON} (\`${gmatch}\`)."
  fi
  verdict="NEEDS_HUMAN"
  case "$esc" in
    FINDINGS|BOTH) esc="BOTH";;
    *)             esc="POLICY";;
  esac
  # the needle is quoted so a glob metachar in the filename compares literally.
  gate_needle=";${gate_path};"
  if [[ ";${escalation_paths};" != *"$gate_needle"* ]]; then
    escalation_paths="${escalation_paths:+${escalation_paths};}${gate_path}"
  fi
fi
[ "$verdict" = "AUTO_APPROVE" ] && esc="NONE"
[ "$verdict" = "AUTO_APPROVE" ] && escalation_paths=""
[ "$verdict" = "NEEDS_HUMAN" ] && [ "$esc" = "NONE" ] && esc="POLICY"
# Agent said FINDINGS but also named a rubric path: the two untrusted fields
# disagree. Promote to BOTH rather than discard — it can only add human signal.
[ "$esc" = "FINDINGS" ] && [ -n "$escalation_paths" ] && esc="BOTH"

# The inline set feeds both review.json and the fallback markdown. Cap at
# INLINE_CAP so a hijacked agent cannot spray unbounded comments, and truncate
# each body/note/reachability to the MAX_* limits so one oversized finding cannot
# exceed GitHub's 65,536-char comment limit and 422 the whole review. Overflow
# past the cap is counted (inline_dropped) and reported in the summary, not lost.
INLINE_CAP=50
MAX_BODY=1500
MAX_NOTE=600  # room for the four Given/When/Actual/Expected bullets
MAX_REACH=300
DROPPED_DUPLICATES_RECAP_CAP=50
IMPACT_CLASSES='["api-contract","persisted-state","outbound-system","in-app-behaviour","ci-pipeline","trust-boundary","other","none","undetermined"]'
jq --argjson maxbody "$MAX_BODY" --argjson maxnote "$MAX_NOTE" \
   --argjson maxreach "$MAX_REACH" --argjson classes "$IMPACT_CLASSES" '
  def scrub($n):
    tostring | gsub("<!--"; "<!-\u200b-")
    | if length > $n then (.[0:$n] + " \u2026(truncated)") else . end;
  def norm:
    ((.side // "RIGHT") | tostring | ascii_upcase) as $s
    | ((.start_side // .side // "RIGHT") | tostring | ascii_upcase) as $ss
    | (.line | floor) as $ln
    | (if (.start_line | type) == "number" then (.start_line | floor) else null end) as $sl
    | ((if (.impact | type) == "array" then .impact
        elif (.impact | type) == "string" then [.impact]
        else [] end)
       | map(. as $c
             | if ($c | type) == "string" and ($classes | index($c | ascii_downcase))
               then ($c | ascii_downcase) else "other" end)
       | unique) as $raw
    # none/undetermined are sentinels that cannot co-exist with an observable
    # class: any observable class wins; else contradictory none+undetermined
    # collapses to undetermined (the weaker "could not establish" claim).
    | ([$raw[] | select(. != "none" and . != "undetermined")]) as $observable
    | (if ($raw | length) == 0 then []
       elif ($observable | length) > 0 then $observable
       elif ($raw | index("undetermined")) then ["undetermined"]
       else ["none"] end) as $imp
    | ((if (.impact_note  | type) == "string" and (.impact_note  | test("\\S")) then .impact_note  else "" end) | scrub($maxnote))  as $note
    | ((if (.reachability | type) == "string" and (.reachability | test("\\S")) then .reachability else "" end) | scrub($maxreach)) as $reach
    | (["high","medium","low"]) as $ratingscale
    | (.likelihood)        as $likeraw
    | (.end_user_severity) as $sevraw
    | (if ($likeraw | type) == "string" and ($ratingscale | index($likeraw | ascii_downcase)) then ($likeraw | ascii_downcase) else "" end) as $like
    | (if ($sevraw | type) == "string" and ($ratingscale | index($sevraw | ascii_downcase)) then ($sevraw | ascii_downcase) else "" end) as $sev
    | ((if (.body | type) == "string" then .body else "" end) | scrub($maxbody)) as $b
    # $needs/$wrench: the leading severity code must be the first substantive
    # token. [^A-Za-z0-9]* skips markdown wrappers (**❌**, > ❌, - ❌) but not
    # prose, so a code buried after text ("see ❌ …") does not qualify.
    | ($b | sub("^\\s+"; "")) as $bt
    | ($bt | test("^[^A-Za-z0-9]*(❓|❌|:question:|:x:)")) as $needs
    | ($bt | test("^[^A-Za-z0-9]*(🔧|:wrench:)")) as $wrench
    | (if ($note != "" and ($note | contains("\n"))) then "\n\n" else "\n" end) as $rbrk
    | { path: (.path | tostring),
        line: $ln,
        body: $b,
        impact_md: (
          ($imp | length) as $nimp
          | (if $needs then
              "\n\n**Impact**: "
              + (if $nimp > 0 then ($imp | map("`" + . + "`") | join(", "))
                 else "_class not supplied_" end)
              + (if $note == "" then "\n**Effect**: _not supplied_"
                 elif ($note | contains("\n")) then "\n" + $note
                 else " \u2014 " + $note end)
              + (if $reach != "" then $rbrk + "**Reachability**: " + $reach
                 else $rbrk + "**Reachability**: _not supplied_" end)
             elif ($wrench and $imp == ["none"]) then
              "\n\n**Impact**: "
              + ($imp | map("`" + . + "`") | join(", "))
              + (if $note == "" then ""
                 elif ($note | contains("\n")) then "\n" + $note
                 else " \u2014 " + $note end)
              + (if $reach != "" then $rbrk + "**Reachability**: " + $reach else "" end)
             else "" end)),
        ratings_md: (
          if ($needs or $wrench) then
            "\n\n**Likelihood**: "
            + (if $like != "" then "`" + $like + "`" else "_not supplied_" end)
            + " \u00b7 **End-user severity**: "
            + (if $sev != "" then "`" + $sev + "`" else "_not supplied_" end)
          else "" end),
        side: (if $s == "LEFT" then "LEFT" else "RIGHT" end),
        start_line: (if ($sl != null and $sl < $ln) then $sl else null end),
        start_side: (if $ss == "LEFT" then "LEFT" else "RIGHT" end) };
  (if (.inline_findings | type) == "array" then .inline_findings else [] end)
  | map(select(type == "object"))
  | map(select((.path | type) == "string" and (.line | type) == "number"))
  | to_entries
  | map((.value | norm) + { dedup_index: .key })
' ai-review/verdict.json > inline-norm.json

# Drop praise-only (👍) findings from the inline set: an automated 👍 is
# weightless noise. Classify by the FIRST severity code so a mis-coded "❌👍"
# binds ❌ and stays. findings_markdown (the summary channel) is deliberately NOT
# filtered — the prompt is its only guard; a leaked summary 👍 is cosmetic, so it
# does not earn a fragile free-text parser.
lead_code='def lead: (.body | capture("^[^A-Za-z0-9]*?(?<c>👍|:\\+1:|❌|:x:|❓|:question:|🔧|:wrench:|💭|🙃)").c) // "";'
praise_sel='(lead == "👍" or lead == ":+1:")'
jq "$lead_code map(select($praise_sel | not))" inline-norm.json > inline-nonpraise.json
jq -r "$lead_code .[] | select($praise_sel) | \"ai-review: dropped praise-only (👍) inline finding at \(.path|@json):\(.line)\"" inline-norm.json
mv inline-nonpraise.json inline-norm.json

# --- LLM FILTER PASS: drop already-raised duplicates -------------------------
# ai-review/dedup.json (from the review job) flags which new findings duplicate
# an inline comment the bot posted in an earlier round. Drop those from the
# inline set, regardless of severity. Dropping a blocker inline never weakens
# the gate: the AUTO_APPROVE/NEEDS_HUMAN verdict is computed from the agent's
# assessment (ai-review/verdict.json) above, independent of the inline set, so
# a re-raised blocker still routes the PR to human review even when its inline
# re-post is collapsed. Each dropped duplicate is recapped in
# dropped-duplicates.md as a link to the original and logged in full for audit.
# dedup.json is fail-open, so a dedup error drops nothing.
#
# `dropped-duplicates.md` is ALWAYS (re)created — empty when there is nothing to
# drop — so the post step can test it unconditionally.
: > dropped-duplicates.md
if [ -f ai-review/dedup.json ]; then
  dedup_dups=$(jq -c '[ (.duplicates // [])[]
    | select(type == "object" and (.path | type == "string") and (.line | type == "number"))
    | { dedup_index: ((.dedup_index // -1) | floor),
        path: (.path | tostring),
        line: (.line | floor),
        side: ((.side // "RIGHT") | tostring | ascii_upcase),
        url: (if (.url | type) == "string" then .url else "" end) }
    | select(.url | test("^https?://[^[:space:]<>]+$")) ]' \
    ai-review/dedup.json 2>/dev/null || echo '[]')
else
  dedup_dups='[]'
fi

n_dups=$(printf '%s' "$dedup_dups" | jq 'length' 2>/dev/null || echo 0)
if [ "$n_dups" -gt 0 ]; then
  # Match on the finding's INDEX (unique per finding, carried through dedup.json)
  # AND {path,line,side} as a location guard — so two distinct findings on the
  # same path:line:side are distinguished (only the flagged one is dropped)
  # instead of dropped together. If the two sides' indexing ever diverged, the
  # guard makes the worst case a missed drop (fail-open), never an over-drop.
  # shellcheck disable=SC2016  # $f/$dups are jq variables, not shell expansions.
  dup_match='(. as $f | (first($dups[]? | select(.dedup_index == $f.dedup_index and .path == $f.path and .line == $f.line and .side == $f.side)) // null))'
  jq --argjson dups "$dedup_dups" \
    "map(. as \$f | ($dup_match) as \$dup | select(\$dup == null))" \
    inline-norm.json > inline-deduped.json
  jq --argjson dups "$dedup_dups" \
    "map(. as \$f | ($dup_match) as \$dup | select(\$dup != null) | . + {dedup_url: \$dup.url})" \
    inline-norm.json > dropped-dups.json
  mv inline-deduped.json inline-norm.json

  n_dropped=$(jq 'length' dropped-dups.json)
  if [ "$n_dropped" -gt 0 ]; then
    echo "ai-review dedup: full content of dropped duplicate(s) follows:"
    jq -r '
      to_entries[]
      | . as $entry
      | ($entry.value.body + $entry.value.ratings_md + $entry.value.impact_md) as $full
      | "ai-review dedup audit [\($entry.key + 1)]: \($entry.value.path|@json):\($entry.value.line)"
        + "\n"
        + ($full | split("\n") | map("ai-review dedup audit: " + .) | join("\n"))
    ' dropped-dups.json

    # Render compact links to the original comments. The full suppressed
    # finding text is in the run log above; the PR summary only needs to point
    # reviewers back to the earlier inline thread and is bounded by count.
    dropped_md=$(jq -r --argjson cap "$DROPPED_DUPLICATES_RECAP_CAP" '
      def esc: gsub("@"; "@\u200b") | gsub("<!--"; "<!-\u200b-");
      def lead: (.body | capture("^[^A-Za-z0-9]*?(?<c>👍|:\\+1:|❌|:x:|❓|:question:|🔧|:wrench:|💭|🙃)").c) // "";
      def lead_emoji:
        (lead) as $c
        | if $c == ":+1:" then "👍"
          elif $c == ":x:" then "❌"
          elif $c == ":question:" then "❓"
          elif $c == ":wrench:" then "🔧"
          else $c end;
      def url: (.dedup_url | esc);
      . as $all
      | ($all[0:$cap]
         | map((lead_emoji) as $e | "- " + (if $e == "" then "" else "\($e) " end) + "[already raised in an earlier round](<\(url)>)")) as $shown
      | (($all | length) - ($shown | length)) as $omitted
      | ($shown + (if $omitted > 0
                   then ["- …and \($omitted) more already-raised finding(s) — see the run logs"]
                   else [] end))
      | join("\n")
    ' dropped-dups.json)
    printf '%s\n' "$dropped_md" > dropped-duplicates.md
    echo "ai-review dedup: dropped ${n_dropped} already-raised duplicate(s) from the inline set."
  fi
fi

inline_total=$(jq 'length' inline-norm.json)
inline_dropped=$(( inline_total > INLINE_CAP ? inline_total - INLINE_CAP : 0 ))

prefix=""
if [ "${SHADOW_MODE}" = "true" ]; then prefix="[SHADOW] "; fi

case "$esc" in
  POLICY)   esc_label="POLICY — a rubric rule requires a human; no quality objection";;
  FINDINGS) esc_label="FINDINGS — the agent objects to the change (would request changes)";;
  BOTH)     esc_label="BOTH — a rubric rule applies AND the agent objects";;
  *)        esc_label="";;
esac

{
  echo "<details>"
  echo "<summary>🤖 AI review - ${prefix}${verdict} — confidence ${confidence} (click to expand)</summary>"
  echo ""
  [ -n "$esc_label" ] && echo "- **Escalation type:** ${esc_label}"
  if [ -n "$escalation_paths" ]; then
    echo "- **Escalation paths:** ${escalation_paths}"
  elif [ "$esc" = "POLICY" ] || [ "$esc" = "BOTH" ]; then
    echo "- **Escalation paths:** _not supplied_"
  fi
  echo "- **Reason:** ${reason}"
  echo "- **Test coverage:** ${tcov} — ${tnote}"
  [ -n "$gate_note" ] && echo "" && echo "$gate_note"
  [ -n "$conf_note" ] && echo "" && echo "$conf_note"
  [ -n "$approve_contradiction_note" ] && echo "" && echo "$approve_contradiction_note"
  echo ""
  echo "### Findings"
  echo ""
  echo "> ℹ️ **How this review is laid out:** line-specific findings are posted as **inline review comments** in the *Files changed* tab where possible; any that could not be attached inline are included in this summary. Findings that are not tied to a single line are listed below."
  echo ""
  if [ -n "$findings" ]; then
    printf '%s\n' "$findings"
  else
    echo "_No findings that are not line-specific._"
  fi
  if [ "$inline_dropped" -gt 0 ]; then
    echo ""
    echo "> ⚠️ ${inline_dropped} additional line-specific finding(s) exceeded the ${INLINE_CAP}-comment cap and were omitted."
  fi
  echo ""
  echo "<sub>Automated review. The agent runs read-only; this verdict is applied by a separate non-AI job, and hard escalation paths are enforced deterministically. ${RUBRIC_REF:-Powered by \`pr-review-agent\`.}</sub>"
  echo ""
  echo "</details>"
} > body.md

# Own file (not appended to body.md) so the post step can emit it as the very
# LAST line of the review body, after any folded-in fallback findings — keeping
# the "body ends with the marker" contract and preventing marker-poisoning.
printf '<!-- ai-review verdict=%s escalation_type=%s confidence=%s shadow=%s -->\n' \
  "$verdict" "$esc" "$confidence" "$SHADOW_MODE" > summary-marker.md

# commit_id anchors comments to the exact reviewed commit (HEAD_SHA); without it
# GitHub uses the PR's latest commit, so a push landing meanwhile could attach
# stale findings to unreviewed code. Omitted only if HEAD_SHA is unset.
# The path is posted verbatim: it must byte-match the diff to anchor, so unlike
# the body it is never @-/<!-- escaped.
jq -n --slurpfile n inline-norm.json --arg head "${HEAD_SHA:-}" --argjson cap "$INLINE_CAP" '
  {
    event: "COMMENT",
    comments: (
      $n[0][0:$cap]
      | map(
          {
            path: .path,
            line: .line,
            side: .side,
            body: (((.body + .ratings_md + .impact_md) | gsub("@"; "@\u200b")) + "\n\n<!-- ai-review-inline -->")
          }
          + (if .start_line != null
             then { start_line: .start_line, start_side: .start_side }
             else {} end)
        )
    )
  }
  + (if $head == "" then {} else { commit_id: $head } end)
' > review.json

# Fallback budget is DERIVED from body.md's size so the summary comment (base +
# folded fallback + marker) stays under GitHub's 65,536-char limit, which would
# otherwise 422 the post and lose everything. Reserve covers the framing the
# post step adds around the findings.
COMMENT_LIMIT=65536
FALLBACK_RESERVE=1500
# The dropped-duplicates recap (compact links, count-capped) is appended AFTER
# the fallback in build_body on the SAME body, so — as on the combined path —
# the fallback budget must leave room for it, or a saturated fallback plus the
# recap can push the body-only retry past COMMENT_LIMIT and 422 the review.
# dropped-duplicates.md is already written above (empty when nothing was
# de-duplicated), so subtract its actual size.
FALLBACK_BUDGET=$(( COMMENT_LIMIT - $(wc -c < body.md) - $(wc -c < dropped-duplicates.md) - FALLBACK_RESERVE ))
[ "$FALLBACK_BUDGET" -lt 0 ] && FALLBACK_BUDGET=0
jq -r --argjson cap "$INLINE_CAP" --argjson budget "$FALLBACK_BUDGET" '
  def esc: gsub("@"; "@\u200b") | gsub("<!--"; "<!-\u200b-");
  [ .[0:$cap][]
    | (if .start_line != null then "\(.start_line)-\(.line)" else "\(.line)" end) as $loc
    | ((.body + (.ratings_md | gsub("\n"; " ")) + (.impact_md | gsub("\n"; " "))) | esc) as $txt
    | "- `\(.path | esc):\($loc)` - \($txt)"
  ]
  | reduce .[] as $l ({out: [], used: 0, omitted: 0};
      if .omitted == 0 and (.used + ($l | length) + 1) <= $budget
      then {out: (.out + [$l]), used: (.used + ($l | length) + 1), omitted: 0}
      else {out: .out, used: .used, omitted: (.omitted + 1)} end)
  | (.out | join("\n"))
    + (if .omitted > 0
       then "\n- _(\(.omitted) further finding(s) omitted from this summary to stay within the comment size limit.)_"
       else "" end)
' inline-norm.json > inline-fallback.md

echo "verdict=$verdict" >> "$GITHUB_OUTPUT"
echo "escalation_type=$esc" >> "$GITHUB_OUTPUT"
