#!/usr/bin/env bash
# CI check (not part of the review workflow): a PR marks a breaking change
# consistently, so that release-please picks the right version from the squash
# commit (PR title = subject, PR description = body).
#
#   - A title with "!" (feat!: …, fix(scope)!: …) needs a BREAKING CHANGE footer.
#   - A BREAKING CHANGE footer needs "!" in the title.
#   - The footer must be in the last paragraph of the description; the
#     Conventional Commits parser ignores it anywhere else.
#
# A footer is a line that starts with "BREAKING CHANGE: " or "BREAKING-CHANGE: ".
# Env: PR_TITLE, PR_BODY. Exit 1 with ::error:: annotations on a violation.
set -euo pipefail

title=${PR_TITLE:-}
body=$(printf '%s' "${PR_BODY:-}" | tr -d '\r')

bang_re='^[a-z]+(\([^)]*\))?!: '
footer_re='^BREAKING[ -]CHANGE: [^[:space:]]'

title_breaking=false
[[ $title =~ $bang_re ]] && title_breaking=true

n=0 footer_line=0 para_start=1 saw_blank=false
while IFS= read -r line || [[ -n $line ]]; do
  n=$((n + 1))
  if [[ -z ${line//[[:space:]]/} ]]; then
    saw_blank=true
    continue
  fi
  if $saw_blank; then para_start=$n; saw_blank=false; fi
  if [[ $line =~ $footer_re ]]; then footer_line=$n; fi
done <<< "$body"

fail=false
err() { echo "::error title=Breaking change::$1"; fail=true; }

if $title_breaking && [[ $footer_line -eq 0 ]]; then
  err "The title marks a breaking change (!), but the description has no 'BREAKING CHANGE:' paragraph. Add one as the last paragraph and tell callers what to change (see AGENTS.md)."
fi
if ! $title_breaking && [[ $footer_line -gt 0 ]]; then
  err "The description has a 'BREAKING CHANGE:' paragraph, but the title has no '!'. Add '!' before the colon in the title (for example 'feat!: …'), or remove the paragraph."
fi
if [[ $footer_line -gt 0 && $footer_line -lt $para_start ]]; then
  err "The 'BREAKING CHANGE:' paragraph must be the last paragraph of the description, or release-please ignores it. Move any text after it (for example an attribution line) above it."
fi

$fail && exit 1
if $title_breaking; then
  echo "Breaking change marked consistently."
else
  echo "Not a breaking change."
fi
