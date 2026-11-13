// Tests for ai-review-mask-session.sh: the security-critical masking pass that
// redacts secrets out of the AI review agent's output (a copy of the session
// transcript, and verdict.json / dedup.json in place) before it is uploaded as
// an artifact. A masking rule that silently stops
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

// In-place mode: the review job masks verdict.json and dedup.json before the
// `ai-review-verdict` upload, because `decide` posts their text on the PR.

/** Run the script in in-place mode on the given files. */
function runInPlace(files, { runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-runner-temp-')) } = {}) {
  return execFileSync('bash', [SCRIPT, ...files], {
    env: { ...process.env, ANTHROPIC_API_KEY, GITHUB_TOKEN, RUNNER_TEMP: runnerTemp },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
}

test('verdict.json and dedup.json are masked in place and stay valid JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-mask-'));
  const verdict = path.join(dir, 'verdict.json');
  const dedup = path.join(dir, 'dedup.json');
  fs.writeFileSync(
    verdict,
    JSON.stringify({
      verdict: 'NEEDS_HUMAN',
      summary: `Leaked: ${ANTHROPIC_API_KEY}`,
      findings: [{ path: 'a.js', line: 1, body: `token ${GITHUB_TOKEN} and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789` }],
    }),
  );
  fs.writeFileSync(dedup, JSON.stringify({ dropped: [{ reason: `see ${ANTHROPIC_API_KEY}` }] }));

  runInPlace([verdict, dedup]);

  for (const f of [verdict, dedup]) {
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!text.includes(ANTHROPIC_API_KEY), `${path.basename(f)}: ANTHROPIC_API_KEY must be gone`);
    assert.ok(!text.includes(GITHUB_TOKEN), `${path.basename(f)}: GITHUB_TOKEN must be gone`);
    assert.ok(!text.includes('ghp_ABCDEFGHIJ'), `${path.basename(f)}: token shapes must be gone`);
    assert.doesNotThrow(() => JSON.parse(text), `${path.basename(f)} must stay valid JSON`);
  }
  assert.strictEqual(JSON.parse(fs.readFileSync(verdict, 'utf8')).verdict, 'NEEDS_HUMAN', 'non-secret fields survive');
  assert.ok(!fs.existsSync(`${verdict}.masked`), 'no temp file left behind');
});

test('in-place mode skips a missing file (dedup.json is optional)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-mask-'));
  const verdict = path.join(dir, 'verdict.json');
  fs.writeFileSync(verdict, JSON.stringify({ summary: ANTHROPIC_API_KEY }));
  const stdout = runInPlace([verdict, path.join(dir, 'dedup.json')]);
  assert.ok(!fs.readFileSync(verdict, 'utf8').includes(ANTHROPIC_API_KEY));
  assert.match(stdout, /Nothing to mask at .*dedup\.json/);
});

test('in-place mode fails closed when masking fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-mask-'));
  const verdict = path.join(dir, 'verdict.json');
  fs.writeFileSync(verdict, JSON.stringify({ summary: ANTHROPIC_API_KEY }));
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-runner-temp-'));
  // A read-only directory makes the final `mv` into place fail.
  fs.chmodSync(dir, 0o500);
  try {
    assert.throws(() => runInPlace([verdict], { runnerTemp }), 'the step must fail so the file is not uploaded');
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  assert.deepStrictEqual(fs.readdirSync(runnerTemp), [], 'no half-masked temp file remains');
});

test('in-place mode refuses a symlink and never writes through one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-mask-'));
  const trusted = path.join(dir, 'trusted.sh');
  fs.writeFileSync(trusted, 'echo ORIGINAL\n');
  const verdict = path.join(dir, 'verdict.json');
  fs.symlinkSync(trusted, verdict);
  assert.throws(() => runInPlace([verdict]), 'a symlinked input must fail the step');
  assert.strictEqual(fs.readFileSync(trusted, 'utf8'), 'echo ORIGINAL\n', 'the symlink target is untouched');
});

test('in-place mode ignores a planted <file>.masked symlink', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-mask-'));
  const trusted = path.join(dir, 'trusted.sh');
  fs.writeFileSync(trusted, 'echo ORIGINAL\n');
  const verdict = path.join(dir, 'verdict.json');
  fs.writeFileSync(verdict, `echo PWNED ${ANTHROPIC_API_KEY}\n`);
  fs.symlinkSync(trusted, `${verdict}.masked`);
  runInPlace([verdict]);
  assert.strictEqual(fs.readFileSync(trusted, 'utf8'), 'echo ORIGINAL\n', 'the trusted script is untouched');
  assert.ok(!fs.lstatSync(verdict).isSymbolicLink(), 'verdict.json stays a regular file');
  assert.ok(!fs.readFileSync(verdict, 'utf8').includes(ANTHROPIC_API_KEY));
});

test('in-place mode refuses a directory, which would be uploaded unmasked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-mask-'));
  const dedup = path.join(dir, 'dedup.json');
  fs.mkdirSync(dedup);
  fs.writeFileSync(path.join(dedup, 'leak.json'), JSON.stringify({ k: ANTHROPIC_API_KEY }));
  assert.throws(() => runInPlace([dedup]), 'a directory input must fail the step');
  assert.deepStrictEqual(fs.readdirSync(dedup), ['leak.json'], 'nothing is moved into the directory');
});
