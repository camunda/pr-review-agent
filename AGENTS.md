# Conventions for contributors and agents

This repository ships a reusable workflow that other repositories pin by commit SHA.
Every change on `main` becomes part of a semver release. These rules make sure that a
breaking change is never released as a minor or patch update.

## Commands

```bash
npm test     # node --test; needs bash, jq, yq (v4), perl, git
npm run lint # shellcheck + actionlint
```

## Commits and PR titles

PRs are squash-merged. The PR title becomes the commit subject, and the PR description
becomes the commit body. release-please reads that commit to pick the next version.

Write the PR title (and every commit subject) as a
[Conventional Commit](https://www.conventionalcommits.org/): `<type>[(scope)][!]: <summary>`.

| Type | Use it when | Release |
| --- | --- | --- |
| `fix` | A behaviour correction: workflow, scripts, prompt or default rubric | patch |
| `feat` | A new input, output, config key or behaviour that callers can use | minor |
| `deps` | A dependency update in `.github/workflows/pr-review.yml` | patch |
| `refactor` | Code changes with no change in behaviour | none |
| `docs` | Documentation only | none |
| `test` | Tests only | none |
| `ci` | This repository's own CI or release workflows | none |
| `chore` | Anything else that callers do not see | none |

Changes to `prompts/` and `scripts/` reach callers. Use `fix` or `feat` for them,
not `chore`, unless the behaviour does not change.

## Breaking changes

A change is breaking (`!` in the title, major release) when a caller must change its
workflow YAML or its team config, or when an existing output changes meaning. Examples:

- Remove or rename a `workflow_call` input, secret or output.
- Add a required input or secret.
- Change an input default or a config default so that existing callers behave differently.
- Remove or rename a team config key. Unknown keys fail `scripts/load-config.sh`, so a
  caller's existing config stops working.
- Change the values or meaning of `verdict`, `escalation_type`, `selected` or `reviewed`.

For a breaking change:

1. Add `!` to the title, for example `feat!: rename the config input to team`.
2. Show the caller YAML before and after in the PR description.
3. End the PR description with one paragraph that starts with `BREAKING CHANGE:` and
   tells callers what to change. Keep it as prose, and do not start a line in it with
   `word:`. release-please copies this paragraph into the release notes.
4. Nothing may follow that paragraph. Put any attribution line (for example
   "Generated with …") above it, or release-please ignores the footer.

The "Breaking change marked consistently" check fails when the title has `!` but no
footer, when a footer exists but the title has no `!`, or when the footer is not the
last paragraph.

When you are not sure whether a change is breaking, treat it as breaking.

The same check also compares the caller contract with the PR base. It reads the
`workflow_call` inputs, secrets and outputs, the job permissions, and the team config
fixtures. A breaking difference without `!` in the title fails the check. A new config
key must also go into `scripts/__tests__/fixtures/contract/full.yml`.

Tightening the validation of an existing config key is breaking, for example a higher
minimum or a shorter maximum length. The check reads the fixtures from the PR base, so
a fixture that you add in the same PR does not count. If no fixture holds the old
boundary value yet, use two PRs:

1. Add the old boundary value to a contract fixture (`edge.yml` holds them). Merge this
   PR first. It is not breaking.
2. Tighten the rule with `!` in the title. In the same PR, change the fixture to a value
   that the new rule accepts, or the fixture tests fail. The check still uses the base
   fixture and reports the break.

The check does not cover the workflow's runtime checks on inputs, for example the
Vault secret pairs in `pr-review.yml`. Review those changes by hand.

## Dependency updates

Renovate (`.github/renovate.json5`) updates the pinned actions every weekend.

| Update | PR title | Merge |
| --- | --- | --- |
| Action in `pr-review.yml` | `deps: …` (patch release) | see below |
| Action in the other workflows | `ci(deps): …` (no release) | see below |
| Minor or patch | | Renovate merges after the required checks pass |
| Major | | `@camunda/ple` reviews and merges |
| Digest only (tag moved, no release) | | a person reviews and merges |

A major update is not a breaking change by default. It is breaking only when callers must
change their workflow YAML, for example because the action needs a new permission or a
newer runner. Only then change the title to `deps!: …` and add the `BREAKING CHANGE:`
paragraph described above.

## Releases

- release-please keeps one release PR open (`chore(main): release X.Y.Z`). A maintainer
  approves its CI runs and merges it to publish the tag `vX.Y.Z` and the GitHub release.
  The steps are in "How to publish a release" in `README.md`.
- Do not create, move or delete tags by hand. There is no floating `v1` tag.
- Do not edit `CHANGELOG.md` or `.release-please-manifest.json` by hand.
  release-please owns them.
- Do not merge the release PR unless a maintainer asks you to.

## Pinning

- Pin every action in this repository to a full commit SHA with the full version as a
  comment: `uses: owner/action@<40-char sha> # v1.2.3`.
- Docs and examples tell callers to pin this workflow the same way:
  `camunda/pr-review-agent/.github/workflows/pr-review.yml@<sha> # vX.Y.Z`.
