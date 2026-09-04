import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createNote, createReminder } from '../src/actions.js';
import {
  createAuthenticator,
  createClientDevice,
  createDevice,
  createDeviceConnection,
  deleteInactiveDeviceConnection,
  DeviceLimiter,
  listClientDevices,
  listDevices,
  resetDeviceSessions,
  revokeDevice
} from '../src/auth.js';
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

test('typed devices own independently scoped child connections', async (t) => {
  const value = fixture();
  t.after(() => value.close());

  const index = createClientDevice(value.db, { name: 'Index ring', type: 'index' });
  const hold = createDeviceConnection(value.db, value.cryptoService, index.id, {
    indexTrigger: 'single-click-hold'
  });
  const answers = createDeviceConnection(value.db, value.cryptoService, index.id, {
    label: 'Answers', indexTrigger: 'double-click-hold', scopes: ['webhook:write']
  });
  const allGestures = createDeviceConnection(value.db, value.cryptoService, index.id, {
    connectionType: 'webhook', label: 'All gestures'
  });
  assert.deepEqual(hold.connection.scopes, ['webhook:write']);
  assert.equal(hold.connection.connectionType, 'webhook');
  assert.equal(hold.connection.label, 'Ring Button Hold & Talk');
  assert.equal(hold.connection.indexTrigger, 'single-click-hold');
  assert.equal(hold.connection.webhookPath, `/webhooks/index/${hold.connection.id}`);
  assert.equal(answers.connection.ownerDeviceId, index.id);
  assert.equal(allGestures.connection.connectionType, 'webhook');
  assert.deepEqual(allGestures.connection.scopes, ['webhook:write']);
  assert.equal(allGestures.connection.indexTrigger, 'all');
  const mcp = createDeviceConnection(value.db, value.cryptoService, index.id, {
    connectionType: 'mcp', label: 'Proxy tools'
  });
  assert.equal(mcp.connection.connectionType, 'mcp');
  assert.deepEqual(mcp.connection.scopes, ['mcp:invoke']);
  assert.equal(mcp.connection.indexTrigger, null);
  assert.equal(mcp.connection.webhookPath, null);
  assert.throws(
    () => createDeviceConnection(value.db, value.cryptoService, index.id, { scopes: ['ai:chat'] }),
    (error) => error.code === 'invalid_index_scopes'
  );
  assert.throws(
    () => createDeviceConnection(value.db, value.cryptoService, index.id, {
      connectionType: 'mcp', indexTrigger: 'double-click-hold'
    }),
    (error) => error.code === 'invalid_index_trigger'
  );

  const pebble = createClientDevice(value.db, { name: 'Pebble Time', type: 'pebble' });
  const app = createDeviceConnection(value.db, value.cryptoService, pebble.id, { label: 'Assistant app' });
  assert.equal(app.connection.connectionType, 'client');
  assert.deepEqual(app.connection.scopes, ['ai:chat', 'webhook:write', 'tts:speech', 'mcp:invoke']);
  assert.equal(app.connection.indexTrigger, null);
  assert.throws(
    () => createDeviceConnection(value.db, value.cryptoService, pebble.id, { indexTrigger: 'all' }),
    (error) => error.code === 'invalid_index_trigger'
  );
  for (const connectionType of ['webhook', 'mcp']) {
    assert.throws(
      () => createDeviceConnection(value.db, value.cryptoService, pebble.id, { connectionType }),
      (error) => error.code === 'invalid_connection_type'
    );
  }
  assert.throws(
    () => createDeviceConnection(value.db, value.cryptoService, pebble.id, { scopes: 'ai:chat' }),
    (error) => error.code === 'invalid_scopes'
  );
  assert.throws(
    () => createDeviceConnection(value.db, value.cryptoService, pebble.id, { scopes: ['ai:chat', 'admin'] }),
    (error) => error.code === 'invalid_scopes'
  );
  assert.throws(
    () => createDeviceConnection(value.db, value.cryptoService, pebble.id, { scopes: ['ai:chat'], aliases: 'pebble-assistant' }),
    (error) => error.code === 'invalid_aliases'
  );
  assert.throws(
    () => createDeviceConnection(value.db, value.cryptoService, pebble.id, { scopes: ['ai:chat'], aliases: ['not valid'] }),
    (error) => error.code === 'invalid_aliases'
  );

  const authenticate = createAuthenticator({ db: value.db, cryptoService: value.cryptoService });
  const authenticated = await authenticate(
    { headers: { 'x-widget-token': hold.token } },
    'webhook:write',
    { allowWebhookHeaders: true }
  );
  assert.equal(authenticated.id, hold.connection.id);
  assert.equal(authenticated.ownerDeviceId, index.id);
  assert.equal(authenticated.connectionType, 'webhook');
  assert.equal(authenticated.indexTrigger, 'single-click-hold');

  const groups = listClientDevices(value.db);
  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups.find((item) => item.id === index.id).connections.map((item) => item.id).sort(),
    [allGestures.connection.id, answers.connection.id, hold.connection.id, mcp.connection.id].sort()
  );
  assert.equal(groups.find((item) => item.id === index.id).connections
    .find((item) => item.id === mcp.connection.id).connectionType, 'mcp');
  assert.equal(groups.find((item) => item.id === index.id).connections
    .find((item) => item.id === hold.connection.id).connectionType, 'webhook');
  assert.equal(groups.find((item) => item.id === pebble.id).connections[0].connectionType, 'client');
  const flatConnections = listDevices(value.db);
  assert.equal(flatConnections.find((item) => item.id === hold.connection.id).connectionType, 'webhook');
  assert.equal(flatConnections.find((item) => item.id === mcp.connection.id).connectionType, 'mcp');
  assert.equal(flatConnections.find((item) => item.id === app.connection.id).connectionType, 'client');

  const other = createClientDevice(value.db, { name: 'Phone client', type: 'other' });
  assert.throws(
    () => createDeviceConnection(value.db, value.cryptoService, other.id, { connectionType: 'mcp' }),
    (error) => error.code === 'invalid_connection_type'
  );
});

test('permanent connection deletion preserves retained recordings, notes, and reminders', (t) => {
  const value = fixture();
  t.after(() => value.close());
  const parent = createClientDevice(value.db, { name: 'Retired Index', type: 'index' });
  const created = createDeviceConnection(value.db, value.cryptoService, parent.id, {
    connectionType: 'webhook'
  });
  const connectionId = created.connection.id;
  revokeDevice(value.db, connectionId);
  const otherParent = createClientDevice(value.db, { name: 'Other device', type: 'other' });
  assert.throws(
    () => deleteInactiveDeviceConnection(value.db, otherParent.id, connectionId),
    (error) => error.status === 404 && error.code === 'device_not_found'
  );
  const assertProtected = () => assert.throws(
    () => deleteInactiveDeviceConnection(value.db, parent.id, connectionId),
    (error) => error.status === 409 && error.code === 'connection_has_data'
  );
  const now = new Date().toISOString();

  value.db.prepare(`INSERT INTO recordings
    (id, device_id, received_at, stt_state, idempotency_key, created_at, updated_at)
    VALUES ('recording-cleanup', ?, ?, 'received', 'cleanup-key', ?, ?)`).run(connectionId, now, now, now);
  assertProtected();
  assert.ok(value.db.prepare("SELECT id FROM recordings WHERE id = 'recording-cleanup'").get());
  value.db.prepare("DELETE FROM recordings WHERE id = 'recording-cleanup'").run();

  const note = createNote(value.db, connectionId, { title: 'Keep', body: 'Retained note' });
  assertProtected();
  assert.ok(value.db.prepare('SELECT id FROM notes WHERE id = ?').get(note.id));
  value.db.prepare('DELETE FROM notes WHERE id = ?').run(note.id);

  const reminder = createReminder(value.db, connectionId, { title: 'Keep this reminder' });
  assertProtected();
  assert.ok(value.db.prepare('SELECT id FROM reminders WHERE id = ?').get(reminder.id));
  value.db.prepare('DELETE FROM reminders WHERE id = ?').run(reminder.id);

  deleteInactiveDeviceConnection(value.db, parent.id, connectionId);
  assert.equal(value.db.prepare('SELECT id FROM device_credentials WHERE id = ?').get(connectionId), undefined);
});

test('database migration preserves legacy credential IDs and tokens idempotently', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pebble-proxy-migration-'));
  const databasePath = path.join(directory, 'db.sqlite');
  const cryptoService = createCryptoService({ dataDir: directory, appSeed: 'migration-test-seed' });
  const credentialId = '0123456789abcdef';
  const token = `pp_${credentialId}_${'a'.repeat(43)}`;
  let legacy = new DatabaseSync(databasePath);
  legacy.exec(`CREATE TABLE device_credentials (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    secret_prefix TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    aliases_json TEXT NOT NULL,
    requests_per_minute INTEGER NOT NULL DEFAULT 30,
    max_concurrency INTEGER NOT NULL DEFAULT 2,
    session_epoch INTEGER NOT NULL DEFAULT 1,
    expires_at TEXT,
    revoked_at TEXT,
    last_used_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  legacy.prepare(`INSERT INTO device_credentials
    (id, name, secret_hash, secret_prefix, scopes_json, aliases_json, created_at, updated_at)
    VALUES (?, 'Existing client', ?, ?, '["webhook:write"]', '[]', ?, ?)`).run(
    credentialId,
    cryptoService.hashToken(token),
    `pp_${credentialId}`,
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z'
  );
  legacy.close();

  let migrated = createDatabase(databasePath);
  t.after(() => {
    try { migrated.close(); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const stored = migrated.prepare('SELECT id, owner_device_id, connection_label FROM device_credentials').get();
  assert.deepEqual({ ...stored }, {
    id: credentialId,
    owner_device_id: credentialId,
    connection_label: 'Existing client'
  });
  assert.deepEqual(
    { ...migrated.prepare('SELECT id, name, type FROM client_devices').get() },
    { id: credentialId, name: 'Existing client', type: 'other' }
  );
  const authenticate = createAuthenticator({ db: migrated, cryptoService });
  assert.equal(
    (await authenticate({ headers: { authorization: `Bearer ${token}` } }, 'webhook:write')).id,
    credentialId
  );

  migrated.close();
  migrated = createDatabase(databasePath);
  assert.equal(migrated.prepare('SELECT COUNT(*) AS count FROM client_devices').get().count, 1);
  assert.equal(migrated.prepare('SELECT COUNT(*) AS count FROM device_credentials').get().count, 1);
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
