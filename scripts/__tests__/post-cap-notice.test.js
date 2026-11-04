// Tests for post-cap-notice.sh — the one-time "review cap reached" PR comment.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runScript, tmpdir, ghStubDir } = require('./helpers');

const MARKER = '<!-- ai-review-cap-notice -->';

/**
 * Run the script with a stubbed `gh`. `existing` is what the comment lookup
 * prints (ids of earlier notices); `lookupFails` / `postFails` make that call fail.
 */
function notice({ existing = '', lookupFails = false, postFails = false, label = 'ai-review' } = {}) {
  const dir = tmpdir('notice');
  const ghLog = path.join(dir, 'gh.log');
  const bin = ghStubDir(`echo "CALL $*" >> '${ghLog}'
case "$*" in
  *"-X POST"*) ${postFails ? 'echo "gh: Forbidden (HTTP 403)" >&2; exit 1' : 'echo 1'} ;;
  *) ${lookupFails ? 'echo "gh: Server Error (HTTP 500)" >&2; exit 1' : `printf '%s' '${existing}'`} ;;
esac`);
  const res = runScript('post-cap-notice.sh', {
    cwd: dir,
    env: {
      GITHUB_REPOSITORY: 'acme/widgets', PR: '7', OPT_IN_LABEL: label, REVIEW_COUNT: '3', MAX_AUTO_REVIEWS: '3',
      PATH: `${bin}:${process.env.PATH}`,
    },
  });
  // A POST body spans lines, so calls are split on the CALL prefix.
  const calls = fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf8').split(/^CALL /m).filter(Boolean) : [];
  return { res, posts: calls.filter((c) => c.includes('-X POST')) };
}

test('posts one comment naming the label, with the hidden marker', () => {
  const { res, posts } = notice({ label: 'needs ai' });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(posts.length, 1);
  assert.match(posts[0], /repos\/acme\/widgets\/issues\/7\/comments/);
  assert.ok(posts[0].includes(MARKER));
  assert.ok(posts[0].includes('`needs ai`'));
  assert.match(posts[0], /3 AI review\(s\)/);
  assert.match(posts[0], /remove \(if present\) and re-add the `needs ai` label/);
});

test('does not repeat the notice when one is already on the PR', () => {
  const { res, posts } = notice({ existing: '12345' });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(posts.length, 0);
});

test('a failed comment lookup posts nothing and does not fail', () => {
  const { res, posts } = notice({ lookupFails: true });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(posts.length, 0);
  assert.match(res.stdout + res.stderr, /not posting/);
});

test('a failed post only warns', () => {
  const { res } = notice({ postFails: true });
  assert.strictEqual(res.status, 0);
  assert.match(res.stdout, /failed to post/);
});
