import crypto from 'node:crypto';
import { createNote, createReminder } from './actions.js';
import {
  createClientDevice,
  createDevice,
  createDeviceConnection,
  deleteEmptyClientDevice,
  listClientDevices,
  listDevices,
  resetDeviceSessions,
  revokeDevice
} from './auth.js';
import { HttpError, readJson, sendJson, safeJson } from './http.js';
import { nowIso } from './db.js';
import { checkSttHealth } from './recordings.js';
import { checkTtsHealth } from './tts.js';
import {
  checkProcessingHealth,
  currentProcessingConfig,
  listProcessingJobs,
  processingConfigView,
  retryProcessingJob
} from './processing.js';
import {
  joinBackendUrl,
  parseBackendBaseUrl,
  secureFetch,
  validateEndpointPath,
  validateProviderInput
} from './security.js';

function providerView(row) {
  const config = safeJson(row.config_json, {});
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    baseUrl: row.base_url,
    chatPath: row.chat_path,
    modelsPath: row.models_path,
    healthPath: row.health_path,
    hasCredential: Boolean(row.encrypted_credential),
    enabled: Boolean(row.enabled),
    internal: config.internal !== false,
    healthStatus: row.health_status,
    status: row.health_status,
    lastHealthAt: row.last_health_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function aliasView(row) {
  return {
    id: row.alias,
    alias: row.alias,
    providerId: row.provider_id,
    providerName: row.provider_name,
    upstreamModel: row.upstream_model,
    downstreamModel: row.upstream_model,
    agentProfileId: row.agent_profile_id,
    enabled: Boolean(row.enabled),
    maxOutputTokens: row.max_output_tokens,
    timeoutMs: row.timeout_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function aliasRows(db) {
  return db.prepare(`SELECT a.*, p.name AS provider_name FROM model_aliases a
    JOIN ai_providers p ON p.id = a.provider_id ORDER BY a.alias`).all().map(aliasView);
}

function integer(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function boolean(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function validatedCredential(value) {
  const credential = String(value ?? '');
  if (credential.length > 4096 || /[\r\n]/.test(credential)) {
    throw new HttpError(400, 'invalid_credential', 'Credential must be at most 4096 characters and cannot contain line breaks');
  }
  return credential;
}

async function timedFetch(url, options, timeoutMs, policy) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  timeout.unref?.();
  const started = Date.now();
  try {
    const response = await secureFetch(url, { ...options, redirect: 'manual', signal: controller.signal }, policy);
    let disposed = false;
    return {
      response,
      latencyMs: Date.now() - started,
      async dispose() {
        if (disposed) return;
        disposed = true;
        try { await response.body?.cancel(); } catch {}
        clearTimeout(timeout);
      }
    };
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

function safeHealthMessage(error) {
  if (error?.name === 'AbortError' || error?.message === 'timeout') return 'Connection timed out';
  if (error instanceof HttpError) return error.message.slice(0, 300);
  return 'Could not connect to the backend';
}

export async function testProvider(db, cryptoService, provider, config) {
  const url = joinBackendUrl(provider.base_url, provider.health_path);
  const providerConfig = safeJson(provider.config_json, {});
  const allowLoopback = config.nodeEnv === 'test';
  const now = nowIso();
  let fetched;
  try {
    const credential = cryptoService.decrypt(provider.encrypted_credential);
    const headers = { Accept: 'application/json', 'User-Agent': 'PebbleProxy/0.1' };
    if (credential) headers.Authorization = `Bearer ${credential}`;
    fetched = await timedFetch(
      url,
      { method: 'GET', headers },
      Math.min(15_000, config.aiTimeoutMs),
      { internal: providerConfig.internal !== false, allowLoopback }
    );
    const { response, latencyMs } = fetched;
    if (response.status >= 300 && response.status < 400) throw new HttpError(503, 'backend_redirected', 'Backend returned an unexpected redirect');
    if (!response.ok) throw new HttpError(503, 'backend_unhealthy', `Backend health check returned HTTP ${response.status}`);
    db.prepare(`UPDATE ai_providers SET health_status = 'healthy', last_health_at = ?, last_error = NULL, updated_at = ?
      WHERE id = ? AND updated_at = ?`).run(now, now, provider.id, provider.updated_at);
    return { ok: true, status: 'healthy', latencyMs };
  } catch (error) {
    const message = safeHealthMessage(error);
    db.prepare(`UPDATE ai_providers SET health_status = 'unavailable', last_health_at = ?, last_error = ?, updated_at = ?
      WHERE id = ? AND updated_at = ?`).run(now, message, now, provider.id, provider.updated_at);
    return { ok: false, status: 'unavailable', error: message };
  } finally {
    await fetched?.dispose();
  }
}

function sttView(row) {
  return {
    providerType: row.provider_type,
    baseUrl: row.base_url,
    transcriptionPath: row.transcription_path,
    healthPath: row.health_path,
    model: row.model,
    language: row.language,
    hasCredential: Boolean(row.encrypted_credential),
    enabled: Boolean(row.enabled),
    revision: row.revision,
    healthStatus: row.health_status,
    status: row.health_status,
    lastHealthAt: row.last_health_at,
    lastError: row.last_error,
    updatedAt: row.updated_at
  };
}

function ttsView(row) {
  return {
    providerType: row.provider_type,
    baseUrl: row.base_url,
    speechPath: row.speech_path,
    voicesPath: row.voices_path,
    healthPath: row.health_path,
    model: row.model,
    voice: row.voice,
    responseFormat: row.response_format,
    hasCredential: Boolean(row.encrypted_credential),
    enabled: Boolean(row.enabled),
    revision: row.revision,
    healthStatus: row.health_status,
    status: row.health_status,
    lastHealthAt: row.last_health_at,
    lastError: row.last_error,
    updatedAt: row.updated_at
  };
}

export async function testStt(db, cryptoService, config) {
  const started = Date.now();
  const result = await checkSttHealth({ db, cryptoService, config }, { force: true });
  return { ok: result.status === 'healthy', ...result, latencyMs: Date.now() - started };
}

export async function testTts(db, cryptoService, config) {
  const started = Date.now();
  const result = await checkTtsHealth({ db, cryptoService, config }, { force: true });
  return { ok: result.status === 'healthy', ...result, latencyMs: Date.now() - started };
}

function scheduleHealthCheck(db, key) {
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, 'pending', ?)
    ON CONFLICT(key) DO UPDATE SET value = 'pending', updated_at = excluded.updated_at`).run(`health_request:${key}`, nowIso());
}

export function startHealthWorker({ db, cryptoService, config, log = () => {} }) {
  let stopped = false;
  let timer;
  let running = false;
  const check = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const requested = db.prepare("SELECT key FROM settings WHERE key LIKE 'health_request:%' AND value = 'pending' ORDER BY updated_at LIMIT 10").all();
      for (const item of requested) {
        const target = item.key.slice('health_request:'.length);
        if (target === 'stt') await testStt(db, cryptoService, config);
        else if (target === 'tts') await testTts(db, cryptoService, config);
        else if (target.startsWith('provider:')) {
          const provider = db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(target.slice('provider:'.length));
          if (provider) await testProvider(db, cryptoService, provider, config);
        }
        db.prepare("UPDATE settings SET value = 'completed', updated_at = ? WHERE key = ?").run(nowIso(), item.key);
      }

      const cutoff = new Date(Date.now() - 60_000).toISOString();
      const staleProviders = db.prepare(`SELECT * FROM ai_providers WHERE enabled = 1
        AND (last_health_at IS NULL OR last_health_at < ?) ORDER BY COALESCE(last_health_at, '') LIMIT 2`).all(cutoff);
      for (const provider of staleProviders) await testProvider(db, cryptoService, provider, config);
      const stt = db.prepare('SELECT * FROM stt_config WHERE id = 1 AND enabled = 1').get();
      if (stt && (!stt.last_health_at || stt.last_health_at < cutoff)) await testStt(db, cryptoService, config);
      const tts = db.prepare('SELECT * FROM tts_config WHERE id = 1 AND enabled = 1').get();
      if (tts && (!tts.last_health_at || tts.last_health_at < cutoff)) await testTts(db, cryptoService, config);
    } catch (error) {
      log('error', 'health_worker_failed', { error: error?.message });
    } finally {
      running = false;
    }
  };
  timer = setInterval(check, 5_000);
  timer.unref?.();
  setTimeout(check, 250).unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function ensureAlias(value) {
  const alias = String(value || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(alias)) throw new HttpError(400, 'invalid_alias', 'Alias must contain only letters, numbers, dots, colons, underscores, or dashes');
  return alias;
}

const PUBLIC_BASE_URL_SETTING = 'public_base_url';

function normalizePublicBaseUrl(value) {
  const raw = String(value || '').trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HttpError(400, 'invalid_public_base_url', 'Enter a valid public HTTPS origin');
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname) {
    throw new HttpError(400, 'invalid_public_base_url', 'The public origin must use HTTPS');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) {
    throw new HttpError(400, 'invalid_public_base_url', 'Enter only the HTTPS origin, without credentials, a path, query, or fragment');
  }
  return parsed.origin;
}

function configuredPublicBaseUrl(db, config) {
  const stored = db.prepare('SELECT value FROM settings WHERE key = ?').get(PUBLIC_BASE_URL_SETTING)?.value;
  const candidate = stored || config.publicBaseUrl;
  if (!candidate) return '';
  try {
    return normalizePublicBaseUrl(candidate);
  } catch {
    return '';
  }
}

function connectivityView(db, config) {
  const publicBaseUrl = configuredPublicBaseUrl(db, config);
  const webhookUrl = publicBaseUrl ? `${publicBaseUrl}/webhooks/index` : '';
  const serviceUrl = `http://${config.umbrelAppId}_api_1:8080`;
  return {
    publicBaseUrl,
    publicHostname: publicBaseUrl,
    cloudflare: {
      managedExternally: true,
      status: 'not_checked',
      serviceUrl,
      publicTarget: serviceUrl,
      routeMode: 'internal_container',
      hostPortPublished: false,
      adminPort: 9432,
      adminPublic: false
    },
    publicApi: {
      status: publicBaseUrl ? 'configured' : 'unknown',
      baseUrl: publicBaseUrl,
      webhookUrl,
      openAiBaseUrl: publicBaseUrl ? `${publicBaseUrl}/v1` : '',
      mcpUrl: publicBaseUrl ? `${publicBaseUrl}/mcp` : ''
    }
  };
}

function credentialInput(input) {
  const expiryDurations = { '30d': 30 * 86_400_000, '90d': 90 * 86_400_000, '1y': 365 * 86_400_000 };
  if (input.expiresIn != null && !['never', ...Object.keys(expiryDurations)].includes(String(input.expiresIn))) {
    throw new HttpError(400, 'invalid_expiry', 'Select a supported token expiry');
  }
  const expiresAt = input.expiresAt || (expiryDurations[input.expiresIn]
    ? new Date(Date.now() + expiryDurations[input.expiresIn]).toISOString()
    : null);
  return {
    ...input,
    requestsPerMinute: input.requestsPerMinute ?? input.rateLimit,
    expiresAt
  };
}

function adminConnectionView(connection, publicBaseUrl) {
  const scopes = Array.isArray(connection.scopes) ? connection.scopes : [];
  return {
    ...connection,
    webhookUrl: connection.webhookPath && publicBaseUrl ? `${publicBaseUrl}${connection.webhookPath}` : '',
    openAiBaseUrl: scopes.includes('ai:chat') && publicBaseUrl ? `${publicBaseUrl}/v1` : '',
    speechUrl: scopes.includes('tts:speech') && publicBaseUrl ? `${publicBaseUrl}/v1/audio/speech` : '',
    mcpUrl: scopes.includes('mcp:invoke') && publicBaseUrl ? `${publicBaseUrl}/mcp` : ''
  };
}

function adminDeviceGroupView(device, publicBaseUrl) {
  return {
    ...device,
    connections: device.connections.map((connection) => adminConnectionView(connection, publicBaseUrl))
  };
}

function overview(db, config) {
  const count = (table, where = '') => db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get().count;
  const activeConnections = db.prepare(`SELECT COUNT(*) AS count FROM device_credentials
    WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`).get(nowIso()).count;
  const stt = db.prepare('SELECT health_status, enabled FROM stt_config WHERE id = 1').get();
  const tts = db.prepare('SELECT health_status, enabled FROM tts_config WHERE id = 1').get();
  const processing = currentProcessingConfig(db);
  const connectivity = connectivityView(db, config);
  return {
    version: '0.1.0-test.9',
    role: config.role,
    publicBaseUrl: connectivity.publicBaseUrl,
    publicHostname: connectivity.publicHostname,
    connectivity,
    counts: {
      devices: count('client_devices'),
      activeConnections,
      activeDevices: activeConnections,
      backends: count('ai_providers', 'WHERE enabled = 1'),
      aliases: count('model_aliases', 'WHERE enabled = 1'),
      recordings: count('recordings'),
      recordingsPending: count('recordings', "WHERE stt_state IN ('received','transcribing')"),
      notes: count('notes', 'WHERE archived = 0'),
      reminders: count('reminders', 'WHERE completed_at IS NULL'),
      processingPending: count('processing_jobs', "WHERE status IN ('pending','processing','needs_review')")
    },
    stt: { enabled: Boolean(stt.enabled), healthStatus: stt.health_status, status: stt.health_status },
    tts: { enabled: Boolean(tts.enabled), healthStatus: tts.health_status, status: tts.health_status },
    processing: {
      enabled: Boolean(processing.enabled),
      healthStatus: processing.health_status,
      status: processing.health_status
    },
    cloudflare: connectivity.cloudflare,
    publicApi: connectivity.publicApi
  };
}

export function registerAdminRoutes(router, { db, cryptoService, config }) {
  router.add('GET', '/admin/api/overview', (_req, res) => sendJson(res, 200, overview(db, config)));
  router.add('PUT', '/admin/api/connectivity', async (req, res) => {
    const input = await readJson(req, config.maxJsonBytes);
    const publicBaseUrl = normalizePublicBaseUrl(input.publicBaseUrl);
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(PUBLIC_BASE_URL_SETTING, publicBaseUrl, nowIso());
    sendJson(res, 200, { connectivity: connectivityView(db, config) });
  });

  router.add('GET', '/admin/api/devices', (_req, res) => sendJson(res, 200, { devices: listDevices(db) }));
  router.add('POST', '/admin/api/devices', async (req, res) => {
    const input = await readJson(req, config.maxJsonBytes);
    sendJson(res, 201, createDevice(db, cryptoService, credentialInput(input)));
  });
  router.add('DELETE', '/admin/api/devices/:id', (_req, res, { params }) => {
    revokeDevice(db, params.id);
    sendJson(res, 200, { ok: true });
  });
  router.add('POST', '/admin/api/devices/:id/reset-sessions', (_req, res, { params }) => {
    resetDeviceSessions(db, params.id);
    sendJson(res, 200, { ok: true });
  });

  router.add('GET', '/admin/api/device-groups', (_req, res) => {
    const publicBaseUrl = configuredPublicBaseUrl(db, config);
    sendJson(res, 200, {
      devices: listClientDevices(db).map((device) => adminDeviceGroupView(device, publicBaseUrl))
    });
  });
  router.add('POST', '/admin/api/device-groups', async (req, res) => {
    const input = await readJson(req, config.maxJsonBytes);
    sendJson(res, 201, { device: createClientDevice(db, input) });
  });
  router.add('DELETE', '/admin/api/device-groups/:id', (_req, res, { params }) => {
    deleteEmptyClientDevice(db, params.id);
    sendJson(res, 200, { ok: true });
  });
  router.add('POST', '/admin/api/device-groups/:id/connections', async (req, res, { params }) => {
    const input = credentialInput(await readJson(req, config.maxJsonBytes));
    const created = createDeviceConnection(db, cryptoService, params.id, input);
    const publicBaseUrl = configuredPublicBaseUrl(db, config);
    sendJson(res, 201, {
      connection: adminConnectionView(created.connection, publicBaseUrl),
      token: created.token
    });
  });

  router.add('GET', '/admin/api/backends', (_req, res) => {
    const providers = db.prepare('SELECT * FROM ai_providers ORDER BY created_at DESC').all().map(providerView);
    sendJson(res, 200, { backends: providers });
  });
  router.add('POST', '/admin/api/backends', async (req, res) => {
    const raw = await readJson(req, config.maxJsonBytes);
    const presetTypes = { openclaw: 'openclaw-umbrel', hermes: 'hermes-umbrel', generic: 'generic' };
    const input = validateProviderInput({ ...raw, credential: validatedCredential(raw.credential), type: raw.type || presetTypes[raw.preset] || 'generic' });
    const id = crypto.randomUUID();
    const now = nowIso();
    db.prepare(`INSERT INTO ai_providers
      (id, name, type, base_url, chat_path, models_path, health_path, encrypted_credential, enabled, config_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.name, input.type, input.baseUrl, input.chatPath, input.modelsPath, input.healthPath,
        cryptoService.encrypt(input.credential), input.enabled ? 1 : 0, JSON.stringify(input.config), now, now);
    sendJson(res, 201, { backend: providerView(db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(id)) });
  });
  router.add('PUT', '/admin/api/backends/:id', async (req, res, { params }) => {
    const current = db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(params.id);
    if (!current) throw new HttpError(404, 'backend_not_found', 'Backend not found');
    const raw = await readJson(req, config.maxJsonBytes);
    const input = validateProviderInput({
      ...raw,
      credential: validatedCredential(raw.credential),
      type: raw.type ?? current.type,
      name: raw.name ?? current.name,
      baseUrl: raw.baseUrl ?? current.base_url,
      chatPath: raw.chatPath ?? current.chat_path,
      modelsPath: raw.modelsPath ?? current.models_path,
      healthPath: raw.healthPath ?? current.health_path,
      allowExternal: raw.allowExternal ?? safeJson(current.config_json, {}).allowExternal,
      enabled: raw.enabled ?? Boolean(current.enabled)
    });
    const encrypted = raw.clearCredential === true
      ? null
      : raw.credential ? cryptoService.encrypt(input.credential) : current.encrypted_credential;
    db.prepare(`UPDATE ai_providers SET name = ?, type = ?, base_url = ?, chat_path = ?, models_path = ?, health_path = ?,
      encrypted_credential = ?, enabled = ?, config_json = ?, health_status = 'unknown', last_error = NULL, updated_at = ? WHERE id = ?`)
      .run(input.name, input.type, input.baseUrl, input.chatPath, input.modelsPath, input.healthPath, encrypted,
        input.enabled ? 1 : 0, JSON.stringify(input.config), nowIso(), params.id);
    sendJson(res, 200, { backend: providerView(db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(params.id)) });
  });
  router.add('DELETE', '/admin/api/backends/:id', (_req, res, { params }) => {
    const aliases = db.prepare('SELECT alias FROM model_aliases WHERE provider_id = ?').all(params.id);
    const changed = db.prepare('DELETE FROM ai_providers WHERE id = ?').run(params.id);
    if (!changed.changes) throw new HttpError(404, 'backend_not_found', 'Backend not found');
    for (const row of aliases) db.prepare('DELETE FROM ai_sessions WHERE alias = ?').run(row.alias);
    sendJson(res, 200, { ok: true });
  });
  router.add('POST', '/admin/api/backends/:id/test', async (_req, res, { params }) => {
    const provider = db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(params.id);
    if (!provider) throw new HttpError(404, 'backend_not_found', 'Backend not found');
    scheduleHealthCheck(db, `provider:${provider.id}`);
    sendJson(res, 202, { ok: false, scheduled: true, status: 'pending', message: 'Backend health check scheduled' });
  });

  const aliasesHandler = (_req, res) => sendJson(res, 200, { modelAliases: aliasRows(db), aliases: aliasRows(db) });
  router.add('GET', '/admin/api/model-aliases', aliasesHandler);
  router.add('GET', '/admin/api/aliases', aliasesHandler);
  router.add('POST', '/admin/api/model-aliases', async (req, res) => {
    const input = await readJson(req, config.maxJsonBytes);
    const alias = ensureAlias(input.alias);
    const provider = db.prepare('SELECT id, type FROM ai_providers WHERE id = ?').get(String(input.providerId || input.backendId || ''));
    if (!provider) throw new HttpError(400, 'invalid_provider', 'Select an existing backend');
    const model = String(input.upstreamModel || input.downstreamModel || '').trim();
    if (!model || model.length > 200) throw new HttpError(400, 'invalid_model', 'Upstream model is required');
    if (provider.type === 'openclaw-umbrel' && model !== 'openclaw/pebble') {
      throw new HttpError(400, 'invalid_model', 'The OpenClaw preset is restricted to the dedicated openclaw/pebble agent');
    }
    const profile = String(input.agentProfileId || 'pebble');
    if (!db.prepare('SELECT id FROM agent_profiles WHERE id = ?').get(profile)) throw new HttpError(400, 'invalid_profile', 'Agent profile not found');
    const now = nowIso();
    try {
      db.prepare(`INSERT INTO model_aliases
        (alias, provider_id, upstream_model, agent_profile_id, enabled, max_output_tokens, timeout_ms, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(alias, provider.id, model, profile, input.enabled === false ? 0 : 1,
          integer(input.maxOutputTokens, 1024, 1, 8192), integer(input.timeoutMs, config.aiTimeoutMs, 5000, 600000), now, now);
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new HttpError(409, 'alias_exists', 'That public model alias already exists');
      throw error;
    }
    sendJson(res, 201, { modelAlias: aliasRows(db).find((item) => item.alias === alias) });
  });
  router.add('DELETE', '/admin/api/model-aliases/:alias', (_req, res, { params }) => {
    const changed = db.prepare('DELETE FROM model_aliases WHERE alias = ?').run(params.alias);
    if (!changed.changes) throw new HttpError(404, 'alias_not_found', 'Model alias not found');
    db.prepare('DELETE FROM ai_sessions WHERE alias = ?').run(params.alias);
    sendJson(res, 200, { ok: true });
  });

  router.add('GET', '/admin/api/stt', (_req, res) => {
    const stt = sttView(db.prepare('SELECT * FROM stt_config WHERE id = 1').get());
    sendJson(res, 200, { stt, health: { status: stt.healthStatus, checkedAt: stt.lastHealthAt, error: stt.lastError, model: stt.model } });
  });
  router.add('PUT', '/admin/api/stt', async (req, res) => {
    const raw = await readJson(req, config.maxJsonBytes);
    const current = db.prepare('SELECT * FROM stt_config WHERE id = 1').get();
    const providerType = String(raw.providerType || raw.provider || current.provider_type);
    if (!['localai', 'openai-compatible', 'sidecar'].includes(providerType)) throw new HttpError(400, 'invalid_stt_type', 'Unsupported speech-to-text provider type');
    const base = parseBackendBaseUrl(raw.baseUrl || current.base_url);
    const model = String(raw.model || current.model).trim();
    if (!model || model.length > 200) throw new HttpError(400, 'invalid_stt_model', 'STT model is required');
    const language = raw.language == null || raw.language === '' ? null : String(raw.language).trim().slice(0, 20);
    const rawCredential = validatedCredential(raw.credential);
    const credential = raw.clearCredential === true
      ? null
      : rawCredential ? cryptoService.encrypt(rawCredential) : current.encrypted_credential;
    db.prepare(`UPDATE stt_config SET provider_type = ?, base_url = ?, transcription_path = ?, health_path = ?, model = ?, language = ?,
      encrypted_credential = ?, enabled = ?, revision = revision + 1, health_status = 'unknown', last_error = NULL, updated_at = ? WHERE id = 1`)
      .run(providerType, base.toString().replace(/\/$/, ''),
        validateEndpointPath(raw.transcriptionPath || current.transcription_path, 'Transcription path'),
        validateEndpointPath(raw.healthPath || current.health_path, 'Health path'), model, language, credential,
        boolean(raw.enabled, Boolean(current.enabled)) ? 1 : 0, nowIso());
    sendJson(res, 200, { stt: sttView(db.prepare('SELECT * FROM stt_config WHERE id = 1').get()) });
  });
  router.add('POST', '/admin/api/stt/test', async (_req, res) => {
    scheduleHealthCheck(db, 'stt');
    sendJson(res, 202, { ok: false, scheduled: true, status: 'pending', message: 'Speech-to-text health check scheduled' });
  });

  router.add('GET', '/admin/api/tts', (_req, res) => {
    const tts = ttsView(db.prepare('SELECT * FROM tts_config WHERE id = 1').get());
    sendJson(res, 200, { tts, health: { status: tts.healthStatus, checkedAt: tts.lastHealthAt, error: tts.lastError, model: tts.model, voice: tts.voice } });
  });
  router.add('PUT', '/admin/api/tts', async (req, res) => {
    const raw = await readJson(req, config.maxJsonBytes);
    const current = db.prepare('SELECT * FROM tts_config WHERE id = 1').get();
    const providerType = String(raw.providerType || raw.provider || current.provider_type).toLowerCase();
    if (providerType !== 'kokoro') throw new HttpError(400, 'invalid_tts_type', 'Unsupported text-to-speech provider type');
    const base = parseBackendBaseUrl(raw.baseUrl || current.base_url);
    const model = String(raw.model || current.model).trim();
    const voice = String(raw.voice || current.voice).trim();
    const responseFormat = String(raw.responseFormat || current.response_format).trim().toLowerCase();
    if (!model || model.length > 100) throw new HttpError(400, 'invalid_tts_model', 'TTS model is required');
    if (!/^[A-Za-z0-9_+().-]{1,200}$/.test(voice)) throw new HttpError(400, 'invalid_tts_voice', 'TTS voice contains unsupported characters');
    if (!['mp3', 'wav', 'opus', 'flac', 'aac', 'pcm'].includes(responseFormat)) {
      throw new HttpError(400, 'invalid_tts_format', 'Unsupported TTS audio format');
    }
    const rawCredential = validatedCredential(raw.credential);
    const credential = raw.clearCredential === true
      ? null
      : rawCredential ? cryptoService.encrypt(rawCredential) : current.encrypted_credential;
    db.prepare(`UPDATE tts_config SET provider_type = ?, base_url = ?, speech_path = ?, voices_path = ?,
      health_path = ?, model = ?, voice = ?, response_format = ?, encrypted_credential = ?, enabled = ?,
      revision = revision + 1, health_status = 'unknown', last_error = NULL, updated_at = ? WHERE id = 1`)
      .run(providerType, base.toString().replace(/\/$/, ''),
        validateEndpointPath(raw.speechPath || current.speech_path, 'Speech path'),
        validateEndpointPath(raw.voicesPath || current.voices_path, 'Voices path'),
        validateEndpointPath(raw.healthPath || current.health_path, 'Health path'),
        model, voice, responseFormat, credential,
        boolean(raw.enabled, Boolean(current.enabled)) ? 1 : 0, nowIso());
    sendJson(res, 200, { tts: ttsView(db.prepare('SELECT * FROM tts_config WHERE id = 1').get()) });
  });
  router.add('POST', '/admin/api/tts/test', async (_req, res) => {
    scheduleHealthCheck(db, 'tts');
    sendJson(res, 202, { ok: false, scheduled: true, status: 'pending', message: 'Text-to-speech health check scheduled' });
  });

  router.add('GET', '/admin/api/processing', (_req, res) => {
    sendJson(res, 200, {
      processing: processingConfigView(currentProcessingConfig(db)),
      jobs: listProcessingJobs(db, 100)
    });
  });
  router.add('PUT', '/admin/api/processing', async (req, res) => {
    const input = await readJson(req, config.maxJsonBytes);
    const current = currentProcessingConfig(db);
    const threshold = input.confidenceThreshold === undefined
      ? Number(current.confidence_threshold)
      : Number(input.confidenceThreshold);
    if (!Number.isFinite(threshold) || threshold < 0.05 || threshold > 0.99) {
      throw new HttpError(400, 'invalid_confidence_threshold', 'Confidence threshold must be between 0.05 and 0.99');
    }
    const rawAlias = input.agentAlias === undefined ? current.agent_alias : input.agentAlias;
    const agentAlias = rawAlias == null || String(rawAlias).trim() === '' ? null : ensureAlias(rawAlias);
    if (agentAlias && !db.prepare(`SELECT ma.alias FROM model_aliases ma
      JOIN ai_providers p ON p.id = ma.provider_id
      WHERE ma.alias = ? AND ma.enabled = 1 AND p.enabled = 1`).get(agentAlias)) {
      throw new HttpError(400, 'invalid_agent_alias', 'Select an enabled agent alias');
    }
    db.prepare(`UPDATE processing_config SET enabled = ?, confidence_threshold = ?, agent_alias = ?,
      revision = revision + 1, updated_at = ? WHERE id = 1`).run(
      boolean(input.enabled, Boolean(current.enabled)) ? 1 : 0,
      threshold,
      agentAlias,
      nowIso()
    );
    sendJson(res, 200, { processing: processingConfigView(currentProcessingConfig(db)) });
  });
  router.add('POST', '/admin/api/processing/test', async (_req, res) => {
    const result = await checkProcessingHealth({ db, cryptoService, config });
    sendJson(res, result.ok ? 200 : 503, result);
  });
  router.add('POST', '/admin/api/processing/jobs/:id/retry', (_req, res, { params }) => {
    retryProcessingJob(db, params.id);
    sendJson(res, 202, { ok: true, queued: true });
  });

  router.add('GET', '/admin/api/notes', (_req, res) => {
    const notes = db.prepare(`SELECT n.id, n.title, n.body, n.archived, n.created_at, n.updated_at,
      d.id AS device_id, d.name AS device_name, d.owner_device_id, d.connection_label
      FROM notes n JOIN device_credentials d ON d.id = n.device_id
      ORDER BY n.updated_at DESC LIMIT 200`).all();
    sendJson(res, 200, { notes });
  });
  router.add('POST', '/admin/api/notes', async (req, res) => {
    const input = await readJson(req, config.maxJsonBytes);
    const body = String(input.body || '').trim();
    const title = input.title == null || input.title === '' ? null : String(input.title).trim();
    if (!body || body.length > 8000) throw new HttpError(400, 'invalid_note', 'Note body is required and must be at most 8000 characters');
    if (title && title.length > 120) throw new HttpError(400, 'invalid_note', 'Note title must be at most 120 characters');
    if (!input.deviceId) throw new HttpError(400, 'device_required', 'Select the device that owns this note');
    const device = db.prepare('SELECT id FROM device_credentials WHERE id = ? AND revoked_at IS NULL').get(String(input.deviceId));
    if (!device) throw new HttpError(400, 'device_required', 'Select an active device for this note');
    const note = createNote(db, device.id, { title, body });
    sendJson(res, 201, { note });
  });
  router.add('DELETE', '/admin/api/notes/:id', (_req, res, { params }) => {
    const changed = db.prepare('DELETE FROM notes WHERE id = ?').run(params.id);
    if (!changed.changes) throw new HttpError(404, 'note_not_found', 'Note not found');
    sendJson(res, 200, { ok: true });
  });
  router.add('GET', '/admin/api/reminders', (_req, res) => {
    const reminders = db.prepare(`SELECT r.id, r.title, r.due_at, r.due_text, r.timezone, r.completed_at, r.created_at, r.updated_at,
      d.id AS device_id, d.name AS device_name, d.owner_device_id, d.connection_label
      FROM reminders r JOIN device_credentials d ON d.id = r.device_id
      ORDER BY r.completed_at IS NOT NULL, r.due_at IS NULL, r.due_at LIMIT 200`).all();
    sendJson(res, 200, { reminders });
  });
  router.add('POST', '/admin/api/reminders', async (req, res) => {
    const input = await readJson(req, config.maxJsonBytes);
    const title = String(input.title || '').trim();
    if (!title || title.length > 200) throw new HttpError(400, 'invalid_reminder', 'Reminder title is required and must be at most 200 characters');
    const rawDue = input.dueAt ?? input.due_at;
    let dueAt = null;
    if (rawDue) {
      const due = new Date(rawDue);
      if (!Number.isFinite(due.getTime())) throw new HttpError(400, 'invalid_due_at', 'Reminder due date is invalid');
      dueAt = due.toISOString();
    }
    if (!input.deviceId) throw new HttpError(400, 'device_required', 'Select the device that owns this reminder');
    const device = db.prepare('SELECT id FROM device_credentials WHERE id = ? AND revoked_at IS NULL').get(String(input.deviceId));
    if (!device) throw new HttpError(400, 'device_required', 'Select an active device for this reminder');
    const reminder = createReminder(db, device.id, {
      title,
      due_at: dueAt,
      timezone: input.timezone ? String(input.timezone).slice(0, 80) : null
    });
    sendJson(res, 201, { reminder });
  });
  router.add('PATCH', '/admin/api/reminders/:id', async (req, res, { params }) => {
    const input = await readJson(req, config.maxJsonBytes);
    if (typeof input.completed !== 'boolean') throw new HttpError(400, 'invalid_reminder', 'completed must be a boolean');
    const now = nowIso();
    const changed = db.prepare('UPDATE reminders SET completed_at = ?, updated_at = ? WHERE id = ?')
      .run(input.completed ? now : null, now, params.id);
    if (!changed.changes) throw new HttpError(404, 'reminder_not_found', 'Reminder not found');
    sendJson(res, 200, { reminder: db.prepare('SELECT id, device_id, title, due_at, due_text, timezone, completed_at, created_at, updated_at FROM reminders WHERE id = ?').get(params.id) });
  });
  router.add('DELETE', '/admin/api/reminders/:id', (_req, res, { params }) => {
    const changed = db.prepare('DELETE FROM reminders WHERE id = ?').run(params.id);
    if (!changed.changes) throw new HttpError(404, 'reminder_not_found', 'Reminder not found');
    sendJson(res, 200, { ok: true });
  });
}
