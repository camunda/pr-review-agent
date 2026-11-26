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
function notice({ existing = '', comments, config, lookupFails = false, postFails = false, label = 'ai-review' } = {}) {
  const dir = tmpdir('notice');
  const ghLog = path.join(dir, 'gh.log');
  // With `comments`, the stub runs the script's own --jq filter over them with
  // real jq, so the per-config matching is exercised and not just stubbed.
  const commentsFile = path.join(dir, 'comments.json');
  fs.writeFileSync(commentsFile, JSON.stringify(comments || []));
  const lookup = comments
    ? `args=("$@"); expr=""; for i in "\${!args[@]}"; do [ "\${args[$i]}" = "--jq" ] && expr="\${args[$((i+1))]}"; done
jq -r "$expr" '${commentsFile}'`
    : `printf '%s' '${existing}'`;
  const bin = ghStubDir(`echo "CALL $*" >> '${ghLog}'
case "$*" in
  *"-X POST"*) ${postFails ? 'echo "gh: Forbidden (HTTP 403)" >&2; exit 1' : 'echo 1'} ;;
  *) ${lookupFails ? 'echo "gh: Server Error (HTTP 500)" >&2; exit 1' : lookup} ;;
esac`);
  const res = runScript('post-cap-notice.sh', {
    cwd: dir,
    env: {
      GITHUB_REPOSITORY: 'acme/widgets', PR: '7', OPT_IN_LABEL: label, REVIEW_COUNT: '3', MAX_AUTO_REVIEWS: '3',
      PATH: `${bin}:${process.env.PATH}`,
      ...(config === undefined ? {} : { CONFIG_NAME: config }),
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
  assert.match(posts[0], /to request one more review, remove \(if present\) and re-add the `needs ai` label/);
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

// Per-config notices. Each config has its own cap, so each posts its own notice.
const CONFIG_MARKER = (name) => `<!-- ai-review-cap-notice-config config=${name} -->`;
const comment = (id, body, login = 'github-actions[bot]') => ({ id, user: { login }, body });
const legacyNotice = (id) => comment(id, `skipped\n\n${MARKER}`);
const configNotice = (id, name) => comment(id, `skipped\n\n${MARKER}\n${CONFIG_MARKER(name)}`);

test('with a config name the notice keeps the original marker and adds a config marker after it', () => {
  const { res, posts } = notice({ config: 'tasklist' });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(posts.length, 1);
  assert.ok(posts[0].includes(`${MARKER}\n${CONFIG_MARKER('tasklist')}`));
});

test('with a config name the visible text names the config', () => {
  const { posts } = notice({ config: 'tasklist' });
  assert.strictEqual(posts.length, 1);
  assert.match(posts[0], /already has 3 AI review\(s\) that count toward the cap of config `tasklist` \(the limit is 3\)/);
});

test('without a config name the notice has no config marker and names no config', () => {
  const { posts } = notice();
  assert.strictEqual(posts.length, 1);
  assert.ok(!posts[0].includes('cap-notice-config'));
  assert.match(posts[0], /already has 3 AI review\(s\) \(the limit is 3\)/);
  assert.ok(!posts[0].includes('config `'));
});

test('a notice for another config does not suppress this config notice', () => {
  const { posts } = notice({ config: 'tasklist', comments: [configNotice(1, 'operate-admin')] });
  assert.strictEqual(posts.length, 1);
});

test('a notice for the same config is not repeated', () => {
  const { posts } = notice({ config: 'tasklist', comments: [configNotice(1, 'operate-admin'), configNotice(2, 'tasklist')] });
  assert.strictEqual(posts.length, 0);
});

test('a legacy notice (no config marker) suppresses every config', () => {
  for (const config of ['tasklist', 'operate-admin']) {
    const { posts } = notice({ config, comments: [legacyNotice(1)] });
    assert.strictEqual(posts.length, 0, config);
  }
});

test('config names that are prefixes of each other are not confused', () => {
  assert.strictEqual(notice({ config: 'app-integrations', comments: [configNotice(1, 'app')] }).posts.length, 1);
  assert.strictEqual(notice({ config: 'app', comments: [configNotice(1, 'app-integrations')] }).posts.length, 1);
});

test('comments from other authors are ignored', () => {
  const { posts } = notice({ config: 'tasklist', comments: [comment(1, `quote ${MARKER}\n${CONFIG_MARKER('tasklist')}`, 'mallory')] });
  assert.strictEqual(posts.length, 1);
});

test('an invalid config name posts nothing and does not fail', () => {
  const { res, posts } = notice({ config: 'bad" or true or "' });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(posts.length, 0);
  assert.match(res.stdout + res.stderr, /invalid config name/);
});
