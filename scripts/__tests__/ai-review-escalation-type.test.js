// Tests how ai-review-compute-verdict.sh settles `escalation_type`: the value
// the agent wrote, combined with the deterministic gate and the fail-safe
// fallbacks. The value lands in the workflow output and the machine-read marker.
//
// The script is executed as a subprocess so the test exercises the real
// bash/jq logic, not a reimplementation.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const COMPUTE = path.join(ROOT, 'scripts', 'ai-review-compute-verdict.sh');

const VALUES = ['NONE', 'POLICY', 'NO_CATEGORY', 'FINDINGS', 'BOTH'];

const verdictFile = (overrides = {}) => ({
  verdict: 'NEEDS_HUMAN',
  escalation_type: 'NO_CATEGORY',
  escalation_paths: ['B: author has not confirmed manual testing'],
  confidence: '0.90',
  reason: 'fits no auto-approve category',
  test_coverage: 'PASS',
  test_coverage_note: 'covered',
  inline_findings: [],
  findings_markdown: '',
  ...overrides,
});

const GATE = { GATE_ESCALATE: 'true', GATE_REASON: 'escalation rule', GATE_MATCH: 'db/migration.sql' };

/** Run the script in a throwaway dir; return the settled outputs. */
function compute(verdict, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-esc-'));
  fs.mkdirSync(path.join(dir, 'ai-review'));
  fs.writeFileSync(path.join(dir, 'ai-review', 'verdict.json'), JSON.stringify(verdict));
  const ghOut = path.join(dir, 'gh_output');
  fs.writeFileSync(ghOut, '');
  execFileSync('bash', [COMPUTE], {
    cwd: dir,
    env: {
      ...process.env,
      GATE_ESCALATE: 'false',
      GATE_REASON: '',
      GATE_MATCH: '',
      SHADOW_MODE: 'true',
      CONFIG_NAME: '',
      GITHUB_OUTPUT: ghOut,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = Object.fromEntries(
    fs.readFileSync(ghOut, 'utf8').trim().split('\n').map((l) => l.split('=')),
  );
  const marker = fs.readFileSync(path.join(dir, 'summary-marker.md'), 'utf8');
  const m = marker.match(/^<!-- ai-review verdict=(\S+) escalation_type=(\S+) confidence=\S+ shadow=\S+ -->$/m);
  assert.ok(m, `marker parses: ${marker}`);
  assert.strictEqual(m[1], out.verdict, 'marker and output agree on verdict');
  assert.strictEqual(m[2], out.escalation_type, 'marker and output agree on escalation_type');
  return { verdict: out.verdict, esc: out.escalation_type, body: fs.readFileSync(path.join(dir, 'body.md'), 'utf8') };
}

test('NO_CATEGORY from the agent reaches the output and the marker', () => {
  const r = compute(verdictFile());
  assert.strictEqual(r.verdict, 'NEEDS_HUMAN');
  assert.strictEqual(r.esc, 'NO_CATEGORY');
  assert.match(r.body, /\*\*Escalation type:\*\* NO_CATEGORY — no escalation rule matched/);
  assert.match(r.body, /\*\*Escalation paths:\*\* B: author has not confirmed manual testing/);
});

test('NO_CATEGORY with escalation_paths is not promoted (the paths name unmet criteria)', () => {
  assert.strictEqual(compute(verdictFile()).esc, 'NO_CATEGORY');
});

test('NO_CATEGORY without escalation_paths says they were not supplied', () => {
  const r = compute(verdictFile({ escalation_paths: [] }));
  assert.strictEqual(r.esc, 'NO_CATEGORY');
  assert.match(r.body, /\*\*Escalation paths:\*\* _not supplied_/);
});

test('a gate match wins over NO_CATEGORY: it becomes POLICY', () => {
  const r = compute(verdictFile(), GATE);
  assert.strictEqual(r.verdict, 'NEEDS_HUMAN');
  assert.strictEqual(r.esc, 'POLICY');
  assert.match(r.body, /gate: escalation rule \(db\/migration\.sql\)/);
  assert.match(r.body, /\*\*Escalation type:\*\* POLICY — an escalation rule, a safeguard or a fail-closed fallback requires a human/);
});

test('a gate match still turns FINDINGS into BOTH and keeps POLICY/BOTH', () => {
  const findings = verdictFile({ escalation_type: 'FINDINGS', escalation_paths: [] });
  assert.strictEqual(compute(findings, GATE).esc, 'BOTH');
  assert.strictEqual(compute(verdictFile({ escalation_type: 'POLICY' }), GATE).esc, 'POLICY');
  assert.strictEqual(compute(verdictFile({ escalation_type: 'BOTH' }), GATE).esc, 'BOTH');
});

test('a gate match on an AUTO_APPROVE gives POLICY', () => {
  const approve = verdictFile({ verdict: 'AUTO_APPROVE', escalation_type: 'NONE', escalation_paths: [] });
  const r = compute(approve, GATE);
  assert.strictEqual(r.verdict, 'NEEDS_HUMAN');
  assert.strictEqual(r.esc, 'POLICY');
});

test('FINDINGS without paths stays FINDINGS; with paths it is promoted to BOTH', () => {
  assert.strictEqual(compute(verdictFile({ escalation_type: 'FINDINGS', escalation_paths: [] })).esc, 'FINDINGS');
  assert.strictEqual(compute(verdictFile({ escalation_type: 'FINDINGS' })).esc, 'BOTH');
});

test('NEEDS_HUMAN without a type falls back to POLICY, not NO_CATEGORY', () => {
  assert.strictEqual(compute(verdictFile({ escalation_type: 'NONE', escalation_paths: [] })).esc, 'POLICY');
  const missing = verdictFile({ escalation_paths: [] });
  delete missing.escalation_type;
  assert.strictEqual(compute(missing).esc, 'POLICY');
});

test('an unknown escalation_type fails safe to POLICY', () => {
  for (const bad of ['no_category', 'NO-CATEGORY', 'CATEGORY', 'NO_CATEGORY ', '']) {
    assert.strictEqual(compute(verdictFile({ escalation_type: bad })).esc, 'POLICY', `'${bad}'`);
  }
});

test('an AUTO_APPROVE always carries NONE, whatever type the agent wrote', () => {
  const r = compute(verdictFile({ verdict: 'AUTO_APPROVE', escalation_paths: [] }));
  assert.strictEqual(r.verdict, 'AUTO_APPROVE');
  assert.strictEqual(r.esc, 'NONE');
});

test('a confidence-floor override of an AUTO_APPROVE gives POLICY', () => {
  const r = compute(verdictFile({ verdict: 'AUTO_APPROVE', escalation_type: 'NONE', escalation_paths: [], confidence: '0.5' }));
  assert.strictEqual(r.verdict, 'NEEDS_HUMAN');
  assert.strictEqual(r.esc, 'POLICY');
});

// The value set is spelled out in four places. They must agree, or the agent
// can write a value the script silently rewrites to POLICY.
test('the prompt, rubric, script and workflow output list the same escalation types', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

  const script = read('scripts/ai-review-compute-verdict.sh').match(/case "\$esc"\s+in ([A-Z_|]+)\)/);
  assert.ok(script, 'validation case statement found');
  assert.deepStrictEqual(script[1].split('|').sort(), [...VALUES].sort());

  const schema = read('prompts/review-prompt.md').match(/"escalation_type": "([A-Z_ |]+)"/);
  assert.ok(schema, 'prompt schema line found');
  assert.deepStrictEqual(schema[1].split(' | ').sort(), [...VALUES].sort());

  const output = read('.github/workflows/pr-review.yml').match(/escalation_type:\n\s+description: ([^(]+)\(/);
  assert.ok(output, 'workflow output description found');
  assert.deepStrictEqual(output[1].replace(' or ', ', ').trim().split(', ').sort(), [...VALUES].sort());

  const rubric = read('prompts/rubric-default.md');
  for (const v of VALUES) assert.ok(rubric.includes(`**${v}**`), `default rubric defines ${v}`);
});
