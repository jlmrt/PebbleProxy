import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { once } from 'node:events';
import test from 'node:test';

import { createCryptoService } from '../src/crypto.js';
import { createDatabase } from '../src/db.js';
import { Router } from '../src/http.js';
import { checkTtsHealth, registerTtsRoutes } from '../src/tts.js';

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
  get body() { return Buffer.concat(this.chunks); }
  get json() { return JSON.parse(this.body.toString('utf8')); }
}

async function dispatch(router, { method = 'GET', url = '/', headers = {}, body = '' } = {}) {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  req.method = method;
  req.url = url;
  req.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const res = new CaptureResponse();
  await router.dispatch(req, res);
  if (!res.writableFinished) await once(res, 'finish');
  return res;
}

function fixture(t, fetchImpl) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebble-tts-'));
  const db = createDatabase(path.join(dataDir, 'db.sqlite'));
  const cryptoService = createCryptoService({ dataDir, appSeed: 'tts-test-seed' });
  db.prepare("UPDATE tts_config SET enabled = 1 WHERE id = 1").run();
  const calls = [];
  const authenticate = async (_req, scope) => {
    calls.push(scope);
    return { id: 'tts-device', requests_per_minute: 30, max_concurrency: 2 };
  };
  const router = new Router();
  const deps = {
    db,
    cryptoService,
    authenticate,
    limiter: { acquire: () => ({ release() {} }) },
    config: { maxJsonBytes: 64 * 1024, ttsTimeoutMs: 1000, ttsMaxResponseBytes: 1024 * 1024, nodeEnv: 'test' },
    fetchImpl
  };
  registerTtsRoutes(router, deps);
  t.after(() => { db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { db, deps, router, calls };
}

test('Kokoro speech is token-scoped, validated, and returned as audio', async (t) => {
  let upstream;
  const app = fixture(t, async (url, init, policy) => {
    upstream = { url: String(url), init, policy };
    return new Response(Buffer.from('fake-mp3'), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  });
  const response = await dispatch(app.router, {
    method: 'POST',
    url: '/v1/audio/speech',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
    body: JSON.stringify({ model: 'tts-1', input: 'Hello Pebble', voice: 'af_sky', response_format: 'mp3', speed: 1.1 })
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'audio/mpeg');
  assert.equal(response.body.toString(), 'fake-mp3');
  assert.deepEqual(app.calls, ['tts:speech']);
  assert.equal(upstream.url, 'http://kokoro_web_1:8880/v1/audio/speech');
  assert.equal(upstream.policy.internal, true);
  assert.deepEqual(JSON.parse(upstream.init.body), {
    model: 'kokoro', input: 'Hello Pebble', voice: 'af_sky', response_format: 'mp3', speed: 1.1, stream: false
  });
});

test('Kokoro voice list is normalized and unsafe request fields are rejected', async (t) => {
  const app = fixture(t, async () => new Response(JSON.stringify({ voices: [{ id: 'af_heart' }, { id: 'bad voice' }, 'am_michael'] }), {
    status: 200, headers: { 'content-type': 'application/json' }
  }));
  const voices = await dispatch(app.router, { url: '/v1/audio/voices' });
  assert.deepEqual(voices.json.voices, [{ id: 'af_heart', name: 'af_heart' }, { id: 'am_michael', name: 'am_michael' }]);
  await assert.rejects(
    dispatch(app.router, {
      method: 'POST', url: '/v1/audio/speech', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'Hello', upstream_url: 'http://attacker/' })
    }),
    (error) => error.status === 400 && error.code === 'unsupported_field'
  );
});

test('Kokoro health checks use the private official Umbrel service', async (t) => {
  let target = '';
  const app = fixture(t, async (url) => {
    target = String(url);
    return new Response(JSON.stringify({ status: 'healthy' }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const health = await checkTtsHealth(app.deps, { force: true });
  assert.equal(health.status, 'healthy');
  assert.equal(target, 'http://kokoro_web_1:8880/health');
  assert.equal(app.db.prepare('SELECT health_status FROM tts_config WHERE id = 1').get().health_status, 'healthy');
});
