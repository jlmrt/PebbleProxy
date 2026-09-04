import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

function configFixture(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebble-proxy-config-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return loadConfig({ DATA_DIR: dataDir, UMBREL_APP_ID: undefined, ...overrides });
}

test('config defaults to the local Pebble Proxy app ID', (t) => {
  assert.equal(configFixture(t).umbrelAppId, 'pebble-proxy');
});

test('config accepts valid Umbrel community-store app IDs', (t) => {
  assert.equal(configFixture(t, { UMBREL_APP_ID: 'jlmrt-pebble-proxy' }).umbrelAppId, 'jlmrt-pebble-proxy');
  assert.equal(configFixture(t, { UMBREL_APP_ID: 'community42-pebble-proxy' }).umbrelAppId, 'community42-pebble-proxy');
});

test('config rejects invalid Umbrel app IDs', (t) => {
  for (const umbrelAppId of ['x', 'UPPERCASE', '-leading', 'trailing-', 'has space', 'under_score', 'dot.name']) {
    assert.throws(
      () => configFixture(t, { UMBREL_APP_ID: umbrelAppId }),
      /UMBREL_APP_ID must be a lowercase kebab-case Umbrel app ID/
    );
  }
});
