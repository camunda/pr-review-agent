// Tests for load-config.sh: config source (caller repo, default branch),
// defaults, validation and built-in escalation rules.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, runScript, configEnv, MINIMAL_CONFIG, resolveConfig } = require('./helpers');

function load(yaml, env = {}) {
  return runScript('load-config.sh', { env: { ...configEnv(yaml).env, ...env } });
}

test('a minimal config resolves with safe defaults', () => {
  const { config, outputs } = resolveConfig(MINIMAL_CONFIG);
  assert.strictEqual(config.shadow_mode, true, 'shadow mode is on unless explicitly disabled');
  assert.deepStrictEqual(config.policy.rubric, { from: 'agent', path: 'prompts/rubric-default.md' });
  assert.deepStrictEqual(config.policy.skills, []);
  assert.strictEqual(config.triggers.opt_in_label, 'ai-review');
  assert.deepStrictEqual(config.triggers.skip_authors, ['renovate[bot]', 'dependabot[bot]']);
  assert.strictEqual(config.labels.needs_human, '');
  assert.strictEqual(outputs.shadow_mode, 'true');
  assert.strictEqual(outputs.vault_anthropic_secret, 'secret/data/products/acme/ci/common ANTHROPIC_API_KEY | ANTHROPIC_API_KEY ;');
  assert.strictEqual(outputs.timeout_minutes, '15');
});

test('the config is read from the caller repo at its default branch', () => {
  const { env, ghLog } = configEnv(MINIMAL_CONFIG);
  const res = runScript('load-config.sh', { env });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(res.outputs.found, 'true');
  assert.match(fs.readFileSync(ghLog, 'utf8'),
    /application\/vnd\.github\.raw\+json repos\/acme\/widgets\/contents\/\.github\/pr-review-agent\/team\.yml\?ref=main/);
});

test('the default branch name is URL-encoded in the config request', () => {
  const { env, ghLog } = configEnv(MINIMAL_CONFIG);
  runScript('load-config.sh', { env: { ...env, DEFAULT_BRANCH: 'release+stable&x#1' } });
  assert.match(fs.readFileSync(ghLog, 'utf8'), /\?ref=release%2Bstable%26x%231$/m);
});

test('a config not yet on the default branch skips the review with a notice', () => {
  const res = load(MINIMAL_CONFIG, { DEFAULT_BRANCH: 'develop' });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(res.outputs.found, 'false');
  assert.strictEqual(res.outputs.config_file, undefined);
  assert.match(res.stdout, /::notice::.*no config '\.github\/pr-review-agent\/team\.yml' on acme\/widgets@develop yet/);
});

test('any other error reading the config fails the run', () => {
  const res = load(MINIMAL_CONFIG, { DEFAULT_BRANCH: 'broken' });
  assert.notStrictEqual(res.status, 0);
  assert.match(res.stderr, /could not read .*HTTP 500/);
});

test('a missing DEFAULT_BRANCH is rejected', () => {
  const res = load(MINIMAL_CONFIG, { DEFAULT_BRANCH: '' });
  assert.notStrictEqual(res.status, 0);
  assert.match(res.stderr, /DEFAULT_BRANCH is required/);
});

test('the reviewer workflow and config are always escalation paths, before team rules', () => {
  const { config } = resolveConfig(`${MINIMAL_CONFIG}
escalation:
  rules:
    - reason: db
      paths: ["db/*"]
`);
  const rules = config.escalation.effective_rules;
  assert.deepStrictEqual(rules[0], { reason: 'reviewer workflow', paths: ['.github/workflows/*'] });
  assert.deepStrictEqual(rules[1], { reason: 'reviewer config', paths: ['.github/pr-review-agent/*'] });
  assert.deepStrictEqual(rules.at(-1), { reason: 'db', paths: ['db/*'] });
});

test('review policy files read from the repo become an escalation rule', () => {
  const { config } = resolveConfig(`${MINIMAL_CONFIG}
policy:
  rubric: { from: repo, path: docs/rubric.md }
  skills:
    - path: .agents/skills/review/SKILL.md
    - { from: agent, path: prompts/rubric-default.md }
`);
  const rule = config.escalation.builtin_rules.find((r) => r.reason === 'review policy change');
  assert.deepStrictEqual(rule.paths, ['docs/rubric.md', '.agents/skills/review/SKILL.md']);
  assert.strictEqual(config.policy.skills[0].from, 'repo', 'skills default to from: repo');
});

for (const [label, name] of [['path traversal', '../etc'], ['uppercase', 'Team'], ['empty', '']]) {
  test(`an invalid config name is rejected (${label})`, () => {
    const res = load(MINIMAL_CONFIG, { CONFIG_NAME: name });
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /invalid config name/);
  });
}

const invalid = {
  'missing vault path': ['schema_version: 1\n', /vault\.anthropic_api_key\.path is required/],
  'repositories key (configs now live in the repo they govern)': [`${MINIMAL_CONFIG}\nrepositories: [acme/widgets]\n`, /unknown key\(s\): repositories/],
  'unknown top-level key': [`${MINIMAL_CONFIG}\nshadow: false\n`, /unknown key\(s\): shadow/],
  'nested typo (escalation.rule)': [`${MINIMAL_CONFIG}\nescalation:\n  rule:\n    - reason: db\n      paths: ["db/*"]\n`, /unknown key\(s\): escalation\.rule/],
  'nested typo in a rule': [`${MINIMAL_CONFIG}\nescalation:\n  rules:\n    - reason: db\n      path: ["db/*"]\n`, /escalation\.rules\[0\]\.path/],
  'nested typo in a skill': [`${MINIMAL_CONFIG}\npolicy:\n  skills:\n    - { path: a.md, form: repo }\n`, /policy\.skills\[0\]\.form/],
  'nested typo in triggers': [`${MINIMAL_CONFIG}\ntriggers:\n  skip_author: [x]\n`, /triggers\.skip_author/],
  'section is not a mapping': [`${MINIMAL_CONFIG}\nlabels: review/needs-human\n`, /must be mappings: labels/],
  'non-boolean shadow_mode': [`${MINIMAL_CONFIG}\nshadow_mode: "no"\n`, /shadow_mode must be true or false/],
  'wildcard allowed_bots': [`${MINIMAL_CONFIG}\nagent:\n  allowed_bots: ["*"]\n`, /allowed_bots/],
  'policy path traversal': [`${MINIMAL_CONFIG}\npolicy:\n  skills:\n    - path: ../../secrets.md\n`, /policy\.skills\[0\]\.path/],
  'absolute policy path': [`${MINIMAL_CONFIG}\npolicy:\n  rubric: { from: repo, path: /etc/passwd }\n`, /policy\.rubric\.path/],
  'bad policy source': [`${MINIMAL_CONFIG}\npolicy:\n  rubric: { from: web, path: r.md }\n`, /policy\.rubric\.from/],
  'missing agent policy file': [`${MINIMAL_CONFIG}\npolicy:\n  rubric: { from: agent, path: config/nope.md }\n`, /does not exist in pr-review-agent/],
  'rule without paths': [`${MINIMAL_CONFIG}\nescalation:\n  rules:\n    - reason: db\n`, /paths must be a non-empty list/],
  'rule with brace glob': [`${MINIMAL_CONFIG}\nescalation:\n  rules:\n    - reason: db\n      paths: ["{a,b}/*"]\n`, /invalid glob/],
  'rule with bad reason': [`${MINIMAL_CONFIG}\nescalation:\n  rules:\n    - reason: "x\\ny"\n      paths: ["a/*"]\n`, /reason must be/],
  'numeric label': [`${MINIMAL_CONFIG}\ntriggers:\n  opt_in_label: 5\n`, /opt_in_label is invalid/],
  'bad mention': [`${MINIMAL_CONFIG}\nnotifications:\n  capture_alert_mentions: ["everyone"]\n`, /capture_alert_mentions/],
  'timeout out of range': [`${MINIMAL_CONFIG}\nagent:\n  timeout_minutes: 600\n`, /timeout_minutes/],
};
for (const [label, [yaml, pattern]] of Object.entries(invalid)) {
  test(`validation rejects: ${label}`, () => {
    const res = load(yaml);
    assert.notStrictEqual(res.status, 0, 'expected a validation failure');
    assert.match(res.stderr, pattern);
  });
}

test('the example team config is valid', () => {
  const yaml = fs.readFileSync(path.join(ROOT, 'examples', 'config', 'my-team.yml'), 'utf8');
  const res = load(yaml);
  assert.strictEqual(res.status, 0, res.stderr);
});
