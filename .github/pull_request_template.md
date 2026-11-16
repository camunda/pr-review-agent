## What and why

<!-- What changes for callers, and why. -->

## Checklist

- [ ] The title follows the commit conventions in `AGENTS.md` (`fix:`, `feat:`, `feat!:` …).
- [ ] `npm test` and `npm run lint` pass.
- [ ] If a caller must change its workflow YAML or its team config, the title has `!`
      and the last paragraph is the breaking-change footer (see below).

<!--
The squash commit uses this description as its body, and release-please reads it.

Breaking change: put caller YAML before/after above this comment, then end the
description with ONE paragraph that starts with the footer token. Example paragraph
(the token is quoted here on purpose, so this comment never counts as a footer):
"BREAKING CHANGE: the `foo` input is renamed to `bar`. Callers replace `foo:` with `bar:`."

Keep that paragraph as prose. Do not start a line in it with `word:`, because the
parser can read such a line as a new footer.
-->
