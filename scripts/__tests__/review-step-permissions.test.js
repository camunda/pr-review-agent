// Tests that the claude-code-action review step pins its permission mode.
//
// From claude-code-action v1.0.273, agent-mode sessions start in auto mode, and
// in auto mode --allowedTools is no longer a strict allowlist: a safety review
// can approve tools that no allow rule covers. The review job relies on a strict
// list, so claude_args must set --permission-mode default. The action puts its
// own --permission-mode first, so ours must come later and must be the last one.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const WORKFLOW = path.resolve(__dirname, '..', '..', '.github', 'workflows', 'pr-review.yml');

const claudeArgs = () =>
  execFileSync(
    'yq',
    ['.jobs[].steps[] | select(.id == "claude") | .with.claude_args', WORKFLOW],
    { encoding: 'utf8' },
  ).trim();

test('review step sets claude_args', () => {
  assert.notStrictEqual(claudeArgs(), '');
  assert.notStrictEqual(claudeArgs(), 'null');
});

test('review step pins the permission mode to default (last one wins)', () => {
  const modes = [...claudeArgs().matchAll(/--permission-mode[=\s]+["']?([\w-]+)/g)].map((m) => m[1]);
  assert.ok(modes.length > 0, 'claude_args must set --permission-mode');
  assert.strictEqual(modes[modes.length - 1], 'default');
});
