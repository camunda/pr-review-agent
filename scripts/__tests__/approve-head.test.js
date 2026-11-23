// ai-review-approve.sh must only approve the exact commit the agent reviewed.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runScript, tmpdir, ghStubDir } = require('./helpers');

const REVIEWED = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NEWER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/** @param {string[]} heads successive answers to `gh pr view --json headRefOid` */
function approve(heads, extraEnv = {}) {
  const dir = tmpdir('approve');
  fs.writeFileSync(path.join(dir, 'body.md'), 'summary\n');
  fs.writeFileSync(path.join(dir, 'summary-marker.md'), '<!-- ai-review verdict=AUTO_APPROVE -->\n');
  fs.writeFileSync(path.join(dir, 'inline-fallback.md'), '');
  fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify({ event: 'COMMENT', comments: [] }));
  fs.writeFileSync(path.join(dir, 'heads'), heads.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify([[
    { id: 77, user: { login: 'bot' }, state: 'APPROVED', body: '<!-- ai-review verdict=AUTO_APPROVE -->' },
  ]]));
  const bin = ghStubDir(`
echo "$*" >> "${dir}/calls"
case "$*" in
  "pr view 42 --json isDraft"*) echo false ;;
  "pr view 42 --json headRefOid"*) head -n1 "${dir}/heads"; sed -i.bak 1d "${dir}/heads" ;;
  "pr checks"*) exit 0 ;;
  "api repos/acme/widgets/pulls/42/reviews --input approve.json"*) cp approve.json "${dir}/approved.json"; echo 77 ;;
  "api --paginate --slurp repos/acme/widgets/pulls/42/reviews?per_page=100") cat "${dir}/reviews.json" ;;
  "api -X PUT repos/acme/widgets/pulls/42/reviews/77/dismissals"*) echo "$*" >> "${dir}/dismissed" ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac`);
  const res = runScript('ai-review-approve.sh', {
    cwd: dir,
    env: { PATH: `${bin}:${process.env.PATH}`, PR: '42', GITHUB_REPOSITORY: 'acme/widgets', HEAD_SHA: REVIEWED, ...extraEnv },
  });
  assert.strictEqual(res.status, 0, res.stderr);
  const approvedFile = path.join(dir, 'approved.json');
  const dismissedFile = path.join(dir, 'dismissed');
  return {
    res,
    approved: fs.existsSync(approvedFile) ? JSON.parse(fs.readFileSync(approvedFile, 'utf8')) : null,
    dismissed: fs.existsSync(dismissedFile) ? fs.readFileSync(dismissedFile, 'utf8') : '',
  };
}

test('approves the reviewed commit when the head has not moved', () => {
  const { approved } = approve([REVIEWED, REVIEWED]);
  assert.strictEqual(approved.event, 'APPROVE');
  assert.strictEqual(approved.commit_id, REVIEWED);
});

test('skips approval when the head moved before the checks wait', () => {
  const { approved, res } = approve([NEWER]);
  assert.strictEqual(approved, null);
  assert.match(res.stdout, /not the reviewed/);
});

test('skips approval when the head moved during the checks wait', () => {
  const { approved } = approve([REVIEWED, NEWER]);
  assert.strictEqual(approved, null);
});

test('reports approved=true and records the base branch', () => {
  const { approved, res } = approve([REVIEWED, REVIEWED, REVIEWED], { BASE_REF: 'main' });
  assert.strictEqual(res.outputs.approved, 'true');
  assert.match(approved.body, /<!-- ai-review approved-base=main -->\n<!-- ai-review verdict=AUTO_APPROVE -->\n$/);
});

test('dismisses its own bot approval when the head moved during the POST', () => {
  const { approved, dismissed, res } = approve([REVIEWED, REVIEWED, NEWER], { BOT_LOGIN: 'bot' });
  assert.ok(approved, 'the approval was posted');
  assert.match(dismissed, /reviews\/77\/dismissals/);
  assert.notStrictEqual(res.outputs.approved, 'true');
});

test('the bot account never tries to approve its own PR', () => {
  const { approved, res } = approve([REVIEWED, REVIEWED], { BOT_LOGIN: 'bot', PR_AUTHOR: 'bot' });
  assert.strictEqual(approved, null);
  assert.match(res.stdout, /cannot approve its own PR/);
});
