#!/usr/bin/env bash
# Posts the AI review outcome as a real pull-request REVIEW (event=COMMENT) that
# carries BOTH the collapsed summary (as the review body) AND the line-anchored
# findings (as inline review comments) in a single review. Posting them as one
# review means the summary and its inline comments can be hidden together, the
# review is counted as a review, and — because a submitted review cannot be
# deleted via the API — the AI-review history is preserved on the PR without any
# explicit "keep" logic. event=COMMENT never approves or requests changes, so the
# shadow-mode no-approval guarantee is untouched (approval is a separate step).
#
# GitHub rejects (422) a review if ANY inline comment targets a line outside the
# diff, and it does so atomically — one bad line would take the summary down too.
# To guarantee the summary always lands, a rejected combined review is retried as
# a body-only review with the findings folded into the body (see build_body).
#
# Expects: PR, GITHUB_REPOSITORY, SHADOW_MODE, VERDICT env vars, plus body.md,
# summary-marker.md, review.json and inline-fallback.md in the working directory
# (all produced by ai-review-compute-verdict.sh). AI_REVIEW_LABEL_PRESENT
# ("true"/"false") is optional; when not "true" a tip about the opt-in label
# (OPT_IN_LABEL, default `ai-review`) is appended so authors who did not request one learn they can — and
# that it works on a draft to pre-review it before requesting human review.
set -euo pipefail

# Label names come from the central config (trusted); defaults match the
# original behaviour. An empty NEEDS_HUMAN_LABEL disables labelling.
opt_in_label="${OPT_IN_LABEL:-ai-review}"
needs_human_label="${NEEDS_HUMAN_LABEL-review/needs-human}"

# Assemble the review body into body-final.md, with the trusted calibration
# marker as the LAST line (rubric contract: nothing agent-authored may follow
# it). $1 = "true" to fold the line-anchored findings into the body — used only
# on the body-only retry, when they could not be posted as inline comments.
build_body() {
  cp body.md body-final.md

  if [ "$1" = "true" ] && [ -s inline-fallback.md ]; then
    {
      echo ""
      echo "---"
      echo ""
      echo "<details>"
      echo "<summary>⚠️ Some finding(s) that couldn't be posted inline (click to expand)</summary>"
      echo ""
      echo "> These line-specific findings could not be posted as inline comments (a line outside the diff), so they are listed here instead:"
      echo ""
      cat inline-fallback.md
      echo ""
      echo "</details>"
    } >> body-final.md
  fi

  # LLM FILTER PASS (dedup): findings the bot already raised inline in an earlier
  # round were dropped from the inline set by compute-verdict, so they are not
  # re-posted as fresh threads. Collapse them here into a summary section with
  # compact links to the original threads. Full suppressed content is written to
  # the workflow logs by compute-verdict. dropped-duplicates.md is
  # pre-escaped and count-bounded by compute-verdict; it is absent/empty when
  # nothing was de-duplicated.
  if [ -s dropped-duplicates.md ]; then
    {
      echo ""
      echo "---"
      echo ""
      echo "<details>"
      echo "<summary>♻️ Finding(s) already raised in an earlier review round (click to expand)</summary>"
      echo ""
      echo "> These findings duplicate comments already posted on this PR, so they were not re-posted inline. The emoji is **this round's** severity; the linked earlier comment may have been raised at a different one (the bot matches on the underlying problem, not severity). Full suppressed content is in this run's logs:"
      echo ""
      cat dropped-duplicates.md
      echo ""
      echo "</details>"
    } >> body-final.md
  fi

  # Tip for authors who did NOT request a review via the label. Placed before the
  # calibration marker so the trusted marker still ends the body. Shown only when
  # the `ai-review` label is absent (present => they already know).
  if [ "${AI_REVIEW_LABEL_PRESENT:-false}" != "true" ]; then
    {
      echo ""
      echo "---"
      echo ""
      echo "<details>"
      echo "<summary>ℹ️ Tip: request an AI review yourself with the \`${opt_in_label}\` label</summary>"
      echo ""
      echo "> [!TIP]"
      echo "> You can request this AI review yourself with the \`${opt_in_label}\` label. It is especially useful on a **draft** PR — the bot reviews it (and re-reviews on every push) so you can address its findings **before** marking the PR ready and requesting human review."
      echo ""
      echo "</details>"
    } >> body-final.md
  fi

  cat summary-marker.md >> body-final.md
}

reviews_url="repos/${GITHUB_REPOSITORY}/pulls/${PR}/reviews"
n_inline=$(jq '.comments | length' review.json 2>/dev/null || echo 0)

# Attempt 1: one review carrying the summary body AND the inline comments.
# review.json already holds {event, comments[], commit_id?}; add the body.
# When there are no findings, drop the empty comments[] entirely so the payload
# is exactly what the old inline path sent (a review with no comments key), not
# an untested `comments: []` shape.
build_body false
jq --rawfile body body-final.md \
  '(if (.comments | length) == 0 then del(.comments) else . end) + {body: $body}' \
  review.json > review-post.json

if gh api "$reviews_url" --input review-post.json >review-out.txt 2>review-err.txt; then
  echo "Posted AI review $(jq -r '.html_url // .id // "?"' review-out.txt) (summary + ${n_inline} inline finding(s))."
elif [ "$n_inline" -gt 0 ] && grep -q 'HTTP 422' review-err.txt; then
  # A review carrying inline comments was rejected with HTTP 422. GitHub applies
  # a review atomically, so it created NOTHING — safe to retry. The usual cause
  # is an inline comment on a line outside the diff; retry body-only with the
  # findings folded into the body so the summary still lands.
  #
  # The retry KEEPS commit_id (the sha the agent reviewed) so GitHub anchors the
  # review to the exact commit that was reviewed — never to a newer, unreviewed
  # head. If an ordinary push landed mid-run, that commit is still an ancestor of
  # the new head, so GitHub accepts the review and just marks it "outdated" — the
  # correct attribution (the verdict is for the code the agent saw). Only if the
  # reviewed commit was force-pushed OUT of the PR does GitHub reject the fallback
  # (422); then we fail loudly rather than guess, and a fresh review runs on the
  # new head.
  echo "Combined review rejected with HTTP 422 (likely an inline comment on a line outside the diff); retrying body-only. Details:"
  # gh prints "… (HTTP 422)" to stderr but the errors[] array naming the rejected
  # path/line to stdout, so surface both to make the fallback log say which
  # finding was off-diff.
  cat review-err.txt review-out.txt || true

  build_body true
  jq --rawfile body body-final.md \
    '{event: .event, body: $body} + (if .commit_id then {commit_id: .commit_id} else {} end)' \
    review.json > review-fallback.json
  if gh api "$reviews_url" --input review-fallback.json >fallback-out.txt 2>fallback-err.txt; then
    echo "Posted AI review summary $(jq -r '.html_url // .id // "?"' fallback-out.txt) (findings folded into the body)."
  else
    echo "Body-only fallback also failed; not retrying to avoid a duplicate review. Error:" >&2
    cat fallback-err.txt fallback-out.txt >&2 || true
    echo "Most likely the reviewed commit was force-pushed out of the PR (a stale-commit 422), in which case a fresh review already runs on the new head; other causes (a 5xx, a rate limit, or an oversized body) would need a re-run." >&2
    exit 1
  fi
else
  # Any OTHER failure — a transient 5xx, a network/read timeout, rate limiting,
  # or an auth error — is NOT safe to blind-retry: the review may actually have
  # landed server-side despite gh's non-zero exit, so a body-only retry would
  # post a SECOND, duplicate review. (A body-only run with n_inline == 0 also
  # has no inline comments to drop, so the fallback would gain nothing.) Fail
  # loudly instead — the step is visible and can be re-run — rather than
  # silently duplicating the review.
  echo "Failed to post AI review; the error is not a retriable inline-line 422, so not retrying to avoid a duplicate review. Details:" >&2
  # gh writes the status line to stderr and the errors[] payload to stdout;
  # surface both so the actionable API cause is not lost.
  cat review-err.txt review-out.txt >&2 || true
  exit 1
fi

if [ "${SHADOW_MODE}" != "true" ] && [ "${VERDICT}" = "NEEDS_HUMAN" ]; then
  if [ -n "$needs_human_label" ]; then
    gh pr edit "$PR" --add-label "$needs_human_label" || true
  fi
fi
