import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createAuthenticator, createDevice, DeviceLimiter } from '../src/auth.js';
import { createCryptoService } from '../src/crypto.js';
import { createDatabase } from '../src/db.js';
import { HttpError, Router, sendJson } from '../src/http.js';
import { registerMcpRoutes } from '../src/mcp.js';

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pebble-proxy-mcp-'));
  const db = createDatabase(path.join(directory, 'db.sqlite'));
  const cryptoService = createCryptoService({ dataDir: directory, appSeed: 'mcp-test-seed' });
  const authenticate = createAuthenticator({ db, cryptoService });
  const router = new Router();
  registerMcpRoutes(router, { db, config: { maxJsonBytes: 64 * 1024 }, authenticate, limiter: new DeviceLimiter() });
  const dispatch = async ({ token = '', method = 'POST', body = '' } = {}) => {
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    req.method = method;
    req.url = '/mcp';
    req.headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) };
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
      sendJson(res, clean.status, { error: clean.code });
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return { status: res.statusCode, body: text ? JSON.parse(text) : null };
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
  assert.equal(initialized.body.result.serverInfo.name, 'Pebble Proxy Notes & Reminders');

  const created = await rpc(value.dispatch, one.token, 2, 'tools/call', {
    name: 'notes_create', arguments: { title: 'Milk', body: 'Buy oat milk' }
  });
  assert.equal(created.body.result.structuredContent.title, 'Milk');

  const own = await rpc(value.dispatch, one.token, 3, 'tools/call', { name: 'notes_list', arguments: {} });
  assert.equal(own.body.result.structuredContent.notes.length, 1);
  const isolated = await rpc(value.dispatch, two.token, 4, 'tools/call', { name: 'notes_list', arguments: {} });
  assert.equal(isolated.body.result.structuredContent.notes.length, 0);

  const reminder = await rpc(value.dispatch, one.token, 5, 'tools/call', {
    name: 'reminders_create', arguments: { title: 'Call Alice', due_at: '2026-09-01T09:00:00Z', timezone: 'Europe/Amsterdam' }
  });
  assert.equal(reminder.body.result.structuredContent.title, 'Call Alice');
});

test('MCP rejects missing credentials', async (t) => {
  const value = await fixture(t);
  const response = await value.dispatch({ body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
  assert.equal(response.status, 401);
});
