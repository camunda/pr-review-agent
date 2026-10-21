// Tests for should-review.sh — the trigger filter.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runScript, tmpdir, resolveConfig, MINIMAL_CONFIG } = require('./helpers');

const { file: CONFIG_FILE } = resolveConfig(MINIMAL_CONFIG);
const { file: DRAFTS_CONFIG } = resolveConfig(`${MINIMAL_CONFIG}\ntriggers:\n  review_drafts: true\n`);

function event({ action = 'opened', draft = false, labels = [], label, author = 'alice', headRepo = 'acme/widgets' } = {}) {
  return {
    action,
    ...(label ? { label: { name: label } } : {}),
    pull_request: {
      draft,
      labels: labels.map((name) => ({ name })),
      user: { login: author },
      head: { repo: { full_name: headRepo } },
    },
  };
}

function decide(ev, { eventName = 'pull_request', config = CONFIG_FILE } = {}) {
  const dir = tmpdir('should');
  const evPath = path.join(dir, 'event.json');
  fs.writeFileSync(evPath, JSON.stringify(ev));
  const res = runScript('should-review.sh', {
    cwd: dir,
    env: { GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: evPath, GITHUB_REPOSITORY: 'acme/widgets', CONFIG_FILE: config },
  });
  assert.strictEqual(res.status, 0, res.stderr);
  return res.outputs;
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
