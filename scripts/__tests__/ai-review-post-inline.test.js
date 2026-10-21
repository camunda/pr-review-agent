// Tests that ai-review-post-inline.sh (the live approval path's inline poster)
// is additive: it posts the new findings as a review and NEVER lists or deletes
// prior AI-review inline comments. Retaining that history is a stated behavior
// change (the prune-by-marker block was removed), so this guards against a
// future regression that resumes pruning.
//
// The script is executed as a subprocess against a stubbed `gh` so the test
// exercises the real bash/jq logic, not a reimplementation.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPTS = path.resolve(__dirname, '..');
const POST_INLINE = path.join(SCRIPTS, 'ai-review-post-inline.sh');

const HEAD_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

/**
 * Drive ai-review-post-inline.sh with a stubbed `gh` and return every gh call
 * plus the parsed JSON payloads that were POSTed and the inline-post-ok flag.
 *
 * @param {object} opts
 * @param {number} opts.nComments  How many line-anchored findings review.json carries.
 */
function postInline({ nComments = 1 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-inline-'));

  const comments = [];
  for (let i = 0; i < nComments; i += 1) {
    comments.push({ path: 'a.js', line: i + 1, side: 'RIGHT', body: `finding ${i}\n\n<!-- ai-review-inline -->` });
  }
  fs.writeFileSync(
    path.join(dir, 'review.json'),
    JSON.stringify({ event: 'COMMENT', comments, commit_id: HEAD_SHA }),
  );

  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'gh-calls.log');
  const gh = `#!/usr/bin/env bash
echo "$@" >> "${log}"
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
echo '{"id":123,"state":"COMMENTED"}'
exit 0
`;
  fs.writeFileSync(path.join(bin, 'gh'), gh);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);

  execFileSync('bash', [POST_INLINE], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: 'acme/widgets',
      PR: '42',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const payloads = [];
  for (let i = 1; ; i += 1) {
    const f = path.join(dir, `captured-${i}.json`);
    if (!fs.existsSync(f)) break;
    payloads.push(JSON.parse(fs.readFileSync(f, 'utf8')));
  }
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  return {
    calls,
    payloads,
    inlineOk: fs.readFileSync(path.join(dir, 'inline-post-ok.txt'), 'utf8'),
  };
}

test('posts the new inline findings as one review and never lists or deletes prior comments', () => {
  const { calls, payloads, inlineOk } = postInline({ nComments: 2 });

  const reviewPosts = calls.filter((c) => /pulls\/42\/reviews/.test(c) && c.includes('--input'));
  assert.strictEqual(reviewPosts.length, 1, 'exactly one review POST carrying the findings');
  assert.strictEqual(payloads.length, 1);
  assert.strictEqual(payloads[0].comments.length, 2, 'both findings ride in the review');

  // Keep-history: no enumeration of prior comments and no deletion, on any endpoint.
  assert.ok(!calls.some((c) => /-X\s+DELETE|--method\s+DELETE/.test(c)), 'no DELETE call is made');
  assert.ok(!calls.some((c) => /\/comments(\s|$)/.test(c) && !/reviews/.test(c)), 'prior inline comments are not listed');

  assert.strictEqual(inlineOk, 'true', 'inline-post-ok.txt records success');
});

test('a run with no findings posts nothing and still records success', () => {
  const { calls, payloads, inlineOk } = postInline({ nComments: 0 });

  assert.strictEqual(payloads.length, 0, 'no review is posted when there is nothing to say');
  assert.ok(!calls.some((c) => /pulls\/42\/reviews/.test(c)), 'no review POST');
  assert.strictEqual(inlineOk, 'true', 'the empty case is still a success');
});
