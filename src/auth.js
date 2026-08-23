import crypto from 'node:crypto';
import { bearerToken, HttpError, safeJson } from './http.js';
import { nowIso, transaction } from './db.js';

export const DEVICE_SCOPES = Object.freeze(['ai:chat', 'webhook:write', 'mcp:invoke']);

function tokenId(token) {
  const match = /^pp_([a-f0-9]{16})_[A-Za-z0-9_-]{32,}$/.exec(token);
  return match?.[1] || '';
}

function parseList(value) {
  const parsed = safeJson(value, []);
  return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
}

function publicDevice(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.secret_prefix,
    scopes: parseList(row.scopes_json),
    aliases: parseList(row.aliases_json),
    requestsPerMinute: row.requests_per_minute,
    maxConcurrency: row.max_concurrency,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function createAuthenticator({ db, cryptoService }) {
  const touchTimes = new Map();

  return async function authenticate(req, requiredScope) {
    const token = bearerToken(req);
    const id = tokenId(token);
    const row = id ? db.prepare('SELECT * FROM device_credentials WHERE id = ?').get(id) : null;
    const valid = Boolean(row && cryptoService.verifyToken(token, row.secret_hash));
    if (!valid || row.revoked_at || (row.expires_at && Date.parse(row.expires_at) <= Date.now())) {
      throw new HttpError(401, 'invalid_api_key', 'Invalid or expired API key', {
        'WWW-Authenticate': 'Bearer realm="Pebble Proxy"'
      });
    }

    const scopes = parseList(row.scopes_json);
    if (requiredScope && !scopes.includes(requiredScope)) {
      throw new HttpError(403, 'permission_denied', 'This device is not permitted to use this endpoint');
    }

    const lastTouch = touchTimes.get(row.id) || 0;
    if (Date.now() - lastTouch > 60_000) {
      touchTimes.set(row.id, Date.now());
      try { db.prepare('UPDATE device_credentials SET last_used_at = ? WHERE id = ?').run(nowIso(), row.id); } catch {}
    }

    return { ...row, scopes, aliases: parseList(row.aliases_json) };
  };
}

export function createDevice(db, cryptoService, input = {}) {
  const name = String(input.name || '').trim();
  if (!name || name.length > 100) throw new HttpError(400, 'invalid_name', 'Device name is required and must be at most 100 characters');
  const scopes = [...new Set((Array.isArray(input.scopes) ? input.scopes : DEVICE_SCOPES).filter((scope) => DEVICE_SCOPES.includes(scope)))];
  if (!scopes.length) throw new HttpError(400, 'invalid_scopes', 'Select at least one device permission');
  const aliases = [...new Set((Array.isArray(input.aliases) ? input.aliases : []).map(String).filter((value) => /^[a-zA-Z0-9._:-]{1,100}$/.test(value)))];
  const requestsPerMinute = boundedInteger(input.requestsPerMinute, 30, 1, 600);
  const maxConcurrency = boundedInteger(input.maxConcurrency, 2, 1, 20);
  let expiresAt = null;
  if (input.expiresAt) {
    const expires = new Date(input.expiresAt);
    if (!Number.isFinite(expires.getTime()) || expires.getTime() <= Date.now()) throw new HttpError(400, 'invalid_expiry', 'Expiry must be a future date');
    expiresAt = expires.toISOString();
  }

  const credential = cryptoService.createDeviceToken();
  const now = nowIso();
  db.prepare(`INSERT INTO device_credentials
    (id, name, secret_hash, secret_prefix, scopes_json, aliases_json, requests_per_minute,
     max_concurrency, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(credential.id, name, credential.hash, credential.prefix, JSON.stringify(scopes), JSON.stringify(aliases),
      requestsPerMinute, maxConcurrency, expiresAt, now, now);
  return { device: publicDevice(db.prepare('SELECT * FROM device_credentials WHERE id = ?').get(credential.id)), token: credential.token };
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

export function listDevices(db) {
  return db.prepare('SELECT * FROM device_credentials ORDER BY created_at DESC').all().map(publicDevice);
}

export function revokeDevice(db, id) {
  const now = nowIso();
  const result = transaction(db, () => {
    const updated = db.prepare(`UPDATE device_credentials
      SET revoked_at = COALESCE(revoked_at, ?), session_epoch = session_epoch + 1, updated_at = ? WHERE id = ?`)
      .run(now, now, id);
    db.prepare('DELETE FROM ai_sessions WHERE device_id = ?').run(id);
    return updated;
  });
  if (!result.changes) throw new HttpError(404, 'device_not_found', 'Device not found');
}

export function resetDeviceSessions(db, id) {
  const changed = transaction(db, () => {
    const updated = db.prepare('UPDATE device_credentials SET session_epoch = session_epoch + 1, updated_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(nowIso(), id);
    db.prepare('DELETE FROM ai_sessions WHERE device_id = ?').run(id);
    return updated.changes;
  });
  if (!changed) throw new HttpError(404, 'device_not_found', 'Active device not found');
}

export class DeviceLimiter {
  #entries = new Map();

  acquire(device) {
    const now = Date.now();
    const minute = Math.floor(now / 60_000);
    let entry = this.#entries.get(device.id);
    if (!entry) {
      entry = { minute, requests: 0, active: 0 };
    } else if (entry.minute !== minute) {
      // Keep the same object so leases created in the previous minute still
      // decrement the active counter held in the map.
      entry.minute = minute;
      entry.requests = 0;
    }
    const limit = boundedInteger(device.requests_per_minute, 30, 1, 600);
    const concurrency = boundedInteger(device.max_concurrency, 2, 1, 20);
    if (entry.requests >= limit) {
      const retryAfter = Math.max(1, 60 - Math.floor((now % 60_000) / 1000));
      throw new HttpError(429, 'rate_limit_exceeded', 'Device request limit exceeded', { 'Retry-After': String(retryAfter) });
    }
    if (entry.active >= concurrency) {
      throw new HttpError(429, 'concurrency_limit_exceeded', 'Too many concurrent device requests', { 'Retry-After': '1' });
    }
    entry.requests += 1;
    entry.active += 1;
    this.#entries.set(device.id, entry);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        entry.active = Math.max(0, entry.active - 1);
        if (entry.active === 0 && entry.minute < Math.floor(Date.now() / 60_000) - 1) this.#entries.delete(device.id);
      }
    };
  }
}

export function randomId(prefix = '') {
  return `${prefix}${crypto.randomUUID()}`;
}
