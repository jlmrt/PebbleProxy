import crypto from 'node:crypto';
import { HttpError, readJson, sendJson } from './http.js';
import { nowIso } from './db.js';

const PROTOCOL_VERSION = '2025-06-18';

const TOOLS = [
  {
    name: 'notes_create',
    title: 'Create note',
    description: 'Create a private note for the authenticated Pebble device.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['body'],
      properties: { title: { type: 'string', maxLength: 120 }, body: { type: 'string', minLength: 1, maxLength: 8000 } }
    }
  },
  {
    name: 'notes_list',
    title: 'List notes',
    description: 'List private notes for the authenticated Pebble device.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { query: { type: 'string', maxLength: 200 }, include_archived: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }
    }
  },
  {
    name: 'notes_update',
    title: 'Update note',
    description: 'Update one private note owned by the authenticated Pebble device.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['id'],
      properties: { id: { type: 'string' }, title: { type: ['string', 'null'], maxLength: 120 }, body: { type: 'string', minLength: 1, maxLength: 8000 }, archived: { type: 'boolean' } }
    }
  },
  {
    name: 'notes_delete',
    title: 'Delete note',
    description: 'Permanently delete one private note only after the user explicitly confirms the deletion.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id', 'confirm'], properties: { id: { type: 'string' }, confirm: { type: 'boolean', const: true, description: 'Must be true only after explicit user confirmation.' } } },
    annotations: { destructiveHint: true }
  },
  {
    name: 'reminders_create',
    title: 'Create reminder',
    description: 'Create a reminder for the authenticated Pebble device.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['title'],
      properties: { title: { type: 'string', minLength: 1, maxLength: 200 }, due_at: { type: ['string', 'null'], description: 'ISO 8601 date-time' }, timezone: { type: ['string', 'null'], maxLength: 80 } }
    }
  },
  {
    name: 'reminders_list',
    title: 'List reminders',
    description: 'List reminders for the authenticated Pebble device.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { include_completed: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }
    }
  },
  {
    name: 'reminders_complete',
    title: 'Complete reminder',
    description: 'Mark one reminder owned by the authenticated Pebble device complete.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } }
  },
  {
    name: 'reminders_delete',
    title: 'Delete reminder',
    description: 'Permanently delete one reminder only after the user explicitly confirms the deletion.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id', 'confirm'], properties: { id: { type: 'string' }, confirm: { type: 'boolean', const: true, description: 'Must be true only after explicit user confirmation.' } } },
    annotations: { destructiveHint: true }
  }
];

function object(value, name = 'arguments') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'invalid_params', `${name} must be an object`);
  return value;
}

function text(value, name, max, { optional = false } = {}) {
  if (value == null && optional) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new HttpError(400, 'invalid_params', `${name} is invalid`);
  return value.trim();
}

function limit(value) {
  return Number.isInteger(value) ? Math.min(50, Math.max(1, value)) : 20;
}

function isoDate(value, name, optional = true) {
  if ((value == null || value === '') && optional) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new HttpError(400, 'invalid_params', `${name} must be a valid ISO date-time`);
  return date.toISOString();
}

function result(value, message) {
  return {
    content: [{ type: 'text', text: message || JSON.stringify(value) }],
    structuredContent: value
  };
}

function ownedChange(change, noun) {
  if (!change.changes) throw new HttpError(404, 'not_found', `${noun} not found`);
}

function callTool(db, device, name, rawArgs) {
  const args = object(rawArgs ?? {});
  const now = nowIso();
  if (name === 'notes_create') {
    const id = crypto.randomUUID();
    const titleValue = args.title == null || args.title === '' ? null : text(args.title, 'title', 120);
    const body = text(args.body, 'body', 8000);
    db.prepare('INSERT INTO notes (id, device_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, device.id, titleValue, body, now, now);
    const note = db.prepare('SELECT id, title, body, archived, created_at, updated_at FROM notes WHERE id = ?').get(id);
    return result(note, `Note created: ${titleValue || body.slice(0, 80)}`);
  }
  if (name === 'notes_list') {
    const includeArchived = args.include_archived === true;
    const query = typeof args.query === 'string' ? args.query.trim().slice(0, 200) : '';
    const queryLike = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    const rows = query
      ? db.prepare(`SELECT id, title, body, archived, created_at, updated_at FROM notes
          WHERE device_id = ? AND (? OR archived = 0) AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')
          ORDER BY updated_at DESC LIMIT ?`).all(device.id, includeArchived ? 1 : 0, queryLike, queryLike, limit(args.limit))
      : db.prepare(`SELECT id, title, body, archived, created_at, updated_at FROM notes
          WHERE device_id = ? AND (? OR archived = 0) ORDER BY updated_at DESC LIMIT ?`)
        .all(device.id, includeArchived ? 1 : 0, limit(args.limit));
    return result({ notes: rows }, rows.length ? `${rows.length} note${rows.length === 1 ? '' : 's'} found.` : 'No notes found.');
  }
  if (name === 'notes_update') {
    const id = text(args.id, 'id', 100);
    const current = db.prepare('SELECT * FROM notes WHERE id = ? AND device_id = ?').get(id, device.id);
    if (!current) throw new HttpError(404, 'not_found', 'Note not found');
    const titleValue = Object.hasOwn(args, 'title') ? (args.title == null || args.title === '' ? null : text(args.title, 'title', 120)) : current.title;
    const body = Object.hasOwn(args, 'body') ? text(args.body, 'body', 8000) : current.body;
    const archived = Object.hasOwn(args, 'archived') ? (args.archived === true ? 1 : 0) : current.archived;
    db.prepare('UPDATE notes SET title = ?, body = ?, archived = ?, updated_at = ? WHERE id = ? AND device_id = ?')
      .run(titleValue, body, archived, now, id, device.id);
    const note = db.prepare('SELECT id, title, body, archived, created_at, updated_at FROM notes WHERE id = ?').get(id);
    return result(note, 'Note updated.');
  }
  if (name === 'notes_delete') {
    const id = text(args.id, 'id', 100);
    if (args.confirm !== true) throw new HttpError(400, 'confirmation_required', 'Explicit confirmation is required before deleting a note');
    ownedChange(db.prepare('DELETE FROM notes WHERE id = ? AND device_id = ?').run(id, device.id), 'Note');
    return result({ id, deleted: true }, 'Note deleted.');
  }
  if (name === 'reminders_create') {
    const id = crypto.randomUUID();
    const titleValue = text(args.title, 'title', 200);
    const dueAt = isoDate(args.due_at, 'due_at');
    const timezone = args.timezone == null || args.timezone === '' ? null : text(args.timezone, 'timezone', 80);
    db.prepare('INSERT INTO reminders (id, device_id, title, due_at, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, device.id, titleValue, dueAt, timezone, now, now);
    const reminder = db.prepare('SELECT id, title, due_at, timezone, completed_at, created_at, updated_at FROM reminders WHERE id = ?').get(id);
    return result(reminder, `Reminder created: ${titleValue}`);
  }
  if (name === 'reminders_list') {
    const rows = db.prepare(`SELECT id, title, due_at, timezone, completed_at, created_at, updated_at FROM reminders
      WHERE device_id = ? AND (? OR completed_at IS NULL)
      ORDER BY completed_at IS NOT NULL, due_at IS NULL, due_at, created_at DESC LIMIT ?`)
      .all(device.id, args.include_completed === true ? 1 : 0, limit(args.limit));
    return result({ reminders: rows }, rows.length ? `${rows.length} reminder${rows.length === 1 ? '' : 's'} found.` : 'No reminders found.');
  }
  if (name === 'reminders_complete') {
    const id = text(args.id, 'id', 100);
    ownedChange(db.prepare('UPDATE reminders SET completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ? AND device_id = ?')
      .run(now, now, id, device.id), 'Reminder');
    return result({ id, completed_at: now }, 'Reminder completed.');
  }
  if (name === 'reminders_delete') {
    const id = text(args.id, 'id', 100);
    if (args.confirm !== true) throw new HttpError(400, 'confirmation_required', 'Explicit confirmation is required before deleting a reminder');
    ownedChange(db.prepare('DELETE FROM reminders WHERE id = ? AND device_id = ?').run(id, device.id), 'Reminder');
    return result({ id, deleted: true }, 'Reminder deleted.');
  }
  throw new HttpError(404, 'tool_not_found', 'Tool not found');
}

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

export function registerMcpRoutes(router, { db, config, authenticate, limiter }) {
  router.add('POST', '/mcp', async (req, res) => {
    const device = await authenticate(req, 'mcp:invoke');
    const lease = limiter.acquire(device);
    try {
      const payload = await readJson(req, config.maxJsonBytes);
      if (!payload || payload.jsonrpc !== '2.0' || typeof payload.method !== 'string') {
        return sendJson(res, 200, rpcError(payload?.id, -32600, 'Invalid Request'));
      }
      if (payload.method.startsWith('notifications/')) {
        res.writeHead(202, { 'Cache-Control': 'no-store' });
        return res.end();
      }
      let rpcResult;
      if (payload.method === 'initialize') {
        rpcResult = {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'Pebble Proxy Notes & Reminders', version: '0.1.0' },
          instructions: 'Tools are private to the authenticated Pebble device. Deletion tools require confirm=true after explicit user confirmation.'
        };
      } else if (payload.method === 'ping') {
        rpcResult = {};
      } else if (payload.method === 'tools/list') {
        rpcResult = { tools: TOOLS };
      } else if (payload.method === 'tools/call') {
        const params = object(payload.params, 'params');
        if (typeof params.name !== 'string') throw new HttpError(400, 'invalid_params', 'Tool name is required');
        try {
          rpcResult = callTool(db, device, params.name, params.arguments);
        } catch (error) {
          if (!(error instanceof HttpError)) throw error;
          rpcResult = { isError: true, content: [{ type: 'text', text: error.message }] };
        }
      } else {
        return sendJson(res, 200, rpcError(payload.id, -32601, 'Method not found'));
      }
      return sendJson(res, 200, { jsonrpc: '2.0', id: payload.id ?? null, result: rpcResult }, {
        'MCP-Protocol-Version': PROTOCOL_VERSION
      });
    } catch (error) {
      if (error instanceof HttpError && ['invalid_params', 'tool_not_found'].includes(error.code)) {
        return sendJson(res, 200, rpcError(null, -32602, error.message));
      }
      throw error;
    } finally {
      lease.release();
    }
  });

  router.add('GET', '/mcp', async (req, res) => {
    await authenticate(req, 'mcp:invoke');
    throw new HttpError(405, 'method_not_allowed', 'This server uses stateless Streamable HTTP; send JSON-RPC requests with POST', { Allow: 'POST' });
  });
}

export { TOOLS as MCP_TOOLS };
