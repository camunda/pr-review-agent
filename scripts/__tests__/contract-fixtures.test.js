'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { resolveConfig } = require('./helpers');

const DIR = path.join(__dirname, 'fixtures', 'contract');
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

const leaves = (o, p = '') => Object.entries(o).flatMap(([k, v]) =>
  v && typeof v === 'object' && !Array.isArray(v) ? leaves(v, `${p}${k}.`) : [[`${p}${k}`, v]]);

// Settings that full.yml leaves equal to the default on purpose: they have no
// meaningful non-default value (the schema version is fixed, `name` comes from
// the caller, the vault path is required so minimal sets it too).
const SAME_ON_PURPOSE = ['schema_version', 'name', 'vault.anthropic_api_key.path'];

test('full.yml sets every resolved setting to a non-default value', () => {
  const min = Object.fromEntries(leaves(resolveConfig(read('minimal.yml')).config));
  const full = Object.fromEntries(leaves(resolveConfig(read('full.yml')).config));
  for (const [k, v] of Object.entries(min)) {
    if (SAME_ON_PURPOSE.some((s) => k === s || k.startsWith(`${s}.`))) continue;
    assert.notDeepStrictEqual(full[k], v, `full.yml must set ${k}`);
  }
});

// List entries (policy.skills[], escalation.rules[]) count as one leaf above,
// so a new per-entry setting with a default could stay unset in full.yml. Each
// entry in full.yml must therefore set every key that its resolved entry has.
// Arrays that the fixture does not set (derived ones) are skipped.
function uncoveredEntryKeys(raw, resolved, p = '') {
  if (Array.isArray(resolved)) {
    if (!Array.isArray(raw)) return [];
    return resolved.flatMap((entry, i) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const set = raw[i] && typeof raw[i] === 'object' ? raw[i] : {};
      return Object.keys(entry).filter((k) => !(k in set)).map((k) => `${p}[${i}].${k}`);
    });
  }
  if (!resolved || typeof resolved !== 'object') return [];
  return Object.entries(resolved).flatMap(([k, v]) =>
    uncoveredEntryKeys(raw && typeof raw === 'object' ? raw[k] : undefined, v, p ? `${p}.${k}` : k));
}

test('the entry guard reports a per-entry setting that the fixture leaves unset', () => {
  const raw = { policy: { skills: [{ path: 'a.md' }] } };
  const resolved = { policy: { skills: [{ path: 'a.md', from: 'repo' }] }, escalation: { builtin_rules: [{ reason: 'x' }] } };
  assert.deepStrictEqual(uncoveredEntryKeys(raw, resolved), ['policy.skills[0].from']);
});

test('full.yml sets every setting of its list entries', () => {
  const raw = JSON.parse(execFileSync('yq', ['-o=json', '.', path.join(DIR, 'full.yml')], { encoding: 'utf8' }));
  assert.deepStrictEqual(uncoveredEntryKeys(raw, resolveConfig(read('full.yml')).config), []);
});

test('every contract fixture loads', () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.yml'));
  assert.ok(files.length >= 2);
  for (const f of files) assert.doesNotThrow(() => resolveConfig(read(f)), f);
});
