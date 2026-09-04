import fs from 'node:fs';
import path from 'node:path';

function integer(value, fallback, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function list(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function integerList(value, fallback) {
  const parsed = String(value ?? '')
    .split(',')
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isSafeInteger(item) && item >= 50 && item <= 3_600_000);
  return parsed.length ? parsed : fallback;
}

function umbrelAppId(value) {
  const appId = String(value || 'pebble-proxy');
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(appId)) {
    throw new Error('UMBREL_APP_ID must be a lowercase kebab-case Umbrel app ID');
  }
  return appId;
}

export function loadConfig(overrides = {}) {
  const env = { ...process.env, ...overrides };
  const role = ['all', 'public', 'admin'].includes(env.ROLE) ? env.ROLE : 'all';
  const dataDir = path.resolve(env.DATA_DIR || './data');
  const recordingsDir = path.join(dataDir, 'recordings');
  const tmpDir = path.join(dataDir, 'tmp');

  for (const directory of [dataDir, recordingsDir, tmpDir]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  return Object.freeze({
    role,
    dataDir,
    recordingsDir,
    tmpDir,
    databasePath: path.join(dataDir, 'pebble-proxy.sqlite'),
    publicHost: env.PUBLIC_HOST || '0.0.0.0',
    publicPort: integer(env.PUBLIC_PORT, 8080, 1, 65535),
    adminHost: env.ADMIN_HOST || '0.0.0.0',
    adminPort: integer(env.ADMIN_PORT, 3000, 1, 65535),
    umbrelAppId: umbrelAppId(env.UMBREL_APP_ID),
    appSeed: env.APP_SEED || '',
    publicBaseUrl: env.PUBLIC_BASE_URL || '',
    allowedPublicHosts: list(env.ALLOWED_PUBLIC_HOSTS),
    maxJsonBytes: integer(env.MAX_JSON_BYTES, 256 * 1024, 1024, 2 * 1024 * 1024),
    maxWebhookBytes: integer(env.MAX_WEBHOOK_BYTES, 16 * 1024 * 1024, 1024, 64 * 1024 * 1024),
    workerPollMs: integer(env.WORKER_POLL_MS, 2000, 250, 60000),
    sttTimeoutMs: integer(env.STT_TIMEOUT_MS, 120000, 5000, 600000),
    sttMaxAttempts: integer(env.STT_MAX_ATTEMPTS, 3, 1, 10),
    sttRetryDelaysMs: integerList(env.STT_RETRY_DELAYS_MS, [15000, 60000, 300000]),
    needleRouterUrl: env.NEEDLE_ROUTER_URL || 'http://needle:8090',
    processingTimeoutMs: integer(env.PROCESSING_TIMEOUT_MS, 30000, 5000, 120000),
    processingMaxAttempts: integer(env.PROCESSING_MAX_ATTEMPTS, 3, 1, 10),
    processingRetryDelaysMs: integerList(env.PROCESSING_RETRY_DELAYS_MS, [15000, 60000, 300000]),
    ttsTimeoutMs: integer(env.TTS_TIMEOUT_MS, 120000, 5000, 600000),
    ttsMaxResponseBytes: integer(env.TTS_MAX_RESPONSE_BYTES, 32 * 1024 * 1024, 1024, 128 * 1024 * 1024),
    aiTimeoutMs: integer(env.AI_TIMEOUT_MS, 90000, 5000, 600000),
    aiMaxMessages: integer(env.AI_MAX_MESSAGES, 64, 1, 512),
    aiMaxMessageChars: integer(env.AI_MAX_MESSAGE_CHARS, 16384, 256, 262144),
    aiMaxInputChars: integer(env.AI_MAX_INPUT_CHARS, 65536, 1024, 1048576),
    aiMaxResponseBytes: integer(env.AI_MAX_RESPONSE_BYTES, 2 * 1024 * 1024, 1024, 32 * 1024 * 1024),
    aiMaxResponseChars: integer(env.AI_MAX_RESPONSE_CHARS, 262144, 256, 4 * 1024 * 1024),
    aiSessionTtlDays: integer(env.AI_SESSION_TTL_DAYS, 30, 1, 365),
    logLevel: env.LOG_LEVEL || 'info',
    nodeEnv: env.NODE_ENV || 'production'
  });
}
