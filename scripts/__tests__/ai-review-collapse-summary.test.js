// Tests that ai-review-compute-verdict.sh folds the summary detail into a
// collapsed <details> so each review keeps a small default footprint, while the
// verdict headline stays visible and the trusted marker stays in its own file
// (so the post step can keep it as the LAST line of the review body).
//
// Posting behaviour is covered by ai-review-post-summary-as-review.test.js.
//
// The script is executed as a subprocess so the test exercises the real
// bash/jq logic, not a reimplementation.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPTS = path.resolve(__dirname, '..');
const COMPUTE = path.join(SCRIPTS, 'ai-review-compute-verdict.sh');

const ZWSP = '\u200b';

const baseVerdict = (overrides = {}) => ({
  verdict: 'NEEDS_HUMAN',
  escalation_type: 'POLICY',
  escalation_paths: ['restapi/db/foo.sql'],
  confidence: '0.90',
  reason: 'touches the db',
  test_coverage: 'PASS',
  test_coverage_note: 'covered',
  inline_findings: [],
  findings_markdown: 'A non-line finding.',
  ...overrides,
});

/** Run ai-review-compute-verdict.sh in a throwaway dir and return its artifacts. */
function compute(verdict, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-collapse-'));
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
      HEAD_SHA: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      GITHUB_OUTPUT: ghOut,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    dir,
    body: fs.readFileSync(path.join(dir, 'body.md'), 'utf8'),
    marker: fs.readFileSync(path.join(dir, 'summary-marker.md'), 'utf8'),
  };
}

test('summary detail is folded into a single collapsed <details>', () => {
  const { body } = compute(baseVerdict());

  assert.strictEqual((body.match(/<details>/g) || []).length, 1, 'exactly one <details>');
  assert.strictEqual((body.match(/<\/details>/g) || []).length, 1, 'exactly one </details>');

  // The verdict is visible in the always-shown <summary> line (before the block
  // is clicked open), i.e. between <details> and </summary>.
  const headlineIdx = body.indexOf('NEEDS_HUMAN');
  const detailsIdx = body.indexOf('<details>');
  const summaryEndIdx = body.indexOf('</summary>');
  assert.ok(headlineIdx > detailsIdx && headlineIdx < summaryEndIdx,
    'verdict appears in the visible <summary> line');

  // The bulky detail lives INSIDE the collapsed block.
  const inside = body.slice(detailsIdx, body.indexOf('</details>'));
  assert.ok(inside.includes('### Findings'), 'findings are inside the collapsed block');
  assert.ok(inside.includes('A non-line finding.'), 'finding text is inside the collapsed block');
  assert.ok(inside.includes('**Reason:**'), 'reason is inside the collapsed block');
});

test('the trusted marker stays out of body.md so the post step keeps it last', () => {
  const { body, marker } = compute(baseVerdict());
  assert.ok(!body.includes('<!-- ai-review verdict='), 'marker is not embedded in body.md');
  assert.match(marker.trim(), /^<!-- ai-review verdict=NEEDS_HUMAN .* -->$/);
  // Nothing agent-authored may follow the marker: it is a single trailing line.
  assert.strictEqual(marker.trim().split('\n').length, 1, 'marker is a single line');
});

test('anti-injection neutralisation still holds inside the collapsed block', () => {
  const { body } = compute(
    baseVerdict({ reason: 'ping @org/team and <!-- sneak --> here' }),
  );
  assert.ok(!body.includes('@org/team'), '@mention is neutralised even when collapsed');
  assert.ok(body.includes(`@${ZWSP}org/team`), '@ gets a zero-width space');
  assert.ok(!body.includes('<!-- sneak -->'), 'HTML-comment opener is neutralised');
});
