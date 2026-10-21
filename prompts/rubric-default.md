# Default PR Review Rubric

This is the default rubric used when a team config does not set `policy.rubric`. It is
deliberately conservative: copy it to `.github/pr-review-agent/<name>-rubric.md` in your
repository, tailor it, and point `policy.rubric` at your copy with `from: repo`.

> **Trust boundary.** The rubric is loaded from `pr-review-agent` (or, when a team opts
> for `from: repo`, from the PR's **base** commit), never from the PR head, so a PR cannot
> edit the rules it is judged against. The paths in your config's `escalation.rules` are
> **also** enforced deterministically by the workflow, independently of the agent, so a
> missed or manipulated agent verdict cannot auto-approve them.

## Escalate to human (never auto-approve)

Any of the following is sufficient to require a human review:

### Security-sensitive areas
- Changes to authentication, authorization, session, token or permission handling.
- Hardcoded secrets, credentials, or API keys anywhere in the diff.
- New input parsing at a trust boundary (HTTP handlers, deserialisation, shell/SQL
  construction) without validation.

### Persistent data
- Database schema changes and migrations.
- Changes to how persisted data is written, migrated or deleted.

### Public contract
- Changes to a public API, published schema, CLI flags, or wire format that callers rely
  on — in particular removing or renaming endpoints, fields or options.

### Infrastructure and CI
- Changes to CI workflows, composite actions, or scripts executed by CI.
- Docker, Helm, Kubernetes or other deployment configuration.

### Repository and agent configuration
- Changes to `AGENTS.md`, `CLAUDE.md`, agent skills, or other files that instruct
  automated agents (including the review skills this workflow loads).

### Change size / breadth
- Diff exceeds 2000 lines changed (excluding generated files and lock files).
- Changes span more than 3 independent modules or subsystems.

---

## Auto-approve criteria

A PR may be auto-approved only when **none** of the escalation criteria above apply,
all required status checks are green, and the change fits either **A** or **B** below.

### A — Doc / mechanical changes with no user-facing impact

1. **Pure test changes** — only test files are modified; no production code changed.
2. **Documentation only** — only Markdown/docs or code comments changed (excluding the
   agent-instruction files listed above).
3. **Isolated refactoring** — renames, moves within a module, extracted helpers — with no
   behavioural change visible in the diff and tests covering the refactored code.

### B — Well-tested features

A new feature or user-facing change whose new or changed behaviour is covered by
automated tests, and whose author has confirmed in the PR description that they manually
tested the change.

---

## Confidence threshold

Only approve when confidence is **≥ 0.85**. If uncertain, escalate to a human.

## Escalation type

Every NEEDS_HUMAN verdict is tagged with an `escalation_type`:

- **POLICY** — a rule above matched; a human is required regardless of quality.
- **FINDINGS** — the agent has a ❌-class objection of its own.
- **BOTH** — a policy rule matched **and** the agent objects.
- **NONE** — AUTO_APPROVE.

## Impact assessment

Every ❓ and ❌ finding states its caller-visible impact (see the review prompt). Impact is
a triage aid; it is not severity and must not be used to justify an AUTO_APPROVE.
