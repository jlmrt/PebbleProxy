import { HttpError, readJson, sendJson } from './http.js';
import { executeMcpTool } from './actions.js';

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
    title: 'Create local reminder',
    description: 'Create a reminder entry in the authenticated device workspace. This stores the reminder in Pebble Proxy; it does not schedule a phone notification.',
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

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

function httpsOrigin(value) {
  if (typeof value !== 'string' || value !== value.trim() || /[\r\n]/.test(value)) return '';
  let parsed;
  try { parsed = new URL(value); }
  catch { return ''; }
  if (
    parsed.protocol !== 'https:'
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || parsed.pathname !== '/'
  ) return '';
  return parsed.origin;
}

function configuredPublicOrigin(db, config) {
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'public_base_url'").get()?.value;
  return httpsOrigin(stored || config.publicBaseUrl || '');
}

function validateOrigin(req, db, config) {
  const rawOrigin = req.headers.origin;
  if (rawOrigin == null) return;
  const origin = Array.isArray(rawOrigin) ? '' : httpsOrigin(rawOrigin);
  const trustedOrigin = configuredPublicOrigin(db, config);
  if (!origin || !trustedOrigin || origin !== trustedOrigin) {
    throw new HttpError(403, 'invalid_origin', 'Cross-origin MCP requests are not allowed');
  }
}

export function registerMcpRoutes(router, { db, config, authenticate, limiter }) {
  router.add('POST', '/mcp', async (req, res) => {
    validateOrigin(req, db, config);
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
          serverInfo: { name: 'Pebble Proxy Notes & Reminders', version: '0.1.0-test.10' },
          instructions: 'Tools use the private workspace shared by this device’s connections. Reminder tools store local Pebble Proxy entries and do not schedule phone notifications. Deletion tools require confirm=true after explicit user confirmation.'
        };
      } else if (payload.method === 'ping') {
        rpcResult = {};
      } else if (payload.method === 'tools/list') {
        rpcResult = { tools: TOOLS };
      } else if (payload.method === 'tools/call') {
        const params = object(payload.params, 'params');
        if (typeof params.name !== 'string') throw new HttpError(400, 'invalid_params', 'Tool name is required');
        try {
          rpcResult = executeMcpTool(db, device, params.name, params.arguments);
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
    validateOrigin(req, db, config);
    await authenticate(req, 'mcp:invoke');
    throw new HttpError(405, 'method_not_allowed', 'This server uses stateless Streamable HTTP; send JSON-RPC requests with POST', { Allow: 'POST' });
  });
}

export { TOOLS as MCP_TOOLS };
