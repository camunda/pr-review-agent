// Tests for check-breaking-change.sh — the PR title "!" and the BREAKING CHANGE
// footer must agree, and the footer must be the last paragraph.

const { test } = require('node:test');
const assert = require('node:assert');
const { runScript } = require('./helpers');

function check(title, body) {
  return runScript('check-breaking-change.sh', { env: { PR_TITLE: title, PR_BODY: body } });
}

const FOOTER = 'BREAKING CHANGE: the `foo` input is renamed to `bar`.';

test('plain fix without footer passes', () => {
  const res = check('fix: handle empty diff', 'Some text.');
  assert.strictEqual(res.status, 0, res.stdout);
});

test('empty body passes for a non-breaking title', () => {
  assert.strictEqual(check('docs: typo', '').status, 0);
});

test('"!" with footer as last paragraph passes', () => {
  const res = check('feat!: rename foo', `What and why.\n\n${FOOTER}`);
  assert.strictEqual(res.status, 0, res.stdout);
});

test('scoped "!" and BREAKING-CHANGE token pass', () => {
  const res = check('fix(config)!: drop key', 'Text.\n\nBREAKING-CHANGE: remove `x` from your config.');
  assert.strictEqual(res.status, 0, res.stdout);
});

test('CRLF line endings (GitHub web editor) are handled', () => {
  const res = check('feat!: rename foo', `What and why.\r\n\r\n${FOOTER}\r\n`);
  assert.strictEqual(res.status, 0, res.stdout);
});

test('footer followed by a trailer in the same paragraph passes', () => {
  const res = check('feat!: rename foo', `Text.\n\n${FOOTER}\nCo-Authored-By: someone <a@b.c>`);
  assert.strictEqual(res.status, 0, res.stdout);
});

test('"!" without footer fails', () => {
  const res = check('feat!: rename foo', 'What and why.');
  assert.strictEqual(res.status, 1);
  assert.match(res.stdout, /no 'BREAKING CHANGE:' paragraph/);
});

test('footer without "!" fails', () => {
  const res = check('feat: rename foo', `Text.\n\n${FOOTER}`);
  assert.strictEqual(res.status, 1);
  assert.match(res.stdout, /title has no '!'/);
});

test('footer that is not the last paragraph fails', () => {
  const res = check('feat!: rename foo', `Text.\n\n${FOOTER}\n\n🤖 Generated with Claude Code`);
  assert.strictEqual(res.status, 1);
  assert.match(res.stdout, /must be the last paragraph/);
});

test('quoted example in the template comment is not a footer', () => {
  const body = 'Text.\n\n<!--\nExample:\n"BREAKING CHANGE: the `foo` input is renamed."\n-->';
  assert.strictEqual(check('feat: add input', body).status, 0);
});

test('"!" elsewhere in the title does not count', () => {
  assert.strictEqual(check('fix: handle "!" in labels', 'Text.').status, 0);
});
