# pr-review-agent

A reusable GitHub Actions workflow for AI pull-request review.

A Claude agent reviews each PR with read-only access and writes a verdict
(`AUTO_APPROVE` / `NEEDS_HUMAN`) along with findings. A separate job with no AI then
applies team-defined escalation rules and posts the review as inline comments plus a
summary. When the team enables live mode, that job can also approve the PR.

## Quick start

1. Add a team config to your repo: `.github/pr-review-agent/<name>.yml`. Start from
   [`examples/config/my-team.yml`](examples/config/my-team.yml); all keys are in the
   [configuration reference](docs/configuration.md).
2. Add the caller workflow to your repo:

   ```yaml
   # .github/workflows/ai-pr-review.yml
   on:
     pull_request:
       types: [opened, synchronize, reopened, ready_for_review, labeled]
   concurrency:
     # Other labels get their own group, so they never cancel a running review.
     group: >-
       ${{ github.event.action == 'labeled' && github.event.label.name != 'ai-review'
           && format('ai-pr-review-ignored-{0}', github.run_id)
           || format('ai-pr-review-{0}-{1}', github.workflow, github.event.pull_request.number) }}
     cancel-in-progress: true
   permissions: {}
   jobs:
     review:
       if: github.event.action != 'labeled' || github.event.label.name == 'ai-review'
       permissions: { contents: read, pull-requests: write, checks: read, statuses: read, id-token: write }
       uses: camunda/pr-review-agent/.github/workflows/pr-review.yml@<commit-sha> # vX.Y.Z
       with:
         config: <name>
         vault_auth_method: jwt
       secrets:
         VAULT_ADDR: ${{ secrets.VAULT_ADDR }}
         VAULT_JWT_PATH: ${{ secrets.VAULT_JWT_PATH }}
         VAULT_JWT_ROLE: ${{ secrets.VAULT_JWT_ROLE }}
         VAULT_JWT_AUDIENCE: ${{ secrets.VAULT_JWT_AUDIENCE }}
   ```

   The full example is in [`examples/caller-workflow.yml`](examples/caller-workflow.yml).
   For a repository shared by several teams, see
   [`examples/monorepo-caller.yml`](examples/monorepo-caller.yml).
3. Merge. Reviews start once the config is on the default branch.

## Repository layout

| Path | Contents |
| --- | --- |
| `.github/workflows/pr-review.yml` | The reusable workflow (`workflow_call`) |
| `scripts/` | Bash scripts the workflow runs, plus tests in `scripts/__tests__/` |
| `prompts/review-prompt.md` | The agent prompt (generic, with placeholders for each repo) |
| `prompts/rubric-default.md` | Default rubric for teams without their own |
| `docs/` | [Configuration](docs/configuration.md), [security model](docs/security-model.md) |
| `examples/` | Caller workflows and a team config |

### Scripts

| Script | Job | Purpose |
| --- | --- | --- |
| `load-config.sh` | config | Reads `.github/pr-review-agent/<name>.yml` from the calling repo's default branch, validates it, and applies defaults and built-in escalation rules |
| `should-review.sh` | config | Trigger filter: drafts, forks, skipped authors, label events |
| `vault-wrap-key.sh` | config | AppRole only: wraps the Anthropic key in a single-use Vault token for the review job. JWT uses the shared `vault-wrapped-secrets/wrap` action, and the review job unwraps with `vault-wrapped-secrets/unwrap` |
| `load-policy.sh` | review | Copies the rubric and skills into `.policy/` from this repo or the PR base commit (default branch if missing there) |
| `render-prompt.sh` | review | Fills in the prompt placeholders |
| `ai-review-dedup-findings.sh` | review | LLM pass that drops findings already raised in earlier rounds (fail-open) |
| `ai-review-mask-session.sh` | review | Removes secrets from the agent transcript, verdict and dedup files before upload |
| `gate.sh` | decide | Deterministic escalation from the changed-file list |
| `ai-review-compute-verdict.sh` | decide | Combines the agent verdict, gate result and confidence floor, and builds the review payloads |
| `ai-review-post-summary.sh` | decide | Posts a single COMMENT review (summary + inline comments, with a 422 fallback) |
| `ai-review-approve.sh` / `ai-review-post-inline.sh` | decide | Live-mode approval after required checks pass |

## Development

```bash
npm test     # node --test; needs bash, jq, yq (v4), perl, git
npm run lint # shellcheck + actionlint
```

## Releasing

Releases are automated with [release-please](https://github.com/googleapis/release-please).
The conventions for commits, PR titles and breaking changes are in [`AGENTS.md`](AGENTS.md).

1. PRs are squash-merged. The PR title must be a Conventional Commit: `fix:` → patch,
   `feat:` → minor, `!` → major. `refactor`, `docs`, `test`, `ci` and `chore` do not
   create a release.
2. After each merge to `main`, release-please updates one open release PR with the next
   version and the `CHANGELOG.md` entry.
3. A maintainer merges the release PR when a release is wanted. release-please then creates
   the tag `vX.Y.Z` and a GitHub release. A major release has a **⚠ BREAKING CHANGES**
   section with the migration notes from the PR descriptions.

`main` only accepts squash-merged PRs, and these checks are required: `Script tests`,
`Lint`, `Conventional PR title` and `Breaking change marked consistently`. Releases are
immutable: once published, a release and its tag cannot change.

### How to publish a release

1. Open the release PR. It is the open PR titled `chore(main): release X.Y.Z`
   ([search](https://github.com/camunda/pr-review-agent/pulls?q=is%3Apr+is%3Aopen+%22chore%28main%29%3A+release%22)).
   release-please creates and updates it; you never open it yourself.
2. Read the version and the `CHANGELOG.md` diff. For a major version, check that the
   **⚠ BREAKING CHANGES** section tells callers what to change. If a PR was merged with
   the wrong type (for example `feat:` instead of `feat!:`), edit the description of that
   merged PR and add a `BEGIN_COMMIT_OVERRIDE` … `END_COMMIT_OVERRIDE` block with the
   corrected commit message. release-please uses it on its next run (see
   [How can I fix release notes?](https://github.com/googleapis/release-please#how-can-i-fix-release-notes)).
   Do not edit the release PR itself.
3. Click **Approve workflows to run** on the release PR. GitHub does not start CI on its
   own for PRs opened by `GITHUB_TOKEN`. Wait until the required checks pass.
4. Squash-merge the release PR. release-please creates the tag and the GitHub release a
   few seconds later (see the `release-please` workflow run on `main`).
5. Check the [release page](https://github.com/camunda/pr-review-agent/releases). Callers
   get a Renovate PR for the new version.

There is no floating major tag. Callers pin the commit SHA of a release tag and keep the
version as a comment, so Renovate can tell major, minor and patch updates apart:

```yaml
uses: camunda/pr-review-agent/.github/workflows/pr-review.yml@<commit-sha> # vX.Y.Z
```

We recommend [`infra-renovate-config`](https://github.com/camunda/infra-renovate-config) for
callers. It does not auto-merge major updates.
