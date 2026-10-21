// Tests for the praise-drop logic in ai-review-compute-verdict.sh: 👍 approval /
// praise-only findings (leading 👍 / :+1:) in inline_findings[] must NOT be
// surfaced by the bot. The structured inline_findings[]
// drop is the only code-level praise guard; praise in the free-text
// findings_markdown is left to the prompt
//
// The script is executed as a subprocess in a temp working directory so the
// test exercises the real jq/bash logic, not a reimplementation.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.resolve(__dirname, '..', 'ai-review-compute-verdict.sh');

/**
 * Run the script against a verdict.json in a throwaway dir and return the
 * artifacts it writes.
 */
function run(verdict, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-praise-'));
  fs.mkdirSync(path.join(dir, 'ai-review'));
  fs.writeFileSync(
    path.join(dir, 'ai-review', 'verdict.json'),
    JSON.stringify(verdict),
  );
  const ghOut = path.join(dir, 'gh_output');
  fs.writeFileSync(ghOut, '');

  const stdout = execFileSync('bash', [SCRIPT], {
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
  }).toString();

  return {
    body: fs.readFileSync(path.join(dir, 'body.md'), 'utf8'),
    review: JSON.parse(fs.readFileSync(path.join(dir, 'review.json'), 'utf8')),
    fallback: fs.readFileSync(path.join(dir, 'inline-fallback.md'), 'utf8'),
    stdout,
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

const inlineBodies = (review) => review.comments.map((c) => c.body);

test('👍 and :+1: praise in inline_findings are dropped, not surfaced anywhere', () => {
  const { body, review, fallback } = run(
    baseVerdict([
      { path: 'src/A.java', line: 10, side: 'RIGHT', body: '👍 Nice cleanup here' },
      { path: 'src/B.java', line: 20, side: 'RIGHT', body: ':+1: elegant solution' },
      {
        path: 'src/C.java',
        line: 30,
        side: 'RIGHT',
        body: '❌ Null deref on this path',
        impact: ['in-app-behaviour'],
        impact_note: 'boom',
        reachability: 'reached via caller X',
      },
    ]),
  );

  // Praise is gone from the inline payload and its fallback rendering.
  const bodies = inlineBodies(review).join('\n');
  assert.ok(!bodies.includes('Nice cleanup'), 'praise 👍 must not be inline');
  assert.ok(!bodies.includes('elegant solution'), 'praise :+1: must not be inline');
  assert.ok(!fallback.includes('Nice cleanup'), 'praise must not be in inline fallback');
  assert.ok(!fallback.includes('elegant solution'), 'praise must not be in inline fallback');

  // Praise is NOT surfaced in the summary either — it is dropped entirely.
  assert.ok(!body.includes('Nice cleanup'), 'praise 👍 must not appear in summary');
  assert.ok(!body.includes('elegant solution'), 'praise :+1: must not appear in summary');

  // Actionable findings are untouched: still inline, not duplicated in summary.
  assert.ok(bodies.includes('Null deref'), 'actionable ❌ stays inline');
  assert.ok(!body.includes('Null deref'), 'actionable ❌ must not leak into summary');
});

test('classification uses the FIRST severity code — "❌ … 👍" stays inline', () => {
  const { body, review } = run(
    baseVerdict([
      { path: 'src/D.java', line: 40, side: 'RIGHT', body: '❌ then 👍 mixed code' },
    ]),
  );
  assert.ok(
    inlineBodies(review).join('\n').includes('mixed code'),
    'a finding whose first code is ❌ must stay inline even if it contains 👍',
  );
  assert.ok(!body.includes('mixed code'), 'mixed finding must not be rerouted to summary');
});

test('praise behind markdown wrappers is dropped, not surfaced', () => {
  const { body, review } = run(
    baseVerdict([
      { path: 'src/E.java', line: 50, side: 'RIGHT', body: '**👍** wrapped praise' },
      { path: 'src/F.java', line: 60, side: 'RIGHT', body: '> 👍 quoted praise' },
      { path: 'src/G.java', line: 61, side: 'RIGHT', body: '`👍` backtick praise' },
      { path: 'src/H.java', line: 62, side: 'RIGHT', body: '### 👍 heading praise' },
      { path: 'src/I.java', line: 63, side: 'RIGHT', body: '+ 👍 plus praise' },
    ]),
  );
  assert.strictEqual(review.comments.length, 0, 'wrapped praise must not be inline');
  for (const p of ['wrapped', 'quoted', 'backtick', 'heading', 'plus']) {
    assert.ok(!body.includes(`${p} praise`), `${p} praise must not appear in summary`);
  }
});

test('a :text: alias in inline_findings is not treated as praise', () => {
  // A finding coded with a `:text:` alias (:thought_balloon: / :upside_down_face:)
  // must stay inline. lead_code intentionally does NOT list these aliases; the
  // finding is kept anyway because the alphabetic characters inside the alias stop
  // the leading-code scan before it can reach any later 👍, so `lead` is "" (not
  // praise). This asserts that invariant so a future regex change is not guided by
  // a false rationale.
  const { review } = run(
    baseVerdict([
      { path: 'src/A.java', line: 10, side: 'RIGHT', body: '👍 nice work' },
      { path: 'src/B.java', line: 20, side: 'RIGHT', body: ':thought_balloon: keep this musing' },
      { path: 'src/C.java', line: 30, side: 'RIGHT', body: ':upside_down_face: keep this nitpick' },
    ]),
  );
  const bodies = inlineBodies(review).join('\n');
  assert.ok(!bodies.includes('nice work'), 'praise line dropped from inline set');
  assert.ok(bodies.includes('keep this musing'), ':thought_balloon: finding must stay inline');
  assert.ok(bodies.includes('keep this nitpick'), ':upside_down_face: finding must stay inline');
});

test('praise is dropped from the inline set in shadow mode too, not only live mode', () => {
  // The inline praise-drop is not gated on SHADOW_MODE, so it must behave
  // identically under shadow mode — the issue's acceptance criteria call out
  // both modes explicitly (#28882).
  const verdict = baseVerdict([
    { path: 'src/A.java', line: 10, side: 'RIGHT', body: '👍 inline praise' },
    { path: 'src/C.java', line: 30, side: 'RIGHT', body: '❌ real issue on this line' },
  ]);
  const { body, review } = run(verdict, { SHADOW_MODE: 'true' });
  const bodies = inlineBodies(review).join('\n');
  assert.ok(!bodies.includes('inline praise'), 'inline praise dropped in shadow mode');
  assert.ok(bodies.includes('real issue on this line'), 'actionable ❌ stays inline in shadow mode');
  assert.ok(body.includes('[SHADOW]'), 'shadow-mode run is actually in shadow mode');
});

test('an all-praise review yields an empty inline payload and no summary praise', () => {
  const { body, review, fallback } = run(
    baseVerdict(
      [
        { path: 'src/A.java', line: 1, side: 'RIGHT', body: '👍 one' },
        { path: 'src/B.java', line: 2, side: 'RIGHT', body: '👍 two' },
      ],
      '',
    ),
  );
  assert.strictEqual(review.comments.length, 0, 'no inline comments when all findings are praise');
  assert.strictEqual(fallback.trim(), '', 'empty inline fallback when all findings are praise');
  assert.ok(
    body.includes('_No findings that are not line-specific._'),
    'summary shows no findings when everything was praise',
  );
});

test('actionable findings without praise are unaffected', () => {
  const { body, review } = run(
    baseVerdict([
      { path: 'src/A.java', line: 1, side: 'RIGHT', body: '🔧 rename this var' },
      {
        path: 'src/B.java',
        line: 2,
        side: 'RIGHT',
        body: '❓ is this intended?',
        impact: ['none'],
        impact_note: 'no change',
        reachability: 'n/a',
      },
    ]),
  );
  assert.strictEqual(review.comments.length, 2, 'both actionable findings stay inline');
  const bodies = inlineBodies(review).join('\n');
  assert.ok(bodies.includes('rename this var'));
  assert.ok(bodies.includes('is this intended'));
  assert.ok(!body.includes('rename this var'), 'inline finding must not duplicate into summary');
});

test('the INLINE_CAP overflow count excludes dropped praise', () => {
  // 55 actionable findings + 10 praise. INLINE_CAP is 50, so 50 actionable
  // findings post inline and the "additional …" count must be 5 (55 − 50),
  // derived from the non-praise set only — the 10 praise findings are dropped
  // before the cap and must neither inflate the count nor appear in the summary.
  const actionable = Array.from({ length: 55 }, (_, i) => ({
    path: `src/A${i}.java`,
    line: i + 1,
    side: 'RIGHT',
    body: `❌ actionable finding number ${i}`,
    impact: ['in-app-behaviour'],
    impact_note: `boom ${i}`,
    reachability: `reached ${i}`,
  }));
  const praise = Array.from({ length: 10 }, (_, i) => ({
    path: `src/P${i}.java`,
    line: 1000 + i,
    side: 'RIGHT',
    body: `👍 praise finding number ${i}`,
  }));

  const { body, review } = run(baseVerdict([...actionable, ...praise], ''));

  assert.strictEqual(review.comments.length, 50, 'inline payload is capped at INLINE_CAP=50 actionable findings');
  assert.ok(
    review.comments.every((c) => c.body.includes('actionable finding')),
    'only actionable findings are posted inline',
  );
  assert.ok(
    /5 additional line-specific finding\(s\) exceeded/.test(body),
    'overflow count must be 55 − 50 = 5, excluding praise',
  );
  assert.ok(!body.includes('praise finding number 0'), 'dropped praise must not appear in the summary');
});

test('the dropped-praise audit log @json-encodes the path, blocking log injection', () => {
  // The path is agent-authored; a newline followed by "::error::" would let PR
  // content forge a workflow command on the privileged job's stdout. The log
  // line @json-encodes .path, so the newline renders as a literal \n and the
  // marker can never start its own line. .path itself stays byte-exact for the
  // review API anchor, so it is encoded only here at the echo site.
  const { review, stdout } = run(
    baseVerdict([
      { path: 'src/A.java\n::error::INJECTED', line: 10, side: 'RIGHT', body: '👍 nice' },
    ]),
  );
  assert.strictEqual(review.comments.length, 0, 'praise must be dropped from the inline payload');
  assert.ok(
    !stdout.split('\n').some((l) => /^::error::/.test(l)),
    'an injected ::error:: must never start a log line',
  );
  assert.ok(
    stdout.includes('"src/A.java\\n::error::INJECTED"'),
    'the path is echoed @json-encoded, keeping the newline as a literal \\n',
  );
});
