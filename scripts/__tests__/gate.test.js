// Tests for gate.sh — the deterministic, config-driven escalation gate.

const { test } = require('node:test');
const assert = require('node:assert');
const { runScript, resolveConfig, ghStubDir, MINIMAL_CONFIG } = require('./helpers');

const { file: CONFIG_FILE } = resolveConfig(`${MINIMAL_CONFIG}
policy:
  skills:
    - path: .agents/skills/review/SKILL.md
escalation:
  rules:
    - reason: db migration
      paths: ["restapi/db/*"]
    - reason: security-sensitive
      paths: ["*/auth/*"]
    - reason: repo config
      paths: ["AGENTS.md", "*/AGENTS.md"]
`);

// `files` entries are paths, or [path, previousPath] for a rename.
function gate(files, { ghFails = false, config = CONFIG_FILE } = {}) {
  const lines = files.map((f) => (Array.isArray(f) ? f : [f, '']).join('\t'));
  const bin = ghStubDir(
    ghFails
      ? 'echo "boom" >&2; exit 1'
      : `[ "$1 $2 $3" = "api --paginate repos/{owner}/{repo}/pulls/7/files" ] || { echo "unexpected: $*" >&2; exit 2; }\nprintf '%b\\n' ${lines.map((l) => `'${l}'`).join(' ')}`,
  );
  const res = runScript('gate.sh', {
    env: { PR: '7', CONFIG_FILE: config, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.strictEqual(res.status, 0, res.stderr);
  return res.outputs;
}

test('no matching path -> no escalation', () => {
  assert.deepStrictEqual(gate(['src/app.js', 'README.md']), { escalate: 'false', reason: '', match: '' });
});

test('`*` matches across directories', () => {
  const out = gate(['restapi/db/src/main/resources/V1__init.sql']);
  assert.strictEqual(out.escalate, 'true');
  assert.strictEqual(out.reason, 'db migration');
});

test('a leading `*/` pattern matches at any depth', () => {
  assert.strictEqual(gate(['restapi/modeler/auth/Login.java']).reason, 'security-sensitive');
  assert.strictEqual(gate(['frontend/AGENTS.md']).reason, 'repo config');
  assert.strictEqual(gate(['AGENTS.md']).reason, 'repo config');
});

test('the built-in reviewer-workflow rule applies to every team', () => {
  const out = gate(['src/a.js', '.github/workflows/ai-pr-review.yml']);
  assert.strictEqual(out.reason, 'reviewer workflow');
  assert.strictEqual(out.match, '.github/workflows/ai-pr-review.yml');
});

test('editing a repo-sourced review skill escalates', () => {
  assert.strictEqual(gate(['.agents/skills/review/SKILL.md']).reason, 'review policy change');
});

test('renaming a file out of a protected path escalates on its old path', () => {
  const out = gate([['archive/SKILL.md', '.agents/skills/review/SKILL.md']]);
  assert.strictEqual(out.reason, 'review policy change');
  assert.strictEqual(out.match, '.agents/skills/review/SKILL.md');
  assert.strictEqual(gate([['old-ci/x.yml', '.github/workflows/ai-pr-review.yml']]).reason, 'reviewer workflow');
});

test('a PR at the 3000-file API cap fails closed (escalates)', () => {
  const out = gate(Array.from({ length: 3000 }, (_, i) => `src/f${i}.js`));
  assert.strictEqual(out.escalate, 'true');
  assert.strictEqual(out.reason, 'gate error');
});

test('a glob-like filename is treated as data, not a pattern', () => {
  assert.strictEqual(gate(['*']).escalate, 'false');
});

test('an unreadable diff fails closed (escalates)', () => {
  const out = gate([], { ghFails: true });
  assert.strictEqual(out.escalate, 'true');
  assert.strictEqual(out.reason, 'gate error');
});

test('an unreadable config fails closed (escalates)', () => {
  const out = gate(['src/a.js'], { config: '/nonexistent.json' });
  assert.strictEqual(out.escalate, 'true');
});
