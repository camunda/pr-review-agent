// vault-wrap-key.sh / vault-unwrap-key.sh hand the Anthropic key from the
// `config` job to the `review` job as a single-use Vault wrapping token.
// `curl` is stubbed: it logs its argv, its headers and its body, and answers
// with a canned response.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runScript, tmpdir } = require('./helpers');

const KEY = 'sk-ant-test-key';
const VAULT_TOKEN = 'hvb.login-token';
const WRAP_TOKEN = 'hvs.wrapping-token';

/** Run `script` with a stub curl that answers `response` and exits `exit`. */
function withCurl(script, { response, exit = 0, env = {} }) {
  const dir = tmpdir('vault');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(dir, 'response'), JSON.stringify(response));
  fs.writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env bash
echo "ARGV $*" >> '${dir}/argv'
args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  if [ "\${args[i]}" = -H ]; then
    h=\${args[i+1]}
    if [ "\${h:0:1}" = @ ]; then cat "\${h:1}" >> '${dir}/headers'; else echo "$h" >> '${dir}/headers'; fi
  fi
done
case "$*" in *--data*) cat > '${dir}/body' ;; esac
cat '${dir}/response'
exit ${exit}
`);
  fs.chmodSync(path.join(bin, 'curl'), 0o755);
  const res = runScript(script, {
    cwd: dir,
    env: { PATH: `${bin}:${process.env.PATH}`, VAULT_ADDR: 'https://vault.example/', ...env },
  });
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : '');
  return { res, argv: read('argv'), headers: read('headers'), body: read('body') };
}

const wrap = (opts) => withCurl('vault-wrap-key.sh', {
  ...opts, env: { VAULT_TOKEN, ANTHROPIC_API_KEY: KEY, ...opts.env },
});
const unwrap = (opts) => withCurl('vault-unwrap-key.sh', { ...opts, env: { WRAP_TOKEN, ...opts.env } });

test('wrap: wraps only the key and outputs the wrapping token', () => {
  const { res, argv, headers, body } = wrap({ response: { wrap_info: { token: WRAP_TOKEN, ttl: 1800 } } });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(res.outputs.wrap_token, WRAP_TOKEN);
  assert.deepStrictEqual(JSON.parse(body), { ANTHROPIC_API_KEY: KEY });
  assert.match(argv, /https:\/\/vault\.example\/v1\/sys\/wrapping\/wrap/);
  assert.match(headers, new RegExp(`X-Vault-Token: ${VAULT_TOKEN}`));
  assert.match(headers, /X-Vault-Wrap-TTL: 30m/);
});

test('wrap: never puts the key or the Vault token on argv or in the log', () => {
  const { res, argv } = wrap({ response: { wrap_info: { token: WRAP_TOKEN } } });
  for (const secret of [KEY, VAULT_TOKEN]) assert.ok(!argv.includes(secret), `${secret} on argv`);
  for (const secret of [KEY, VAULT_TOKEN, WRAP_TOKEN]) assert.ok(!res.stdout.includes(secret), `${secret} in log`);
});

test('wrap: WRAP_TTL overrides the default TTL', () => {
  const { headers } = wrap({ response: { wrap_info: { token: WRAP_TOKEN } }, env: { WRAP_TTL: '5m' } });
  assert.match(headers, /X-Vault-Wrap-TTL: 5m/);
});

test('wrap: fails with the Vault error when Vault refuses', () => {
  const { res } = wrap({ response: { errors: ['permission denied'] }, exit: 22 });
  assert.strictEqual(res.status, 1);
  assert.match(res.stdout, /refused to wrap.*permission denied/);
  assert.strictEqual(res.outputs.wrap_token, undefined);
});

test('wrap: fails when Vault returns no wrapping token', () => {
  const { res } = wrap({ response: { data: {} } });
  assert.strictEqual(res.status, 1);
  assert.match(res.stdout, /no wrapping token/);
  assert.strictEqual(res.outputs.wrap_token, undefined);
});

test('unwrap: outputs the key, masked, and keeps the token off argv', () => {
  const { res, argv, headers } = unwrap({ response: { data: { ANTHROPIC_API_KEY: KEY } } });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(res.outputs.ANTHROPIC_API_KEY, KEY);
  assert.ok(res.stdout.includes(`::add-mask::${KEY}`));
  assert.match(argv, /https:\/\/vault\.example\/v1\/sys\/wrapping\/unwrap/);
  assert.ok(!argv.includes(WRAP_TOKEN));
  assert.match(headers, new RegExp(`X-Vault-Token: ${WRAP_TOKEN}`));
});

test('unwrap: fails and flags possible tampering when the token is already used', () => {
  const { res } = unwrap({ response: { errors: ['wrapping token is not valid or does not exist'] }, exit: 22 });
  assert.strictEqual(res.status, 1);
  assert.match(res.stdout, /not valid or does not exist/);
  assert.match(res.stdout, /tampering/);
  assert.strictEqual(res.outputs.ANTHROPIC_API_KEY, undefined);
});

test('unwrap: fails when the response holds no key', () => {
  const { res } = unwrap({ response: { data: { OTHER: 'x' } } });
  assert.strictEqual(res.status, 1);
  assert.match(res.stdout, /no ANTHROPIC_API_KEY/);
});

test('unwrap: fails without a wrapping token', () => {
  const { res } = unwrap({ response: {}, env: { WRAP_TOKEN: '' } });
  assert.notStrictEqual(res.status, 0);
  assert.match(res.stderr, /WRAP_TOKEN is required/);
});
