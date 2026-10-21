// Shared helpers for the pr-review-agent script tests. Scripts run as real
// subprocesses (bash/jq/yq), with `gh` stubbed on PATH where needed.

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPTS = path.join(ROOT, 'scripts');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pra-${prefix}-`));
}

/** Parse a $GITHUB_OUTPUT file (single-line and heredoc forms). */
function readOutputs(file) {
  const out = {};
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heredoc = line.match(/^([A-Za-z_][A-Za-z0-9_]*)<<(.+)$/);
    if (heredoc) {
      const [, key, delim] = heredoc;
      const buf = [];
      while (++i < lines.length && lines[i] !== delim) buf.push(lines[i]);
      out[key] = buf.join('\n');
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/**
 * Run a script. Returns { status, stdout, stderr, outputs }.
 * @param {string} script  file name under scripts/
 * @param {object} opts    { cwd, env }
 */
function runScript(script, { cwd, env = {} } = {}) {
  const dir = cwd || tmpdir('run');
  const ghOut = path.join(dir, `gh_output_${process.hrtime.bigint()}`);
  fs.writeFileSync(ghOut, '');
  const res = spawnSync('bash', [path.join(SCRIPTS, script)], {
    cwd: dir,
    env: { ...process.env, RUNNER_TEMP: dir, GITHUB_OUTPUT: ghOut, ...env },
    encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, outputs: readOutputs(ghOut) };
}

/** A throwaway AGENT_DIR (copying prompts/ so defaults resolve) plus extra files. */
function agentDir(extraFiles = {}) {
  const dir = tmpdir('agent');
  fs.cpSync(path.join(ROOT, 'prompts'), path.join(dir, 'prompts'), { recursive: true });
  for (const [rel, content] of Object.entries(extraFiles)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

/**
 * Env for running load-config.sh against `yaml` as config "team" of acme/widgets.
 * `gh` is stubbed: it serves the config only for the default branch (main),
 * answers 500 for ref=broken and 404 otherwise, and logs its arguments to `ghLog`.
 */
function configEnv(yaml, extraFiles = {}) {
  const dir = agentDir(extraFiles);
  const yamlFile = path.join(dir, 'team.yml');
  const ghLog = path.join(dir, 'gh.log');
  fs.writeFileSync(yamlFile, yaml);
  const bin = ghStubDir(`echo "$*" >> '${ghLog}'
case "$*" in
  *"repos/acme/widgets/contents/.github/pr-review-agent/team.yml?ref=main"*) cat '${yamlFile}' ;;
  *"?ref=broken"*) echo "gh: Server Error (HTTP 500)" >&2; exit 1 ;;
  *) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
esac`);
  return {
    agentDir: dir,
    ghLog,
    env: {
      CONFIG_NAME: 'team', AGENT_DIR: dir, GITHUB_REPOSITORY: 'acme/widgets', DEFAULT_BRANCH: 'main',
      PATH: `${bin}:${process.env.PATH}`,
    },
  };
}

const MINIMAL_CONFIG = `
schema_version: 1
vault:
  anthropic_api_key:
    path: secret/data/products/acme/ci/common
`;

/** Load a config through load-config.sh and return the resolved JSON + file path. */
function resolveConfig(yaml, { extraFiles } = {}) {
  const { agentDir: dir, env } = configEnv(yaml, extraFiles);
  const file = path.join(dir, 'resolved.json');
  const res = runScript('load-config.sh', { env: { ...env, RESOLVED_CONFIG: file } });
  if (res.status !== 0) throw new Error(`load-config failed: ${res.stderr}`);
  return { file, config: JSON.parse(fs.readFileSync(file, 'utf8')), agentDir: dir, outputs: res.outputs };
}

/** Put a stub `gh` on PATH that prints `files` for `gh pr diff --name-only`. */
function ghStubDir(script) {
  const bin = tmpdir('bin');
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env bash\n${script}\n`);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  return bin;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

module.exports = {
  ROOT, SCRIPTS, tmpdir, readOutputs, runScript, agentDir, configEnv, MINIMAL_CONFIG,
  resolveConfig, ghStubDir, git,
};
