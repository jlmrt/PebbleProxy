import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS client_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('index','pebble','other')),
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS device_credentials (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_device_id TEXT REFERENCES client_devices(id),
  connection_label TEXT NOT NULL DEFAULT '',
  index_trigger TEXT CHECK(index_trigger IS NULL OR index_trigger IN ('single-click-hold','double-click-hold','all')),
  secret_hash TEXT NOT NULL,
  secret_prefix TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  aliases_json TEXT NOT NULL,
  requests_per_minute INTEGER NOT NULL DEFAULT 30,
  max_concurrency INTEGER NOT NULL DEFAULT 2,
  session_epoch INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT,
  revoked_at TEXT,
  deleted_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  base_url TEXT NOT NULL,
  chat_path TEXT NOT NULL,
  models_path TEXT NOT NULL,
  health_path TEXT NOT NULL,
  encrypted_credential TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL DEFAULT '{}',
  health_status TEXT NOT NULL DEFAULT 'unknown',
  last_health_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  instructions TEXT NOT NULL,
  allowed_tools_json TEXT NOT NULL DEFAULT '[]',
  max_tool_calls INTEGER NOT NULL DEFAULT 4,
  max_run_seconds INTEGER NOT NULL DEFAULT 90,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_aliases (
  alias TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  upstream_model TEXT NOT NULL,
  agent_profile_id TEXT NOT NULL DEFAULT 'pebble' REFERENCES agent_profiles(id),
  enabled INTEGER NOT NULL DEFAULT 1,
  max_output_tokens INTEGER NOT NULL DEFAULT 1024,
  timeout_ms INTEGER NOT NULL DEFAULT 90000,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_sessions (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  hint_hash TEXT NOT NULL,
  downstream_id TEXT NOT NULL,
  session_epoch INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(device_id, alias, profile_id, hint_hash, session_epoch)
);

CREATE TABLE IF NOT EXISTS ai_request_audit (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  alias TEXT,
  status_code INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  usage_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recordings (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES device_credentials(id),
  client TEXT,
  trigger TEXT,
  recorded_at TEXT,
  received_at TEXT NOT NULL,
  audio_path TEXT,
  audio_mime TEXT,
  audio_size INTEGER,
  audio_sha256 TEXT,
  stt_state TEXT NOT NULL CHECK(stt_state IN ('received','transcribing','ready','error')),
  idempotency_key TEXT NOT NULL UNIQUE,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transcripts (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK(source IN ('pebble','local_stt')),
  text TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  language TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(recording_id, source)
);

CREATE TABLE IF NOT EXISTS transcription_jobs (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL UNIQUE REFERENCES recordings(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending','processing','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  lease_until TEXT,
  config_revision INTEGER NOT NULL DEFAULT 1,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stt_config (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  provider_type TEXT NOT NULL,
  base_url TEXT NOT NULL,
  transcription_path TEXT NOT NULL,
  health_path TEXT NOT NULL,
  model TEXT NOT NULL,
  language TEXT,
  encrypted_credential TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  health_status TEXT NOT NULL DEFAULT 'unknown',
  last_health_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tts_config (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  provider_type TEXT NOT NULL,
  base_url TEXT NOT NULL,
  speech_path TEXT NOT NULL,
  voices_path TEXT NOT NULL,
  health_path TEXT NOT NULL,
  model TEXT NOT NULL,
  voice TEXT NOT NULL,
  response_format TEXT NOT NULL,
  encrypted_credential TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  health_status TEXT NOT NULL DEFAULT 'unknown',
  last_health_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processing_config (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  confidence_threshold REAL NOT NULL DEFAULT 0.2,
  agent_alias TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  health_status TEXT NOT NULL DEFAULT 'unknown',
  last_health_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processing_jobs (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL UNIQUE REFERENCES recordings(id) ON DELETE CASCADE,
  transcript_id TEXT REFERENCES transcripts(id) ON DELETE SET NULL,
  transcript_source TEXT CHECK(transcript_source IN ('pebble','local_stt')),
  status TEXT NOT NULL CHECK(status IN ('pending','processing','completed','failed','needs_review')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  lease_until TEXT,
  config_revision INTEGER NOT NULL DEFAULT 1,
  confidence REAL,
  proposed_action_json TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processing_actions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES processing_jobs(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK(action_type IN ('create_note','create_reminder','forward_agent')),
  arguments_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('processing','completed','failed','needs_review')),
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  title TEXT,
  body TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  due_at TEXT,
  due_text TEXT,
  timezone TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recordings_received ON recordings(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_transcripts_recording ON transcripts(recording_id);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON transcription_jobs(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_notes_device ON notes(device_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_reminders_device ON reminders(device_id, due_at);
CREATE INDEX IF NOT EXISTS idx_ai_audit_created ON ai_request_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_processing_jobs_due ON processing_jobs(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_processing_actions_status ON processing_actions(status, updated_at DESC);
`;

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((item) => item.name === column)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    const refreshed = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!refreshed.some((item) => item.name === column)) throw error;
  }
}

function migrateCredentialOwners(db) {
  const credentials = db.prepare(`SELECT c.id, c.name, c.owner_device_id, c.connection_label,
      c.created_at, c.updated_at
    FROM device_credentials c
    LEFT JOIN client_devices d ON d.id = c.owner_device_id
    WHERE c.deleted_at IS NULL
      AND (c.owner_device_id IS NULL OR trim(c.connection_label) = '' OR d.id IS NULL)`).all();
  if (!credentials.length) return;

  transaction(db, () => {
    for (const credential of credentials) {
      const ownerId = credential.owner_device_id || credential.id;
      db.prepare(`INSERT OR IGNORE INTO client_devices (id, name, type, created_at, updated_at)
        VALUES (?, ?, 'other', ?, ?)`).run(
        ownerId,
        credential.name,
        credential.created_at,
        credential.updated_at
      );
      db.prepare(`UPDATE device_credentials SET owner_device_id = ?,
        connection_label = CASE WHEN trim(connection_label) = '' THEN name ELSE connection_label END
        WHERE id = ?`).run(ownerId, credential.id);
    }
  });
}

export function nowIso() {
  return new Date().toISOString();
}

export function createDatabase(databasePath) {
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA synchronous=NORMAL;');
  db.exec('PRAGMA foreign_keys=ON;');
  db.exec('PRAGMA busy_timeout=5000;');
  db.exec(SCHEMA);
  ensureColumn(db, 'client_devices', 'deleted_at', 'TEXT');
  ensureColumn(db, 'device_credentials', 'owner_device_id', 'TEXT REFERENCES client_devices(id)');
  ensureColumn(db, 'device_credentials', 'connection_label', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'device_credentials', 'index_trigger', "TEXT CHECK(index_trigger IS NULL OR index_trigger IN ('single-click-hold','double-click-hold','all'))");
  ensureColumn(db, 'device_credentials', 'deleted_at', 'TEXT');
  ensureColumn(db, 'recordings', 'trigger', 'TEXT');
  ensureColumn(db, 'reminders', 'due_text', 'TEXT');
  migrateCredentialOwners(db);
  db.exec('CREATE INDEX IF NOT EXISTS idx_device_credentials_owner ON device_credentials(owner_device_id, created_at)');

  const now = nowIso();
  db.prepare(`INSERT OR IGNORE INTO agent_profiles
    (id, name, instructions, allowed_tools_json, max_tool_calls, max_run_seconds, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      'pebble',
      'Pebble Assistant',
      'You are a concise assistant for a Pebble watch. Never claim to perform an action unless a permitted tool confirms it. Keep responses useful on a small screen.',
      JSON.stringify(['notes', 'reminders']),
      4,
      90,
      now,
      now
    );

  db.prepare(`INSERT OR IGNORE INTO stt_config
    (id, provider_type, base_url, transcription_path, health_path, model, enabled, revision, health_status, updated_at)
    VALUES (1, 'localai', 'http://localai_api_1:8080', '/v1/audio/transcriptions', '/readyz', 'whisper-1', 0, 1, 'unknown', ?)`)
    .run(now);

  db.prepare(`INSERT OR IGNORE INTO tts_config
    (id, provider_type, base_url, speech_path, voices_path, health_path, model, voice,
     response_format, enabled, revision, health_status, updated_at)
    VALUES (1, 'kokoro', 'http://kokoro_web_1:8880', '/v1/audio/speech',
      '/v1/audio/voices', '/health', 'kokoro', 'af_heart', 'mp3', 0, 1, 'unknown', ?)`).run(now);

  db.prepare(`INSERT OR IGNORE INTO processing_config
    (id, enabled, confidence_threshold, agent_alias, revision, health_status, updated_at)
    VALUES (1, 0, 0.2, NULL, 1, 'unknown', ?)`).run(now);

  return db;
}

export function transaction(db, callback) {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = callback();
    db.exec('COMMIT;');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch {}
    throw error;
  }
}
