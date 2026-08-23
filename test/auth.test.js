import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAuthenticator, createDevice, DeviceLimiter, resetDeviceSessions, revokeDevice } from '../src/auth.js';
import { createCryptoService } from '../src/crypto.js';
import { createDatabase } from '../src/db.js';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pebble-proxy-auth-'));
  const db = createDatabase(path.join(directory, 'db.sqlite'));
  const cryptoService = createCryptoService({ dataDir: directory, appSeed: 'unit-test-seed' });
  return { directory, db, cryptoService, close() { db.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('device tokens are scoped, stored hashed, revocable, and reset sessions', async (t) => {
  const value = fixture();
  t.after(() => value.close());
  const created = createDevice(value.db, value.cryptoService, {
    name: 'Basalt', scopes: ['mcp:invoke'], aliases: ['pebble-assistant'], requestsPerMinute: 4, maxConcurrency: 1
  });
  assert.match(created.token, /^pp_[a-f0-9]{16}_/);
  const stored = value.db.prepare('SELECT * FROM device_credentials WHERE id = ?').get(created.device.id);
  assert.notEqual(stored.secret_hash, created.token);
  assert.ok(!JSON.stringify(stored).includes(created.token));

  const authenticate = createAuthenticator({ db: value.db, cryptoService: value.cryptoService });
  const req = { headers: { authorization: `Bearer ${created.token}` } };
  const device = await authenticate(req, 'mcp:invoke');
  assert.equal(device.id, created.device.id);
  assert.deepEqual(device.aliases, ['pebble-assistant']);
  await assert.rejects(() => authenticate(req, 'ai:chat'), (error) => error.status === 403);

  const before = stored.session_epoch;
  resetDeviceSessions(value.db, device.id);
  assert.equal(value.db.prepare('SELECT session_epoch FROM device_credentials WHERE id = ?').get(device.id).session_epoch, before + 1);
  revokeDevice(value.db, device.id);
  await assert.rejects(() => authenticate(req, 'mcp:invoke'), (error) => error.status === 401);
});

test('Index webhook authentication accepts CoreApp Auth Token headers only when explicitly enabled', async (t) => {
  const value = fixture();
  t.after(() => value.close());
  const created = createDevice(value.db, value.cryptoService, {
    name: 'Index ring', scopes: ['webhook:write']
  });
  const authenticate = createAuthenticator({ db: value.db, cryptoService: value.cryptoService });
  const coreApp = { headers: { 'x-widget-token': created.token } };

  const device = await authenticate(coreApp, 'webhook:write', { allowWebhookHeaders: true });
  assert.equal(device.id, created.device.id);
  await assert.rejects(
    () => authenticate(coreApp, 'webhook:write'),
    (error) => error.status === 401
  );
  await assert.rejects(
    () => authenticate({ headers: { authorization: `Bearer ${created.token}`, 'x-widget-token': 'different' } }, 'webhook:write', { allowWebhookHeaders: true }),
    (error) => error.status === 400 && error.code === 'conflicting_api_keys'
  );
});

test('limiter separates concurrency by device and releases leases', () => {
  const limiter = new DeviceLimiter();
  const first = { id: 'first', requests_per_minute: 10, max_concurrency: 1 };
  const second = { id: 'second', requests_per_minute: 10, max_concurrency: 1 };
  const lease = limiter.acquire(first);
  assert.throws(() => limiter.acquire(first), (error) => error.status === 429 && error.code === 'concurrency_limit_exceeded');
  const other = limiter.acquire(second);
  other.release();
  lease.release();
  limiter.acquire(first).release();
});

test('limiter does not retain phantom concurrency across minute boundaries', () => {
  const originalNow = Date.now;
  let time = 60_000;
  Date.now = () => time;
  try {
    const limiter = new DeviceLimiter();
    const device = { id: 'boundary', requests_per_minute: 10, max_concurrency: 2 };
    const first = limiter.acquire(device);
    const second = limiter.acquire(device);
    time = 120_000;
    assert.throws(() => limiter.acquire(device), (error) => error.code === 'concurrency_limit_exceeded');
    first.release();
    const third = limiter.acquire(device);
    second.release();
    third.release();
    limiter.acquire(device).release();
  } finally {
    Date.now = originalNow;
  }
});
