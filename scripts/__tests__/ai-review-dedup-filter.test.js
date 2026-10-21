// Tests for the LLM FILTER PASS (dedup) — the B-arm that stops the AI review bot
// from re-posting findings it already raised in an earlier round on
// the same PR. Three units, all with the LLM call MOCKED (a stubbed `curl`) and
// GitHub stubbed (`gh`), so the real bash/jq logic is exercised, not a
// reimplementation:
//
//   1. ai-review-dedup-findings.sh — the narrow LLM call. Given new findings and
//      the bot's prior inline comments, it writes ai-review/dedup.json flagging
//      duplicates. Must be FAIL-OPEN (empty duplicates on any error).
//   2. ai-review-compute-verdict.sh — consuming dedup.json: a flagged duplicate
//      is dropped from the inline payload regardless of severity (❌/❓ BLOCKERS
//      included); the dropped finding is collected into dropped-duplicates.md as
//      a compact link while its full text is written to stdout. The
//      AUTO_APPROVE/NEEDS_HUMAN verdict is computed from the agent's assessment,
//      not the inline set, so collapsing a blocker's inline re-post never
//      weakens the gate.
//   3. ai-review-post-summary.sh / ai-review-approve.sh — folds
//      dropped-duplicates.md into the PR-level body as compact original-comment
//      links.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPTS = path.resolve(__dirname, '..');
const DEDUP = path.join(SCRIPTS, 'ai-review-dedup-findings.sh');
const COMPUTE = path.join(SCRIPTS, 'ai-review-compute-verdict.sh');
const POST_SUMMARY = path.join(SCRIPTS, 'ai-review-post-summary.sh');
const APPROVE = path.join(SCRIPTS, 'ai-review-approve.sh');

const HEAD_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

/**
 * The `gh` stub, as a bash script. It reproduces two real behaviours the script
 * depends on, so a regression can't slip through:
 *   • gh REJECTS `--slurp` together with `--jq`/`--template` (the bug this PR
 *     fixes) — exit non-zero with gh's real error message when both are present.
 *     The fixed script uses `--slurp` WITHOUT `--jq` (jq runs in a real pipe), so
 *     it passes; reintroducing the combined form would fail the suite.
 *   • a GitHub-side failure — when GH_STUB_FAIL is set, exit non-zero with a
 *     stderr message, so the script's fetch-failure diagnostic can be tested.
 * Otherwise it emits `ghOut` (a single slurped array-of-pages) on stdout.
 *
 * @param {string} ghOut  the JSON the stub prints for a successful call.
 * @returns {string} the bash source of the stub.
 */
function ghStubScript(ghOut) {
  return `#!/usr/bin/env bash
if [ -n "$GH_STUB_FAIL" ]; then
  echo "gh: HTTP 403: API rate limit exceeded for installation" >&2
  exit 1
fi
has_slurp=0
has_jq=0
for a in "$@"; do
  case "$a" in
    --slurp) has_slurp=1 ;;
    --jq|--jq=*|--template|--template=*) has_jq=1 ;;
  esac
done
if [ "$has_slurp" = 1 ] && [ "$has_jq" = 1 ]; then
  echo "the --slurp option is not supported with --jq or --template" >&2
  exit 1
fi
cat <<'JSON'
${ghOut}
JSON
`;
}

// -- unit 1: the dedup script (LLM call mocked via a stubbed curl) -------------

/**
 * Run ai-review-dedup-findings.sh with `gh` (prior comments) and `curl` (the
 * Anthropic call) stubbed on PATH.
 *
 * @param {object} opts
 * @param {object[]} opts.findings   inline_findings written to verdict.json.
 * @param {object[]} opts.existing   the RAW comment objects the stubbed `gh`
 *   returns as a single page. The script's own jq pipe (a real PIPE now, not
 *   `gh --jq`) filters them by the provenance marker and extracts
 *   {index,path,line,sha,url,body}, so this fixture exercises that filter for real.
 * @param {object[][]} opts.existingPages  when set, overrides `existing`: each
 *   element is one page of raw comments. The stub wraps them into the single
 *   slurped array-of-pages that `gh api --paginate --slurp` emits (which the
 *   script's jq flattens with `.[][]`), reproducing a multi-page result.
 * @param {string} opts.llmText      the assistant text the stubbed `curl` returns
 *   inside a `text` content block (the model's JSON contract, or garbage to test
 *   fail-open). The script selects it by block type, not index.
 * @param {boolean} opts.noKey       omit ANTHROPIC_API_KEY to test the fail-open guard.
 * @param {boolean} opts.thinkingFirst  when set, the stubbed `curl` prepends a
 *   `thinking` content block before the `text` block (as adaptive-thinking models
 *   like sonnet-5 do), so the answer is NOT at content[0]; proves the script
 *   still finds the text block by type.
 * @param {string} opts.rawResponse  when set, the stubbed `curl` emits this exact
 *   JSON as the whole API response (overrides llmText/thinkingFirst) — used to
 *   feed an API error object or a truncated no-text-block reply.
 * @param {string} opts.model  when set, exported as ANTHROPIC_DEDUP_MODEL to test
 *   the model override; otherwise the script's default is used.
 * @param {boolean} opts.ghFails  when set, the `gh` stub exits non-zero (a
 *   GitHub-side failure) so the fetch-failure diagnostic can be asserted.
 * @param {boolean} opts.curlFails  when set, the `curl` stub exits non-zero with
 *   a stderr message and no stdout (a transport failure) so the transport-failure
 *   diagnostic can be asserted.
 * @returns {object} the parsed dedup.json, with two extra fields for assertions:
 *   `_stderr` (everything the script logged to stderr) and `_request` (the parsed
 *   JSON body the script sent to the API, when the curl stub was reached).
 */
function runDedup({ findings, existing = [{ path: 'src/A.java', line: 10, html_url: 'https://github.com/acme/widgets/pull/42#discussion_r1', body: 'prior <!-- ai-review-inline -->' }], existingPages = null, llmText = '{"duplicates":[]}', noKey = false, thinkingFirst = false, rawResponse = null, model = null, ghFails = false, curlFails = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-dedup-'));
  fs.mkdirSync(path.join(dir, 'ai-review'));
  fs.writeFileSync(path.join(dir, 'ai-review', 'verdict.json'), JSON.stringify({ inline_findings: findings }));

  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  // Stub `gh` (see ghStubScript): the fixed script runs `gh api --paginate
  // --slurp <endpoint> | jq …` (jq is a real PIPE, NOT `gh --jq`). `--slurp`
  // makes gh emit ONE JSON value: an array with one element PER page, each the
  // page's array of comments. Reproduce that shape (a single `existing` fixture
  // => one page). The stub returns RAW comment objects; the script's real jq
  // filters by the provenance marker and extracts {index,path,line,sha,url,body}.
  const ghOut = JSON.stringify(existingPages ? existingPages : [existing]);
  fs.writeFileSync(path.join(bin, 'gh'), ghStubScript(ghOut));
  // Stub `curl`: capture the request body (so tests can assert the request shape)
  // and print an Anthropic-shaped response. `rawResponse` overrides the body
  // entirely; otherwise carry `llmText` in a `text` block, optionally after a
  // `thinking` block (as adaptive-thinking models like sonnet-5 do), so the text
  // is NOT at content[0] and the script must find it by type.
  const contentBlocks = thinkingFirst
    ? [{ type: 'thinking', thinking: 'let me consider…' }, { type: 'text', text: llmText }]
    : [{ type: 'text', text: llmText }];
  const resp = rawResponse !== null ? rawResponse : JSON.stringify({ type: 'message', stop_reason: 'end_turn', content: contentBlocks });
  const reqPath = path.join(dir, 'request.json');
  const curlBody = curlFails
    ? `#!/usr/bin/env bash\ncat > '${reqPath}'\necho "curl: (28) Operation timed out after 60000 milliseconds" >&2\nexit 28\n`
    : `#!/usr/bin/env bash\ncat > '${reqPath}'\ncat <<'JSON'\n${resp}\nJSON\n`;
  fs.writeFileSync(path.join(bin, 'curl'), curlBody);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  fs.chmodSync(path.join(bin, 'curl'), 0o755);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GH_TOKEN: 'x',
    GITHUB_REPOSITORY: 'acme/widgets',
    PR: '42',
  };
  if (!noKey) env.ANTHROPIC_API_KEY = 'sk-test';
  if (model) env.ANTHROPIC_DEDUP_MODEL = model;
  if (ghFails) env.GH_STUB_FAIL = '1';

  const run = spawnSync('bash', [DEDUP], { cwd: dir, env, encoding: 'utf8' });
  const out = JSON.parse(fs.readFileSync(path.join(dir, 'ai-review', 'dedup.json'), 'utf8'));
  out._stderr = run.stderr || '';
  if (fs.existsSync(reqPath)) out._request = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
  return out;
}

test('dedup: the mocked LLM flags a duplicate; resolved to {path,line,side,url}', () => {
  const out = runDedup({
    findings: [
      { path: 'src/A.java', line: 10, side: 'RIGHT', body: '🔧 rename' },
      { path: 'src/B.java', line: 20, side: 'RIGHT', body: '❌ boom' },
    ],
    llmText: '{"duplicates":[{"index":0,"existing":0}]}',
  });
  assert.deepStrictEqual(out.duplicates, [
    { dedup_index: 0, path: 'src/A.java', line: 10, side: 'RIGHT', url: 'https://github.com/acme/widgets/pull/42#discussion_r1' },
  ]);
});

test('dedup: fail-open — a garbage LLM reply yields no duplicates', () => {
  const out = runDedup({
    findings: [{ path: 'src/A.java', line: 10, side: 'RIGHT', body: '🔧 rename' }],
    llmText: 'sorry I cannot help with that',
  });
  assert.deepStrictEqual(out.duplicates, []);
});

test('dedup: fail-open — no API key skips the call and drops nothing', () => {
  const out = runDedup({
    findings: [{ path: 'src/A.java', line: 10, side: 'RIGHT', body: '🔧 rename' }],
    noKey: true,
  });
  assert.deepStrictEqual(out.duplicates, []);
  assert.strictEqual(out.skipped, 'no-api-key');
});

test('dedup: prior comments spanning multiple pages are all considered', () => {
  // `gh api --paginate` returns one JSON array PER page; a single review round
  // can post up to 50 inline comments while GitHub pages at 30, so from round
  // two on, the bot's own prior comments already span >1 page. Both pages must
  // be merged before dedup, or the feature silently no-ops when it matters most.
  const out = runDedup({
    findings: [
      { path: 'src/A.java', line: 10, side: 'RIGHT', body: '🔧 rename' },
      { path: 'src/B.java', line: 20, side: 'RIGHT', body: '🔧 other' },
    ],
    existingPages: [
      [{ path: 'src/A.java', line: 10, html_url: 'https://github.com/acme/widgets/pull/42#discussion_r1', body: 'prior A <!-- ai-review-inline -->' }],
      [{ path: 'src/B.java', line: 20, html_url: 'https://github.com/acme/widgets/pull/42#discussion_r2', body: 'prior B <!-- ai-review-inline -->' }],
    ],
    llmText: '{"duplicates":[{"index":0,"existing":0},{"index":1,"existing":1}]}',
  });
  assert.strictEqual(out.existing_comments, 2, 'both pages of prior comments are counted');
  assert.deepStrictEqual(out.duplicates, [
    { dedup_index: 0, path: 'src/A.java', line: 10, side: 'RIGHT', url: 'https://github.com/acme/widgets/pull/42#discussion_r1' },
    { dedup_index: 1, path: 'src/B.java', line: 20, side: 'RIGHT', url: 'https://github.com/acme/widgets/pull/42#discussion_r2' },
  ]);
});

test('dedup: only the bot\'s OWN marked comments are considered (human comments excluded)', () => {
  // gh rejects `--slurp` with `--jq`, so dedup filters by marker in a real jq
  // pipe. A human comment (no `<!-- ai-review-inline -->` marker) must be
  // excluded; only the bot's own marked comments count.
  const out = runDedup({
    findings: [{ path: 'src/A.java', line: 10, side: 'RIGHT', body: '🔧 rename' }],
    existing: [
      { path: 'src/A.java', line: 10, original_commit_id: 'cafe1234cafe', html_url: 'https://github.com/acme/widgets/pull/42#discussion_r1', body: 'bot prior <!-- ai-review-inline -->' },
      { path: 'src/A.java', line: 11, body: 'a human reviewer comment with no marker' },
    ],
    llmText: '{"duplicates":[{"index":0,"existing":0}]}',
  });
  assert.strictEqual(out.existing_comments, 1, 'the unmarked human comment is filtered out');
  assert.deepStrictEqual(out.duplicates, [
    { dedup_index: 0, path: 'src/A.java', line: 10, side: 'RIGHT', url: 'https://github.com/acme/widgets/pull/42#discussion_r1' },
  ]);
});

test('dedup: a thinking block before the text block is handled (adaptive-thinking models)', () => {
  // sonnet-5 and other adaptive-thinking models can return a `thinking` content
  // block first, so the answer is NOT at content[0]. The script must pick the
  // text block by type, not by index, or it would misread every reply as empty.
  const out = runDedup({
    findings: [{ path: 'src/A.java', line: 10, side: 'RIGHT', body: '🔧 rename' }],
    thinkingFirst: true,
    llmText: '{"duplicates":[{"index":0,"existing":0}]}',
  });
  assert.deepStrictEqual(out.duplicates, [
    { dedup_index: 0, path: 'src/A.java', line: 10, side: 'RIGHT', url: 'https://github.com/acme/widgets/pull/42#discussion_r1' },
  ]);
});

test('dedup: a duplicate without a linkable original is omitted and therefore stays inline', () => {
  const out = runDedup({
    findings: [{ path: 'src/A.java', line: 10, side: 'RIGHT', body: '🔧 rename' }],
    existing: [{ path: 'src/A.java', line: 10, body: 'prior without url <!-- ai-review-inline -->' }],
    llmText: '{"duplicates":[{"index":0,"existing":0}]}',
  });
  assert.deepStrictEqual(out.duplicates, [], 'the dedup result does not suppress a finding without an original-comment URL');
  assert.match(out._stderr, /no linkable original for src\/A.java:10; keeping it inline/);

  const { review } = runCompute(
    [{ path: 'src/A.java', line: 10, side: 'RIGHT', body: '🔧 rename' }],
    out.duplicates,
  );
  assert.deepStrictEqual(inlinePaths(review), ['src/A.java:10'], 'the finding stays inline when dedup cannot link the original');
});

test('dedup: the gh stub reproduces gh rejecting --slurp with --jq (regression guard)', () => {
  // gh rejects `--slurp` with `--jq`, so the stub must fail on that combination
  // and succeed on the `--slurp`-without-`--jq` shape the script uses — else a
  // regression to the combined form would pass silently.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-dedup-ghstub-'));
  const gh = path.join(dir, 'gh');
  fs.writeFileSync(gh, ghStubScript('[[]]'));
  fs.chmodSync(gh, 0o755);

  const bad = spawnSync('bash', [gh, 'api', '--paginate', '--slurp', '--jq', '.'], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 1, 'stub exits non-zero when --slurp and --jq are combined');
  assert.match(bad.stderr, /--slurp option is not supported with --jq/);

  const badEq = spawnSync('bash', [gh, 'api', '--paginate', '--slurp', '--jq=.'], { encoding: 'utf8' });
  assert.strictEqual(badEq.status, 1, 'stub also catches the --jq=<expr> form real gh rejects too');

  const ok = spawnSync('bash', [gh, 'api', '--paginate', '--slurp', 'repos/x/pulls/1/comments'], { encoding: 'utf8' });
  assert.strictEqual(ok.status, 0, 'stub succeeds with --slurp and no --jq (the shape the script uses)');
});

test('dedup: the request omits temperature and sends max_tokens 64000 and the default model', () => {
  // The request shape is a silent-fail contract: re-adding temperature, lowering
  // max_tokens, or changing the default model would present as a no-op, so assert
  // the body the curl stub captured.
  const out = runDedup({
    findings: [{ path: 'src/A.java', line: 10, side: 'RIGHT', body: '🔧 rename' }],
    llmText: '{"duplicates":[]}',
  });
  assert.ok(out._request, 'the curl stub captured the request body');
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(out._request, 'temperature'), false,
    'no temperature is sent (current models reject it)',
  );
  assert.strictEqual(out._request.max_tokens, 64000, 'max_tokens is 64000');
  assert.strictEqual(out._request.model, 'claude-sonnet-5', 'the default model is the current sonnet');
});

test('dedup: ANTHROPIC_DEDUP_MODEL overrides the model in the request', () => {
  const out = runDedup({
    findings: [{ path: 'src/A.java', line: 10, side: 'RIGHT', body: '🔧 rename' }],
    model: 'claude-opus-5',
  });
  assert.strictEqual(out._request.model, 'claude-opus-5');
});

test('dedup: an API error object is logged with its error type, not swallowed', () => {
  const out = runDedup({
    findings: [{ path: 'src/A.java', line: 10, side: 'RIGHT', body: '🔧 rename' }],
    rawResponse: '{"type":"error","error":{"type":"not_found_error","message":"model: x not found"}}',
  });
  assert.deepStrictEqual(out.duplicates, [], 'fail-open: no duplicates on an API error');
  assert.strictEqual(out.skipped, 'empty-completion');
  assert.match(out._stderr, /api error type: not_found_error/);
});

test('dedup: a truncated no-text reply logs stop_reason, not the useless "message" type', () => {
  // Adaptive thinking can exhaust max_tokens before any text, returning a
  // successful message whose only block is `thinking` with stop_reason
  // "max_tokens". The diagnostic must log `.stop_reason`, not `.type` (the
  // useless literal "message").
  const out = runDedup({
    findings: [{ path: 'src/A.java', line: 10, side: 'RIGHT', body: '🔧 rename' }],
    rawResponse: '{"type":"message","stop_reason":"max_tokens","content":[{"type":"thinking","thinking":"…"}]}',
  });
  assert.deepStrictEqual(out.duplicates, []);
  assert.strictEqual(out.skipped, 'empty-completion');
  assert.match(out._stderr, /stop_reason: max_tokens/);
  assert.doesNotMatch(out._stderr, /api error type: message/, 'the useless "message" type must not be logged');
});

test('dedup: a gh fetch failure is logged, not a silent no-prior-comments', () => {
  // A gh fetch failure must leave a diagnostic while still failing open to
  // no-prior-comments.
  const out = runDedup({
    findings: [{ path: 'src/A.java', line: 10, side: 'RIGHT', body: '🔧 rename' }],
    ghFails: true,
  });
  assert.deepStrictEqual(out.duplicates, []);
  assert.strictEqual(out.skipped, 'no-prior-comments');
  assert.match(out._stderr, /prior-comment fetch failed \(gh:/);
});

test('dedup: a curl transport failure is logged, not a silent no-response', () => {
  // A curl transport failure (DNS/TLS/timeout) must leave a diagnostic while
  // still failing open to no-response.
  const out = runDedup({
    findings: [{ path: 'src/A.java', line: 10, side: 'RIGHT', body: '🔧 rename' }],
    curlFails: true,
  });
  assert.deepStrictEqual(out.duplicates, []);
  assert.strictEqual(out.skipped, 'no-response');
  assert.match(out._stderr, /transport failed \(curl exit 28/);
});

// -- unit 2: compute-verdict consuming dedup.json ------------------------------

/**
 * Run ai-review-compute-verdict.sh with a verdict.json and an optional
 * dedup.json in the working dir; return the artifacts it writes.
 */
function runCompute(inlineFindings, duplicates) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-dedup-compute-'));
  fs.mkdirSync(path.join(dir, 'ai-review'));
  fs.writeFileSync(
    path.join(dir, 'ai-review', 'verdict.json'),
    JSON.stringify({
      verdict: 'NEEDS_HUMAN',
      escalation_type: 'FINDINGS',
      escalation_paths: [],
      confidence: '0.9',
      reason: 'has findings',
      test_coverage: 'PASS',
      test_coverage_note: 'covered',
      inline_findings: inlineFindings,
      findings_markdown: '',
    }),
  );
  if (duplicates) {
    fs.writeFileSync(path.join(dir, 'ai-review', 'dedup.json'), JSON.stringify({ duplicates }));
  }
  const ghOut = path.join(dir, 'gh_output');
  fs.writeFileSync(ghOut, '');

  const stdout = execFileSync('bash', [COMPUTE], {
    cwd: dir,
    env: {
      ...process.env,
      GATE_ESCALATE: 'false',
      GATE_REASON: '',
      GATE_MATCH: '',
      SHADOW_MODE: 'false',
      HEAD_SHA,
      GITHUB_OUTPUT: ghOut,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();

  const droppedPath = path.join(dir, 'dropped-duplicates.md');
  return {
    dir,
    stdout,
    review: JSON.parse(fs.readFileSync(path.join(dir, 'review.json'), 'utf8')),
    fallback: fs.readFileSync(path.join(dir, 'inline-fallback.md'), 'utf8'),
    dropped: fs.existsSync(droppedPath) ? fs.readFileSync(droppedPath, 'utf8') : '',
  };
}

const inlinePaths = (review) => review.comments.map((c) => `${c.path}:${c.line}`);
const dedupUrl = (i) => `https://github.com/acme/widgets/pull/42#discussion_r${i + 1}`;

test('compute-verdict: non-blocker duplicate is dropped inline and rendered as a compact original-comment link', () => {
  const { review, fallback, dropped, stdout } = runCompute(
    [
      { path: 'src/A.java', line: 10, side: 'RIGHT', body: '🔧 rename this var', likelihood: 'low', end_user_severity: 'low' },
      { path: 'src/C.java', line: 30, side: 'RIGHT', body: '🔧 a fresh non-dup finding' },
    ],
    [{ dedup_index: 0, path: 'src/A.java', line: 10, side: 'RIGHT', url: dedupUrl(0) }],
  );

  const paths = inlinePaths(review);
  assert.ok(!paths.includes('src/A.java:10'), 'the non-blocker duplicate must not be re-posted inline');
  assert.ok(paths.includes('src/C.java:30'), 'the fresh non-dup finding stays inline');
  assert.ok(!fallback.includes('rename this var'), 'dropped finding must not ride in the inline fallback');
  assert.strictEqual(dropped.trim(), `- 🔧 [already raised in an earlier round](<${dedupUrl(0)}>)`);
  assert.ok(!dropped.includes('rename this var'), 'the compact recap does not embed the full finding body');
  assert.ok(stdout.includes('ai-review dedup audit: 🔧 rename this var'), 'the full dropped finding body is written to the run log');
  assert.ok(stdout.includes('**Likelihood**: `low` · **End-user severity**: `low`'), 'ratings stay available in the audit log');
});

test('compute-verdict: a dropped finding with no recognized severity code renders without a stray space', () => {
  // lead_emoji is "" for a body with no ❌/❓/🔧/💭/🙃/👍 code. The recap line
  // must not emit a leading double space.
  const { dropped } = runCompute(
    [{ path: 'src/A.java', line: 10, side: 'RIGHT', body: 'no severity code here' }],
    [{ dedup_index: 0, path: 'src/A.java', line: 10, side: 'RIGHT', url: dedupUrl(0) }],
  );
  assert.strictEqual(dropped.trim(), `- [already raised in an earlier round](<${dedupUrl(0)}>)`);
  assert.ok(!dropped.includes('-  ['), 'no double space when there is no severity emoji');
});

test('compute-verdict: a ❌/❓ blocker duplicate is collapsed into the dropped section', () => {
  const { review, dropped, stdout } = runCompute(
    [
      { path: 'src/B.java', line: 20, side: 'RIGHT', body: '❌ null deref', impact: ['in-app-behaviour'], impact_note: 'boom', reachability: 'via X' },
      { path: 'src/Q.java', line: 5, side: 'RIGHT', body: '❓ is this intended?', impact: ['none'], impact_note: 'n/a', reachability: 'n/a' },
    ],
    [
      { dedup_index: 0, path: 'src/B.java', line: 20, side: 'RIGHT', url: dedupUrl(0) },
      { dedup_index: 1, path: 'src/Q.java', line: 5, side: 'RIGHT', url: dedupUrl(1) },
    ],
  );

  const paths = inlinePaths(review);
  assert.ok(!paths.includes('src/B.java:20'), '❌ blocker duplicate must not be re-posted inline');
  assert.ok(!paths.includes('src/Q.java:5'), '❓ blocker duplicate must not be re-posted inline');
  assert.strictEqual(
    dropped.trim(),
    `- ❌ [already raised in an earlier round](<${dedupUrl(0)}>)\n- ❓ [already raised in an earlier round](<${dedupUrl(1)}>)`,
    'both blockers are recapped as compact links carrying their severity emoji',
  );
  assert.ok(stdout.includes('ai-review dedup audit: ❌ null deref'), 'the full ❌ finding body is written to the run log');
  assert.ok(stdout.includes('ai-review dedup audit: ❓ is this intended?'), 'the full ❓ finding body is written to the run log');
});

test('compute-verdict: a genuinely new ❌ blocker (not a duplicate) is still posted inline', () => {
  const { review, dropped } = runCompute(
    [{ path: 'src/New.java', line: 7, side: 'RIGHT', body: '❌ fresh blocker', impact: ['in-app-behaviour'], impact_note: 'boom', reachability: 'via X' }],
    [{ dedup_index: 0, path: 'src/Other.java', line: 99, side: 'RIGHT', url: dedupUrl(0) }],
  );
  assert.ok(inlinePaths(review).includes('src/New.java:7'), 'a blocker that was not previously raised stays inline');
  assert.strictEqual(dropped.trim(), '', 'nothing is collapsed for a non-duplicate blocker');
});

test('compute-verdict: no dedup.json means no drops (pre-existing behaviour)', () => {
  const { review, dropped } = runCompute(
    [{ path: 'src/A.java', line: 10, side: 'RIGHT', body: '🔧 rename this var' }],
    null,
  );
  assert.deepStrictEqual(inlinePaths(review), ['src/A.java:10'], 'every finding stays inline without dedup.json');
  assert.strictEqual(dropped.trim(), '', 'nothing collapsed when the LLM pass produced no result');
});

test('compute-verdict: two findings on the same line — only the flagged index is dropped (collision)', () => {
  // Identity is the finding index plus location, not location alone: two distinct
  // non-blockers can share a path:line:side, so flagging one must not drop the
  // other.
  const { review, dropped } = runCompute(
    [
      { path: 'src/A.java', line: 10, side: 'RIGHT', body: '🔧 first suggestion on this line' },
      { path: 'src/A.java', line: 10, side: 'RIGHT', body: '🔧 second distinct suggestion same line' },
    ],
    [{ dedup_index: 0, path: 'src/A.java', line: 10, side: 'RIGHT', url: dedupUrl(0) }],
  );
  const bodies = review.comments.map((c) => c.body).join('\n');
  assert.ok(!bodies.includes('first suggestion on this line'), 'the flagged index-0 finding is dropped');
  assert.ok(bodies.includes('second distinct suggestion same line'), 'the fresh index-1 finding on the same line is NOT dropped');
  assert.strictEqual(dropped.trim(), `- 🔧 [already raised in an earlier round](<${dedupUrl(0)}>)`);
});

test('compute-verdict: dropped recap is count-capped and points to logs for the omitted links', () => {
  const findings = [];
  const duplicates = [];
  for (let i = 0; i < 55; i += 1) {
    findings.push({ path: `src/Many${i}.java`, line: i + 1, side: 'RIGHT', body: `🔧 dup ${i}` });
    duplicates.push({ dedup_index: i, path: `src/Many${i}.java`, line: i + 1, side: 'RIGHT', url: dedupUrl(i) });
  }
  const { dropped, stdout } = runCompute(findings, duplicates);
  const lines = dropped.trim().split('\n');
  assert.strictEqual(lines.filter((line) => line.includes('[already raised in an earlier round]')).length, 50);
  assert.strictEqual(lines.at(-1), '- …and 5 more already-raised finding(s) — see the run logs');
  assert.ok(dropped.length < 6000, `the compact dropped section stays small in this scenario (was ${dropped.length})`);
  assert.ok(stdout.includes('ai-review dedup audit: 🔧 dup 54'), 'the audit log still contains omitted recap entries');
});

test('compute-verdict: dedup entries without a valid URL do not suppress findings', () => {
  const { review, dropped } = runCompute(
    [{ path: 'src/A.java', line: 10, side: 'RIGHT', body: '🔧 keep me inline' }],
    [{ dedup_index: 0, path: 'src/A.java', line: 10, side: 'RIGHT' }],
  );
  assert.deepStrictEqual(inlinePaths(review), ['src/A.java:10'], 'a duplicate without a valid original-comment URL stays inline');
  assert.strictEqual(dropped.trim(), '', 'nothing is recapped without a linkable original');
});

test('compute-verdict: the fallback budget reserves for the recap (saturated retry stays within 65536)', () => {
  // The body-only retry appends BOTH the inline fallback and the dropped recap
  // to body.md. With a saturated fallback and a full 50-link recap, the total
  // must still fit GitHub's 65536-byte limit — the fallback budget has to leave
  // room for the recap that is appended after it.
  const big = 'q'.repeat(1500);
  const findings = [];
  const duplicates = [];
  for (let i = 0; i < 50; i += 1) {
    findings.push({ path: `src/Drop${i}.java`, line: i + 1, side: 'RIGHT', body: `🔧 dropped ${i}` });
    duplicates.push({ dedup_index: i, path: `src/Drop${i}.java`, line: i + 1, side: 'RIGHT', url: dedupUrl(i) });
  }
  for (let i = 0; i < 60; i += 1) {
    findings.push({ path: `src/Fresh${i}.java`, line: 1000 + i, side: 'RIGHT', body: `🔧 fresh ${i} ${big}` });
  }
  const { dir, dropped } = runCompute(findings, duplicates);
  const size = (f) => (fs.existsSync(path.join(dir, f)) ? fs.statSync(path.join(dir, f)).size : 0);
  const total = size('body.md') + size('inline-fallback.md') + size('dropped-duplicates.md');
  assert.strictEqual(
    dropped.split('\n').filter((l) => l.includes('[already raised')).length, 50,
    'the full 50-link recap is present',
  );
  assert.ok(size('inline-fallback.md') > 20000, `the inline fallback is saturated in this scenario (was ${size('inline-fallback.md')})`);
  assert.ok(total <= 65536, `body + fallback + recap must fit GitHub's 65536-byte limit (was ${total})`);
});

// -- unit 3: post-summary folds the dropped section into the review body -------

test('post-summary: dropped duplicates are folded into the posted review body', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-dedup-post-'));

  fs.writeFileSync(
    path.join(dir, 'body.md'),
    '<details>\n<summary>🤖 AI review - NEEDS_HUMAN — confidence 0.90 (click to expand)</summary>\n\ndetail\n\n</details>\n',
  );
  fs.writeFileSync(
    path.join(dir, 'summary-marker.md'),
    '<!-- ai-review verdict=NEEDS_HUMAN escalation_type=FINDINGS confidence=0.90 shadow=true -->\n',
  );
  fs.writeFileSync(
    path.join(dir, 'review.json'),
    JSON.stringify({ event: 'COMMENT', comments: [{ path: 'src/C.java', line: 30, side: 'RIGHT', body: 'finding\n\n<!-- ai-review-inline -->' }], commit_id: HEAD_SHA }),
  );
  fs.writeFileSync(path.join(dir, 'inline-fallback.md'), '- `src/C.java:30` - a finding\n');
  fs.writeFileSync(path.join(dir, 'dropped-duplicates.md'), `- 🔧 [already raised in an earlier round](<${dedupUrl(0)}>)\n`);

  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const gh = `#!/usr/bin/env bash
input=""
prev=""
for a in "$@"; do
  [ "$prev" = "--input" ] && input="$a"
  prev="$a"
done
if [ -n "$input" ] && [ -f "$input" ]; then
  idx=$(ls "${dir}"/captured-*.json 2>/dev/null | wc -l | tr -d ' ')
  cp "$input" "${dir}/captured-$((idx + 1)).json"
fi
echo '{"id":1,"html_url":"http://x"}'
exit 0
`;
  fs.writeFileSync(path.join(bin, 'gh'), gh);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);

  execFileSync('bash', [POST_SUMMARY], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: 'acme/widgets',
      PR: '42',
      SHADOW_MODE: 'true',
      VERDICT: 'NEEDS_HUMAN',
      AI_REVIEW_LABEL_PRESENT: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const posted = JSON.parse(fs.readFileSync(path.join(dir, 'captured-1.json'), 'utf8'));
  assert.ok(posted.body.includes('already raised in an earlier review round'), 'the review body carries the dedup section header');
  assert.ok(posted.body.includes(dedupUrl(0)), 'the dropped finding links to the original comment');
  assert.ok(posted.body.includes('Full suppressed content is in this run\'s logs'), 'the section points to the audit log');
  assert.ok(posted.body.includes("The emoji is **this round's** severity"), 'the recap clarifies the emoji is the current round\'s severity, not the linked comment\'s');
  // The trusted calibration marker must remain the very last line of the body.
  assert.ok(/verdict=NEEDS_HUMAN[^\n]*-->\n?$/.test(posted.body.trimEnd() + '\n'), 'the calibration marker still ends the body');
});

const APPROVE_HEAD = 'feedfacefeedfacefeedfacefeedfacefeedface';

test('approve: dropped duplicates are folded into the approval body before the marker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-dedup-approve-'));

  fs.writeFileSync(
    path.join(dir, 'body.md'),
    '<details>\n<summary>🤖 AI review - AUTO_APPROVE — confidence 0.90 (click to expand)</summary>\n\ndetail\n\n</details>\n',
  );
  fs.writeFileSync(
    path.join(dir, 'summary-marker.md'),
    '<!-- ai-review verdict=AUTO_APPROVE escalation_type=NONE confidence=0.90 shadow=false -->\n',
  );
  fs.writeFileSync(path.join(dir, 'inline-fallback.md'), '');
  fs.writeFileSync(path.join(dir, 'dropped-duplicates.md'), `- 🔧 [already raised in an earlier round](<${dedupUrl(0)}>)\n`);
  fs.mkdirSync(path.join(dir, '.github', 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.github', 'scripts', 'ai-review-post-inline.sh'),
    '#!/usr/bin/env bash\necho true > inline-post-ok.txt\n',
  );

  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const gh = `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  case "$*" in
    *headRefOid*) echo "${APPROVE_HEAD}" ;;
    *) echo false ;;
  esac
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/widgets/pulls/42/reviews" ]; then
  input=""
  prev=""
  for a in "$@"; do
    [ "$prev" = "--input" ] && input="$a"
    prev="$a"
  done
  jq -r '.body' "$input" > "${dir}/approve-body.md"
  cp "$input" "${dir}/approve-payload.json"
  echo '{}'
  exit 0
fi
echo "unexpected gh call: $*" >&2
exit 1
`;
  fs.writeFileSync(path.join(bin, 'gh'), gh);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);

  execFileSync('bash', [APPROVE], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      PR: '42',
      AGENT_SCRIPTS_DIR: path.join(dir, '.github', 'scripts'),
      GITHUB_REPOSITORY: 'acme/widgets',
      HEAD_SHA: APPROVE_HEAD,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const body = fs.readFileSync(path.join(dir, 'approve-body.md'), 'utf8');
  assert.ok(body.includes('Finding(s) already raised in an earlier review round'), 'the approval body carries the dedup section header');
  assert.ok(body.includes(dedupUrl(0)), 'the approval body links to the original comment');
  assert.ok(body.indexOf('Finding(s) already raised') < body.indexOf('<!-- ai-review verdict=AUTO_APPROVE'), 'the dedup section is before the marker');
  assert.ok(/verdict=AUTO_APPROVE[^\n]*-->\n?$/.test(body.trimEnd() + '\n'), 'the calibration marker still ends the approval body');
  const payload = JSON.parse(fs.readFileSync(path.join(dir, 'approve-payload.json'), 'utf8'));
  assert.strictEqual(payload.event, 'APPROVE');
  assert.strictEqual(payload.commit_id, APPROVE_HEAD, 'the approval is anchored to the reviewed commit');
});
