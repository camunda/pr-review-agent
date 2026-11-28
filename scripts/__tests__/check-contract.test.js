// Tests for check-contract.sh — a breaking change to the caller contract of the
// reusable workflow (workflow_call inputs, secrets, outputs, job permissions)
// needs "!" in the PR title.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, runScript, contractRepo } = require('./helpers');

const WORKFLOW = '.github/workflows/pr-review.yml';

// A small synthetic workflow, so that the tests do not change with pr-review.yml.
const BASE = `name: test
on:
  workflow_call:
    inputs:
      config:
        required: true
        type: string
      force_shadow_mode:
        required: false
        type: boolean
        default: false
      runs_on:
        type: string
        default: ubuntu-slim
      egress_policy:
        type: string
        default: block
      extra:
        type: string
    secrets:
      VAULT_ADDR:
        required: true
      VAULT_ROLE_ID:
        required: false
      VAULT_SECRET_ID:
    outputs:
      verdict:
        description: The verdict.
        value: \${{ jobs.decide.outputs.verdict }}
      reviewed:
        description: Whether a review ran.
        value: \${{ jobs.decide.outputs.reviewed }}
jobs:
  config:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - run: echo config
  decide:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - run: echo decide
`;

/** Apply a yq expression to a workflow YAML text. */
function edit(expr, yaml = BASE) {
  return execFileSync('yq', [expr, '-'], { input: yaml, encoding: 'utf8' });
}

function check({ base = BASE, head = base, title }) {
  const { dir, baseSha } = contractRepo({ base: { [WORKFLOW]: base }, head: { [WORKFLOW]: head } });
  const res = runScript('check-contract.sh', { cwd: dir, env: { BASE_SHA: baseSha, PR_TITLE: title } });
  return { ...res, out: res.stdout + res.stderr };
}

const NO_INPUT = 'del(.on.workflow_call.inputs.runs_on)';

test('no change passes', () => {
  const res = check({ title: 'fix: x' });
  assert.strictEqual(res.status, 0, res.out);
  assert.doesNotMatch(res.out, /::(error|notice|warning)/);
});

test('removed input is breaking', () => {
  const res = check({ head: edit(NO_INPUT), title: 'fix: x' });
  assert.strictEqual(res.status, 1, res.out);
  assert.match(res.out, /::error title=Breaking change::inputs\.runs_on: removed/);
});

test('removed input with ! passes', () => {
  const res = check({ head: edit(NO_INPUT), title: 'fix!: x' });
  assert.strictEqual(res.status, 0, res.out);
  assert.match(res.out, /::notice title=Breaking change::inputs\.runs_on: removed/);
  assert.doesNotMatch(res.out, /::error/);
});

test('scoped bang counts', () => {
  const res = check({ head: edit(NO_INPUT), title: 'fix(config)!: x' });
  assert.strictEqual(res.status, 0, res.out);
});

test('new required input is breaking', () => {
  const head = edit('.on.workflow_call.inputs.team = {"required": true, "type": "string"}');
  const res = check({ head, title: 'feat: x' });
  assert.strictEqual(res.status, 1, res.out);
  assert.match(res.out, /inputs\.team: new required input/);
});

test('new optional input passes', () => {
  const head = edit('.on.workflow_call.inputs.team = {"required": false, "type": "string", "default": ""}');
  const res = check({ head, title: 'feat: x' });
  assert.strictEqual(res.status, 0, res.out);
});

test('changed default is breaking', () => {
  const res = check({ head: edit('.on.workflow_call.inputs.egress_policy.default = "audit"'), title: 'fix: x' });
  assert.strictEqual(res.status, 1, res.out);
  assert.match(res.out, /inputs\.egress_policy: default/);
});

test('added default is breaking', () => {
  const res = check({ head: edit('.on.workflow_call.inputs.extra.default = "x"'), title: 'fix: x' });
  assert.strictEqual(res.status, 1, res.out);
  assert.match(res.out, /inputs\.extra: default/);
});

test('changed type is breaking', () => {
  const head = edit('.on.workflow_call.inputs.force_shadow_mode.type = "string"');
  const res = check({ head, title: 'fix: x' });
  assert.strictEqual(res.status, 1, res.out);
  assert.match(res.out, /inputs\.force_shadow_mode: type/);
});

test('optional to required is breaking', () => {
  const head = edit('.on.workflow_call.secrets.VAULT_ROLE_ID.required = true');
  const res = check({ head, title: 'fix: x' });
  assert.strictEqual(res.status, 1, res.out);
  assert.match(res.out, /secrets\.VAULT_ROLE_ID: /);
});

test('required to optional passes', () => {
  const head = edit('.on.workflow_call.secrets.VAULT_ADDR.required = false');
  const res = check({ head, title: 'fix: x' });
  assert.strictEqual(res.status, 0, res.out);
});

test('removed output is breaking', () => {
  const res = check({ head: edit('del(.on.workflow_call.outputs.reviewed)'), title: 'fix: x' });
  assert.strictEqual(res.status, 1, res.out);
  assert.match(res.out, /outputs\.reviewed: removed/);
});

test('new output passes', () => {
  const head = edit('.on.workflow_call.outputs.selected = {"description": "x", "value": "y"}');
  const res = check({ head, title: 'feat: x' });
  assert.strictEqual(res.status, 0, res.out);
});

test('output description change warns', () => {
  const head = edit('.on.workflow_call.outputs.verdict.description = "Another text."');
  const res = check({ head, title: 'fix: x' });
  assert.strictEqual(res.status, 0, res.out);
  assert.match(res.out, /::warning title=Output description changed::outputs\.verdict/);
});

test('new permission scope is breaking', () => {
  const res = check({ head: edit('.jobs.decide.permissions.actions = "read"'), title: 'fix: x' });
  assert.strictEqual(res.status, 1, res.out);
  assert.match(res.out, /permissions\.actions: read/);
});

test('read to write is breaking', () => {
  const res = check({ head: edit('.jobs.config.permissions.contents = "write"'), title: 'fix: x' });
  assert.strictEqual(res.status, 1, res.out);
  assert.match(res.out, /permissions\.contents: write/);
});

test('new job with known scopes passes', () => {
  const head = edit('.jobs.extra = {"runs-on": "ubuntu-latest", "permissions": {"contents": "read"}, "steps": [{"run": "echo"}]}');
  const res = check({ head, title: 'fix: x' });
  assert.strictEqual(res.status, 0, res.out);
});

test('removed permission passes', () => {
  const res = check({ head: edit('del(.jobs.config.permissions.id-token)'), title: 'fix: x' });
  assert.strictEqual(res.status, 0, res.out);
});

test('null blocks do not crash', () => {
  const base = edit('del(.on.workflow_call.outputs) | del(.jobs.decide.permissions)');
  const head = edit('.on.workflow_call.outputs.selected = {"description": "x", "value": "y"}', base);
  const res = check({ base, head, title: 'feat: x' });
  assert.strictEqual(res.status, 0, res.out);
});

test('job without permissions inherits the workflow block', () => {
  const base = edit('.permissions = {} | del(.jobs.decide.permissions)');
  const head = edit('.permissions = {"actions": "read"}', base);
  const res = check({ base, head, title: 'fix: x' });
  assert.strictEqual(res.status, 1, res.out);
  assert.match(res.out, /permissions\.actions: read/);
});

test('removed default is breaking', () => {
  const res = check({ head: edit('del(.on.workflow_call.inputs.runs_on.default)'), title: 'fix: x' });
  assert.strictEqual(res.status, 1, res.out);
  assert.match(res.out, /inputs\.runs_on: default changed from "ubuntu-slim" to ""/);
});

// GitHub uses false, 0 or "" when an optional input has no default.
test('removing a default equal to the implicit one passes', () => {
  const res = check({ head: edit('del(.on.workflow_call.inputs.force_shadow_mode.default)'), title: 'fix: x' });
  assert.strictEqual(res.status, 0, res.out);
  assert.doesNotMatch(res.out, /::error/);
});

test('adding a default equal to the implicit one passes', () => {
  const res = check({ head: edit('.on.workflow_call.inputs.extra.default = ""'), title: 'fix: x' });
  assert.strictEqual(res.status, 0, res.out);
  assert.doesNotMatch(res.out, /::error/);
});

test('new required secret is breaking', () => {
  const res = check({ head: edit('.on.workflow_call.secrets.TOKEN = {"required": true}'), title: 'feat: x' });
  assert.strictEqual(res.status, 1, res.out);
  assert.match(res.out, /secrets\.TOKEN: new required secret/);
});

test('missing base workflow fails with an error', () => {
  const { dir, baseSha } = contractRepo({ base: { [WORKFLOW]: null }, head: { [WORKFLOW]: BASE } });
  const res = runScript('check-contract.sh', { cwd: dir, env: { BASE_SHA: baseSha, PR_TITLE: 'fix: x' } });
  const out = res.stdout + res.stderr;
  assert.strictEqual(res.status, 1, out);
  assert.match(out, /::error::cannot read \.github\/workflows\/pr-review\.yml at the base commit/);
});

test('invalid head YAML fails with a parse error', () => {
  const res = check({ head: 'on: [unclosed\n', title: 'fix: x' });
  assert.strictEqual(res.status, 1, res.out);
  assert.match(res.out, /::error::\.github\/workflows\/pr-review\.yml: cannot parse YAML/);
  assert.doesNotMatch(res.out, /permissions/);
});

// Team config part: the base fixtures run through the base and the head
// load-config.sh. The head changes load-config.sh with a small text replace.

const LOAD_CONFIG = 'scripts/load-config.sh';
const FIXTURES = 'scripts/__tests__/fixtures/contract';
const loadConfig = fs.readFileSync(path.join(ROOT, LOAD_CONFIG), 'utf8');

/** Replace `from` with `to` in load-config.sh; fail when `from` is not there. */
function replaceIn(text, from, to) {
  assert.ok(text.includes(from), `load-config.sh does not contain ${from}`);
  return text.replace(from, to);
}

function checkConfig({ base = {}, head = {}, title }) {
  const { dir, baseSha } = contractRepo({
    base: { [WORKFLOW]: BASE, ...base },
    head: { [WORKFLOW]: BASE, ...head },
  });
  const res = runScript('check-contract.sh', { cwd: dir, env: { BASE_SHA: baseSha, PR_TITLE: title } });
  return { ...res, out: res.stdout + res.stderr };
}

test('unchanged config passes', () => {
  const res = checkConfig({ title: 'fix: x' });
  assert.strictEqual(res.status, 0, res.out);
  assert.doesNotMatch(res.out, /::(error|notice|warning)/);
});

test('removed config key is breaking', () => {
  const head = { [LOAD_CONFIG]: replaceIn(loadConfig, '"review_drafts",', '') };
  const res = checkConfig({ head, title: 'fix: x' });
  assert.strictEqual(res.status, 1, res.out);
  assert.match(res.out, /::error title=Breaking change::config full\.yml: rejected: .*unknown key\(s\): triggers\.review_drafts/);
});

test('changed config default is breaking', () => {
  const head = { [LOAD_CONFIG]: replaceIn(loadConfig, 'dflt("ai-review")', 'dflt("ai")') };
  const res = checkConfig({ head, title: 'fix: x' });
  assert.strictEqual(res.status, 1, res.out);
  assert.match(res.out, /::error title=Breaking change::config minimal\.yml: triggers\.opt_in_label changed/);
  // full.yml sets the label, so its resolved value does not change.
  assert.doesNotMatch(res.out, /config full\.yml/);
});

test('new nested default passes', () => {
  let text = replaceIn(loadConfig, 'model: (.agent.model | dflt("")),',
    'foo: (.agent.foo | dflt(1)),\n      model: (.agent.model | dflt("")),');
  text = replaceIn(text, '["model","dedup_model","allowed_bots","timeout_minutes"]',
    '["foo","model","dedup_model","allowed_bots","timeout_minutes"]');
  const res = checkConfig({ head: { [LOAD_CONFIG]: text }, title: 'feat: x' });
  assert.strictEqual(res.status, 0, res.out);
  assert.doesNotMatch(res.out, /::(error|notice|warning)/);
});

test('new list-entry default passes', () => {
  let text = replaceIn(loadConfig, 'map(.from |= dflt("repo"))',
    'map(.from |= dflt("repo") | .optional |= dflt(false))');
  text = replaceIn(text, '"policy.skills[\\($i)]"; ["from","path"]', '"policy.skills[\\($i)]"; ["from","path","optional"]');
  const res = checkConfig({ head: { [LOAD_CONFIG]: text }, title: 'feat: x' });
  assert.strictEqual(res.status, 0, res.out);
  assert.doesNotMatch(res.out, /::(error|notice|warning)/);
});

test('dropped list entry is breaking', () => {
  // edge.yml has two skills; the head keeps only the first.
  const head = { [LOAD_CONFIG]: replaceIn(loadConfig, 'map(.from |= dflt("repo"))', 'map(.from |= dflt("repo")) | .[:1]') };
  const res = checkConfig({ head, title: 'fix: x' });
  assert.strictEqual(res.status, 1, res.out);
  assert.match(res.out, /config edge\.yml: policy\.skills has 1 entries, was 2/);
});

test('fixture edited in head is ignored', () => {
  const full = fs.readFileSync(path.join(ROOT, FIXTURES, 'full.yml'), 'utf8');
  const head = {
    [`${FIXTURES}/full.yml`]: full.replace(/^ {2}review_drafts: .*\n/m, ''),
    [LOAD_CONFIG]: replaceIn(loadConfig, '"review_drafts",', ''),
  };
  const res = checkConfig({ head, title: 'fix: x' });
  assert.strictEqual(res.status, 1, res.out);
  assert.match(res.out, /config full\.yml: rejected/);
});

test('no fixtures in base skips with notice', () => {
  const base = Object.fromEntries(fs.readdirSync(path.join(ROOT, FIXTURES)).map((f) => [`${FIXTURES}/${f}`, null]));
  const res = checkConfig({ base, title: 'fix: x' });
  assert.strictEqual(res.status, 0, res.out);
  assert.match(res.out, /::notice::.*no config fixtures.*skipping the config check/i);
});

test('changed built-in escalation rule passes', () => {
  // builtin_rules and effective_rules come from code, not from the caller's config.
  const head = { [LOAD_CONFIG]: replaceIn(loadConfig, '{reason: "reviewer workflow", paths: [".github/workflows/*"]}',
    '{reason: "reviewer workflow", paths: [".github/workflows/*", ".github/actions/*"]}') };
  const res = checkConfig({ head, title: 'fix: x' });
  assert.strictEqual(res.status, 0, res.out);
  assert.doesNotMatch(res.out, /::error/);
});

test('tightened validation is breaking', () => {
  // edge.yml sets timeout_minutes to the lowest value that loads today.
  const head = { [LOAD_CONFIG]: replaceIn(loadConfig, '.agent.timeout_minutes < 5', '.agent.timeout_minutes < 10') };
  const res = checkConfig({ head, title: 'fix: x' });
  assert.strictEqual(res.status, 1, res.out);
  assert.match(res.out, /::error title=Breaking change::config edge\.yml: rejected: .*timeout_minutes/);
});

test('tightened maximum is breaking', () => {
  // full.yml sets timeout_minutes to the highest value that loads today.
  const head = { [LOAD_CONFIG]: replaceIn(loadConfig, '.agent.timeout_minutes > 60', '.agent.timeout_minutes > 30') };
  const res = checkConfig({ head, title: 'fix: x' });
  assert.strictEqual(res.status, 1, res.out);
  assert.match(res.out, /::error title=Breaking change::config full\.yml: rejected: .*timeout_minutes/);
});
