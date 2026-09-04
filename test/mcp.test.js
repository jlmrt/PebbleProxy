import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createNote, createReminder } from '../src/actions.js';
import { createAuthenticator, createClientDevice, createDevice, createDeviceConnection, DeviceLimiter } from '../src/auth.js';
import { createCryptoService } from '../src/crypto.js';
import { createDatabase } from '../src/db.js';
import { HttpError, Router, sendJson } from '../src/http.js';
import { registerMcpRoutes } from '../src/mcp.js';

async function fixture(t, configOverrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pebble-proxy-mcp-'));
  const db = createDatabase(path.join(directory, 'db.sqlite'));
  const cryptoService = createCryptoService({ dataDir: directory, appSeed: 'mcp-test-seed' });
  const authenticate = createAuthenticator({ db, cryptoService });
  const router = new Router();
  registerMcpRoutes(router, {
    db,
    config: { maxJsonBytes: 64 * 1024, publicBaseUrl: '', ...configOverrides },
    authenticate,
    limiter: new DeviceLimiter()
  });
  const dispatch = async ({ token = '', method = 'POST', body = '', headers = {} } = {}) => {
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    req.method = method;
    req.url = '/mcp';
    req.headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers };
    const chunks = [];
    const res = {
      statusCode: 200,
      headersSent: false,
      headers: {},
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      writeHead(status, headers = {}) { this.statusCode = status; this.headersSent = true; Object.assign(this.headers, headers); },
      end(value) { if (value) chunks.push(Buffer.from(value)); this.headersSent = true; }
    };
    try { await router.dispatch(req, res); }
    catch (error) {
      const clean = error instanceof HttpError ? error : new HttpError(500, 'internal_error', 'Internal error');
      sendJson(res, clean.status, { error: clean.code }, clean.headers);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return { status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
  t.after(async () => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { db, cryptoService, dispatch };
}

async function rpc(dispatch, token, id, method, params) {
  return dispatch({ token, body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) });
}

test('MCP initializes and isolates notes/reminders by authenticated device', async (t) => {
  const value = await fixture(t);
  const one = createDevice(value.db, value.cryptoService, { name: 'One', scopes: ['mcp:invoke'] });
  const two = createDevice(value.db, value.cryptoService, { name: 'Two', scopes: ['mcp:invoke'] });

  const initialized = await rpc(value.dispatch, one.token, 1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(initialized.status, 200);
  assert.equal(initialized.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(initialized.headers['MCP-Protocol-Version'], '2025-06-18');
  assert.equal(initialized.body.result.protocolVersion, '2025-06-18');
  assert.equal(initialized.body.result.serverInfo.name, 'Pebble Proxy Notes & Reminders');

  const initializedNotification = await value.dispatch({
    token: one.token,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
  });
  assert.equal(initializedNotification.status, 202);
  assert.equal(initializedNotification.body, null);

  const streamProbe = await value.dispatch({ token: one.token, method: 'GET' });
  assert.equal(streamProbe.status, 405);
  assert.equal(streamProbe.headers.Allow, 'POST');

  const negotiatedDown = await rpc(value.dispatch, one.token, 10, 'initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' }
  });
  assert.equal(negotiatedDown.status, 200);
  assert.equal(negotiatedDown.body.result.protocolVersion, '2025-06-18');

  const protocolHeader = await value.dispatch({
    token: one.token,
    headers: { 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'ping' })
  });
  assert.equal(protocolHeader.status, 200);

  const created = await rpc(value.dispatch, one.token, 2, 'tools/call', {
    name: 'notes_create', arguments: { title: 'Milk', body: 'Buy oat milk' }
  });
  assert.equal(created.body.result.structuredContent.title, 'Milk');
  assert.equal(value.db.prepare('SELECT device_id FROM notes WHERE id = ?').get(created.body.result.structuredContent.id).device_id, one.device.id);

  const own = await rpc(value.dispatch, one.token, 3, 'tools/call', { name: 'notes_list', arguments: {} });
  assert.equal(own.body.result.structuredContent.notes.length, 1);
  const isolated = await rpc(value.dispatch, two.token, 4, 'tools/call', { name: 'notes_list', arguments: {} });
  assert.equal(isolated.body.result.structuredContent.notes.length, 0);

  const reminder = await rpc(value.dispatch, one.token, 5, 'tools/call', {
    name: 'reminders_create', arguments: { title: 'Call Alice', due_at: '2026-09-01T09:00:00Z', timezone: 'Europe/Amsterdam' }
  });
  assert.equal(reminder.body.result.structuredContent.title, 'Call Alice');
  assert.equal(value.db.prepare('SELECT device_id FROM reminders WHERE id = ?').get(reminder.body.result.structuredContent.id).device_id, one.device.id);
});

test('MCP organizer data is shared by sibling connections but isolated from other parent devices', async (t) => {
  const value = await fixture(t);
  const parent = createClientDevice(value.db, { name: 'Shared Index', type: 'index' });
  const webhook = createDeviceConnection(value.db, value.cryptoService, parent.id, {
    label: 'Hold & Talk', connectionType: 'webhook', indexTrigger: 'single-click-hold'
  });
  const sibling = createDeviceConnection(value.db, value.cryptoService, parent.id, {
    label: 'Organizer', connectionType: 'mcp'
  });
  const otherParent = createClientDevice(value.db, { name: 'Other Index', type: 'index' });
  const outsider = createDeviceConnection(value.db, value.cryptoService, otherParent.id, {
    label: 'Other organizer', connectionType: 'mcp'
  });

  const createdNote = createNote(value.db, webhook.connection.id, { title: 'Shared plan', body: 'First draft' });
  const noteId = createdNote.id;
  assert.equal(value.db.prepare('SELECT device_id FROM notes WHERE id = ?').get(noteId).device_id, webhook.connection.id);

  const siblingNotes = await rpc(value.dispatch, sibling.token, 11, 'tools/call', {
    name: 'notes_list', arguments: { query: 'Shared' }
  });
  assert.deepEqual(siblingNotes.body.result.structuredContent.notes.map((note) => note.id), [noteId]);
  const outsiderNotes = await rpc(value.dispatch, outsider.token, 12, 'tools/call', {
    name: 'notes_list', arguments: {}
  });
  assert.equal(outsiderNotes.body.result.structuredContent.notes.length, 0);

  const outsiderUpdate = await rpc(value.dispatch, outsider.token, 13, 'tools/call', {
    name: 'notes_update', arguments: { id: noteId, body: 'Unauthorized edit' }
  });
  assert.equal(outsiderUpdate.body.result.isError, true);
  assert.equal(value.db.prepare('SELECT body FROM notes WHERE id = ?').get(noteId).body, 'First draft');

  const siblingUpdate = await rpc(value.dispatch, sibling.token, 14, 'tools/call', {
    name: 'notes_update', arguments: { id: noteId, body: 'Updated by sibling' }
  });
  assert.equal(siblingUpdate.body.result.structuredContent.body, 'Updated by sibling');

  const outsiderNoteDelete = await rpc(value.dispatch, outsider.token, 15, 'tools/call', {
    name: 'notes_delete', arguments: { id: noteId, confirm: true }
  });
  assert.equal(outsiderNoteDelete.body.result.isError, true);
  assert.equal(value.db.prepare('SELECT COUNT(*) AS count FROM notes WHERE id = ?').get(noteId).count, 1);

  const createdReminder = createReminder(value.db, webhook.connection.id, {
    title: 'Shared reminder', due_at: '2026-09-10T09:00:00Z'
  });
  const reminderId = createdReminder.id;
  assert.equal(value.db.prepare('SELECT device_id FROM reminders WHERE id = ?').get(reminderId).device_id, webhook.connection.id);

  const siblingReminders = await rpc(value.dispatch, sibling.token, 17, 'tools/call', {
    name: 'reminders_list', arguments: {}
  });
  assert.deepEqual(siblingReminders.body.result.structuredContent.reminders.map((reminder) => reminder.id), [reminderId]);
  const outsiderReminders = await rpc(value.dispatch, outsider.token, 18, 'tools/call', {
    name: 'reminders_list', arguments: {}
  });
  assert.equal(outsiderReminders.body.result.structuredContent.reminders.length, 0);

  const outsiderComplete = await rpc(value.dispatch, outsider.token, 19, 'tools/call', {
    name: 'reminders_complete', arguments: { id: reminderId }
  });
  assert.equal(outsiderComplete.body.result.isError, true);
  assert.equal(value.db.prepare('SELECT completed_at FROM reminders WHERE id = ?').get(reminderId).completed_at, null);

  const siblingComplete = await rpc(value.dispatch, sibling.token, 20, 'tools/call', {
    name: 'reminders_complete', arguments: { id: reminderId }
  });
  assert.equal(siblingComplete.body.result.structuredContent.id, reminderId);
  assert.ok(value.db.prepare('SELECT completed_at FROM reminders WHERE id = ?').get(reminderId).completed_at);

  const outsiderReminderDelete = await rpc(value.dispatch, outsider.token, 21, 'tools/call', {
    name: 'reminders_delete', arguments: { id: reminderId, confirm: true }
  });
  assert.equal(outsiderReminderDelete.body.result.isError, true);
  assert.equal(value.db.prepare('SELECT COUNT(*) AS count FROM reminders WHERE id = ?').get(reminderId).count, 1);

  const siblingNoteDelete = await rpc(value.dispatch, sibling.token, 22, 'tools/call', {
    name: 'notes_delete', arguments: { id: noteId, confirm: true }
  });
  assert.equal(siblingNoteDelete.body.result.structuredContent.deleted, true);
  const siblingReminderDelete = await rpc(value.dispatch, sibling.token, 23, 'tools/call', {
    name: 'reminders_delete', arguments: { id: reminderId, confirm: true }
  });
  assert.equal(siblingReminderDelete.body.result.structuredContent.deleted, true);
});

test('MCP rejects missing credentials', async (t) => {
  const value = await fixture(t);
  const response = await value.dispatch({ body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
  assert.equal(response.status, 401);
});

test('MCP accepts native requests and only trusts the configured public HTTPS origin', async (t) => {
  const value = await fixture(t, { publicBaseUrl: 'https://proxy.example' });
  const device = createDevice(value.db, value.cryptoService, { name: 'Index MCP', scopes: ['mcp:invoke'] });
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });

  const native = await value.dispatch({ token: device.token, body: payload });
  assert.equal(native.status, 200);

  const sameOrigin = await value.dispatch({
    token: device.token,
    body: payload,
    headers: { host: 'internal-api:8080', origin: 'https://proxy.example' }
  });
  assert.equal(sameOrigin.status, 200);

  for (const origin of [
    'http://proxy.example',
    'https://untrusted.example',
    'https://proxy.example:8443',
    'not an origin',
    'https://proxy.example/path',
    'https://user@proxy.example'
  ]) {
    const rejected = await value.dispatch({
      token: device.token,
      body: payload,
      headers: { host: new URL(origin, 'https://attacker.example').host, origin }
    });
    assert.equal(rejected.status, 403, origin);
    assert.equal(rejected.body.error, 'invalid_origin', origin);
  }
});

test('MCP rejects browser origins when no trusted public origin is configured', async (t) => {
  const value = await fixture(t);
  const device = createDevice(value.db, value.cryptoService, { name: 'Index MCP', scopes: ['mcp:invoke'] });
  const response = await value.dispatch({
    token: device.token,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    headers: { host: 'attacker.example', origin: 'https://attacker.example' }
  });
  assert.equal(response.status, 403);
  assert.equal(response.body.error, 'invalid_origin');
});

test('MCP uses the stored public origin before the configuration fallback', async (t) => {
  const value = await fixture(t, { publicBaseUrl: 'https://fallback.example' });
  const device = createDevice(value.db, value.cryptoService, { name: 'Index MCP', scopes: ['mcp:invoke'] });
  value.db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('public_base_url', ?, ?)`)
    .run('https://stored.example:8443', new Date().toISOString());
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });

  const stored = await value.dispatch({
    token: device.token,
    body: payload,
    headers: { host: 'ignored.example', origin: 'https://stored.example:8443' }
  });
  assert.equal(stored.status, 200);

  const fallback = await value.dispatch({
    token: device.token,
    body: payload,
    headers: { host: 'fallback.example', origin: 'https://fallback.example' }
  });
  assert.equal(fallback.status, 403);
  assert.equal(fallback.body.error, 'invalid_origin');
});
