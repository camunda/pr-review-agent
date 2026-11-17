# Configuration

Each team that uses pr-review-agent keeps **one config file in its own repository**:
`.github/pr-review-agent/<name>.yml`. The caller workflow names it:

```yaml
uses: camunda/pr-review-agent/.github/workflows/pr-review.yml@v1
with:
  config: <name>
```

## Where things live, and why

| What | Where | Who can change it |
| --- | --- | --- |
| Workflow, scripts, review prompt | this repo (`.github/workflows/`, `scripts/`, `prompts/`) | pr-review-agent maintainers |
| Team config (escalation paths, labels, Vault path, skills list…) | the team's repo, `.github/pr-review-agent/<name>.yml` | the team; read from the **default branch** |
| Team rubric (optional) | the team's repo (`from: repo`), or the default rubric here | the team; read from the PR **base** commit |
| Review skills (repo conventions) | usually the team's repo, e.g. `.agents/skills/<x>/SKILL.md` | the team; read from the PR **base** commit |

The config decides how a PR is judged, so a PR must not be able to loosen the rules
that apply to itself. The workflow therefore reads the config from the calling
repository's **default branch**, never from the PR. A PR that edits the config is
reviewed with the current version, and it always escalates to a human (built-in rule).
The workflow, scripts and prompt come from this repo at the exact commit of the reusable
workflow you pinned.

Several teams can share one repository: each team adds its own config file and its own
caller workflow, limited with `on.pull_request.paths` to the code the team owns, and owns
both files in CODEOWNERS. See [`examples/monorepo-caller.yml`](../examples/monorepo-caller.yml).

Files the team keeps in its own repo (`from: repo`) are read from the PR's **base**
commit. A PR that edits them is reviewed with the old version. These files are also
added to the escalation rules automatically, so such a PR always needs a human.

## Onboarding a repository

1. Add `.github/pr-review-agent/<name>.yml` to your repo. Start from
   [`examples/config/my-team.yml`](../examples/config/my-team.yml); all keys are in the
   reference below.
2. Optional: add a rubric to your repo (copy `prompts/rubric-default.md`) and point
   `policy.rubric` at it with `from: repo`.
3. Add the caller workflow: [`examples/caller-workflow.yml`](../examples/caller-workflow.yml),
   or [`examples/monorepo-caller.yml`](../examples/monorepo-caller.yml) when several
   teams share the repository. Both can go in the same PR.
4. Merge. Reviews start once the config is on the default branch. Until then, the run
   skips the review with a notice. An invalid config fails the `Resolve config` job
   with one error per problem.
5. Start with `shadow_mode: true`. The bot only comments and never approves. Set it to
   `false` after you have calibrated the rubric and
   [filed the InfoSec exception](./security-model.md#before-enabling-live-mode).

## Reference

```yaml
schema_version: 1                      # required, must be 1

# Default true. true: post a COMMENT review, never approve.
# The caller can force shadow mode with `force_shadow_mode: true`. It cannot turn shadow mode off.
shadow_mode: true

vault:
  anthropic_api_key:                   # required
    path: secret/data/products/<team>/ci/common
    field: ANTHROPIC_API_KEY           # default ANTHROPIC_API_KEY

agent:
  model: ""                            # optional; passed as `--model` to Claude Code
  dedup_model: claude-sonnet-5         # model for the duplicate-finding filter
  allowed_bots: []                     # bot logins allowed to trigger a review (never "*")
  timeout_minutes: 15                  # 5-60, review job timeout

triggers:
  opt_in_label: ai-review              # requests a review (also on drafts)
  review_drafts: false                 # true: review drafts without the label
  skip_authors:                        # PR authors that are never reviewed
    - renovate[bot]
    - dependabot[bot]
  max_auto_reviews: 0                  # whole number >= 1 caps automatic reviews per PR; 0 or unset = no limit

labels:
  needs_human: ""                      # label added on NEEDS_HUMAN in live mode; "" = none

policy:
  # The rubric the agent applies. Default: prompts/rubric-default.md.
  rubric:
    from: repo                         # repo = your repo at PR base; agent = this repo
    path: .github/pr-review-agent/<name>-rubric.md
  # Review skills: your repo's review conventions. Applied in order.
  skills:
    - from: repo                       # default for skills
      path: .agents/skills/<x>/SKILL.md
  # Free text appended to the prompt, e.g. where tests live in your repo.
  instructions: |
    - Java tests live under src/test/ in the same Maven module.

escalation:
  # Changed paths that ALWAYS need a human. Checked without the LLM, after the
  # agent, so a wrong or manipulated verdict cannot auto-approve them.
  rules:
    - reason: db migration             # shown in the review, 1-60 plain characters
      paths: ["db/*", "*/migrations/*"]

notifications:
  # Tagged when the agent's session transcript was not captured.
  capture_alert_mentions: ["@my-user", "@camunda/my-team"]
```

### Capping automatic reviews

A review runs on every push, so a coding agent that fixes each finding and pushes again
can keep a PR in a review and fix loop. Set `triggers.max_auto_reviews` to stop that.
Once a PR has that many agent reviews, further automatic runs are skipped and the PR
gets one comment saying why and how to request a review by hand.

- The count is every earlier agent review on the PR, whether it ran automatically or was
  requested with the label. It is read from the `<!-- ai-review verdict=... -->` marker
  on reviews posted by `github-actions[bot]`.
- Remove (if present) and re-add `triggers.opt_in_label` to request a review past the cap.
  A `labeled` event for that label is never capped.
- Re-running a workflow from the Actions tab is never capped either.
- The comment is posted once per PR, not on every later push.
- If GitHub's review list cannot be read, the cap is not enforced for that run and the
  review goes ahead.
- Unset or `0` means no limit. A negative number, a fraction or a non-number fails
  config validation.

Known limitations:

- **The count is per PR, across all teams and configs.** The marker does not say which
  config posted a review. When a PR touches several teams' code, each team's review
  counts toward every team's cap, so with two teams a cap of 5 is reached after about 3
  pushes. Size the cap with the number of teams on the PR in mind.
- **A push during a manual review past the cap can cancel that review without a new
  notice.** The example workflows cancel an in-progress run when a new push arrives. If
  someone re-adds the label after the cap is reached and a push lands while that review
  is still running, the push cancels it, the new run is skipped by the cap, and no new
  notice is posted because the PR already has one. Wait for the manual review to finish
  before pushing.

### Escalation path syntax

Patterns use bash glob matching against the repo-relative path of every changed file:

- `*` matches any characters, **including `/`**, so `restapi/db/*` covers every file
  under `restapi/db/`.
- `*/auth/*` matches an `auth` directory at any depth except the repo root. Add
  `auth/*` as well if you need the root.
- `?` and `[abc]` work as usual. Brace expansion (`{a,b}`) is **not** supported. List
  each pattern separately.
- Rules are checked in order and the first match wins (its `reason` is shown).

Every team also gets these **built-in rules**, checked before team rules. They cannot
be removed:

| Reason | Paths | Why |
| --- | --- | --- |
| `reviewer workflow` | `.github/workflows/*` | The caller workflow chooses which config and which agent version run. A PR that changes it must not be approved by the run it just changed. |
| `review policy change` | every `policy.*` path with `from: repo` | A PR must not rewrite the skills it is reviewed against and get approved in the same change. |

### Review skills

A skill is a Markdown file that explains your repository's review conventions:
architecture rules, coding standards, security checks and accessibility. The agent reads
every skill you list. Severity codes (❌ ❓ 🔧 💭 🙃) are defined by the prompt, not by
skills, because the workflow parses them.

- **Keep skills in your repo** (`from: repo`) when the same file serves human
  reviewers and other agents (for example `.agents/skills/<x>/SKILL.md`). Changes go
  through your normal PR flow. The bot always uses the version from the base commit.
- `from: agent` only refers to files shipped with pr-review-agent, such as
  `prompts/rubric-default.md`. Team-specific files belong in the team's repo.
- Point at the **real file, not a symlink**. `git show <rev>:<path>` does not follow a
  symlinked directory. For example, use `.agents/skills/x/SKILL.md`, not a
  `.claude/skills/x` symlink.
- A missing skill causes a warning, and the review continues without it. This keeps the
  PR that introduces the skill from being blocked. A missing rubric fails the review.

## Caller workflow inputs

| Input | Default | Purpose |
| --- | --- | --- |
| `config` | (required) | Config name, i.e. `.github/pr-review-agent/<config>.yml` in the calling repo. |
| `force_shadow_mode` | `false` | Force comment-only mode. It can never disable shadow mode. |
| `runs_on` | `ubuntu-slim` | Runner label. The runner needs `jq`, `yq` (v4), `perl`, `gh`, `git`, `curl` and `openssl`. On a public repository the review job always runs on `ubuntu-latest` (needed for the egress firewall). |
| `egress_policy` | `block` | Public repositories only: `block` limits the review job to an allowlist of hosts, `audit` only logs. Use `audit` to find a missing host, then go back to `block`. See [security model](security-model.md). |
| `agent_repo_token_vault_secret` | `""` | `"<vault path> <field>"` for a token that can read this repo. Use it when the caller's `GITHUB_TOKEN` cannot check out pr-review-agent (the usual case for an internal repo). Only the `config` job imports it; the agent job never sees it. Prefer a token scoped to `contents: read` on pr-review-agent. |
| `vault_auth_method` | `approle` | How the `config` job logs in to Vault: `jwt` (GitHub OIDC, recommended) or `approle`. Infrastructure is replacing AppRole with JWT (camunda/team-infrastructure#1076). |

Secrets: `VAULT_ADDR`, plus the secrets of the chosen method. Infrastructure sets both
sets on repositories that are onboarded to Vault.

| `vault_auth_method` | Secrets |
| --- | --- |
| `jwt` | `VAULT_JWT_PATH`, `VAULT_JWT_ROLE`, `VAULT_JWT_AUDIENCE` |
| `approle` | `VAULT_ROLE_ID`, `VAULT_SECRET_ID` |

The Vault role must be able to read `vault.anthropic_api_key.path`, and its token must
have Vault's `default` policy, which allows response wrapping. Only the `config` job
logs in. It hands the key to the agent's job as a single-use wrapping token with a TTL
of 5 minutes, through Infrastructure's shared `vault-wrapped-secrets` action (see the
[security model](security-model.md), guarantee 8). The actions come from
`camunda/infra-global-github-actions`, so the calling repository must allow them.

To retry a failed review, use **Re-run all jobs**. "Re-run failed jobs" does not re-run
`config`, so the `review` job gets the already-used token and fails at the unwrap.

Outputs: `selected` (passed the trigger filter), `reviewed` (a verdict was produced),
`verdict` (`AUTO_APPROVE` / `NEEDS_HUMAN`), and `escalation_type`.

The calling job must grant `contents: read`, `pull-requests: write`, `checks: read`,
`statuses: read`, and `id-token: write`. Each job in the called workflow uses only a
subset of these (the config job reads `pull-requests` to count reviews for
`triggers.max_auto_reviews`). Only the `config` job, which runs no AI, uses
`id-token: write`. GitHub checks the permissions when the workflow starts, so AppRole
callers must grant it too.
Keep the calling check **non-required**. In live mode, the approval step waits for
required checks, so it would wait for itself.

Copy the caller's `concurrency` group and the `review` job's `if:` from the examples.
Without them, adding any other label to a PR starts a run that cancels a review in
progress, and the new run is skipped (only `triggers.opt_in_label` requests a review),
so that commit is never reviewed. The label name in the caller must match
`triggers.opt_in_label`.

## Versioning

Pin `uses:` to a release tag (`@v1`) or a full commit SHA. Scripts and prompt are
always taken from the same commit as the workflow (`job.workflow_sha`), so pinning the
workflow pins them. The team config is independent of the pin: a change takes effect
as soon as it is merged to your default branch.
