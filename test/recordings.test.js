import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { createCryptoService } from '../src/crypto.js';
import { createDatabase, nowIso } from '../src/db.js';
import { Router } from '../src/http.js';
import { checkSttHealth, registerRecordingRoutes, startSttWorker } from '../src/recordings.js';

class CaptureResponse extends Writable {
  constructor() {
    super();
    this.statusCode = null;
    this.headers = {};
    this.chunks = [];
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
    return this;
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  get body() {
    return Buffer.concat(this.chunks);
  }

  get json() {
    return JSON.parse(this.body.toString('utf8'));
  }
}

async function dispatch(router, { method = 'GET', url = '/', headers = {}, body = Buffer.alloc(0) } = {}) {
  const req = Readable.from(body.length ? [body] : []);
  req.method = method;
  req.url = url;
  req.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const res = new CaptureResponse();
  await router.dispatch(req, res);
  if (!res.writableFinished) await once(res, 'finish');
  return res;
}

function validM4a(payload = 'pebble-audio') {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypM4A '),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from(payload)
  ]);
}

function multipart({ audio = null, transcription = null, recordedAt = null, client = null, test: testFlag = null, boundary = null } = {}) {
  boundary ||= `pebble-${Math.random().toString(16).slice(2)}`;
  const chunks = [];
  const field = (name, value) => {
    if (value === null || value === undefined) return;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  };
  if (audio) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="voice.m4a"\r\nContent-Type: audio/mp4\r\n\r\n`));
    chunks.push(audio);
    chunks.push(Buffer.from('\r\n'));
  }
  field('transcription', transcription);
  field('recordedAt', recordedAt);
  field('client', client);
  field('test', testFlag);
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
    boundary
  };
}

async function fixture(t, overrides = {}) {
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pebble-recordings-'));
  const recordingsDir = path.join(dataDir, 'recordings');
  await fs.promises.mkdir(recordingsDir, { recursive: true });
  const db = createDatabase(path.join(dataDir, 'db.sqlite'));
  const now = nowIso();
  db.prepare(`INSERT INTO device_credentials
    (id, name, secret_hash, secret_prefix, scopes_json, aliases_json,
     requests_per_minute, max_concurrency, session_epoch, created_at, updated_at)
    VALUES ('device-1', 'Test Pebble', 'hash', 'pp_test', '["webhook:write"]', '[]', 30, 2, 1, ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO device_credentials
    (id, name, secret_hash, secret_prefix, scopes_json, aliases_json,
     requests_per_minute, max_concurrency, session_epoch, created_at, updated_at)
    VALUES ('device-2', 'Second Pebble', 'hash-2', 'pp_second', '["webhook:write"]', '[]', 30, 2, 1, ?, ?)`).run(now, now);

  const config = {
    dataDir,
    recordingsDir,
    maxWebhookBytes: 1024 * 1024,
    workerPollMs: 10,
    sttTimeoutMs: 1000,
    sttMaxAttempts: 3,
    sttRetryDelaysMs: [25, 25, 25],
    nodeEnv: 'test',
    ...overrides
  };
  const cryptoService = createCryptoService({ dataDir, appSeed: 'recordings-test-seed' });
  const publicRouter = new Router();
  const adminRouter = new Router();
  const authCalls = [];
  const authenticate = async (req, scope, options = {}) => {
    authCalls.push({ scope, options });
    return {
      id: req.headers['x-test-device-id'] || 'device-1',
      index_trigger: req.headers['x-test-index-trigger-config'] || null,
      scopes: ['webhook:write'],
      aliases: []
    };
  };
  const deps = { db, cryptoService, config, authenticate, fetchImpl: (...args) => globalThis.fetch(...args) };
  registerRecordingRoutes(publicRouter, adminRouter, deps);

  t.after(async () => {
    try { db.close(); } catch {}
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  });
  return { db, config, cryptoService, deps, publicRouter, adminRouter, authCalls };
}

async function waitFor(predicate, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for condition');
}

test('Index webhook is bounded, authenticated, idempotent, and manageable through admin APIs', async (t) => {
  const app = await fixture(t);
  const audio = validM4a();
  const form = multipart({
    audio,
    transcription: 'Pebble heard this',
    recordedAt: String(Date.parse('2026-08-22T12:34:56Z')),
    client: 'Pebble Index'
  });
  const request = {
    method: 'POST',
    url: '/webhooks/index',
    headers: {
      'content-type': form.contentType,
      'x-audio-size': String(audio.length),
      'idempotency-key': 'index-event-1',
      authorization: 'Bearer device-token',
      'x-index-trigger': 'double-click-hold'
    },
    body: form.body
  };

  const created = await dispatch(app.publicRouter, request);
  assert.equal(created.statusCode, 202);
  assert.equal(created.json.state, 'received');
  assert.equal(created.json.deduplicated, false);
  assert.deepEqual(app.authCalls, [{ scope: 'webhook:write', options: { allowWebhookHeaders: true } }]);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM recordings').get().count, 1);
  assert.equal(app.db.prepare('SELECT recorded_at FROM recordings').get().recorded_at, '2026-08-22T12:34:56.000Z');
  assert.equal(app.db.prepare('SELECT trigger FROM recordings').get().trigger, 'double-click-hold');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM transcription_jobs').get().count, 1);
  assert.equal(app.db.prepare("SELECT text FROM transcripts WHERE source = 'pebble'").get().text, 'Pebble heard this');

  const replay = await dispatch(app.publicRouter, request);
  assert.equal(replay.statusCode, 202);
  assert.equal(replay.json.id, created.json.id);
  assert.equal(replay.json.deduplicated, true);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM recordings').get().count, 1);

  const conflictingForm = multipart({
    audio,
    transcription: 'Different text',
    client: 'Pebble Index',
    recordedAt: String(Date.parse('2026-08-22T12:34:56Z'))
  });
  await assert.rejects(
    dispatch(app.publicRouter, {
      ...request,
      headers: { ...request.headers, 'content-type': conflictingForm.contentType },
      body: conflictingForm.body
    }),
    (error) => error.status === 409 && error.code === 'idempotency_conflict'
  );

  const listed = await dispatch(app.adminRouter, { url: '/admin/api/recordings?limit=10' });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json.recordings.length, 1);
  assert.equal(listed.json.recordings[0].transcripts[0].text, 'Pebble heard this');

  const detail = await dispatch(app.adminRouter, { url: `/admin/api/recordings/${created.json.id}` });
  assert.equal(detail.statusCode, 200);
  assert.deepEqual(detail.json.transcripts.map((item) => item.source), ['pebble']);

  const downloaded = await dispatch(app.adminRouter, { url: `/admin/api/recordings/${created.json.id}/audio` });
  assert.equal(downloaded.statusCode, 200);
  assert.deepEqual(downloaded.body, audio);
  const storedAudioPath = path.join(app.config.recordingsDir, app.db.prepare('SELECT audio_path FROM recordings').get().audio_path);

  const retried = await dispatch(app.adminRouter, { method: 'POST', url: `/admin/api/recordings/${created.json.id}/retry` });
  assert.equal(retried.statusCode, 202);
  assert.equal(retried.json.state, 'received');

  const deleted = await dispatch(app.adminRouter, { method: 'DELETE', url: `/admin/api/recordings/${created.json.id}` });
  assert.equal(deleted.statusCode, 204);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM recordings').get().count, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM transcripts').get().count, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM transcription_jobs').get().count, 0);
  await assert.rejects(fs.promises.stat(storedAudioPath), (error) => error.code === 'ENOENT');
});

test('route-specific Index webhooks bind the URL to its authenticated connection and gesture', async (t) => {
  const app = await fixture(t);
  const form = multipart({ transcription: 'Remember the route', client: 'ring' });
  const accepted = await dispatch(app.publicRouter, {
    method: 'POST',
    url: '/webhooks/index/device-1',
    headers: {
      'content-type': form.contentType,
      'x-test-device-id': 'device-1',
      'x-test-index-trigger-config': 'single-click-hold',
      'x-index-trigger': 'single-click-hold',
      'idempotency-key': 'route-specific-1'
    },
    body: form.body
  });
  assert.equal(accepted.statusCode, 202);
  assert.equal(accepted.json.connectionId, 'device-1');
  assert.equal(accepted.json.trigger, 'single-click-hold');
  assert.equal(app.db.prepare('SELECT device_id FROM recordings').get().device_id, 'device-1');

  const wrongConnection = multipart({ transcription: 'Wrong connection', client: 'ring' });
  await assert.rejects(
    dispatch(app.publicRouter, {
      method: 'POST',
      url: '/webhooks/index/device-2',
      headers: {
        'content-type': wrongConnection.contentType,
        'x-test-device-id': 'device-1',
        'idempotency-key': 'route-specific-wrong'
      },
      body: wrongConnection.body
    }),
    (error) => error.status === 403 && error.code === 'connection_mismatch'
  );

  const wrongGesture = multipart({ transcription: 'Wrong gesture', client: 'ring' });
  await assert.rejects(
    dispatch(app.publicRouter, {
      method: 'POST',
      url: '/webhooks/index/device-1',
      headers: {
        'content-type': wrongGesture.contentType,
        'x-test-device-id': 'device-1',
        'x-test-index-trigger-config': 'single-click-hold',
        'x-index-trigger': 'double-click-hold',
        'idempotency-key': 'route-specific-gesture'
      },
      body: wrongGesture.body
    }),
    (error) => error.status === 409 && error.code === 'index_trigger_mismatch'
  );
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM recordings').get().count, 1);

  const noObservedGesture = multipart({ transcription: 'Legacy retry without gesture', client: 'ring' });
  const acceptedWithoutGesture = await dispatch(app.publicRouter, {
    method: 'POST',
    url: '/webhooks/index/device-1',
    headers: {
      'content-type': noObservedGesture.contentType,
      'x-test-device-id': 'device-1',
      'x-test-index-trigger-config': 'single-click-hold',
      'idempotency-key': 'route-specific-no-gesture'
    },
    body: noObservedGesture.body
  });
  assert.equal(acceptedWithoutGesture.statusCode, 202);
  assert.equal(acceptedWithoutGesture.json.trigger, 'single-click-hold');
  const inferredRoute = app.db.prepare('SELECT trigger FROM recordings WHERE id = ?')
    .get(acceptedWithoutGesture.json.id);
  assert.equal(inferredRoute.trigger, 'single-click-hold');
});

test('CoreApp test events are acknowledged without creating recordings or jobs', async (t) => {
  const app = await fixture(t);
  for (const request of [
    { form: multipart({ test: 'true' }), headers: {} },
    { form: multipart({}), headers: { 'x-index-test': 'true', 'x-index-trigger': 'test-event' } }
  ]) {
    const response = await dispatch(app.publicRouter, {
      method: 'POST',
      url: '/webhooks/index',
      headers: { 'content-type': request.form.contentType, ...request.headers },
      body: request.form.body
    });
    assert.equal(response.statusCode, 202);
    assert.equal(response.json.test, true);
    assert.equal(response.json.stored, false);
  }
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM recordings').get().count, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM transcription_jobs').get().count, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM processing_jobs').get().count, 0);
});

test('idempotency keys are isolated per authenticated device', async (t) => {
  const app = await fixture(t);
  const form = multipart({ audio: validM4a('same-event'), transcription: 'Same payload' });
  const common = {
    method: 'POST',
    url: '/webhooks/index',
    headers: { 'content-type': form.contentType, 'idempotency-key': 'shared-client-key' },
    body: form.body
  };

  const first = await dispatch(app.publicRouter, common);
  const second = await dispatch(app.publicRouter, {
    ...common,
    headers: { ...common.headers, 'x-test-device-id': 'device-2' }
  });

  assert.equal(first.statusCode, 202);
  assert.equal(second.statusCode, 202);
  assert.notEqual(second.json.id, first.json.id);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM recordings').get().count, 2);
});

test('webhook validates exact audio sizes, timestamps, and multipart framing', async (t) => {
  const app = await fixture(t);
  const audio = validM4a('validation');
  const send = (form, headers = {}) => dispatch(app.publicRouter, {
    method: 'POST',
    url: '/webhooks/index',
    headers: { 'content-type': form.contentType, ...headers },
    body: form.body
  });

  const mismatch = multipart({ audio, transcription: 'size mismatch' });
  await assert.rejects(
    send(mismatch, { 'x-audio-size': String(audio.length + 1) }),
    (error) => error.status === 400 && error.code === 'audio_size_mismatch'
  );
  await assert.rejects(
    send(mismatch, { 'x-audio-size': `${audio.length}, ${audio.length}` }),
    (error) => error.status === 400 && error.code === 'invalid_audio_size'
  );

  const transcriptOnly = multipart({ transcription: 'No audio here' });
  await assert.rejects(
    send(transcriptOnly, { 'x-audio-size': '0' }),
    (error) => error.status === 400 && error.code === 'unexpected_audio_size'
  );

  const impossibleDate = multipart({ transcription: 'Bad date', recordedAt: '2026-02-30T12:00:00Z' });
  await assert.rejects(
    send(impossibleDate),
    (error) => error.status === 400 && error.code === 'invalid_recorded_at'
  );
  const unsafeEpoch = multipart({ transcription: 'Bad epoch', recordedAt: '99999999999999999' });
  await assert.rejects(
    send(unsafeEpoch),
    (error) => error.status === 400 && error.code === 'invalid_recorded_at'
  );

  const validIso = multipart({ transcription: 'Timezone', recordedAt: '2026-08-22T14:34:56+02:00' });
  const accepted = await send(validIso);
  assert.equal(accepted.statusCode, 202);
  assert.equal(
    app.db.prepare('SELECT recorded_at FROM recordings WHERE id = ?').get(accepted.json.id).recorded_at,
    '2026-08-22T12:34:56.000Z'
  );

  const framed = multipart({ transcription: 'Strict framing' });
  await assert.rejects(
    send({ ...framed, body: Buffer.concat([Buffer.from('preamble'), framed.body]) }),
    (error) => error.status === 400 && error.code === 'invalid_multipart'
  );
  await assert.rejects(
    send({ ...framed, body: Buffer.concat([framed.body, Buffer.from('trailing-data')]) }),
    (error) => error.status === 400 && error.code === 'invalid_multipart'
  );

  const binaryBoundary = 'pebble-fixed-boundary';
  const binaryAudio = validM4a(`binary--${binaryBoundary}-bytes`);
  const binaryForm = multipart({ audio: binaryAudio, boundary: binaryBoundary });
  const binaryAccepted = await send(binaryForm, { 'x-audio-size': String(binaryAudio.length) });
  assert.equal(binaryAccepted.statusCode, 202);
});

test('a transcript-only webhook remains received and does not lose the Pebble transcript', async (t) => {
  const app = await fixture(t);
  const form = multipart({ transcription: 'Already transcribed by Pebble', client: 'Pebble Index' });
  const response = await dispatch(app.publicRouter, {
    method: 'POST',
    url: '/webhooks/index',
    headers: { 'content-type': form.contentType },
    body: form.body
  });
  assert.equal(response.statusCode, 202);

  const listed = await dispatch(app.adminRouter, { url: '/admin/api/recordings' });
  assert.equal(listed.json.recordings[0].hasAudio, false);
  assert.equal(listed.json.recordings[0].audioUrl, null);
  assert.equal(listed.json.recordings[0].audio, null);
  const detail = await dispatch(app.adminRouter, { url: `/admin/api/recordings/${response.json.id}` });
  assert.equal(detail.json.hasAudio, false);
  assert.equal(detail.json.audioUrl, null);
  assert.equal(detail.json.audio, null);
  await assert.rejects(
    dispatch(app.adminRouter, { url: `/admin/api/recordings/${response.json.id}/audio` }),
    (error) => error.status === 404 && error.code === 'audio_not_found'
  );
  await assert.rejects(
    dispatch(app.adminRouter, { method: 'POST', url: `/admin/api/recordings/${response.json.id}/retry` }),
    (error) => error.status === 409 && error.code === 'recording_has_no_audio'
  );

  const stop = startSttWorker(app.deps);
  await waitFor(() => app.db.prepare('SELECT status FROM transcription_jobs').get()?.status === 'completed');
  await stop();

  const recording = app.db.prepare('SELECT stt_state FROM recordings').get();
  assert.equal(recording.stt_state, 'received');
  const transcripts = app.db.prepare('SELECT source, text FROM transcripts').all().map((row) => ({ ...row }));
  assert.deepEqual(transcripts, [{ source: 'pebble', text: 'Already transcribed by Pebble' }]);
});

test('delete preserves the database row when stored audio cannot be removed', async (t) => {
  const app = await fixture(t);
  const form = multipart({ audio: validM4a('delete-order') });
  const accepted = await dispatch(app.publicRouter, {
    method: 'POST',
    url: '/webhooks/index',
    headers: { 'content-type': form.contentType },
    body: form.body
  });
  const row = app.db.prepare('SELECT audio_path FROM recordings WHERE id = ?').get(accepted.json.id);
  const storedPath = path.join(app.config.recordingsDir, row.audio_path);
  await fs.promises.unlink(storedPath);
  await fs.promises.mkdir(storedPath);

  await assert.rejects(
    dispatch(app.adminRouter, { method: 'DELETE', url: `/admin/api/recordings/${accepted.json.id}` }),
    (error) => error.code && error.code !== 'ENOENT'
  );
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM recordings WHERE id = ?').get(accepted.json.id).count, 1);

  await fs.promises.rmdir(storedPath);
  const deleted = await dispatch(app.adminRouter, { method: 'DELETE', url: `/admin/api/recordings/${accepted.json.id}` });
  assert.equal(deleted.statusCode, 204);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM recordings WHERE id = ?').get(accepted.json.id).count, 0);
});

test('worker calls the configured private OpenAI transcription endpoint and preserves both transcripts', async (t) => {
  const app = await fixture(t);
  let receivedRequest = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    receivedRequest = { url: String(url), options };
    if (String(url).endsWith('/readyz')) return new Response('{"status":"ok"}', { status: 200 });
    return new Response('{"text":"Locally generated transcript"}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const baseUrl = 'http://127.0.0.1:8642';
  const now = nowIso();
  app.db.prepare(`UPDATE stt_config SET provider_type = 'test-openai', base_url = ?,
    transcription_path = '/v1/audio/transcriptions', health_path = '/readyz',
    model = 'whisper-test', language = 'en', encrypted_credential = ?, enabled = 1,
    revision = revision + 1, updated_at = ? WHERE id = 1`).run(
    baseUrl, app.cryptoService.encrypt('internal-secret'), now
  );

  const form = multipart({ audio: validM4a('private-stt'), transcription: 'Pebble transcript' });
  const accepted = await dispatch(app.publicRouter, {
    method: 'POST',
    url: '/webhooks/index',
    headers: { 'content-type': form.contentType },
    body: form.body
  });
  assert.equal(accepted.statusCode, 202);

  const stop = startSttWorker(app.deps);
  await waitFor(() => app.db.prepare('SELECT stt_state FROM recordings').get()?.stt_state === 'ready');
  await stop();

  assert.equal(receivedRequest.options.method, 'POST');
  assert.equal(receivedRequest.url, `${baseUrl}/v1/audio/transcriptions`);
  assert.equal(receivedRequest.options.headers.Authorization, 'Bearer internal-secret');
  assert.match(receivedRequest.options.body.get('file').name, /^[0-9a-f-]+\.m4a$/i);
  assert.equal(receivedRequest.options.body.get('model'), 'whisper-test');
  assert.equal(receivedRequest.options.body.get('language'), 'en');

  const transcripts = app.db.prepare('SELECT source, text FROM transcripts ORDER BY source').all().map((row) => ({ ...row }));
  assert.deepEqual(transcripts, [
    { source: 'local_stt', text: 'Locally generated transcript' },
    { source: 'pebble', text: 'Pebble transcript' }
  ]);

  const health = await checkSttHealth(app.deps);
  assert.equal(health.status, 'healthy');
  assert.equal(app.db.prepare('SELECT health_status FROM stt_config WHERE id = 1').get().health_status, 'healthy');
});

test('transient STT outages retry to a terminal error without losing the Pebble transcript', async (t) => {
  const app = await fixture(t, { sttMaxAttempts: 2, sttRetryDelaysMs: [50, 50] });
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response('', { status: 503 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  app.db.prepare(`UPDATE stt_config SET provider_type = 'test-openai',
    base_url = 'http://127.0.0.1:8642', transcription_path = '/v1/audio/transcriptions',
    model = 'whisper-test', enabled = 1, revision = revision + 1, updated_at = ? WHERE id = 1`).run(nowIso());
  const form = multipart({ audio: validM4a('outage'), transcription: 'Pebble fallback transcript' });
  await dispatch(app.publicRouter, {
    method: 'POST',
    url: '/webhooks/index',
    headers: { 'content-type': form.contentType },
    body: form.body
  });

  const stop = startSttWorker(app.deps);
  await waitFor(() => app.db.prepare('SELECT stt_state FROM recordings').get()?.stt_state === 'error');
  await stop();

  assert.equal(requests, 2);
  assert.deepEqual(
    { ...app.db.prepare('SELECT status, attempts, last_error_code FROM transcription_jobs').get() },
    { status: 'failed', attempts: 2, last_error_code: 'stt_http_503' }
  );
  assert.equal(app.db.prepare("SELECT text FROM transcripts WHERE source = 'pebble'").get().text, 'Pebble fallback transcript');
  assert.equal(app.db.prepare("SELECT COUNT(*) AS count FROM transcripts WHERE source = 'local_stt'").get().count, 0);
});

test('disabled STT leaves audio queued in received state without consuming attempts', async (t) => {
  const app = await fixture(t);
  const form = multipart({ audio: validM4a('offline'), transcription: 'Still usable' });
  await dispatch(app.publicRouter, {
    method: 'POST',
    url: '/webhooks/index',
    headers: { 'content-type': form.contentType },
    body: form.body
  });

  const stop = startSttWorker(app.deps);
  await waitFor(() => app.db.prepare('SELECT last_error_code FROM transcription_jobs').get()?.last_error_code === 'stt_unconfigured');
  await stop();

  const recording = app.db.prepare('SELECT stt_state FROM recordings').get();
  const job = { ...app.db.prepare('SELECT status, attempts FROM transcription_jobs').get() };
  assert.equal(recording.stt_state, 'received');
  assert.deepEqual(job, { status: 'pending', attempts: 0 });
  assert.equal(app.db.prepare("SELECT text FROM transcripts WHERE source = 'pebble'").get().text, 'Still usable');
});
