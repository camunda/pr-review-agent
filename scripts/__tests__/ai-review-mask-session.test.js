// Tests for ai-review-mask-session.sh: the security-critical masking pass that
// redacts secrets out of a COPY of the AI review agent's session transcript
// before it is uploaded as an artifact. A masking rule that silently stops
// matching is a leaked secret, so these are regression coverage for the seal.
//
// The script is executed as a subprocess in a temp dir so the test exercises
// the real perl/bash logic, not a reimplementation.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.resolve(__dirname, '..', 'ai-review-mask-session.sh');

const ANTHROPIC_API_KEY = 'sk-ant-api03-EXAMPLEsecretVALUE0123456789abcdef';
const GITHUB_TOKEN = 'ghs_EXAMPLEliteraltokenVALUE0123456789abcd';

/**
 * Run the masking script against a transcript string and return the masked
 * output (or null when the script produced no file).
 */
function run(transcript, { execEnv = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-mask-'));
  const input = path.join(dir, 'transcript.json');
  const out = path.join(dir, 'masked.json');
  fs.writeFileSync(input, transcript);

  const stdout = execFileSync('bash', [SCRIPT], {
    env: {
      ...process.env,
      EXECUTION_FILE: input,
      MASKED_FILE: out,
      ANTHROPIC_API_KEY,
      GITHUB_TOKEN,
      ...execEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();

  const masked = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
  return { masked, stdout, out };
}

test('literal ANTHROPIC_API_KEY and GITHUB_TOKEN values are redacted', () => {
  const { masked } = run(
    JSON.stringify({
      a: `key is ${ANTHROPIC_API_KEY} embedded`,
      b: `token ${GITHUB_TOKEN} here`,
    }),
  );
  assert.ok(!masked.includes(ANTHROPIC_API_KEY), 'ANTHROPIC_API_KEY value must be gone');
  assert.ok(!masked.includes(GITHUB_TOKEN), 'GITHUB_TOKEN value must be gone');
  assert.ok(masked.includes('***REDACTED***'), 'redaction marker must be present');
});

test('common plaintext token shapes are redacted', () => {
  const cases = {
    githubPat: 'github_pat_ABCDEFGHIJKLMNOPQRSTUV_0123456789abcdef',
    ghp: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    skAnt: 'sk-ant-OTHERkeyVALUE0123456789abcdef',
    openai: 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
    aws: 'AKIAIOSFODNN7EXAMPLE',
    jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123',
  };
  const { masked } = run(JSON.stringify({ note: Object.values(cases).join(' | ') }));
  for (const [name, secret] of Object.entries(cases)) {
    assert.ok(!masked.includes(secret), `${name} shape must be redacted`);
  }
});

test('Bearer and Authorization: basic credentials are redacted, headers preserved', () => {
  const { masked } = run(
    JSON.stringify({
      bearer: 'Authorization: Bearer abcDEF0123456789ghiJKL_mnop',
      basic: 'AUTHORIZATION: basic dXNlcm5hbWU6c3VwZXJzZWNyZXQ=',
    }),
  );
  assert.ok(!masked.includes('abcDEF0123456789ghiJKL_mnop'), 'Bearer value must be redacted');
  assert.ok(!masked.includes('dXNlcm5hbWU6c3VwZXJzZWNyZXQ='), 'basic base64 must be redacted');
  // The header names survive so the transcript stays readable.
  assert.ok(masked.includes('Bearer ***REDACTED***'), 'Bearer prefix preserved');
  assert.ok(/basic \*\*\*REDACTED\*\*\*/i.test(masked), 'basic prefix preserved');
});

test('the Bearer auth scheme is matched case-insensitively', () => {
  // HTTP auth schemes are case-insensitive (RFC 7235), so a non-canonical
  // `bearer`/`BEARER` must be redacted just like the canonical `Bearer`.
  const token = 'loWERcaseBEARERtoken0123456789xy';
  const { masked } = run(
    JSON.stringify({
      lower: `authorization: bearer ${token}`,
      upper: `Authorization: BEARER ${token}`,
    }),
  );
  assert.ok(!masked.includes(token), 'a lowercase/uppercase bearer token must be redacted');
});

test('masked output is still valid JSON', () => {
  const { masked } = run(
    JSON.stringify({
      key: ANTHROPIC_API_KEY,
      auth: 'AUTHORIZATION: basic dXNlcjpwYXNz',
      nested: { token: GITHUB_TOKEN, note: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' },
    }),
  );
  assert.doesNotThrow(() => JSON.parse(masked), 'redaction must not break JSON validity');
});

test('non-secret content is left intact', () => {
  const transcript = JSON.stringify({ msg: 'The review found a null check missing on line 42.' });
  const { masked } = run(transcript);
  assert.ok(masked.includes('null check missing on line 42'), 'ordinary prose must be untouched');
  assert.ok(!masked.includes('***REDACTED***'), 'nothing to redact here');
});

test('an empty/missing transcript produces no output file and exits cleanly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-mask-'));
  const out = path.join(dir, 'masked.json');
  const stdout = execFileSync('bash', [SCRIPT], {
    env: { ...process.env, EXECUTION_FILE: '', MASKED_FILE: out, ANTHROPIC_API_KEY, GITHUB_TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
  assert.ok(!fs.existsSync(out), 'no artifact should be written when there is no transcript');
  assert.match(stdout, /No session transcript to mask/, 'warns about the missing transcript');
});

test('a masking failure leaves no half-masked output behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-mask-'));
  const input = path.join(dir, 'transcript.json');
  fs.writeFileSync(input, JSON.stringify({ key: ANTHROPIC_API_KEY }));
  // Force the masking pass to fail by pointing the output at a directory that
  // does not exist: the `> "$out"` redirection fails before any bytes land, so
  // the script must take its failure branch and remove the partial file.
  const out = path.join(dir, 'missing-subdir', 'masked.json');
  const stdout = execFileSync('bash', [SCRIPT], {
    env: { ...process.env, EXECUTION_FILE: input, MASKED_FILE: out, ANTHROPIC_API_KEY, GITHUB_TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
  assert.ok(!fs.existsSync(out), 'no half-masked artifact should remain after a failure');
  assert.match(stdout, /Masking pass failed/, 'warns that the masking pass failed');
});
