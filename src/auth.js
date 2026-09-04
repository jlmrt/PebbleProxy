import crypto from 'node:crypto';
import { bearerToken, HttpError, safeJson } from './http.js';
import { nowIso, transaction } from './db.js';

export const DEVICE_SCOPES = Object.freeze(['ai:chat', 'webhook:write', 'tts:speech', 'mcp:invoke']);
export const CLIENT_DEVICE_TYPES = Object.freeze(['index', 'pebble', 'other']);
export const INDEX_TRIGGERS = Object.freeze(['single-click-hold', 'double-click-hold', 'all']);
export const INDEX_CONNECTION_TYPES = Object.freeze(['webhook', 'mcp']);

function compatibilityToken(req) {
  const candidates = [bearerToken(req)];
  for (const name of ['x-widget-token', 'x-pebble-token', 'x-webhook-token']) {
    const value = req.headers[name];
    if (value === undefined) continue;
    if (Array.isArray(value) || typeof value !== 'string' || /[\r\n]/.test(value)) {
      throw new HttpError(400, 'invalid_api_key', `${name} must contain one token`);
    }
    candidates.push(value.trim());
  }
  const supplied = [...new Set(candidates.filter(Boolean))];
  if (supplied.length > 1) throw new HttpError(400, 'conflicting_api_keys', 'Authentication headers contain different tokens');
  return supplied[0] || '';
}

function tokenId(token) {
  const match = /^pp_([a-f0-9]{16})_[A-Za-z0-9_-]{32,}$/.exec(token);
  return match?.[1] || '';
}

function parseList(value) {
  const parsed = safeJson(value, []);
  return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
}

function derivedConnectionType(ownerDeviceType, scopes) {
  if (ownerDeviceType !== 'index') return 'client';
  return scopes.includes('mcp:invoke') ? 'mcp' : 'webhook';
}

function publicDevice(row) {
  if (!row) return null;
  const scopes = parseList(row.scopes_json);
  return {
    id: row.id,
    name: row.name,
    ownerDeviceId: row.owner_device_id || row.id,
    label: row.connection_label || row.name,
    connectionType: derivedConnectionType(row.owner_device_type, scopes),
    indexTrigger: row.index_trigger || null,
    tokenPrefix: row.secret_prefix,
    scopes,
    aliases: parseList(row.aliases_json),
    requestsPerMinute: row.requests_per_minute,
    maxConcurrency: row.max_concurrency,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    webhookPath: scopes.includes('webhook:write') ? `/webhooks/index/${row.id}` : null
  };
}

function clientDeviceView(row, connections = []) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    connections
  };
}

function requiredName(value, field = 'Device name') {
  const name = String(value || '').trim();
  if (!name || name.length > 100) {
    throw new HttpError(400, 'invalid_name', `${field} is required and must be at most 100 characters`);
  }
  return name;
}

function deviceType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (!CLIENT_DEVICE_TYPES.includes(type)) {
    throw new HttpError(400, 'invalid_device_type', 'Device type must be index, pebble, or other');
  }
  return type;
}

function indexTrigger(value) {
  const trigger = String(value || '').trim().toLowerCase();
  if (!INDEX_TRIGGERS.includes(trigger)) {
    throw new HttpError(400, 'invalid_index_trigger', 'Index trigger must be single-click-hold, double-click-hold, or all');
  }
  return trigger;
}

function indexConnectionType(value) {
  const type = String(value || 'webhook').trim().toLowerCase();
  if (!INDEX_CONNECTION_TYPES.includes(type)) {
    throw new HttpError(400, 'invalid_connection_type', 'Index connection type must be webhook or mcp');
  }
  return type;
}

function connectionLabel(value, parent, trigger, connectionType) {
  const explicit = String(value || '').trim();
  if (explicit.length > 100) throw new HttpError(400, 'invalid_connection_label', 'Connection label must be at most 100 characters');
  if (explicit) return explicit;
  if (parent.type !== 'index') return 'Default connection';
  if (connectionType === 'mcp') return 'Custom MCP server';
  if (trigger === 'single-click-hold') return 'Ring Button Hold & Talk';
  if (trigger === 'double-click-hold') return 'Double Click & Hold';
  return 'All Index gestures';
}

function scopesFor(input, parentType, connectionType) {
  if (Object.hasOwn(input, 'scopes') && !Array.isArray(input.scopes)) {
    throw new HttpError(400, 'invalid_scopes', 'Device permissions must be an array');
  }
  if (parentType === 'index') {
    const requiredScope = connectionType === 'mcp' ? 'mcp:invoke' : 'webhook:write';
    if (Array.isArray(input.scopes)) {
      const supplied = [...new Set(input.scopes.map(String))];
      if (supplied.length !== 1 || supplied[0] !== requiredScope) {
        throw new HttpError(400, 'invalid_index_scopes', `Index ${connectionType} connections require only ${requiredScope}`);
      }
    }
    return [requiredScope];
  }
  const supplied = Array.isArray(input.scopes) ? input.scopes.map(String) : DEVICE_SCOPES;
  if (supplied.some((scope) => !DEVICE_SCOPES.includes(scope))) {
    throw new HttpError(400, 'invalid_scopes', 'Device permissions contain an unsupported capability');
  }
  const scopes = [...new Set(supplied)];
  if (!scopes.length) throw new HttpError(400, 'invalid_scopes', 'Select at least one device permission');
  return scopes;
}

function aliasesFor(input) {
  if (Object.hasOwn(input, 'aliases') && !Array.isArray(input.aliases)) {
    throw new HttpError(400, 'invalid_aliases', 'Model alias restrictions must be an array');
  }
  const aliases = Array.isArray(input.aliases) ? input.aliases.map(String) : [];
  if (aliases.some((value) => !/^[a-zA-Z0-9._:-]{1,100}$/.test(value))) {
    throw new HttpError(400, 'invalid_aliases', 'Model alias restrictions contain an invalid alias');
  }
  return [...new Set(aliases)];
}

function expiryFor(input) {
  if (!input.expiresAt) return null;
  const expires = new Date(input.expiresAt);
  if (!Number.isFinite(expires.getTime()) || expires.getTime() <= Date.now()) {
    throw new HttpError(400, 'invalid_expiry', 'Expiry must be a future date');
  }
  return expires.toISOString();
}

function insertClientDevice(db, input = {}) {
  const id = crypto.randomUUID();
  const name = requiredName(input.name);
  const type = deviceType(input.type);
  const now = nowIso();
  db.prepare(`INSERT INTO client_devices (id, name, type, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)`).run(id, name, type, now, now);
  return clientDeviceView(db.prepare('SELECT * FROM client_devices WHERE id = ?').get(id));
}

function insertDeviceConnection(db, cryptoService, parent, input = {}) {
  const requestedConnectionType = input.connectionType ?? input.connection_type;
  if (parent.type !== 'index' && requestedConnectionType != null && String(requestedConnectionType).trim() !== 'client') {
    throw new HttpError(400, 'invalid_connection_type', 'Only Index devices use webhook or MCP connection types');
  }
  const connectionType = parent.type === 'index' ? indexConnectionType(requestedConnectionType) : 'client';
  const triggerInput = input.indexTrigger ?? input.index_trigger ?? input.trigger;
  if (parent.type !== 'index' && triggerInput != null && String(triggerInput).trim()) {
    throw new HttpError(400, 'invalid_index_trigger', 'Only Index devices can assign an Index trigger');
  }
  if (connectionType === 'mcp' && triggerInput != null && String(triggerInput).trim()) {
    throw new HttpError(400, 'invalid_index_trigger', 'Index MCP servers are assigned to gestures in the Pebble app, not on the MCP connection');
  }
  const trigger = parent.type === 'index' && connectionType === 'webhook' ? indexTrigger(triggerInput || 'all') : null;
  const label = connectionLabel(input.label ?? input.connectionLabel, parent, trigger, connectionType);
  const scopes = scopesFor(input, parent.type, connectionType);
  const aliases = aliasesFor(input);
  const requestsPerMinute = boundedInteger(input.requestsPerMinute, 30, 1, 600);
  const maxConcurrency = boundedInteger(input.maxConcurrency, 2, 1, 20);
  const expiresAt = expiryFor(input);
  const credential = cryptoService.createDeviceToken();
  const now = nowIso();
  db.prepare(`INSERT INTO device_credentials
    (id, name, owner_device_id, connection_label, index_trigger, secret_hash, secret_prefix,
     scopes_json, aliases_json, requests_per_minute, max_concurrency, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    credential.id,
    parent.name,
    parent.id,
    label,
    trigger,
    credential.hash,
    credential.prefix,
    JSON.stringify(scopes),
    JSON.stringify(aliases),
    requestsPerMinute,
    maxConcurrency,
    expiresAt,
    now,
    now
  );
  return {
    connection: {
      ...publicDevice(db.prepare('SELECT * FROM device_credentials WHERE id = ?').get(credential.id)),
      connectionType
    },
    token: credential.token
  };
}

export function createAuthenticator({ db, cryptoService }) {
  const touchTimes = new Map();

  return async function authenticate(req, requiredScope, options = {}) {
    const token = options.allowWebhookHeaders ? compatibilityToken(req) : bearerToken(req);
    const id = tokenId(token);
    const row = id ? db.prepare(`SELECT dc.*, cd.type AS owner_device_type
      FROM device_credentials dc
      LEFT JOIN client_devices cd ON cd.id = dc.owner_device_id
      WHERE dc.id = ?`).get(id) : null;
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

    return {
      ...row,
      ownerDeviceId: row.owner_device_id || row.id,
      connectionLabel: row.connection_label || row.name,
      connectionType: derivedConnectionType(row.owner_device_type, scopes),
      indexTrigger: row.index_trigger || null,
      scopes,
      aliases: parseList(row.aliases_json)
    };
  };
}

export function createDevice(db, cryptoService, input = {}) {
  return transaction(db, () => {
    const parent = insertClientDevice(db, { name: input.name, type: 'other' });
    const created = insertDeviceConnection(db, cryptoService, parent, {
      ...input,
      label: input.label || input.name
    });
    return { device: created.connection, token: created.token };
  });
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

export function listDevices(db) {
  return db.prepare(`SELECT dc.*, cd.type AS owner_device_type
    FROM device_credentials dc
    LEFT JOIN client_devices cd ON cd.id = dc.owner_device_id
    ORDER BY dc.created_at DESC`).all().map(publicDevice);
}

export function createClientDevice(db, input = {}) {
  return insertClientDevice(db, input);
}

export function createDeviceConnection(db, cryptoService, ownerDeviceId, input = {}) {
  const parent = db.prepare('SELECT * FROM client_devices WHERE id = ?').get(String(ownerDeviceId || ''));
  if (!parent) throw new HttpError(404, 'device_group_not_found', 'Device not found');
  return insertDeviceConnection(db, cryptoService, parent, input);
}

function inactiveCredential(row, now = Date.now()) {
  if (row.revoked_at) return true;
  const expiresAt = row.expires_at ? Date.parse(row.expires_at) : NaN;
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

function retainedConnectionData(db, connectionIds) {
  if (!connectionIds.length) return 0;
  const placeholders = connectionIds.map(() => '?').join(',');
  return ['recordings', 'notes', 'reminders'].reduce((total, table) => total + Number(
    db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE device_id IN (${placeholders})`)
      .get(...connectionIds).count
  ), 0);
}

function retainedDeviceData(db, ownerDeviceId) {
  return ['recordings', 'notes', 'reminders'].reduce((total, table) => total + Number(
    db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE device_id IN (
      SELECT id FROM device_credentials WHERE owner_device_id = ?
    )`).get(ownerDeviceId).count
  ), 0);
}

export function deleteInactiveDeviceConnection(db, ownerDeviceId, connectionId) {
  const ownerId = String(ownerDeviceId || '');
  const id = String(connectionId || '');
  transaction(db, () => {
    const connection = db.prepare(`SELECT id, revoked_at, expires_at FROM device_credentials
      WHERE id = ? AND owner_device_id = ?`).get(id, ownerId);
    if (!connection) throw new HttpError(404, 'device_not_found', 'Connection not found');
    if (!inactiveCredential(connection)) {
      throw new HttpError(409, 'connection_active', 'Revoke this connection before permanently deleting it');
    }
    if (retainedConnectionData(db, [id]) > 0) {
      throw new HttpError(409, 'connection_has_data', 'Delete this connection’s recordings, notes, and reminders before removing it');
    }
    db.prepare('DELETE FROM device_credentials WHERE id = ? AND owner_device_id = ?').run(id, ownerId);
  });
}

export function deleteInactiveClientDevice(db, ownerDeviceId) {
  const id = String(ownerDeviceId || '');
  transaction(db, () => {
    const parent = db.prepare('SELECT id FROM client_devices WHERE id = ?').get(id);
    if (!parent) throw new HttpError(404, 'device_group_not_found', 'Device not found');
    const connections = db.prepare(`SELECT id, revoked_at, expires_at FROM device_credentials
      WHERE owner_device_id = ?`).all(id);
    if (connections.some((connection) => !inactiveCredential(connection))) {
      throw new HttpError(409, 'device_group_has_active_connections', 'Revoke every active connection before permanently deleting this device');
    }
    if (retainedDeviceData(db, id) > 0) {
      throw new HttpError(409, 'device_group_has_data', 'Delete this device’s recordings, notes, and reminders before removing it');
    }
    db.prepare('DELETE FROM device_credentials WHERE owner_device_id = ?').run(id);
    db.prepare('DELETE FROM client_devices WHERE id = ?').run(id);
  });
}

export function listClientDevices(db) {
  const connections = listDevices(db);
  const grouped = new Map();
  for (const connection of connections) {
    const ownerId = connection.ownerDeviceId;
    if (!grouped.has(ownerId)) grouped.set(ownerId, []);
    grouped.get(ownerId).push(connection);
  }
  return db.prepare('SELECT * FROM client_devices ORDER BY created_at DESC, id DESC').all()
    .map((row) => clientDeviceView(row, grouped.get(row.id) || []));
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
