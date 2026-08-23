import { HttpError, readJson, sendJson } from './http.js';
import { nowIso } from './db.js';
import { joinBackendUrl, secureFetch } from './security.js';

const AUDIO_FORMATS = new Map([
  ['mp3', 'audio/mpeg'],
  ['wav', 'audio/wav'],
  ['opus', 'audio/opus'],
  ['flac', 'audio/flac'],
  ['aac', 'audio/aac'],
  ['pcm', 'audio/pcm']
]);
const VOICE = /^[A-Za-z0-9_+().-]{1,200}$/;
const PUBLIC_HEADERS = Object.freeze({ 'Access-Control-Allow-Origin': '*' });
const MAX_VOICES_RESPONSE_BYTES = 512 * 1024;

function currentConfig(db) {
  return db.prepare('SELECT * FROM tts_config WHERE id = 1').get() || null;
}

function endpoint(config, pathField) {
  try {
    return joinBackendUrl(config.base_url, config[pathField]);
  } catch {
    throw new HttpError(503, 'tts_misconfigured', 'Text-to-speech is not configured correctly');
  }
}

function upstreamHeaders(config, cryptoService, accept) {
  const headers = { Accept: accept, 'User-Agent': 'PebbleProxy/0.1' };
  if (config.encrypted_credential) {
    let credential;
    try { credential = cryptoService.decrypt(config.encrypted_credential); }
    catch { throw new HttpError(503, 'tts_credential_unavailable', 'Text-to-speech credential is unavailable'); }
    if (credential) headers.Authorization = `Bearer ${credential}`;
  }
  return headers;
}

async function fetchWithTimeout(deps, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), timeoutMs);
  timer.unref?.();
  try {
    const response = await (deps.fetchImpl || secureFetch)(
      url,
      { ...init, redirect: 'manual', signal: controller.signal },
      { internal: true, allowLoopback: deps.config.nodeEnv === 'test' }
    );
    let disposed = false;
    return {
      response,
      dispose() {
        if (disposed) return;
        disposed = true;
        clearTimeout(timer);
      }
    };
  } catch (error) {
    clearTimeout(timer);
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new HttpError(504, 'tts_timeout', 'Text-to-speech service timed out');
    }
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'tts_unavailable', 'Text-to-speech service is unavailable');
  }
}

async function boundedBody(response, maximum) {
  const declared = Number.parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isSafeInteger(declared) && declared > maximum) {
    throw new HttpError(502, 'tts_response_too_large', 'Text-to-speech response is too large');
  }
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of response.body || []) {
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      if (total > maximum) throw new HttpError(502, 'tts_response_too_large', 'Text-to-speech response is too large');
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new HttpError(504, 'tts_timeout', 'Text-to-speech service timed out');
    }
    throw new HttpError(503, 'tts_unavailable', 'Text-to-speech service is unavailable');
  }
  return Buffer.concat(chunks);
}

function normalizedSpeechRequest(input, config) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'invalid_request', 'Request body must be an object');
  }
  const allowed = new Set(['model', 'input', 'voice', 'response_format', 'speed', 'stream']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new HttpError(400, 'unsupported_field', `${key} is not supported`);
  }
  if (typeof input.input !== 'string' || !input.input.trim() || input.input.length > 20_000) {
    throw new HttpError(400, 'invalid_input', 'input must contain 1-20,000 characters');
  }
  if (input.model !== undefined && (typeof input.model !== 'string' || input.model.length > 100)) {
    throw new HttpError(400, 'invalid_model', 'model must be a short string');
  }
  const voice = input.voice ?? config.voice;
  if (typeof voice !== 'string' || !VOICE.test(voice)) {
    throw new HttpError(400, 'invalid_voice', 'voice contains unsupported characters');
  }
  const format = String(input.response_format || config.response_format).toLowerCase();
  if (!AUDIO_FORMATS.has(format)) throw new HttpError(400, 'invalid_format', 'Unsupported audio response format');
  const speed = input.speed === undefined ? 1 : input.speed;
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.25 || speed > 4) {
    throw new HttpError(400, 'invalid_speed', 'speed must be between 0.25 and 4');
  }
  if (input.stream !== undefined && typeof input.stream !== 'boolean') {
    throw new HttpError(400, 'invalid_stream', 'stream must be a boolean');
  }
  return {
    model: config.model,
    input: input.input,
    voice,
    response_format: format,
    speed,
    stream: input.stream === true
  };
}

function requireEnabled(config) {
  if (!config?.enabled) throw new HttpError(503, 'tts_not_configured', 'Text-to-speech is not enabled');
  return config;
}

export function registerTtsRoutes(router, deps) {
  const { db, cryptoService, config, authenticate, limiter } = deps;

  router.add('GET', '/v1/audio/voices', async (req, res) => {
    const device = await authenticate(req, 'tts:speech');
    const lease = limiter?.acquire ? limiter.acquire(device) : null;
    let fetched;
    let response;
    try {
      const tts = requireEnabled(currentConfig(db));
      fetched = await fetchWithTimeout(deps, endpoint(tts, 'voices_path'), {
        method: 'GET',
        headers: upstreamHeaders(tts, cryptoService, 'application/json')
      }, Math.min(config.ttsTimeoutMs || 120_000, 20_000));
      response = fetched.response;
      if (!response.ok) throw new HttpError(502, 'tts_upstream_error', 'Text-to-speech service rejected the request');
      const raw = await boundedBody(response, MAX_VOICES_RESPONSE_BYTES);
      let payload;
      try { payload = JSON.parse(raw.toString('utf8')); }
      catch { throw new HttpError(502, 'invalid_tts_response', 'Text-to-speech returned an invalid voice list'); }
      const voices = Array.isArray(payload?.voices) ? payload.voices : [];
      const safeVoices = voices.map((item) => typeof item === 'string' ? item : item?.id)
        .filter((item) => typeof item === 'string' && VOICE.test(item));
      return sendJson(res, 200, { voices: safeVoices.map((id) => ({ id, name: id })) }, PUBLIC_HEADERS);
    } finally {
      try { await response?.body?.cancel(); } catch {}
      fetched?.dispose();
      try { lease?.release?.(); } catch {}
    }
  });

  router.add('POST', '/v1/audio/speech', async (req, res) => {
    const device = await authenticate(req, 'tts:speech');
    const lease = limiter?.acquire ? limiter.acquire(device) : null;
    let fetched;
    let response;
    try {
      const tts = requireEnabled(currentConfig(db));
      const input = await readJson(req, config.maxJsonBytes);
      const body = normalizedSpeechRequest(input, tts);
      fetched = await fetchWithTimeout(deps, endpoint(tts, 'speech_path'), {
        method: 'POST',
        headers: { ...upstreamHeaders(tts, cryptoService, 'audio/*'), 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }, config.ttsTimeoutMs || 120_000);
      response = fetched.response;
      if (!response.ok) {
        const transient = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
        throw new HttpError(transient ? 503 : 502, 'tts_upstream_error', transient
          ? 'Text-to-speech service is temporarily unavailable'
          : 'Text-to-speech service rejected the request');
      }
      const audio = await boundedBody(response, config.ttsMaxResponseBytes || 32 * 1024 * 1024);
      if (!audio.length) throw new HttpError(502, 'invalid_tts_response', 'Text-to-speech returned empty audio');
      const contentType = AUDIO_FORMATS.get(body.response_format);
      res.writeHead(200, {
        ...PUBLIC_HEADERS,
        'Cache-Control': 'no-store',
        'Content-Type': contentType,
        'Content-Length': String(audio.length),
        'Content-Disposition': `attachment; filename="speech.${body.response_format}"`,
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(audio);
    } finally {
      try { await response?.body?.cancel(); } catch {}
      fetched?.dispose();
      try { lease?.release?.(); } catch {}
    }
  });
}

export async function checkTtsHealth(deps, { force = false } = {}) {
  const tts = currentConfig(deps.db);
  if (!tts || (!tts.enabled && !force)) return { status: 'unconfigured' };
  const now = nowIso();
  let fetched;
  let response;
  try {
    fetched = await fetchWithTimeout(deps, endpoint(tts, 'health_path'), {
      method: 'GET',
      headers: upstreamHeaders(tts, deps.cryptoService, 'application/json')
    }, Math.min(deps.config.ttsTimeoutMs || 120_000, 20_000));
    response = fetched.response;
    if (!response.ok) throw new HttpError(503, 'tts_health_failed', 'Text-to-speech health check failed');
    deps.db.prepare(`UPDATE tts_config SET health_status = 'healthy', last_health_at = ?,
      last_error = NULL, updated_at = ? WHERE id = 1 AND revision = ?`).run(now, now, tts.revision);
    return { status: 'healthy', checkedAt: now };
  } catch (error) {
    const message = error instanceof HttpError ? error.message.slice(0, 300) : 'Text-to-speech service is unavailable';
    deps.db.prepare(`UPDATE tts_config SET health_status = 'unavailable', last_health_at = ?,
      last_error = ?, updated_at = ? WHERE id = 1 AND revision = ?`).run(now, message, now, tts.revision);
    return { status: 'unavailable', checkedAt: now, error: message };
  } finally {
    try { await response?.body?.cancel(); } catch {}
    fetched?.dispose();
  }
}
