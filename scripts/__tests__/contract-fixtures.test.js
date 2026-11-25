'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
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

test('every contract fixture loads', () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.yml'));
  assert.ok(files.length >= 2);
  for (const f of files) assert.doesNotThrow(() => resolveConfig(read(f)), f);
});
