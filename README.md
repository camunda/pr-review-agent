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
     group: ai-pr-review-${{ github.workflow }}-${{ github.event.pull_request.number }}
     cancel-in-progress: true
   permissions: {}
   jobs:
     review:
       permissions: { contents: read, pull-requests: write, checks: read, statuses: read }
       uses: camunda/pr-review-agent/.github/workflows/pr-review.yml@v1
       with:
         config: <name>
       secrets:
         VAULT_ADDR: ${{ secrets.VAULT_ADDR }}
         VAULT_ROLE_ID: ${{ secrets.VAULT_ROLE_ID }}
         VAULT_SECRET_ID: ${{ secrets.VAULT_SECRET_ID }}
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
| `load-policy.sh` | review | Copies the rubric and skills into `.policy/` from this repo or the PR base commit |
| `render-prompt.sh` | review | Fills in the prompt placeholders |
| `ai-review-dedup-findings.sh` | review | LLM pass that drops findings already raised in earlier rounds (fail-open) |
| `ai-review-mask-session.sh` | review | Removes secrets from the agent transcript before upload |
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

Callers pin a tag. After merging to `main`, create `vX.Y.Z` and move the major tag:

```bash
git tag vX.Y.Z && git tag -f v1 && git push origin vX.Y.Z && git push -f origin v1
```

Config changes reach callers on `@v1` only after `v1` is moved.
