// Tests for the likelihood / end-user-severity ratings on ACTIONABLE findings (❌/❓/🔧).
//
// The script is executed as a subprocess so the test exercises the real jq/bash
// logic, not a reimplementation.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.resolve(__dirname, '..', 'ai-review-compute-verdict.sh');

function run(verdict, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-ratings-'));
  fs.mkdirSync(path.join(dir, 'ai-review'));
  fs.writeFileSync(
    path.join(dir, 'ai-review', 'verdict.json'),
    JSON.stringify(verdict),
  );
  const ghOut = path.join(dir, 'gh_output');
  fs.writeFileSync(ghOut, '');

  execFileSync('bash', [SCRIPT], {
    cwd: dir,
    env: {
      ...process.env,
      GATE_ESCALATE: 'false',
      GATE_REASON: '',
      GATE_MATCH: '',
      SHADOW_MODE: 'false',
      HEAD_SHA: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      GITHUB_OUTPUT: ghOut,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return {
    body: fs.readFileSync(path.join(dir, 'body.md'), 'utf8'),
    review: JSON.parse(fs.readFileSync(path.join(dir, 'review.json'), 'utf8')),
    fallback: fs.readFileSync(path.join(dir, 'inline-fallback.md'), 'utf8'),
  };
}

const baseVerdict = (inlineFindings, findingsMarkdown = 'A non-line finding.') => ({
  verdict: 'AUTO_APPROVE',
  escalation_type: 'NONE',
  escalation_paths: [],
  confidence: '0.9',
  reason: 'looks fine',
  test_coverage: 'PASS',
  test_coverage_note: 'covered',
  inline_findings: inlineFindings,
  findings_markdown: findingsMarkdown,
});

test('an inline finding renders its likelihood and end-user-severity under the body', () => {
  const { review } = run(
    baseVerdict([
      {
        path: 'src/A.java',
        line: 10,
        side: 'RIGHT',
        body: '❌ Null deref here',
        likelihood: 'medium',
        end_user_severity: 'high',
        impact: ['in-app-behaviour'],
        impact_note: 'boom',
        reachability: 'caller X',
      },
    ]),
  );
  const body = review.comments[0].body;
  assert.ok(body.includes('**Likelihood**: `medium`'), 'likelihood rendered inline');
  assert.ok(body.includes('**End-user severity**: `high`'), 'end_user_severity rendered inline');
});

test('🔧 findings are rated inline; 👍 praise is dropped, not surfaced', () => {
  const { body, review } = run(
    baseVerdict([
      {
        path: 'src/B.java',
        line: 20,
        side: 'RIGHT',
        body: '🔧 rename this var',
        likelihood: 'low',
        end_user_severity: 'low',
      },
      {
        path: 'src/C.java',
        line: 30,
        side: 'RIGHT',
        body: '👍 nice cleanup',
      },
    ]),
  );
  // 🔧 is actionable: stays inline and carries the ratings.
  const wrench = review.comments.find((c) => c.body.includes('rename this var'));
  assert.ok(wrench, '🔧 finding stays inline');
  assert.ok(wrench.body.includes('**Likelihood**: `low`'), '🔧 shows likelihood');
  assert.ok(wrench.body.includes('**End-user severity**: `low`'), '🔧 shows end-user severity');
  // 👍 is dropped entirely — never inline, never in the summary.
  assert.ok(
    !review.comments.some((c) => c.body.includes('nice cleanup')),
    'praise must not be inline',
  );
  assert.ok(!body.includes('nice cleanup'), 'praise must not appear in summary');
});

test('💭/🙃 findings are never rated and 👍 praise is dropped, even if the agent supplies ratings', () => {
  const { body, review } = run(
    baseVerdict(
      [
        // Praise with stray ratings the agent should not have sent.
        {
          path: 'src/P.java',
          line: 1,
          side: 'RIGHT',
          body: '👍 great test',
          likelihood: 'high',
          end_user_severity: 'high',
        },
        // Informational musing (💭) is actionable-adjacent but not rated.
        {
          path: 'src/M.java',
          line: 2,
          side: 'RIGHT',
          body: '💭 consider a follow-up',
          likelihood: 'high',
          end_user_severity: 'high',
        },
        // Nitpick (🙃) is not actionable and is never rated.
        {
          path: 'src/N.java',
          line: 3,
          side: 'RIGHT',
          body: '🙃 nit: spacing',
          likelihood: 'high',
          end_user_severity: 'high',
        },
      ],
      '',
    ),
  );
  // Praise is dropped entirely — never inline, never in the summary.
  assert.ok(
    !review.comments.some((c) => c.body.includes('great test')),
    'praise must not be inline',
  );
  assert.ok(!body.includes('great test'), 'praise must not appear in summary');
  // 💭 stays inline (only 👍 is dropped) but carries no rating line.
  const musing = review.comments.find((c) => c.body.includes('consider a follow-up'));
  assert.ok(musing, '💭 finding stays inline');
  assert.ok(!musing.body.includes('**Likelihood**'), '💭 must not be rated');
  assert.ok(!musing.body.includes('**End-user severity**'), '💭 must not be rated');
  // 🙃 stays inline and carries no rating line either.
  const nit = review.comments.find((c) => c.body.includes('nit: spacing'));
  assert.ok(nit, '🙃 finding stays inline');
  assert.ok(nit.body.includes('🙃 nit: spacing'), '🙃 body renders verbatim');
  assert.ok(!nit.body.includes('**Likelihood**'), '🙃 must not be rated');
  assert.ok(!nit.body.includes('**End-user severity**'), '🙃 must not be rated');
});

test('a missing or off-scale rating degrades to _not supplied_', () => {
  const { review } = run(
    baseVerdict([
      {
        path: 'src/D.java',
        line: 40,
        side: 'RIGHT',
        body: '❓ is this intended?',
        // likelihood absent; end_user_severity off-scale.
        end_user_severity: 'catastrophic',
      },
    ]),
  );
  const body = review.comments[0].body;
  assert.ok(body.includes('**Likelihood**: _not supplied_'), 'absent likelihood is flagged');
  assert.ok(body.includes('**End-user severity**: _not supplied_'), 'off-scale end_user_severity is flagged');
});

test('ratings are case-insensitive and normalised to lowercase', () => {
  const { review } = run(
    baseVerdict([
      {
        path: 'src/E.java',
        line: 50,
        side: 'RIGHT',
        body: '🔧 tidy',
        likelihood: 'HIGH',
        end_user_severity: 'Medium',
      },
    ]),
  );
  const body = review.comments[0].body;
  assert.ok(body.includes('**Likelihood**: `high`'), 'HIGH normalised to high');
  assert.ok(body.includes('**End-user severity**: `medium`'), 'Medium normalised to medium');
});

test('ratings appear in the inline fallback markdown as a single flattened line', () => {
  const { fallback } = run(
    baseVerdict([
      {
        path: 'src/F.java',
        line: 60,
        side: 'RIGHT',
        body: '❌ broken',
        likelihood: 'high',
        end_user_severity: 'high',
        impact: ['in-app-behaviour'],
        impact_note: 'x',
        reachability: 'y',
      },
    ]),
  );
  assert.ok(fallback.includes('**Likelihood**: `high`'), 'fallback carries likelihood');
  assert.ok(fallback.includes('**End-user severity**: `high`'), 'fallback carries end-user severity');
  // Each fallback finding is a single list item — no rating pushed onto its own line.
  const itemLines = fallback.split('\n').filter((l) => l.trim().startsWith('- '));
  assert.strictEqual(itemLines.length, 1, 'the finding stays on one fallback list item');
});
