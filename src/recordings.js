import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { nowIso, transaction } from './db.js';
import {
  HttpError,
  baseHeaders,
  parseMultipart,
  readBuffer,
  sendJson
} from './http.js';
import { secureFetch } from './security.js';

const AUDIO_MIME_TYPES = new Set([
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'application/mp4',
  'video/mp4'
]);
const RECORDING_STATES = new Set(['received', 'transcribing', 'ready', 'error']);
const RECORDING_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TRANSCRIPT_BYTES = 64 * 1024;
const MAX_CLIENT_BYTES = 256;
const MAX_RECORDED_AT_BYTES = 128;
const MAX_STT_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAYS_MS = [15_000, 60_000, 300_000];
const PUBLIC_HEADERS = Object.freeze({ 'Access-Control-Allow-Origin': '*' });
const ISO_RECORDED_AT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

class SttRequestError extends Error {
  constructor(code, message, { transient = false, status = null } = {}) {
    super(message);
    this.name = 'SttRequestError';
    this.code = code;
    this.transient = transient;
    this.status = status;
  }
}

function requireDeps(deps) {
  if (!deps?.db || !deps?.config) throw new TypeError('recordings requires db and config dependencies');
}

function header(req, name) {
  const value = req.headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] || '';
  return typeof value === 'string' ? value : '';
}

function decodeField(part, maxBytes, fieldName) {
  if (!part) return null;
  if (part.filename !== undefined) {
    throw new HttpError(400, 'invalid_multipart', `${fieldName} must be a text field`);
  }
  if (part.data.length > maxBytes) {
    throw new HttpError(413, 'field_too_large', `${fieldName} is too large`);
  }
  let value;
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(part.data);
  } catch {
    throw new HttpError(400, 'invalid_utf8', `${fieldName} must be valid UTF-8`);
  }
  if (value.includes('\u0000')) throw new HttpError(400, 'invalid_field', `${fieldName} contains invalid characters`);
  return value.trim();
}

function onePart(parts, name) {
  const matches = parts.filter((part) => part.name === name);
  if (matches.length > 1) throw new HttpError(400, 'duplicate_field', `${name} may only appear once`);
  return matches[0] || null;
}

function looksLikeIsoBaseMedia(data) {
  return data.length >= 12 && data.subarray(4, 8).toString('ascii') === 'ftyp';
}

function invalidRecordedAt() {
  throw new HttpError(400, 'invalid_recorded_at', 'recordedAt must be epoch milliseconds or an ISO-8601 timestamp');
}

function normalizeRecordedAt(value) {
  let milliseconds;
  if (/^\d+$/.test(value)) {
    milliseconds = Number(value);
    if (!Number.isSafeInteger(milliseconds)) invalidRecordedAt();
  } else {
    const match = ISO_RECORDED_AT_RE.exec(value);
    if (!match) invalidRecordedAt();
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    const fraction = (match[7] || '').padEnd(3, '0').slice(0, 3);
    const offsetHour = Number(match[10] || 0);
    const offsetMinute = Number(match[11] || 0);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (
      month < 1 || month > 12 ||
      day < 1 || day > daysInMonth[month - 1] ||
      hour > 23 || minute > 59 || second > 59 ||
      offsetHour > 14 || offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0)
    ) invalidRecordedAt();

    const parsed = new Date(0);
    parsed.setUTCFullYear(year, month - 1, day);
    parsed.setUTCHours(hour, minute, second, Number(fraction || 0));
    milliseconds = parsed.getTime();
    if (match[8] !== 'Z') {
      const offset = (offsetHour * 60 + offsetMinute) * 60_000;
      milliseconds += match[9] === '+' ? -offset : offset;
    }
  }

  const parsed = new Date(milliseconds);
  if (!Number.isFinite(parsed.getTime())) invalidRecordedAt();
  return parsed.toISOString();
}

function validateAudioSize(req, audioPart) {
  const supplied = req.headers?.['x-audio-size'];
  if (supplied === undefined) return;
  if (Array.isArray(supplied) || typeof supplied !== 'string') {
    throw new HttpError(400, 'invalid_audio_size', 'X-Audio-Size must be one decimal byte count');
  }
  const value = supplied.trim();
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new HttpError(400, 'invalid_audio_size', 'X-Audio-Size must be one decimal byte count');
  }
  const expected = Number(value);
  if (!Number.isSafeInteger(expected)) {
    throw new HttpError(400, 'invalid_audio_size', 'X-Audio-Size is too large');
  }
  if (!audioPart) {
    throw new HttpError(400, 'unexpected_audio_size', 'X-Audio-Size was supplied without an audio file');
  }
  if (expected !== audioPart.data.length) {
    throw new HttpError(400, 'audio_size_mismatch', 'X-Audio-Size does not match the uploaded audio');
  }
}

function parseIndexWebhook(req, buffer) {
  const contentType = header(req, 'content-type');
  if (!/^multipart\/form-data(?:\s*;|$)/i.test(contentType)) {
    throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be multipart/form-data');
  }

  const parts = parseMultipart(buffer, contentType);
  const allowedFields = new Set(['audio', 'transcription', 'recordedAt', 'client']);
  const unexpected = parts.find((part) => !allowedFields.has(part.name));
  if (unexpected) throw new HttpError(400, 'unexpected_field', `Unexpected multipart field: ${unexpected.name}`);

  const audioPart = onePart(parts, 'audio');
  const transcription = decodeField(onePart(parts, 'transcription'), MAX_TRANSCRIPT_BYTES, 'transcription');
  const recordedAtValue = decodeField(onePart(parts, 'recordedAt'), MAX_RECORDED_AT_BYTES, 'recordedAt');
  const client = decodeField(onePart(parts, 'client'), MAX_CLIENT_BYTES, 'client');
  validateAudioSize(req, audioPart);

  if (!audioPart && !transcription) {
    throw new HttpError(400, 'missing_recording_content', 'An audio file or transcription is required');
  }

  let audio = null;
  if (audioPart) {
    if (!audioPart.filename) throw new HttpError(400, 'invalid_audio', 'audio must be a file field');
    if (audioPart.data.length === 0) throw new HttpError(400, 'invalid_audio', 'audio must not be empty');

    const suppliedMime = String(audioPart.contentType || '').split(';')[0].trim().toLowerCase();
    const extension = path.extname(audioPart.filename).toLowerCase();
    const extensionAllowed = extension === '.m4a' || extension === '.mp4';
    if (!AUDIO_MIME_TYPES.has(suppliedMime) && !extensionAllowed) {
      throw new HttpError(415, 'unsupported_audio_type', 'audio must be an M4A or MP4 recording');
    }
    if (!looksLikeIsoBaseMedia(audioPart.data)) {
      throw new HttpError(415, 'invalid_audio', 'audio is not a valid M4A or MP4 container');
    }
    audio = {
      data: audioPart.data,
      mime: AUDIO_MIME_TYPES.has(suppliedMime) ? suppliedMime : 'audio/mp4',
      extension: suppliedMime === 'video/mp4' || suppliedMime === 'application/mp4' || extension === '.mp4' ? '.mp4' : '.m4a',
      sha256: crypto.createHash('sha256').update(audioPart.data).digest('hex')
    };
  }

  let recordedAt = null;
  if (recordedAtValue) {
    recordedAt = normalizeRecordedAt(recordedAtValue);
  }

  if (client && /[\r\n]/.test(client)) throw new HttpError(400, 'invalid_client', 'client contains invalid characters');

  return {
    audio,
    transcription: transcription || null,
    recordedAt,
    client: client || null
  };
}

function payloadFingerprint(payload) {
  return crypto.createHash('sha256').update(JSON.stringify({
    audio_sha256: payload.audio?.sha256 || null,
    audio_size: payload.audio?.data.length || null,
    audio_mime: payload.audio?.mime || null,
    transcription: payload.transcription,
    recorded_at: payload.recordedAt,
    client: payload.client
  })).digest('hex');
}

function idempotencyKey(req, payload, deviceId) {
  const deviceScope = crypto.createHash('sha256').update(String(deviceId)).digest('hex');
  const standard = header(req, 'idempotency-key').trim();
  const legacy = header(req, 'x-idempotency-key').trim();
  if (standard && legacy && standard !== legacy) {
    throw new HttpError(400, 'conflicting_idempotency_keys', 'Idempotency-Key headers do not match');
  }
  const supplied = standard || legacy;
  if (supplied) {
    if (supplied.length > 200 || /[\r\n\u0000]/.test(supplied)) {
      throw new HttpError(400, 'invalid_idempotency_key', 'Idempotency-Key is invalid');
    }
    return `device:${deviceScope}:header:${crypto.createHash('sha256').update(supplied).digest('hex')}`;
  }
  return `device:${deviceScope}:content:${payloadFingerprint(payload)}`;
}

function existingByIdempotency(db, key) {
  return db.prepare(`SELECT r.*,
      (SELECT text FROM transcripts WHERE recording_id = r.id AND source = 'pebble') AS pebble_transcript
    FROM recordings r WHERE r.idempotency_key = ?`).get(key);
}

function assertReplayMatches(existing, payload) {
  const matches =
    (existing.audio_sha256 || null) === (payload.audio?.sha256 || null) &&
    (existing.audio_size || null) === (payload.audio?.data.length || null) &&
    (existing.audio_mime || null) === (payload.audio?.mime || null) &&
    (existing.pebble_transcript || null) === payload.transcription &&
    (existing.recorded_at || null) === payload.recordedAt &&
    (existing.client || null) === payload.client;
  if (!matches) {
    throw new HttpError(409, 'idempotency_conflict', 'Idempotency-Key was already used for a different recording');
  }
}

function isIdempotencyConstraint(error) {
  return /UNIQUE constraint failed:\s*recordings\.idempotency_key/i.test(String(error?.message || ''));
}

function ensureRecordingDirectory(recordingsDir) {
  const resolved = path.resolve(recordingsDir);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  return resolved;
}

function cleanupAudioTombstones(recordingsDir) {
  const root = ensureRecordingDirectory(recordingsDir);
  fs.promises.readdir(root, { withFileTypes: true }).then((entries) => Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.includes('.deleted-'))
      .map((entry) => fs.promises.unlink(path.join(root, entry.name)).catch(() => {}))
  )).catch(() => {});
}

async function saveAudio(recordingsDir, id, audio) {
  if (!audio) return { filename: null, absolutePath: null };
  const root = ensureRecordingDirectory(recordingsDir);
  const filename = `${id}${audio.extension}`;
  const absolutePath = path.resolve(root, filename);
  if (path.dirname(absolutePath) !== root || path.basename(absolutePath) !== filename) {
    throw new Error('Unsafe generated recording path');
  }

  let handle;
  try {
    handle = await fs.promises.open(absolutePath, 'wx', 0o600);
    await handle.writeFile(audio.data);
    await handle.sync();
  } catch (error) {
    try { await fs.promises.unlink(absolutePath); } catch {}
    throw error;
  } finally {
    try { await handle?.close(); } catch {}
  }
  return { filename, absolutePath };
}

function webhookAck(row, deduplicated) {
  return {
    id: row.id,
    state: row.stt_state,
    receivedAt: row.received_at,
    hasAudio: Boolean(row.audio_path),
    transcriptSources: row.pebble_transcript ? ['pebble'] : [],
    deduplicated
  };
}

function recordingRow(db, id) {
  return db.prepare('SELECT * FROM recordings WHERE id = ?').get(id);
}

function transcriptsFor(db, recordingId) {
  return db.prepare(`SELECT id, source, text, provider, model, language, created_at
    FROM transcripts WHERE recording_id = ? ORDER BY created_at ASC`).all(recordingId);
}

function jobFor(db, recordingId) {
  return db.prepare(`SELECT status, attempts, next_attempt_at, lease_until,
      config_revision, last_error_code, last_error_message, created_at, updated_at
    FROM transcription_jobs WHERE recording_id = ?`).get(recordingId) || null;
}

function serializeTranscript(row) {
  return {
    id: row.id,
    source: row.source,
    text: row.text,
    provider: row.provider || null,
    model: row.model || null,
    language: row.language || null,
    createdAt: row.created_at
  };
}

function serializeJob(row) {
  if (!row) return null;
  return {
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    leaseUntil: row.lease_until || null,
    configRevision: row.config_revision,
    lastError: row.last_error_code ? {
      code: row.last_error_code,
      message: row.last_error_message || null
    } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function serializeRecording(row, transcripts = [], job = null) {
  const audioUrl = row.audio_path ? `/admin/api/recordings/${row.id}/audio` : null;
  return {
    id: row.id,
    deviceId: row.device_id,
    client: row.client || null,
    recordedAt: row.recorded_at || null,
    receivedAt: row.received_at,
    state: row.stt_state,
    hasAudio: Boolean(row.audio_path),
    audioUrl,
    audio: row.audio_path ? {
      mime: row.audio_mime,
      size: row.audio_size,
      sha256: row.audio_sha256,
      url: audioUrl
    } : null,
    transcripts: transcripts.map(serializeTranscript),
    lastError: row.last_error || null,
    job: serializeJob(job),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function requireRecordingId(context) {
  const id = String(context?.params?.id || '');
  if (!RECORDING_ID_RE.test(id)) throw new HttpError(404, 'recording_not_found', 'Recording not found');
  return id;
}

function integerQuery(value, fallback, minimum, maximum) {
  if (value === null || value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) throw new HttpError(400, 'invalid_pagination', 'Pagination values must be non-negative integers');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new HttpError(400, 'invalid_pagination', 'Pagination value is too large');
  return Math.max(minimum, Math.min(maximum, parsed));
}

function safeStoredAudioPath(recordingsDir, storedPath) {
  if (!storedPath || path.basename(storedPath) !== storedPath) {
    throw new HttpError(404, 'audio_not_found', 'Audio not found');
  }
  const root = path.resolve(recordingsDir);
  const resolved = path.resolve(root, storedPath);
  if (path.dirname(resolved) !== root) throw new HttpError(404, 'audio_not_found', 'Audio not found');
  return resolved;
}

function noContent(res) {
  res.writeHead(204, baseHeaders());
  res.end();
}

/**
 * Register the public Pebble Index webhook and private recording-management APIs.
 * The admin router is expected to sit behind Umbrel's authenticated app proxy.
 */
export function registerRecordingRoutes(publicRouter, adminRouter, deps) {
  requireDeps(deps);
  const { db, config, authenticate, limiter } = deps;
  if (typeof authenticate !== 'function') throw new TypeError('recordings requires authenticate(req, scope)');
  cleanupAudioTombstones(config.recordingsDir);

  publicRouter.add('POST', '/webhooks/index', async (req, res) => {
    const device = await authenticate(req, 'webhook:write', { allowWebhookHeaders: true });
    if (!device?.id) throw new HttpError(401, 'invalid_token', 'Authentication failed');
    const lease = limiter?.acquire ? await limiter.acquire(device) : null;
    try {

      const buffer = await readBuffer(req, config.maxWebhookBytes || 16 * 1024 * 1024);
      const payload = parseIndexWebhook(req, buffer);
      const key = idempotencyKey(req, payload, device.id);
      const duplicate = existingByIdempotency(db, key);
      if (duplicate) {
        assertReplayMatches(duplicate, payload);
        return sendJson(res, 202, webhookAck(duplicate, true), PUBLIC_HEADERS);
      }

      const id = crypto.randomUUID();
      const savedAudio = await saveAudio(config.recordingsDir, id, payload.audio);
      const now = nowIso();
      try {
        transaction(db, () => {
          db.prepare(`INSERT INTO recordings
          (id, device_id, client, recorded_at, received_at, audio_path, audio_mime,
           audio_size, audio_sha256, stt_state, idempotency_key, last_error, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, NULL, ?, ?)`).run(
          id,
          device.id,
          payload.client,
          payload.recordedAt,
          now,
          savedAudio.filename,
          payload.audio?.mime || null,
          payload.audio?.data.length || null,
          payload.audio?.sha256 || null,
          key,
          now,
          now
        );

          if (payload.transcription) {
            db.prepare(`INSERT INTO transcripts
            (id, recording_id, source, text, provider, model, language, created_at)
            VALUES (?, ?, 'pebble', ?, NULL, NULL, NULL, ?)`).run(
            crypto.randomUUID(), id, payload.transcription, now
          );
          }

          db.prepare(`INSERT INTO transcription_jobs
          (id, recording_id, status, attempts, next_attempt_at, lease_until,
           config_revision, last_error_code, last_error_message, created_at, updated_at)
          VALUES (?, ?, 'pending', 0, ?, NULL,
            COALESCE((SELECT revision FROM stt_config WHERE id = 1), 1), NULL, NULL, ?, ?)`).run(
          crypto.randomUUID(), id, now, now, now
        );
        });
      } catch (error) {
        if (savedAudio.absolutePath) {
          try { await fs.promises.unlink(savedAudio.absolutePath); } catch {}
        }
        if (isIdempotencyConstraint(error)) {
          const racedDuplicate = existingByIdempotency(db, key);
          if (racedDuplicate) {
            assertReplayMatches(racedDuplicate, payload);
            return sendJson(res, 202, webhookAck(racedDuplicate, true), PUBLIC_HEADERS);
          }
        }
        throw error;
      }

      return sendJson(res, 202, webhookAck({
        id,
        stt_state: 'received',
        received_at: now,
        audio_path: savedAudio.filename,
        pebble_transcript: payload.transcription
      }, false), PUBLIC_HEADERS);
    } finally {
      try { lease?.release?.(); } catch {}
    }
  });

  adminRouter.add('GET', '/admin/api/recordings', async (_req, res, context) => {
    const limit = integerQuery(context.url.searchParams.get('limit'), 50, 1, 200);
    const offset = integerQuery(context.url.searchParams.get('offset'), 0, 0, 1_000_000);
    const requestedState = context.url.searchParams.get('state');
    if (requestedState && !RECORDING_STATES.has(requestedState)) {
      throw new HttpError(400, 'invalid_state', 'Unknown recording state');
    }

    const where = requestedState ? 'WHERE r.stt_state = ?' : '';
    const bindings = requestedState ? [requestedState, limit, offset] : [limit, offset];
    const rows = db.prepare(`SELECT r.*,
        (SELECT substr(text, 1, 1024) FROM transcripts t WHERE t.recording_id = r.id AND t.source = 'pebble') AS pebble_transcript,
        (SELECT length(text) > 1024 FROM transcripts t WHERE t.recording_id = r.id AND t.source = 'pebble') AS pebble_transcript_truncated,
        (SELECT substr(text, 1, 1024) FROM transcripts t WHERE t.recording_id = r.id AND t.source = 'local_stt') AS local_transcript,
        (SELECT length(text) > 1024 FROM transcripts t WHERE t.recording_id = r.id AND t.source = 'local_stt') AS local_transcript_truncated
      FROM recordings r ${where}
      ORDER BY r.received_at DESC, r.id DESC LIMIT ? OFFSET ?`).all(...bindings);
    const total = requestedState
      ? db.prepare('SELECT COUNT(*) AS count FROM recordings WHERE stt_state = ?').get(requestedState).count
      : db.prepare('SELECT COUNT(*) AS count FROM recordings').get().count;

    return sendJson(res, 200, {
      recordings: rows.map((row) => ({
        ...serializeRecording(row),
        transcripts: [
          row.pebble_transcript ? { source: 'pebble', text: row.pebble_transcript, truncated: Boolean(row.pebble_transcript_truncated) } : null,
          row.local_transcript ? { source: 'local_stt', text: row.local_transcript, truncated: Boolean(row.local_transcript_truncated) } : null
        ].filter(Boolean)
      })),
      pagination: {
        limit,
        offset,
        total,
        nextOffset: offset + rows.length < total ? offset + rows.length : null
      }
    });
  });

  adminRouter.add('GET', '/admin/api/recordings/:id', async (_req, res, context) => {
    const id = requireRecordingId(context);
    const row = recordingRow(db, id);
    if (!row) throw new HttpError(404, 'recording_not_found', 'Recording not found');
    return sendJson(res, 200, serializeRecording(row, transcriptsFor(db, id), jobFor(db, id)));
  });

  adminRouter.add('GET', '/admin/api/recordings/:id/audio', async (_req, res, context) => {
    const id = requireRecordingId(context);
    const row = recordingRow(db, id);
    if (!row?.audio_path) throw new HttpError(404, 'audio_not_found', 'Audio not found');
    const audioPath = safeStoredAudioPath(config.recordingsDir, row.audio_path);
    let stat;
    try { stat = await fs.promises.stat(audioPath); }
    catch (error) {
      if (error.code === 'ENOENT') throw new HttpError(404, 'audio_not_found', 'Audio not found');
      throw error;
    }
    if (!stat.isFile()) throw new HttpError(404, 'audio_not_found', 'Audio not found');

    res.writeHead(200, baseHeaders({
      'Content-Type': AUDIO_MIME_TYPES.has(row.audio_mime) ? row.audio_mime : 'application/octet-stream',
      'Content-Length': String(stat.size),
      'Content-Disposition': `inline; filename="${id}${path.extname(row.audio_path)}"`,
      'Accept-Ranges': 'none'
    }));
    await pipeline(fs.createReadStream(audioPath), res);
  });

  adminRouter.add('POST', '/admin/api/recordings/:id/retry', async (_req, res, context) => {
    const id = requireRecordingId(context);
    const row = recordingRow(db, id);
    if (!row) throw new HttpError(404, 'recording_not_found', 'Recording not found');
    if (!row.audio_path) throw new HttpError(409, 'recording_has_no_audio', 'This recording has no audio to transcribe');
    const now = nowIso();
    transaction(db, () => {
      db.prepare(`UPDATE recordings SET stt_state = 'received', last_error = NULL, updated_at = ? WHERE id = ?`).run(now, id);
      db.prepare(`INSERT INTO transcription_jobs
        (id, recording_id, status, attempts, next_attempt_at, lease_until,
         config_revision, last_error_code, last_error_message, created_at, updated_at)
        VALUES (?, ?, 'pending', 0, ?, NULL,
          COALESCE((SELECT revision FROM stt_config WHERE id = 1), 1), NULL, NULL, ?, ?)
        ON CONFLICT(recording_id) DO UPDATE SET
          status = 'pending', attempts = 0, next_attempt_at = excluded.next_attempt_at,
          lease_until = NULL, config_revision = excluded.config_revision,
          last_error_code = NULL, last_error_message = NULL, updated_at = excluded.updated_at`).run(
        crypto.randomUUID(), id, now, now, now
      );
    });
    return sendJson(res, 202, { id, state: 'received', queued: true });
  });

  adminRouter.add('DELETE', '/admin/api/recordings/:id', async (_req, res, context) => {
    const id = requireRecordingId(context);
    const row = recordingRow(db, id);
    if (!row) throw new HttpError(404, 'recording_not_found', 'Recording not found');
    let originalPath = null;
    let tombstonePath = null;
    if (row.audio_path) {
      originalPath = safeStoredAudioPath(config.recordingsDir, row.audio_path);
      tombstonePath = `${originalPath}.deleted-${crypto.randomUUID()}`;
      try {
        const stat = await fs.promises.lstat(originalPath);
        if (!stat.isFile()) throw new HttpError(500, 'audio_delete_failed', 'Stored audio could not be safely removed');
        await fs.promises.rename(originalPath, tombstonePath);
      }
      catch (error) {
        if (error.code === 'ENOENT') tombstonePath = null;
        else throw error;
      }
    }
    try {
      transaction(db, () => {
        db.prepare('DELETE FROM recordings WHERE id = ?').run(id);
      });
    } catch (error) {
      if (tombstonePath && originalPath) {
        try { await fs.promises.rename(tombstonePath, originalPath); } catch {}
      }
      throw error;
    }
    // The database commit is authoritative. A failed unlink leaves an
    // unmistakable tombstone that is retried on the next process start.
    if (tombstonePath) await fs.promises.unlink(tombstonePath).catch(() => {});
    return noContent(res);
  });
}

function maxAttempts(config) {
  const value = Number(config.sttMaxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  return Number.isSafeInteger(value) ? Math.max(1, Math.min(10, value)) : DEFAULT_MAX_ATTEMPTS;
}

function retryDelay(config, attempt) {
  const configured = Array.isArray(config.sttRetryDelaysMs) ? config.sttRetryDelaysMs : DEFAULT_RETRY_DELAYS_MS;
  const candidate = Number(configured[Math.min(Math.max(0, attempt - 1), configured.length - 1)]);
  if (!Number.isFinite(candidate)) return DEFAULT_RETRY_DELAYS_MS[Math.min(attempt - 1, DEFAULT_RETRY_DELAYS_MS.length - 1)];
  return Math.max(50, Math.min(60 * 60 * 1000, candidate));
}

function claimNextJob(db, leaseMs) {
  const now = new Date();
  const nowText = now.toISOString();
  const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
  return transaction(db, () => {
    db.prepare(`UPDATE recordings SET stt_state = 'received', updated_at = ?
      WHERE stt_state = 'transcribing' AND id IN (
        SELECT recording_id FROM transcription_jobs
        WHERE status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?
      )`).run(nowText, nowText);
    db.prepare(`UPDATE transcription_jobs
      SET status = 'pending', lease_until = NULL, next_attempt_at = ?, updated_at = ?
      WHERE status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?`).run(nowText, nowText, nowText);

    const candidate = db.prepare(`SELECT j.*, r.audio_path, r.audio_mime, r.audio_size
      FROM transcription_jobs j
      JOIN recordings r ON r.id = j.recording_id
      WHERE j.status = 'pending' AND j.next_attempt_at <= ?
      ORDER BY j.next_attempt_at ASC, j.created_at ASC LIMIT 1`).get(nowText);
    if (!candidate) return null;
    const claimed = db.prepare(`UPDATE transcription_jobs
      SET status = 'processing', attempts = attempts + 1, lease_until = ?, updated_at = ?
      WHERE id = ? AND status = 'pending' AND next_attempt_at <= ?`).run(
      leaseUntil, nowText, candidate.id, nowText
    );
    if (Number(claimed.changes) !== 1) return null;
    db.prepare(`UPDATE recordings
      SET stt_state = 'transcribing', last_error = NULL, updated_at = ? WHERE id = ?`).run(
      nowText, candidate.recording_id
    );
    return { ...candidate, attempts: Number(candidate.attempts) + 1, lease_until: leaseUntil };
  });
}

function currentSttConfig(db) {
  return db.prepare('SELECT * FROM stt_config WHERE id = 1').get() || null;
}

function releaseUnconfigured(db, claim, pollMs) {
  const now = new Date();
  const next = new Date(now.getTime() + Math.max(30_000, pollMs * 5)).toISOString();
  const nowText = now.toISOString();
  transaction(db, () => {
    const current = db.prepare('SELECT status, attempts FROM transcription_jobs WHERE id = ?').get(claim.id);
    if (!current || current.status !== 'processing' || Number(current.attempts) !== claim.attempts) return;
    db.prepare(`UPDATE transcription_jobs SET status = 'pending', attempts = MAX(attempts - 1, 0),
      next_attempt_at = ?, lease_until = NULL, last_error_code = 'stt_unconfigured',
      last_error_message = 'Speech-to-text is not configured', updated_at = ? WHERE id = ?`).run(next, nowText, claim.id);
    db.prepare(`UPDATE recordings SET stt_state = 'received',
      last_error = 'Speech-to-text is not configured', updated_at = ? WHERE id = ?`).run(nowText, claim.recording_id);
  });
}

function finishWithoutAudio(db, claim) {
  const now = nowIso();
  transaction(db, () => {
    const current = db.prepare('SELECT status, attempts FROM transcription_jobs WHERE id = ?').get(claim.id);
    if (!current || current.status !== 'processing' || Number(current.attempts) !== claim.attempts) return;
    db.prepare(`UPDATE transcription_jobs SET status = 'completed', lease_until = NULL,
      last_error_code = NULL, last_error_message = NULL, updated_at = ? WHERE id = ?`).run(now, claim.id);
    db.prepare(`UPDATE recordings SET stt_state = 'received', last_error = NULL, updated_at = ? WHERE id = ?`).run(now, claim.recording_id);
  });
}

function sanitizeErrorMessage(value) {
  return String(value || 'Speech-to-text request failed')
    .replace(/[\r\n\u0000]+/g, ' ')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]')
    .slice(0, 500);
}

function buildPrivateSttUrl(baseUrlValue, routePathValue) {
  let base;
  try { base = new URL(String(baseUrlValue || '')); }
  catch { throw new SttRequestError('invalid_stt_endpoint', 'The configured STT base URL is invalid'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new SttRequestError('invalid_stt_endpoint', 'The configured STT base URL is invalid');
  }
  const routePath = String(routePathValue || '');
  let decodedPath;
  try { decodedPath = decodeURIComponent(routePath); }
  catch { throw new SttRequestError('invalid_stt_path', 'The configured STT path is invalid'); }
  if (!routePath.startsWith('/') || routePath.startsWith('//') || /[?#\\]/.test(routePath) || decodedPath.split('/').includes('..')) {
    throw new SttRequestError('invalid_stt_path', 'The configured STT path is invalid');
  }
  const basePrefix = base.pathname === '/' ? '' : base.pathname.replace(/\/+$/, '');
  const endpoint = new URL(`${base.origin}${basePrefix}${routePath}`);
  if (endpoint.origin !== base.origin) throw new SttRequestError('invalid_stt_endpoint', 'The configured STT endpoint is invalid');
  return endpoint;
}

async function fetchWithTimeout(url, options, timeoutMs, externalSignal = null, transport = secureFetch, policy = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  timeout.unref?.();
  const onAbort = () => controller.abort(externalSignal.reason);
  if (externalSignal) {
    if (externalSignal.aborted) onAbort();
    else externalSignal.addEventListener('abort', onAbort, { once: true });
  }
  const cleanup = () => {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', onAbort);
  };
  try {
    const response = await transport(url, { ...options, signal: controller.signal, redirect: 'error' }, policy);
    let disposed = false;
    return {
      response,
      async dispose() {
        if (disposed) return;
        disposed = true;
        try { await response.body?.cancel(); } catch {}
        cleanup();
      }
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function readResponseBuffer(response, maximum) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) {
    try { await response.body?.cancel(); } catch {}
    throw new SttRequestError('stt_response_too_large', 'STT response is too large');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) throw new SttRequestError('stt_response_too_large', 'STT response is too large');
      chunks.push(Buffer.from(value));
    }
  } finally {
    if (total > maximum) {
      try { await reader.cancel(); } catch {}
    }
  }
  return Buffer.concat(chunks);
}

function classifyFetchError(error) {
  if (error instanceof SttRequestError) return error;
  if (error?.name === 'AbortError' || /timeout|aborted/i.test(String(error?.message || ''))) {
    return new SttRequestError('stt_timeout', 'Speech-to-text request timed out', { transient: true });
  }
  return new SttRequestError('stt_unavailable', 'Speech-to-text service is unavailable', { transient: true });
}

function classifyDestinationError(error) {
  if (!(error instanceof HttpError)) return classifyFetchError(error);
  const dnsFailure = error.code === 'backend_dns_failed' || error.code === 'backend_dns_timeout';
  return new SttRequestError(
    error.code || 'unsafe_stt_endpoint',
    dnsFailure ? 'Speech-to-text hostname could not be resolved' : 'The configured STT endpoint is not private',
    { transient: dnsFailure }
  );
}

async function requestTranscription(deps, sttConfig, claim, signal) {
  const endpoint = buildPrivateSttUrl(sttConfig.base_url, sttConfig.transcription_path);
  const audioPath = safeStoredAudioPath(deps.config.recordingsDir, claim.audio_path);
  let audio;
  try { audio = await fs.promises.readFile(audioPath); }
  catch (error) {
    if (error.code === 'ENOENT') throw new SttRequestError('audio_missing', 'Stored recording audio is missing');
    throw error;
  }

  const form = new FormData();
  const filename = `${claim.recording_id}${path.extname(claim.audio_path) || '.m4a'}`;
  form.append('file', new Blob([audio], { type: claim.audio_mime || 'audio/mp4' }), filename);
  form.append('model', sttConfig.model);
  if (sttConfig.language) form.append('language', sttConfig.language);
  form.append('response_format', 'json');

  const headers = {};
  if (sttConfig.encrypted_credential) {
    if (!deps.cryptoService?.decrypt) throw new SttRequestError('credential_unavailable', 'STT credential cannot be decrypted');
    let credential;
    try { credential = deps.cryptoService.decrypt(sttConfig.encrypted_credential); }
    catch { throw new SttRequestError('credential_unavailable', 'STT credential cannot be decrypted'); }
    if (credential) headers.Authorization = `Bearer ${credential}`;
  }

  let fetched;
  try {
    fetched = await fetchWithTimeout(
      endpoint,
      { method: 'POST', headers, body: form },
      deps.config.sttTimeoutMs || 120_000,
      signal,
      deps.fetchImpl || secureFetch,
      { internal: true, allowLoopback: deps.config.nodeEnv === 'test' }
    );
  } catch (error) {
    throw classifyDestinationError(error);
  }
  const { response } = fetched;
  try {
    if (!response.ok) {
      const transient = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
      throw new SttRequestError(
        `stt_http_${response.status}`,
        transient ? 'Speech-to-text service is temporarily unavailable' : 'Speech-to-text service rejected the request',
        { transient, status: response.status }
      );
    }

    const raw = await readResponseBuffer(response, MAX_STT_RESPONSE_BYTES);
    let body;
    try { body = JSON.parse(raw.toString('utf8')); }
    catch { throw new SttRequestError('invalid_stt_response', 'Speech-to-text returned invalid JSON'); }
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) throw new SttRequestError('invalid_stt_response', 'Speech-to-text response did not contain a transcript');
    if (Buffer.byteLength(text, 'utf8') > MAX_TRANSCRIPT_BYTES) {
      throw new SttRequestError('stt_transcript_too_large', 'Speech-to-text transcript is too large');
    }
    return text;
  } finally {
    await fetched.dispose();
  }
}

function saveSttSuccess(db, claim, sttConfig, transcript) {
  const now = nowIso();
  return transaction(db, () => {
    const current = db.prepare('SELECT status, attempts FROM transcription_jobs WHERE id = ?').get(claim.id);
    if (!current || current.status !== 'processing' || Number(current.attempts) !== claim.attempts) return false;
    if (!recordingRow(db, claim.recording_id)) return false;
    db.prepare(`INSERT INTO transcripts
      (id, recording_id, source, text, provider, model, language, created_at)
      VALUES (?, ?, 'local_stt', ?, ?, ?, ?, ?)
      ON CONFLICT(recording_id, source) DO UPDATE SET
        text = excluded.text, provider = excluded.provider, model = excluded.model,
        language = excluded.language, created_at = excluded.created_at`).run(
      crypto.randomUUID(),
      claim.recording_id,
      transcript,
      sttConfig.provider_type,
      sttConfig.model,
      sttConfig.language || null,
      now
    );
    db.prepare(`UPDATE transcription_jobs SET status = 'completed', lease_until = NULL,
      config_revision = ?, last_error_code = NULL, last_error_message = NULL, updated_at = ? WHERE id = ?`).run(
      sttConfig.revision, now, claim.id
    );
    db.prepare(`UPDATE recordings SET stt_state = 'ready', last_error = NULL, updated_at = ? WHERE id = ?`).run(now, claim.recording_id);
    return true;
  });
}

function saveSttFailure(db, config, claim, error) {
  const normalized = classifyFetchError(error);
  const terminal = !normalized.transient || claim.attempts >= maxAttempts(config);
  const now = new Date();
  const nowText = now.toISOString();
  const nextAttemptAt = terminal ? nowText : new Date(now.getTime() + retryDelay(config, claim.attempts)).toISOString();
  const code = String(normalized.code || 'stt_error').slice(0, 80);
  const message = sanitizeErrorMessage(normalized.message);
  return transaction(db, () => {
    const current = db.prepare('SELECT status, attempts FROM transcription_jobs WHERE id = ?').get(claim.id);
    if (!current || current.status !== 'processing' || Number(current.attempts) !== claim.attempts) return false;
    db.prepare(`UPDATE transcription_jobs SET status = ?, next_attempt_at = ?, lease_until = NULL,
      last_error_code = ?, last_error_message = ?, updated_at = ? WHERE id = ?`).run(
      terminal ? 'failed' : 'pending', nextAttemptAt, code, message, nowText, claim.id
    );
    db.prepare(`UPDATE recordings SET stt_state = ?, last_error = ?, updated_at = ? WHERE id = ?`).run(
      terminal ? 'error' : 'received', message, nowText, claim.recording_id
    );
    return true;
  });
}

async function processClaim(deps, claim, signal) {
  if (!claim.audio_path) {
    finishWithoutAudio(deps.db, claim);
    return;
  }
  const sttConfig = currentSttConfig(deps.db);
  if (!sttConfig?.enabled || !sttConfig.base_url || !sttConfig.transcription_path || !sttConfig.model) {
    releaseUnconfigured(deps.db, claim, deps.config.workerPollMs || 2000);
    return;
  }
  try {
    const transcript = await requestTranscription(deps, sttConfig, claim, signal);
    saveSttSuccess(deps.db, claim, sttConfig, transcript);
  } catch (error) {
    saveSttFailure(deps.db, deps.config, claim, error);
  }
}

/**
 * Start one low-concurrency STT worker. The returned stop function aborts an
 * active request and returns a promise that resolves once the worker is idle.
 */
export function startSttWorker(deps) {
  requireDeps(deps);
  const pollMs = Math.max(25, Number(deps.config.workerPollMs) || 2000);
  const leaseMs = Math.max((Number(deps.config.sttTimeoutMs) || 120_000) + 30_000, pollMs * 3);
  let stopped = false;
  let running = false;
  let timer = null;
  let activeController = null;
  let resolveStopped;
  const stoppedPromise = new Promise((resolve) => { resolveStopped = resolve; });

  const schedule = (delay) => {
    if (stopped) {
      if (!running) resolveStopped();
      return;
    }
    timer = setTimeout(tick, delay);
    timer.unref?.();
  };

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    let claimed = false;
    try {
      const claim = claimNextJob(deps.db, leaseMs);
      if (claim) {
        claimed = true;
        activeController = new AbortController();
        await processClaim(deps, claim, activeController.signal);
      }
    } catch {
      // A worker-level error is intentionally not logged here: upstream errors
      // can contain private URLs or credentials. Claimed jobs retain/recover
      // through their lease, while the worker tries again on the next poll.
    } finally {
      activeController = null;
      running = false;
      if (stopped) resolveStopped();
      else schedule(claimed ? 0 : pollMs);
    }
  };

  schedule(0);
  return function stopSttWorker() {
    if (!stopped) {
      stopped = true;
      if (timer) clearTimeout(timer);
      activeController?.abort(new Error('worker stopped'));
      if (!running) resolveStopped();
    }
    return stoppedPromise;
  };
}

/** Run a shallow private provider health check and persist only sanitized status. */
export async function checkSttHealth(deps, { force = false } = {}) {
  requireDeps(deps);
  const sttConfig = currentSttConfig(deps.db);
  if (!sttConfig || (!sttConfig.enabled && !force)) return { status: 'unconfigured' };
  const now = nowIso();
  try {
    const endpoint = buildPrivateSttUrl(sttConfig.base_url, sttConfig.health_path);
    const headers = {};
    if (sttConfig.encrypted_credential) {
      const credential = deps.cryptoService?.decrypt?.(sttConfig.encrypted_credential);
      if (credential) headers.Authorization = `Bearer ${credential}`;
    }
    const fetched = await fetchWithTimeout(
      endpoint,
      { method: 'GET', headers },
      Math.min(deps.config.sttTimeoutMs || 120_000, 15_000),
      null,
      deps.fetchImpl || secureFetch,
      { internal: true, allowLoopback: deps.config.nodeEnv === 'test' }
    );
    const { response } = fetched;
    try {
      if (!response.ok) throw new SttRequestError(`stt_health_http_${response.status}`, 'Speech-to-text health check failed');
    } finally {
      await fetched.dispose();
    }
    deps.db.prepare(`UPDATE stt_config SET health_status = 'healthy', last_health_at = ?,
      last_error = NULL, updated_at = ? WHERE id = 1 AND revision = ?`).run(now, now, sttConfig.revision);
    return { status: 'healthy', checkedAt: now };
  } catch (error) {
    const message = sanitizeErrorMessage(classifyDestinationError(error).message);
    deps.db.prepare(`UPDATE stt_config SET health_status = 'unavailable', last_health_at = ?,
      last_error = ?, updated_at = ? WHERE id = 1 AND revision = ?`).run(now, message, now, sttConfig.revision);
    return { status: 'unavailable', checkedAt: now, error: message };
  }
}
