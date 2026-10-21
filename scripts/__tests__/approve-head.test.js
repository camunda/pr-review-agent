// ai-review-approve.sh must only approve the exact commit the agent reviewed.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runScript, tmpdir, ghStubDir } = require('./helpers');

const REVIEWED = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NEWER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/** @param {string[]} heads successive answers to `gh pr view --json headRefOid` */
function approve(heads) {
  const dir = tmpdir('approve');
  fs.writeFileSync(path.join(dir, 'body.md'), 'summary\n');
  fs.writeFileSync(path.join(dir, 'summary-marker.md'), '<!-- ai-review verdict=AUTO_APPROVE -->\n');
  fs.writeFileSync(path.join(dir, 'inline-fallback.md'), '');
  fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify({ event: 'COMMENT', comments: [] }));
  fs.writeFileSync(path.join(dir, 'heads'), heads.join('\n') + '\n');
  const bin = ghStubDir(`
echo "$*" >> "${dir}/calls"
case "$*" in
  "pr view 42 --json isDraft"*) echo false ;;
  "pr view 42 --json headRefOid"*) head -n1 "${dir}/heads"; sed -i.bak 1d "${dir}/heads" ;;
  "pr checks"*) exit 0 ;;
  "api repos/acme/widgets/pulls/42/reviews --input approve.json") cp approve.json "${dir}/approved.json"; echo '{}' ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac`);
  const res = runScript('ai-review-approve.sh', {
    cwd: dir,
    env: { PATH: `${bin}:${process.env.PATH}`, PR: '42', GITHUB_REPOSITORY: 'acme/widgets', HEAD_SHA: REVIEWED },
  });
  assert.strictEqual(res.status, 0, res.stderr);
  const approvedFile = path.join(dir, 'approved.json');
  return { res, approved: fs.existsSync(approvedFile) ? JSON.parse(fs.readFileSync(approvedFile, 'utf8')) : null };
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
