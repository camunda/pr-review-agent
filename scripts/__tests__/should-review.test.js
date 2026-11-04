// Tests for should-review.sh — the trigger filter.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runScript, tmpdir, resolveConfig, ghStubDir, MINIMAL_CONFIG } = require('./helpers');

const { file: CONFIG_FILE } = resolveConfig(MINIMAL_CONFIG);
const { file: CAP_CONFIG } = resolveConfig(`${MINIMAL_CONFIG}\ntriggers:\n  max_auto_reviews: 3\n`);
const { file: DRAFTS_CONFIG } = resolveConfig(`${MINIMAL_CONFIG}\ntriggers:\n  review_drafts: true\n`);

function event({ action = 'opened', number = 7, draft = false, labels = [], label, author = 'alice', headRepo = 'acme/widgets' } = {}) {
  return {
    action,
    ...(label ? { label: { name: label } } : {}),
    pull_request: {
      number,
      draft,
      labels: labels.map((name) => ({ name })),
      user: { login: author },
      head: { repo: { full_name: headRepo } },
    },
  };
}

function decide(ev, { eventName = 'pull_request', config = CONFIG_FILE, env = {}, reviews, ghFails = false } = {}) {
  const dir = tmpdir('should');
  const evPath = path.join(dir, 'event.json');
  fs.writeFileSync(evPath, JSON.stringify(ev));
  // `gh` is stubbed: it serves `reviews` as one --slurp page and logs its arguments.
  const ghLog = path.join(dir, 'gh.log');
  const reviewsFile = path.join(dir, 'reviews.json');
  fs.writeFileSync(reviewsFile, JSON.stringify([reviews || []]));
  const bin = ghStubDir(`echo "$*" >> '${ghLog}'
${ghFails ? 'echo "gh: Server Error (HTTP 500)" >&2; exit 1' : `cat '${reviewsFile}'`}`);
  const res = runScript('should-review.sh', {
    cwd: dir,
    env: {
      GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: evPath, GITHUB_REPOSITORY: 'acme/widgets', CONFIG_FILE: config,
      PATH: `${bin}:${process.env.PATH}`, GITHUB_RUN_ATTEMPT: '1', ...env,
    },
  });
  assert.strictEqual(res.status, 0, res.stderr);
  res.outputs.ghCalls = fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean) : [];
  res.outputs.stderr = res.stderr + res.stdout;
  return res.outputs;
}

const MARKER = '<!-- ai-review verdict=NEEDS_HUMAN escalation_type=POLICY confidence=high shadow=true -->';
/** n agent reviews, plus noise that must not be counted. */
function agentReviews(n, { noise = true } = {}) {
  const mine = Array.from({ length: n }, (_, i) => ({ id: i + 1, user: { login: 'github-actions[bot]' }, body: `Summary\n${MARKER}\n` }));
  const other = noise ? [
    { id: 90, user: { login: 'github-actions[bot]' }, body: 'a bot review without the marker' },
    { id: 91, user: { login: 'github-actions[bot]' }, body: null },
    { id: 92, user: { login: 'mallory' }, body: `quoting the marker: ${MARKER}` },
  ] : [];
  return [...mine, ...other];
}

test('a ready same-repo PR is reviewed', () => {
  assert.strictEqual(decide(event()).run, 'true');
});

test('a draft is skipped unless it carries the opt-in label', () => {
  assert.strictEqual(decide(event({ draft: true })).run, 'false');
  assert.strictEqual(decide(event({ draft: true, labels: ['ai-review'] })).run, 'true');
});

test('review_drafts: true reviews drafts without the label', () => {
  assert.strictEqual(decide(event({ draft: true }), { config: DRAFTS_CONFIG }).run, 'true');
});

test('a fork PR is skipped', () => {
  const out = decide(event({ headRepo: 'mallory/widgets' }));
  assert.strictEqual(out.run, 'false');
  assert.match(out.skip_reason, /fork/);
});

test('a skip_authors PR is skipped, judged by PR author', () => {
  assert.strictEqual(decide(event({ author: 'renovate[bot]' })).run, 'false');
  assert.strictEqual(decide(event({ author: 'claude[bot]' })).run, 'true');
});

test('a labeled event only triggers for the opt-in label', () => {
  assert.strictEqual(decide(event({ action: 'labeled', label: 'review/needs-human', labels: ['review/needs-human'] })).run, 'false');
  assert.strictEqual(decide(event({ action: 'labeled', label: 'ai-review', labels: ['ai-review'] })).run, 'true');
});

test('pull_request_target is never reviewed', () => {
  const out = decide(event(), { eventName: 'pull_request_target' });
  assert.strictEqual(out.run, 'false');
  assert.match(out.skip_reason, /only pull_request/);
});

test('max_auto_reviews unset: no limit and the reviews are never listed', () => {
  const out = decide(event(), { reviews: agentReviews(50) });
  assert.strictEqual(out.run, 'true');
  assert.deepStrictEqual(out.ghCalls, []);
  assert.strictEqual(out.cap_reached, undefined);
});

test('max_auto_reviews: below the cap the review runs', () => {
  const out = decide(event(), { config: CAP_CONFIG, reviews: agentReviews(2) });
  assert.strictEqual(out.run, 'true');
  assert.strictEqual(out.cap_reached, undefined);
  assert.match(out.ghCalls[0], /repos\/acme\/widgets\/pulls\/7\/reviews/);
});

test('max_auto_reviews: at the cap the run is skipped and flagged', () => {
  const out = decide(event(), { config: CAP_CONFIG, reviews: agentReviews(3) });
  assert.strictEqual(out.run, 'false');
  assert.strictEqual(out.skip_reason, 'auto-review cap reached (3/3)');
  assert.strictEqual(out.cap_reached, 'true');
  assert.strictEqual(out.review_count, '3');
});

test('max_auto_reviews: above the cap the run is skipped too', () => {
  const out = decide(event(), { config: CAP_CONFIG, reviews: agentReviews(5) });
  assert.strictEqual(out.run, 'false');
  assert.strictEqual(out.skip_reason, 'auto-review cap reached (5/3)');
  assert.strictEqual(out.review_count, '5');
});

test('max_auto_reviews: only github-actions[bot] reviews with the marker are counted', () => {
  const out = decide(event(), { config: CAP_CONFIG, reviews: agentReviews(2) });
  assert.strictEqual(out.run, 'true', 'two real reviews plus three look-alikes stay under a cap of 3');
});

test('max_auto_reviews: a labeled event for the opt-in label bypasses the cap', () => {
  const out = decide(event({ action: 'labeled', label: 'ai-review', labels: ['ai-review'] }), { config: CAP_CONFIG, reviews: agentReviews(9) });
  assert.strictEqual(out.run, 'true');
  assert.strictEqual(out.cap_reached, undefined);
  assert.deepStrictEqual(out.ghCalls, []);
});

test('max_auto_reviews: an Actions re-run bypasses the cap', () => {
  const out = decide(event(), { config: CAP_CONFIG, reviews: agentReviews(9), env: { GITHUB_RUN_ATTEMPT: '2' } });
  assert.strictEqual(out.run, 'true');
  assert.strictEqual(out.cap_reached, undefined);
});

test('max_auto_reviews: events that are skipped anyway do not raise the cap notice', () => {
  const out = decide(event({ headRepo: 'mallory/widgets' }), { config: CAP_CONFIG, reviews: agentReviews(9) });
  assert.strictEqual(out.run, 'false');
  assert.match(out.skip_reason, /fork/);
  assert.strictEqual(out.cap_reached, undefined);
});

test('max_auto_reviews: if the reviews cannot be listed the review still runs, with a warning', () => {
  const out = decide(event(), { config: CAP_CONFIG, ghFails: true });
  assert.strictEqual(out.run, 'true');
  assert.strictEqual(out.cap_reached, undefined);
  assert.match(out.stderr, /not enforced/);
});
