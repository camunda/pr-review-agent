// ai-review-dismiss.sh must dismiss only pr-review-agent approvals made by the
// bot account, and only the ones that no longer match the live head and base.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runScript, tmpdir, ghStubDir } = require('./helpers');

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OLD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BOT = 'cawemo-jenkins';
const ours = (base) => `ok\n<!-- ai-review approved-base=${base} -->\n<!-- ai-review verdict=AUTO_APPROVE -->`;

const REVIEWS = [
  { id: 1, user: { login: BOT }, state: 'APPROVED', commit_id: HEAD, body: ours('main') }, // current
  { id: 2, user: { login: BOT }, state: 'APPROVED', commit_id: OLD, body: ours('main') }, // older commit
  { id: 3, user: { login: BOT }, state: 'APPROVED', commit_id: HEAD, body: ours('release') }, // other base
  { id: 4, user: { login: BOT }, state: 'APPROVED', commit_id: OLD, body: 'backport approval' }, // not ours
  { id: 5, user: { login: 'alice' }, state: 'APPROVED', commit_id: OLD, body: ours('main') }, // a human
  { id: 6, user: { login: BOT }, state: 'DISMISSED', commit_id: OLD, body: ours('main') }, // already dismissed
  { id: 7, user: { login: BOT }, state: 'COMMENTED', commit_id: OLD, body: '<!-- ai-review verdict=NEEDS_HUMAN -->' },
];

function dismiss(env, { failDismiss = false, failList = false, failPr = false } = {}) {
  const dir = tmpdir('dismiss');
  fs.writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify([REVIEWS]));
  fs.writeFileSync(path.join(dir, 'pr.json'), JSON.stringify({ head: { sha: HEAD }, base: { ref: 'main' } }));
  const bin = ghStubDir(`
case "$*" in
  "api repos/acme/widgets/pulls/42") ${failPr ? 'exit 1' : `cat "${dir}/pr.json"`} ;;
  "api --paginate --slurp repos/acme/widgets/pulls/42/reviews?per_page=100")
    ${failList ? 'exit 1' : `cat "${dir}/reviews.json"`} ;;
  "api -X PUT repos/acme/widgets/pulls/42/reviews/"*"/dismissals"*)
    ${failDismiss ? 'exit 1' : ''}
    id="\${4#repos/acme/widgets/pulls/42/reviews/}"; echo "\${id%/dismissals} $*" >> "${dir}/dismissed" ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac`);
  const res = runScript('ai-review-dismiss.sh', {
    cwd: dir,
    env: { PATH: `${bin}:${process.env.PATH}`, PR: '42', GITHUB_REPOSITORY: 'acme/widgets', BOT_LOGIN: BOT, ...env },
  });
  const file = path.join(dir, 'dismissed');
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : [];
  return { res, ids: lines.map((l) => Number(l.split(' ')[0])), lines };
}

test('stale: dismisses our approvals of an older commit or another base only', () => {
  const { res, ids, lines } = dismiss({ MODE: 'stale', REASON: 'new commits' });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.deepStrictEqual(ids, [2, 3]);
  assert.match(lines[0], /message=pr-review-agent: new commits/);
  assert.match(lines[0], /event=DISMISS/);
});

test('stale: uses the live head, not the event payload', () => {
  // HEAD_SHA from an old event must not matter: approval 1 is on the live head.
  const { ids } = dismiss({ MODE: 'stale', HEAD_SHA: OLD });
  assert.ok(!ids.includes(1));
});

test('all: dismisses every approval of ours, never other approvals', () => {
  const { res, ids } = dismiss({ MODE: 'all', RUN_HEAD_SHA: HEAD });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.deepStrictEqual(ids, [1, 2, 3]);
});

test('all: does nothing when this run is for an older head (a newer run decides)', () => {
  const { res, ids } = dismiss({ MODE: 'all', RUN_HEAD_SHA: OLD });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.deepStrictEqual(ids, []);
  assert.match(res.stdout, /newer run decides/);
});

test('one: dismisses only the given review', () => {
  const { res, ids } = dismiss({ MODE: 'one', REVIEW_ID: '1' });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.deepStrictEqual(ids, [1]);
});

test('fails loud when a dismissal fails', () => {
  const { res } = dismiss({ MODE: 'all', RUN_HEAD_SHA: HEAD }, { failDismiss: true });
  assert.strictEqual(res.status, 1);
  assert.match(res.stdout, /::error::.*could not dismiss approval/);
});

test('fails loud when the PR or its reviews cannot be read', () => {
  const list = dismiss({ MODE: 'stale' }, { failList: true }).res;
  assert.strictEqual(list.status, 1);
  assert.match(list.stdout, /::error::.*could not read the reviews/);
  const pr = dismiss({ MODE: 'stale' }, { failPr: true }).res;
  assert.strictEqual(pr.status, 1);
  assert.match(pr.stdout, /::error::.*could not read PR/);
});

test('all mode needs RUN_HEAD_SHA', () => {
  assert.notStrictEqual(dismiss({ MODE: 'all' }).res.status, 0);
});
