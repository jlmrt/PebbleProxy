import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { registerAdminRoutes } from '../src/admin.js';
import { createCryptoService } from '../src/crypto.js';
import { createDatabase } from '../src/db.js';
import { Router } from '../src/http.js';

function responseCapture() {
  const chunks = [];
  return {
    statusCode: 200,
    headersSent: false,
    headers: {},
    writeHead(status, headers = {}) { this.statusCode = status; this.headersSent = true; Object.assign(this.headers, headers); },
    end(value) { if (value) chunks.push(Buffer.from(value)); this.headersSent = true; },
    json() { const text = Buffer.concat(chunks).toString('utf8'); return text ? JSON.parse(text) : null; }
  };
}

async function dispatch(router, method, url, body) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(payload ? [Buffer.from(payload)] : []);
  req.method = method;
  req.url = url;
  req.headers = payload ? { 'content-type': 'application/json' } : {};
  const res = responseCapture();
  await router.dispatch(req, res);
  return { status: res.statusCode, body: res.json() };
}

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebble-proxy-admin-'));
  const db = createDatabase(path.join(dataDir, 'db.sqlite'));
  const cryptoService = createCryptoService({ dataDir, appSeed: 'admin-test-seed' });
  const config = {
    role: 'all', publicBaseUrl: 'https://pebble.example', maxJsonBytes: 128 * 1024,
    aiTimeoutMs: 90_000, nodeEnv: 'test'
  };
  const router = new Router();
  registerAdminRoutes(router, { db, cryptoService, config });
  t.after(() => { db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { db, cryptoService, router };
}

test('admin creates one-time scoped device credentials without returning stored secrets', async (t) => {
  const app = fixture(t);
  const created = await dispatch(app.router, 'POST', '/admin/api/devices', {
    name: 'Pebble One', scopes: ['ai:chat', 'webhook:write'], aliases: ['pebble-assistant']
  });
  assert.equal(created.status, 201);
  assert.match(created.body.token, /^pp_/);
  const listed = await dispatch(app.router, 'GET', '/admin/api/devices');
  assert.equal(listed.body.devices.length, 1);
  assert.equal(listed.body.devices[0].name, 'Pebble One');
  assert.equal(JSON.stringify(listed.body).includes(created.body.token), false);
  const stored = app.db.prepare('SELECT secret_hash FROM device_credentials').get();
  assert.equal(stored.secret_hash.includes(created.body.token), false);
});

test('admin exposes and persists exact public client endpoints', async (t) => {
  const app = fixture(t);
  const initial = await dispatch(app.router, 'GET', '/admin/api/overview');
  assert.equal(initial.body.publicBaseUrl, 'https://pebble.example');
  assert.equal(initial.body.connectivity.cloudflare.serviceUrl, 'http://pebble-proxy_api_1:8080');
  assert.equal(initial.body.connectivity.publicApi.webhookUrl, 'https://pebble.example/webhooks/index');
  assert.equal(initial.body.connectivity.publicApi.openAiBaseUrl, 'https://pebble.example/v1');
  assert.equal(initial.body.connectivity.publicApi.mcpUrl, 'https://pebble.example/mcp');

  const updated = await dispatch(app.router, 'PUT', '/admin/api/connectivity', {
    publicBaseUrl: 'https://Voice.Example:8443/'
  });
  assert.equal(updated.body.connectivity.publicBaseUrl, 'https://voice.example:8443');
  assert.equal(updated.body.connectivity.publicApi.webhookUrl, 'https://voice.example:8443/webhooks/index');
  assert.equal(
    app.db.prepare("SELECT value FROM settings WHERE key = 'public_base_url'").get().value,
    'https://voice.example:8443'
  );

  const persisted = await dispatch(app.router, 'GET', '/admin/api/overview');
  assert.equal(persisted.body.publicBaseUrl, 'https://voice.example:8443');
});

test('admin rejects unsafe or ambiguous public origins', async (t) => {
  const app = fixture(t);
  for (const publicBaseUrl of [
    'http://voice.example',
    'https://user:secret@voice.example',
    'https://voice.example/webhooks/index',
    'https://voice.example?next=other',
    'not a URL'
  ]) {
    await assert.rejects(
      dispatch(app.router, 'PUT', '/admin/api/connectivity', { publicBaseUrl }),
      (error) => error.status === 400 && error.code === 'invalid_public_base_url'
    );
  }
});

test('admin stores encrypted backend credentials and exposes only public aliases', async (t) => {
  const app = fixture(t);
  const backend = await dispatch(app.router, 'POST', '/admin/api/backends', {
    name: 'Private model', type: 'generic', baseUrl: 'http://model_api_1:8080',
    chatPath: '/v1/chat/completions', modelsPath: '/v1/models', healthPath: '/healthz',
    credential: 'upstream-secret'
  });
  assert.equal(backend.status, 201);
  assert.equal(backend.body.backend.hasCredential, true);
  assert.equal(JSON.stringify(backend.body).includes('upstream-secret'), false);
  const stored = app.db.prepare('SELECT encrypted_credential FROM ai_providers').get();
  assert.match(stored.encrypted_credential, /^v1\./);
  assert.equal(app.cryptoService.decrypt(stored.encrypted_credential), 'upstream-secret');

  const alias = await dispatch(app.router, 'POST', '/admin/api/model-aliases', {
    alias: 'pebble-assistant', providerId: backend.body.backend.id, upstreamModel: 'private/model', maxOutputTokens: 120
  });
  assert.equal(alias.status, 201);
  assert.equal(alias.body.modelAlias.alias, 'pebble-assistant');

  const openclaw = await dispatch(app.router, 'POST', '/admin/api/backends', {
    name: 'OpenClaw', type: 'openclaw-umbrel', baseUrl: 'https://attacker.example'
  });
  assert.equal(openclaw.body.backend.baseUrl, 'http://openclaw_gateway_1:18789');
  await assert.rejects(
    dispatch(app.router, 'POST', '/admin/api/model-aliases', {
      alias: 'unsafe-openclaw', providerId: openclaw.body.backend.id, upstreamModel: 'openclaw/main'
    }),
    (error) => error.code === 'invalid_model'
  );
});

test('admin configures private STT without revealing credentials and queues health checks', async (t) => {
  const app = fixture(t);
  const updated = await dispatch(app.router, 'PUT', '/admin/api/stt', {
    providerType: 'localai', baseUrl: 'http://localai_api_1:8080',
    transcriptionPath: '/v1/audio/transcriptions', healthPath: '/readyz', model: 'whisper-1',
    credential: 'local-only-key', enabled: true
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.stt.enabled, true);
  assert.equal(updated.body.stt.hasCredential, true);
  assert.equal(JSON.stringify(updated.body).includes('local-only-key'), false);
  const scheduled = await dispatch(app.router, 'POST', '/admin/api/stt/test');
  assert.equal(scheduled.status, 202);
  assert.equal(app.db.prepare("SELECT value FROM settings WHERE key = 'health_request:stt'").get().value, 'pending');
});

test('admin organizer actions share the same device-scoped MCP data', async (t) => {
  const app = fixture(t);
  const created = await dispatch(app.router, 'POST', '/admin/api/devices', { name: 'Organizer device', scopes: ['mcp:invoke'] });
  const deviceId = created.body.device.id;
  await assert.rejects(
    dispatch(app.router, 'POST', '/admin/api/notes', { title: 'Wrong owner', body: 'Must choose' }),
    (error) => error.code === 'device_required'
  );
  const note = await dispatch(app.router, 'POST', '/admin/api/notes', { deviceId, title: 'Packing', body: 'Bring the charger' });
  assert.equal(note.status, 201);
  assert.equal(app.db.prepare('SELECT body FROM notes WHERE id = ?').get(note.body.note.id).body, 'Bring the charger');

  const reminder = await dispatch(app.router, 'POST', '/admin/api/reminders', { deviceId, title: 'Leave for the train', dueAt: '2026-09-02T07:00:00Z' });
  assert.equal(reminder.status, 201);
  const completed = await dispatch(app.router, 'PATCH', `/admin/api/reminders/${reminder.body.reminder.id}`, { completed: true });
  assert.ok(completed.body.reminder.completed_at);
  assert.equal((await dispatch(app.router, 'DELETE', `/admin/api/notes/${note.body.note.id}`)).status, 200);
  assert.equal((await dispatch(app.router, 'DELETE', `/admin/api/reminders/${reminder.body.reminder.id}`)).status, 200);
});
