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

function fixture(t, configOverrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebble-proxy-admin-'));
  const db = createDatabase(path.join(dataDir, 'db.sqlite'));
  const cryptoService = createCryptoService({ dataDir, appSeed: 'admin-test-seed' });
  const config = {
    role: 'all', publicBaseUrl: 'https://pebble.example', maxJsonBytes: 128 * 1024,
    aiTimeoutMs: 90_000, nodeEnv: 'test', umbrelAppId: 'pebble-proxy',
    ...configOverrides
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
  const stored = app.db.prepare('SELECT secret_hash, id, owner_device_id FROM device_credentials').get();
  assert.equal(stored.secret_hash.includes(created.body.token), false);
  assert.equal(stored.owner_device_id, app.db.prepare('SELECT id FROM client_devices').get().id);
  assert.equal(app.db.prepare('SELECT type FROM client_devices').get().type, 'other');
  const overview = await dispatch(app.router, 'GET', '/admin/api/overview');
  assert.equal(overview.body.counts.devices, 1);
  assert.equal(overview.body.counts.activeConnections, 1);
  assert.equal(overview.body.counts.activeDevices, 1);
  app.db.prepare('UPDATE device_credentials SET expires_at = ? WHERE id = ?')
    .run('2020-01-01T00:00:00.000Z', stored.id);
  const expiredOverview = await dispatch(app.router, 'GET', '/admin/api/overview');
  assert.equal(expiredOverview.body.counts.devices, 1);
  assert.equal(expiredOverview.body.counts.activeConnections, 0);
});

test('admin groups typed devices with one-time child connection tokens', async (t) => {
  const app = fixture(t);
  const createdIndex = await dispatch(app.router, 'POST', '/admin/api/device-groups', {
    name: 'My Index', type: 'index'
  });
  assert.equal(createdIndex.status, 201);
  assert.equal(createdIndex.body.device.type, 'index');
  assert.deepEqual(createdIndex.body.device.connections, []);

  const hold = await dispatch(
    app.router,
    'POST',
    `/admin/api/device-groups/${createdIndex.body.device.id}/connections`,
    { indexTrigger: 'single-click-hold', rateLimit: 12, expiresIn: '30d' }
  );
  assert.equal(hold.status, 201);
  assert.match(hold.body.token, /^pp_/);
  assert.equal(hold.body.connection.label, 'Ring Button Hold & Talk');
  assert.equal(hold.body.connection.connectionType, 'webhook');
  assert.equal(hold.body.connection.indexTrigger, 'single-click-hold');
  assert.deepEqual(hold.body.connection.scopes, ['webhook:write']);
  assert.equal(hold.body.connection.requestsPerMinute, 12);
  assert.equal(hold.body.connection.ownerDeviceId, createdIndex.body.device.id);
  assert.equal(hold.body.connection.webhookPath, `/webhooks/index/${hold.body.connection.id}`);
  assert.equal(hold.body.connection.webhookUrl, `https://pebble.example/webhooks/index/${hold.body.connection.id}`);
  const mcp = await dispatch(
    app.router,
    'POST',
    `/admin/api/device-groups/${createdIndex.body.device.id}/connections`,
    { connectionType: 'mcp', label: 'Proxy organizer' }
  );
  assert.equal(mcp.status, 201);
  assert.equal(mcp.body.connection.connectionType, 'mcp');
  assert.deepEqual(mcp.body.connection.scopes, ['mcp:invoke']);
  assert.equal(mcp.body.connection.indexTrigger, null);
  assert.equal(mcp.body.connection.webhookPath, null);
  assert.equal(mcp.body.connection.webhookUrl, '');
  assert.equal(mcp.body.connection.mcpUrl, 'https://pebble.example/mcp');
  assert.equal(mcp.body.connection.openAiBaseUrl, '');
  assert.equal(mcp.body.connection.speechUrl, '');
  assert.match(mcp.body.token, /^pp_/);

  const createdPebble = await dispatch(app.router, 'POST', '/admin/api/device-groups', {
    name: 'Pebble Time', type: 'pebble'
  });
  const watchApp = await dispatch(
    app.router,
    'POST',
    `/admin/api/device-groups/${createdPebble.body.device.id}/connections`,
    { label: 'Assistant watch app', scopes: ['ai:chat', 'tts:speech'], aliases: ['pebble-assistant'] }
  );
  assert.equal(watchApp.body.connection.indexTrigger, null);
  assert.equal(watchApp.body.connection.connectionType, 'client');
  assert.deepEqual(watchApp.body.connection.scopes, ['ai:chat', 'tts:speech']);
  assert.deepEqual(watchApp.body.connection.aliases, ['pebble-assistant']);
  assert.equal(watchApp.body.connection.openAiBaseUrl, 'https://pebble.example/v1');
  assert.equal(watchApp.body.connection.speechUrl, 'https://pebble.example/v1/audio/speech');
  assert.equal(watchApp.body.connection.mcpUrl, '');

  const listed = await dispatch(app.router, 'GET', '/admin/api/device-groups');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.devices.length, 2);
  const index = listed.body.devices.find((device) => device.id === createdIndex.body.device.id);
  assert.equal(index.connections.length, 2);
  assert.equal(index.connections.some((connection) => connection.id === hold.body.connection.id
    && connection.connectionType === 'webhook'), true);
  assert.equal(index.connections.some((connection) => connection.id === mcp.body.connection.id && connection.connectionType === 'mcp'), true);
  assert.equal(JSON.stringify(listed.body).includes(hold.body.token), false);
  const pebble = listed.body.devices.find((device) => device.id === createdPebble.body.device.id);
  assert.equal(pebble.connections[0].label, 'Assistant watch app');
  assert.equal(pebble.connections[0].connectionType, 'client');
  const flat = await dispatch(app.router, 'GET', '/admin/api/devices');
  assert.equal(flat.body.devices.find((connection) => connection.id === hold.body.connection.id).connectionType, 'webhook');
  assert.equal(flat.body.devices.find((connection) => connection.id === mcp.body.connection.id).connectionType, 'mcp');
  assert.equal(flat.body.devices.find((connection) => connection.id === watchApp.body.connection.id).connectionType, 'client');

  await dispatch(app.router, 'POST', '/admin/api/notes', {
    deviceId: hold.body.connection.id, title: 'Index note', body: 'Owned by the hold connection'
  });
  const notes = await dispatch(app.router, 'GET', '/admin/api/notes');
  assert.equal(notes.body.notes[0].device_name, 'My Index');
  assert.equal(notes.body.notes[0].connection_label, 'Ring Button Hold & Talk');
  assert.equal(notes.body.notes[0].owner_device_id, createdIndex.body.device.id);

  await assert.rejects(
    dispatch(
      app.router,
      'POST',
      `/admin/api/device-groups/${createdIndex.body.device.id}/connections`,
      { scopes: ['webhook:write', 'ai:chat'] }
    ),
    (error) => error.code === 'invalid_index_scopes'
  );
  await assert.rejects(
    dispatch(
      app.router,
      'POST',
      `/admin/api/device-groups/${createdIndex.body.device.id}/connections`,
      { connectionType: 'mcp', scopes: ['webhook:write'] }
    ),
    (error) => error.code === 'invalid_index_scopes'
  );
  await assert.rejects(
    dispatch(app.router, 'POST', '/admin/api/device-groups', { name: 'Mystery', type: 'ring' }),
    (error) => error.code === 'invalid_device_type'
  );
  await assert.rejects(
    dispatch(app.router, 'POST', '/admin/api/device-groups/missing/connections', {}),
    (error) => error.code === 'device_group_not_found'
  );
  await assert.rejects(
    dispatch(app.router, 'POST', `/admin/api/device-groups/${createdPebble.body.device.id}/connections`, {
      scopes: 'ai:chat'
    }),
    (error) => error.code === 'invalid_scopes'
  );
  for (const connectionType of ['webhook', 'mcp']) {
    await assert.rejects(
      dispatch(app.router, 'POST', `/admin/api/device-groups/${createdPebble.body.device.id}/connections`, {
        connectionType
      }),
      (error) => error.code === 'invalid_connection_type'
    );
  }
  await assert.rejects(
    dispatch(app.router, 'POST', '/admin/api/devices', {
      name: 'Other client', connectionType: 'webhook'
    }),
    (error) => error.code === 'invalid_connection_type'
  );
  await assert.rejects(
    dispatch(app.router, 'POST', `/admin/api/device-groups/${createdPebble.body.device.id}/connections`, {
      scopes: ['ai:chat'], expiresIn: 'forever'
    }),
    (error) => error.code === 'invalid_expiry'
  );
});

test('admin removes only parent devices that have no connections', async (t) => {
  const app = fixture(t);
  const empty = await dispatch(app.router, 'POST', '/admin/api/device-groups', {
    name: 'Accidental device', type: 'index'
  });
  const populated = await dispatch(app.router, 'POST', '/admin/api/device-groups', {
    name: 'Configured device', type: 'index'
  });
  const connection = await dispatch(
    app.router,
    'POST',
    `/admin/api/device-groups/${populated.body.device.id}/connections`,
    { connectionType: 'mcp' }
  );

  const removed = await dispatch(app.router, 'DELETE', `/admin/api/device-groups/${empty.body.device.id}`);
  assert.equal(removed.status, 200);
  assert.equal(app.db.prepare('SELECT id FROM client_devices WHERE id = ?').get(empty.body.device.id), undefined);

  await assert.rejects(
    dispatch(app.router, 'DELETE', `/admin/api/device-groups/${empty.body.device.id}`),
    (error) => error.status === 404 && error.code === 'device_group_not_found'
  );
  await assert.rejects(
    dispatch(app.router, 'DELETE', `/admin/api/device-groups/${populated.body.device.id}`),
    (error) => error.status === 409 && error.code === 'device_group_not_empty'
  );
  assert.ok(app.db.prepare('SELECT id FROM client_devices WHERE id = ?').get(populated.body.device.id));
  assert.ok(app.db.prepare('SELECT id FROM device_credentials WHERE id = ?').get(connection.body.connection.id));

  await dispatch(app.router, 'DELETE', `/admin/api/devices/${connection.body.connection.id}`);
  await assert.rejects(
    dispatch(app.router, 'DELETE', `/admin/api/device-groups/${populated.body.device.id}`),
    (error) => error.status === 409 && error.code === 'device_group_not_empty'
  );
});

test('admin exposes and persists exact public client endpoints', async (t) => {
  const app = fixture(t);
  const initial = await dispatch(app.router, 'GET', '/admin/api/overview');
  assert.equal(initial.body.publicBaseUrl, 'https://pebble.example');
  assert.equal(initial.body.connectivity.cloudflare.serviceUrl, 'http://pebble-proxy_api_1:8080');
  assert.equal(initial.body.connectivity.cloudflare.routeMode, 'internal_container');
  assert.equal(initial.body.connectivity.cloudflare.hostPortPublished, false);
  assert.equal(initial.body.connectivity.cloudflare.adminPort, 9432);
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

test('admin derives internal API targets from the configured Umbrel app ID', async (t) => {
  for (const umbrelAppId of ['jlmrt-pebble-proxy', 'community42-pebble-proxy']) {
    await t.test(umbrelAppId, async (t) => {
      const app = fixture(t, { umbrelAppId });
      const overview = await dispatch(app.router, 'GET', '/admin/api/overview');
      const expected = `http://${umbrelAppId}_api_1:8080`;
      assert.equal(overview.body.connectivity.cloudflare.serviceUrl, expected);
      assert.equal(overview.body.connectivity.cloudflare.publicTarget, expected);
    });
  }
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

test('admin configures the official Umbrel Kokoro service and queues health checks', async (t) => {
  const app = fixture(t);
  const updated = await dispatch(app.router, 'PUT', '/admin/api/tts', {
    providerType: 'kokoro', baseUrl: 'http://kokoro_web_1:8880',
    speechPath: '/v1/audio/speech', voicesPath: '/v1/audio/voices', healthPath: '/health',
    model: 'kokoro', voice: 'af_heart', responseFormat: 'mp3', enabled: true
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.tts.enabled, true);
  assert.equal(updated.body.tts.baseUrl, 'http://kokoro_web_1:8880');
  assert.equal(updated.body.tts.speechPath, '/v1/audio/speech');
  const scheduled = await dispatch(app.router, 'POST', '/admin/api/tts/test');
  assert.equal(scheduled.status, 202);
  assert.equal(app.db.prepare("SELECT value FROM settings WHERE key = 'health_request:tts'").get().value, 'pending');
});

test('admin keeps local transcript processing off until explicitly enabled', async (t) => {
  const app = fixture(t);
  const initial = await dispatch(app.router, 'GET', '/admin/api/processing');
  assert.equal(initial.body.processing.enabled, false);
  assert.equal(initial.body.processing.confidenceThreshold, 0.2);
  assert.deepEqual(initial.body.jobs, []);

  const updated = await dispatch(app.router, 'PUT', '/admin/api/processing', {
    enabled: true,
    confidenceThreshold: 0.35,
    agentAlias: null
  });
  assert.equal(updated.body.processing.enabled, true);
  assert.equal(updated.body.processing.confidenceThreshold, 0.35);
  assert.equal(updated.body.processing.agentAlias, null);
  await assert.rejects(
    dispatch(app.router, 'PUT', '/admin/api/processing', { confidenceThreshold: 0.01 }),
    (error) => error.code === 'invalid_confidence_threshold'
  );
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
