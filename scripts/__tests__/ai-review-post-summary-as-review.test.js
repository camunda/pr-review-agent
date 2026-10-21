// Tests that ai-review-post-summary.sh posts the AI review as ONE real
// pull-request review (event=COMMENT) carrying the collapsed summary as the
// review body AND the line-anchored findings as inline comments — and that a
// review rejected because an inline comment sits outside the diff (422) is
// retried as a body-only review with the findings folded into the body, so the
// summary is never lost.
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
const POST_SUMMARY = path.join(SCRIPTS, 'ai-review-post-summary.sh');

const HEAD_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

/**
 * Drive ai-review-post-summary.sh with a stubbed `gh` and return every gh call
 * plus the parsed JSON payloads that were POSTed (in order).
 *
 * @param {object} opts
 * @param {boolean} opts.failOnComments  Simulate the 422: reject any review that
 *   carries inline comments, forcing the body-only retry.
 * @param {boolean} opts.labelPresent    Value of AI_REVIEW_LABEL_PRESENT.
 * @param {boolean} opts.emptyComments   Emit a review.json with no inline
 *   findings, i.e. a summary-only run (compute-verdict still sets commit_id).
 * @param {string[]} opts.prShas     The commit SHAs currently part of the PR.
 *   GitHub accepts a review whose commit_id is any of these (marking it outdated
 *   if it is not the tip) and 422s one whose commit_id was force-pushed out.
 */
function postReview({ failOnComments = false, labelPresent = true, emptyComments = false, failStatus = null, allowFailure = false, prShas = [HEAD_SHA] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-post-'));

  // Artifacts produced upstream by ai-review-compute-verdict.sh.
  const bodyMd =
    '<details>\n<summary>🤖 AI review - NEEDS_HUMAN — confidence 0.90 (click to expand)</summary>\n\ndetail\n\n</details>\n';
  const inlineFallback = '- `a.js:1` - a folded finding\n';
  fs.writeFileSync(path.join(dir, 'body.md'), bodyMd);
  fs.writeFileSync(
    path.join(dir, 'summary-marker.md'),
    '<!-- ai-review verdict=NEEDS_HUMAN escalation_type=POLICY confidence=0.90 shadow=true -->\n',
  );
  fs.writeFileSync(
    path.join(dir, 'review.json'),
    JSON.stringify(
      emptyComments
        ? { event: 'COMMENT', comments: [], commit_id: HEAD_SHA }
        : {
            event: 'COMMENT',
            comments: [{ path: 'a.js', line: 1, side: 'RIGHT', body: 'finding\n\n<!-- ai-review-inline -->' }],
            commit_id: HEAD_SHA,
          },
    ),
  );
  fs.writeFileSync(path.join(dir, 'inline-fallback.md'), inlineFallback);

  // Stub `gh`: log every call, copy each --input payload to captured-N.json in
  // order, and (when configured) reject a review that still carries inline
  // comments so the script must fall back to a body-only review.
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
  ${failStatus ? `echo "HTTP ${failStatus}: simulated server error" >&2; exit 1` : ':'}
  # GitHub accepts a review anchored to any commit that is part of the PR (an
  # older commit just yields an "outdated" review); it 422s only a commit that
  # was force-pushed out of the PR entirely.
  cid=$(jq -r '.commit_id // ""' "$input" 2>/dev/null || echo "")
  if [ -n "$cid" ]; then
    case " ${prShas.join(' ')} " in
      *" $cid "*) : ;;
      *) echo "HTTP 422: commit_id is not part of the pull request" >&2; exit 1 ;;
    esac
  fi
  if [ "${failOnComments ? 'true' : 'false'}" = "true" ]; then
    n=$(jq '.comments | length' "$input" 2>/dev/null || echo 0)
    if [ "$n" -gt 0 ]; then echo "HTTP 422: line must be part of the diff" >&2; exit 1; fi
  fi
fi
echo '{"id":123,"state":"COMMENTED"}'
exit 0
`;
  fs.writeFileSync(path.join(bin, 'gh'), gh);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);

  let failed = false;
  try {
    execFileSync('bash', [POST_SUMMARY], {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_REPOSITORY: 'acme/widgets',
        PR: '42',
        SHADOW_MODE: 'true',
        VERDICT: 'NEEDS_HUMAN',
        AI_REVIEW_LABEL_PRESENT: labelPresent ? 'true' : 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    if (!allowFailure) throw e;
    failed = true;
  }

  const payloads = [];
  for (let i = 1; ; i += 1) {
    const f = path.join(dir, `captured-${i}.json`);
    if (!fs.existsSync(f)) break;
    payloads.push(JSON.parse(fs.readFileSync(f, 'utf8')));
  }
  return {
    calls: fs.readFileSync(log, 'utf8').trim().split('\n'),
    payloads,
    failed,
    inputs: { bodyMd, inlineFallback },
  };
}

const lastLine = (s) => s.replace(/\n+$/, '').split('\n').pop();

test('posts a single review carrying the summary body and the inline comments', () => {
  const { calls, payloads } = postReview();

  const reviewPosts = calls.filter((c) => /pulls\/42\/reviews/.test(c) && c.includes('--input'));
  assert.strictEqual(reviewPosts.length, 1, 'exactly one review is POSTed');
  assert.strictEqual(payloads.length, 1);

  const [review] = payloads;
  assert.strictEqual(review.event, 'COMMENT', 'event is COMMENT (never approves/requests changes)');
  assert.strictEqual(review.comments.length, 1, 'inline findings ride in the same review');
  assert.strictEqual(review.commit_id, HEAD_SHA, 'review is anchored to the reviewed commit');
  assert.ok(review.body.includes('</details>'), 'the collapsed summary is the review body');
  assert.match(lastLine(review.body), /^<!-- ai-review verdict=.* -->$/, 'marker is the last line of the body');

  // Never an issue comment, and nothing is deleted (history is preserved
  // natively because a submitted review cannot be deleted).
  assert.ok(!calls.some((c) => /issues\/42\/comments/.test(c)), 'not posted as an issue comment');
  assert.ok(!calls.some((c) => c.includes('-X DELETE')), 'no deletion of prior content');
});

test('a 422 on a bad inline line retries body-only so the summary still lands', () => {
  const { calls, payloads } = postReview({ failOnComments: true });

  const reviewPosts = calls.filter((c) => /pulls\/42\/reviews/.test(c) && c.includes('--input'));
  assert.strictEqual(reviewPosts.length, 2, 'combined review rejected, then a body-only retry');
  assert.strictEqual(payloads.length, 2);

  const [combined, fallback] = payloads;
  assert.strictEqual(combined.comments.length, 1, 'first attempt carried the inline comments');

  assert.ok(!fallback.comments || fallback.comments.length === 0, 'retry carries no inline comments');
  assert.strictEqual(fallback.event, 'COMMENT', 'retry is still a COMMENT review');
  assert.strictEqual(fallback.commit_id, HEAD_SHA,
    'retry KEEPS commit_id so GitHub anchors the body-only review to the reviewed commit (atomic stale-verdict guard)');
  assert.ok(fallback.body.includes('could not be posted as inline comments'),
    'the rejected findings are folded into the retry body');
  assert.ok(fallback.body.includes('a folded finding'), 'the fallback finding text is present');
  assert.match(lastLine(fallback.body), /^<!-- ai-review verdict=.* -->$/, 'marker stays last after folding');
});

test('a non-422 failure is not retried, so the step fails without posting a duplicate review', () => {
  // A transient 5xx / timeout may mean the review actually landed despite gh's
  // non-zero exit, so a blind body-only retry could double-post. The script must
  // fail loudly (no retry) unless the failure is a retriable inline-line 422.
  const { payloads, failed, calls } = postReview({ failStatus: 500, allowFailure: true });
  assert.ok(failed, 'the step exits non-zero on a non-422 failure');
  const reviewPosts = calls.filter((c) => /pulls\/42\/reviews/.test(c) && c.includes('--input'));
  assert.strictEqual(reviewPosts.length, 1, 'exactly one POST attempt — no retry that could duplicate');
  assert.strictEqual(payloads.length, 1, 'no second review payload was built');
});

test('after an ordinary mid-run push the retry stays anchored to the reviewed commit (outdated, not the new head)', () => {
  // A push landed after the agent reviewed. The reviewed commit is still an
  // ancestor of the new head, so GitHub accepts the body-only retry and marks it
  // outdated — anchored to the code the agent actually saw, never to the new,
  // unreviewed head. This is the original bug's fix: the verdict is never pinned
  // to a commit the agent didn't review.
  const NEW_HEAD = 'abababababababababababababababababababab';
  const { calls, payloads, failed } = postReview({
    failOnComments: true,
    prShas: [HEAD_SHA, NEW_HEAD],
  });
  assert.strictEqual(failed, false, 'an outdated-but-valid commit is accepted, not a failure');
  const reviewPosts = calls.filter((c) => /pulls\/42\/reviews/.test(c) && c.includes('--input'));
  assert.strictEqual(reviewPosts.length, 2, 'combined rejected on the bad line, then a body-only retry');
  const fallback = payloads[1];
  assert.strictEqual(fallback.commit_id, HEAD_SHA, 'retry stays anchored to the reviewed commit, not the new head');
  assert.notStrictEqual(fallback.commit_id, NEW_HEAD, 'the verdict is never pinned to the unreviewed head');
});

test('a force-push that removes the reviewed commit fails closed instead of guessing', () => {
  // The reviewed commit was force-pushed out of the PR, so GitHub 422s both the
  // combined review and the body-only retry (its commit_id is gone). The step
  // fails loudly; a fresh review runs on the new head. Nothing is mislabelled.
  const NEW_HEAD = 'abababababababababababababababababababab';
  const { calls, payloads, failed } = postReview({
    prShas: [NEW_HEAD],
    allowFailure: true,
  });
  assert.ok(failed, 'the step exits non-zero — fail closed, no mislabelled post');
  const reviewPosts = calls.filter((c) => /pulls\/42\/reviews/.test(c) && c.includes('--input'));
  assert.strictEqual(reviewPosts.length, 2, 'combined rejected, body-only retry also rejected');
  assert.ok(
    payloads.every((p) => !('commit_id' in p) || p.commit_id === HEAD_SHA),
    'nothing was ever anchored to the new head — every attempt kept the reviewed sha',
  );
});

test('the tip is appended only when the ai-review label is absent', () => {
  const withLabel = postReview({ labelPresent: true }).payloads[0].body;
  const withoutLabel = postReview({ labelPresent: false }).payloads[0].body;
  assert.ok(!withLabel.includes('request an AI review yourself'), 'no tip when the label is present');
  assert.ok(withoutLabel.includes('request an AI review yourself'), 'tip shown when the label is absent');
  assert.ok(
    withoutLabel.includes('<summary>ℹ️ Tip: request an AI review yourself with the `ai-review` label</summary>'),
    'the tip lives inside its own collapsed <summary> so it stays low-footprint',
  );
  assert.match(lastLine(withoutLabel), /^<!-- ai-review verdict=.* -->$/, 'marker still last after the tip');
});

test('a run with no inline findings posts a single body-only COMMENT review', () => {
  const { calls, payloads } = postReview({ emptyComments: true });

  const reviewPosts = calls.filter((c) => /pulls\/42\/reviews/.test(c) && c.includes('--input'));
  assert.strictEqual(reviewPosts.length, 1, 'a single review is posted — no fallback needed');
  assert.strictEqual(payloads.length, 1);

  const [review] = payloads;
  assert.strictEqual(review.event, 'COMMENT', 'event is COMMENT');
  assert.ok(!('comments' in review), 'the empty comments key is dropped, not sent as comments: []');
  assert.strictEqual(review.commit_id, HEAD_SHA, 'a summary-only review is still anchored to the reviewed commit');
  assert.ok(review.body.includes('</details>'), 'the collapsed summary is the review body');
  assert.match(lastLine(review.body), /^<!-- ai-review verdict=.* -->$/, 'marker is the last line of the body');
  assert.ok(!calls.some((c) => /issues\/42\/comments/.test(c)), 'not posted as an issue comment');
});

// Regression guard for the hand-totalled FALLBACK_RESERVE in
// ai-review-compute-verdict.sh. On the body-only fallback, build_body wraps the
// folded findings in framing (separators + <details>), the optional `ai-review`
// label tip, and the trailing marker — everything the reserve is supposed to
// cover so a maximal fallback body cannot blow GitHub's hard comment limit
// (the fallback is exactly the path where an overflow would lose BOTH the
// summary and the findings). This pins the constant: if someone appends a new
// block to build_body without growing the reserve, this test fails.
test('the body-only fallback framing stays within FALLBACK_RESERVE', () => {
  // Label absent => the tip block is included, i.e. the maximal framing case.
  const { payloads, inputs } = postReview({ failOnComments: true, labelPresent: false });
  const fallbackBody = payloads[1].body;

  const verdictSrc = fs.readFileSync(path.join(SCRIPTS, 'ai-review-compute-verdict.sh'), 'utf8');
  const reserve = Number(/FALLBACK_RESERVE=(\d+)/.exec(verdictSrc)[1]);
  const limit = Number(/COMMENT_LIMIT=(\d+)/.exec(verdictSrc)[1]);

  // Everything build_body adds AROUND the reviewed body and the folded findings
  // is what the reserve must cover.
  const framing =
    Buffer.byteLength(fallbackBody) -
    Buffer.byteLength(inputs.bodyMd) -
    Buffer.byteLength(inputs.inlineFallback);
  assert.ok(
    framing <= reserve,
    `fallback framing is ${framing} bytes but FALLBACK_RESERVE is only ${reserve}; grow the reserve or shrink the framing`,
  );
  assert.ok(Buffer.byteLength(fallbackBody) <= limit, 'the fallback body stays under the API comment limit');
});
