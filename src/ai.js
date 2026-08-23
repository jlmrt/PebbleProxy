import crypto from 'node:crypto';
import { once } from 'node:events';

import { HttpError, baseHeaders, readJson, safeJson, sendJson } from './http.js';
import { secureFetch } from './security.js';

const REQUEST_FIELDS = new Set([
  'model',
  'messages',
  'stream',
  'stream_options',
  'temperature',
  'top_p',
  'n',
  'stop',
  'max_tokens',
  'max_completion_tokens',
  'presence_penalty',
  'frequency_penalty',
  'seed',
  'response_format',
  'user'
]);

const MESSAGE_FIELDS = new Set(['role', 'content', 'name']);
// Policy instructions are owned by the selected server-side agent profile.
// Letting an untrusted watch replace them would defeat the least-privilege boundary.
const MESSAGE_ROLES = new Set(['user', 'assistant']);
const FINISH_REASONS = new Set(['stop', 'length', 'content_filter']);
const SESSION_HINT = /^[A-Za-z0-9._:@-]{1,80}$/;
const PUBLIC_HEADERS = Object.freeze({ 'Access-Control-Allow-Origin': '*' });

class GatewayError extends Error {
  constructor(status, code, message, { headers = {}, upstream = false, health = 'degraded' } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.code = code;
    this.headers = headers;
    this.upstream = upstream;
    this.health = health;
  }
}

function integer(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function permittedAliases(device) {
  if (Array.isArray(device?.aliases)) return device.aliases;
  return safeJson(device?.aliases_json, []) || [];
}

function canUseAlias(device, alias) {
  const aliases = permittedAliases(device);
  return aliases.length === 0 || aliases.includes(alias);
}

function publicError(error, abortKind = '') {
  if (abortKind === 'client') {
    return { status: 499, code: 'client_closed_request', message: 'Client closed the request.', headers: {} };
  }
  if (abortKind === 'timeout' || error?.name === 'TimeoutError') {
    return { status: 504, code: 'upstream_timeout', message: 'The AI backend timed out.', headers: {} };
  }
  if (error instanceof GatewayError || error instanceof HttpError) {
    return {
      status: integer(error.status, 500, 400, 599),
      code: typeof error.code === 'string' ? error.code : 'internal_error',
      message: typeof error.message === 'string' ? error.message : 'Request failed.',
      headers: error.headers || {}
    };
  }
  return { status: 500, code: 'internal_error', message: 'Internal server error.', headers: {} };
}

function errorType(status) {
  if (status === 400 || status === 404 || status === 413 || status === 415 || status === 422) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 429) return 'rate_limit_error';
  return 'api_error';
}

function sendAiError(res, details, requestId) {
  return sendJson(res, details.status, {
    error: {
      message: details.message,
      type: errorType(details.status),
      param: null,
      code: details.code,
      request_id: requestId
    }
  }, { ...PUBLIC_HEADERS, 'X-Request-Id': requestId, ...details.headers });
}

function requirePlainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayError(400, 'invalid_request', `${field} must be an object.`);
  }
  return value;
}

function rejectUnknownFields(value, allowed, prefix) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new GatewayError(400, 'unsupported_field', `${prefix}${key} is not supported.`);
  }
}

function boundedNumber(value, field, minimum, maximum) {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new GatewayError(400, 'invalid_request', `${field} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function textContent(content, field, maxMessageChars) {
  if (typeof content === 'string') {
    if (content.length > maxMessageChars) throw new GatewayError(400, 'input_too_large', `${field} is too long.`);
    return content;
  }

  if (!Array.isArray(content) || content.length === 0) {
    throw new GatewayError(400, 'text_only', `${field} must contain text only.`);
  }

  const parts = content.map((part, index) => {
    requirePlainObject(part, `${field}[${index}]`);
    rejectUnknownFields(part, new Set(['type', 'text']), `${field}[${index}].`);
    if (part.type !== 'text' || typeof part.text !== 'string') {
      throw new GatewayError(400, 'text_only', 'Image, audio, file, and tool content is not supported.');
    }
    return part.text;
  });
  const joined = parts.join('\n');
  if (joined.length > maxMessageChars) throw new GatewayError(400, 'input_too_large', `${field} is too long.`);
  return joined;
}

function validateStop(value) {
  if (value === undefined) return undefined;
  const values = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(values) || values.length < 1 || values.length > 4 || values.some((item) => typeof item !== 'string' || item.length > 100)) {
    throw new GatewayError(400, 'invalid_request', 'stop must be a string or an array of at most four short strings.');
  }
  return value;
}

function validateResponseFormat(value) {
  if (value === undefined) return undefined;
  requirePlainObject(value, 'response_format');
  rejectUnknownFields(value, new Set(['type']), 'response_format.');
  if (value.type !== 'text' && value.type !== 'json_object') {
    throw new GatewayError(400, 'unsupported_field', 'Only text and json_object response formats are supported.');
  }
  return { type: value.type };
}

function normalizeRequest(input, alias, profile, config) {
  requirePlainObject(input, 'request');
  rejectUnknownFields(input, REQUEST_FIELDS, '');

  if (typeof input.model !== 'string' || input.model.length < 1 || input.model.length > 100) {
    throw new GatewayError(400, 'invalid_model', 'model is required.');
  }
  if (!Array.isArray(input.messages) || input.messages.length < 1) {
    throw new GatewayError(400, 'invalid_messages', 'messages must be a non-empty array.');
  }

  const maxMessages = integer(config.aiMaxMessages, 64, 1, 512);
  const maxMessageChars = integer(config.aiMaxMessageChars, 16_384, 256, 262_144);
  const maxInputChars = integer(config.aiMaxInputChars, 65_536, 1024, 1_048_576);
  if (input.messages.length > maxMessages) throw new GatewayError(400, 'input_too_large', 'Too many messages.');

  let totalChars = 0;
  const messages = input.messages.map((message, index) => {
    requirePlainObject(message, `messages[${index}]`);
    rejectUnknownFields(message, MESSAGE_FIELDS, `messages[${index}].`);
    if (!MESSAGE_ROLES.has(message.role)) {
      throw new GatewayError(400, 'unsupported_role', 'Only user and assistant text messages are supported.');
    }
    const content = textContent(message.content, `messages[${index}].content`, maxMessageChars);
    totalChars += content.length;
    const normalized = { role: message.role, content };
    if (message.name !== undefined) {
      if (typeof message.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(message.name)) {
        throw new GatewayError(400, 'invalid_request', `messages[${index}].name is invalid.`);
      }
      normalized.name = message.name;
    }
    return normalized;
  });
  if (totalChars > maxInputChars) throw new GatewayError(400, 'input_too_large', 'The conversation is too large.');

  if (input.stream !== undefined && typeof input.stream !== 'boolean') {
    throw new GatewayError(400, 'invalid_request', 'stream must be a boolean.');
  }
  if (input.n !== undefined && input.n !== 1) {
    throw new GatewayError(400, 'unsupported_field', 'Only n=1 is supported.');
  }
  if (input.stream_options !== undefined) {
    requirePlainObject(input.stream_options, 'stream_options');
    rejectUnknownFields(input.stream_options, new Set(['include_usage']), 'stream_options.');
    if (input.stream_options.include_usage !== undefined && typeof input.stream_options.include_usage !== 'boolean') {
      throw new GatewayError(400, 'invalid_request', 'stream_options.include_usage must be a boolean.');
    }
  }

  const maxOutput = integer(alias.max_output_tokens, 1024, 1, 65_536);
  const requestedOutput = input.max_completion_tokens ?? input.max_tokens ?? maxOutput;
  if (!Number.isSafeInteger(requestedOutput) || requestedOutput < 1) {
    throw new GatewayError(400, 'invalid_request', 'The output token limit must be a positive integer.');
  }
  const outputTokens = Math.min(requestedOutput, maxOutput);

  const upstream = {
    model: alias.upstream_model,
    messages: profile.instructions
      ? [{ role: 'system', content: profile.instructions }, ...messages]
      : messages,
    stream: input.stream === true,
    n: 1
  };

  if (input.max_completion_tokens !== undefined) upstream.max_completion_tokens = outputTokens;
  else upstream.max_tokens = outputTokens;

  const temperature = boundedNumber(input.temperature, 'temperature', 0, 2);
  const topP = boundedNumber(input.top_p, 'top_p', 0, 1);
  const presencePenalty = boundedNumber(input.presence_penalty, 'presence_penalty', -2, 2);
  const frequencyPenalty = boundedNumber(input.frequency_penalty, 'frequency_penalty', -2, 2);
  if (temperature !== undefined) upstream.temperature = temperature;
  if (topP !== undefined) upstream.top_p = topP;
  if (presencePenalty !== undefined) upstream.presence_penalty = presencePenalty;
  if (frequencyPenalty !== undefined) upstream.frequency_penalty = frequencyPenalty;
  if (input.seed !== undefined) {
    if (!Number.isSafeInteger(input.seed)) throw new GatewayError(400, 'invalid_request', 'seed must be an integer.');
    upstream.seed = input.seed;
  }
  const stop = validateStop(input.stop);
  const responseFormat = validateResponseFormat(input.response_format);
  if (stop !== undefined) upstream.stop = stop;
  if (responseFormat !== undefined) upstream.response_format = responseFormat;
  if (upstream.stream && input.stream_options !== undefined) upstream.stream_options = { ...input.stream_options };

  // A client-supplied `user` is deliberately not copied. If session continuity
  // is requested, an adapter replaces it with a server-owned opaque identifier.
  return { body: upstream, stream: upstream.stream };
}

function selectAlias(db, device, aliasName) {
  if (!canUseAlias(device, aliasName)) return null;
  return db.prepare(`SELECT
      ma.alias,
      ma.upstream_model,
      ma.max_output_tokens,
      ma.timeout_ms,
      ap.id AS profile_id,
      ap.instructions AS profile_instructions,
      ap.allowed_tools_json,
      ap.max_tool_calls,
      ap.max_run_seconds,
      p.id AS provider_id,
      p.type AS provider_type,
      p.base_url,
      p.chat_path,
      p.encrypted_credential,
      p.config_json AS provider_config_json
    FROM model_aliases ma
    JOIN ai_providers p ON p.id = ma.provider_id AND p.enabled = 1
    JOIN agent_profiles ap ON ap.id = ma.agent_profile_id
    WHERE ma.alias = ? AND ma.enabled = 1`)
    .get(aliasName) || null;
}

function listAliases(db, device) {
  const rows = db.prepare(`SELECT ma.alias, ma.created_at
    FROM model_aliases ma
    JOIN ai_providers p ON p.id = ma.provider_id AND p.enabled = 1
    JOIN agent_profiles ap ON ap.id = ma.agent_profile_id
    WHERE ma.enabled = 1
    ORDER BY ma.alias`).all();
  return rows.filter((row) => canUseAlias(device, row.alias));
}

function sessionHint(req) {
  const value = req.headers['x-pebble-session'];
  if (value === undefined) return '';
  if (typeof value !== 'string' || !SESSION_HINT.test(value)) {
    throw new GatewayError(400, 'invalid_session', 'X-Pebble-Session must be 1-80 safe ASCII characters.');
  }
  return value;
}

function resolveSession(db, cryptoService, device, alias, hint, config) {
  if (!hint) return null;
  const epoch = integer(device.session_epoch, 1, 1, Number.MAX_SAFE_INTEGER);
  const hintHash = cryptoService.hashHint(hint);
  const now = new Date();
  const ttlDays = integer(config.aiSessionTtlDays, 30, 1, 365);
  const expiresAt = new Date(now.getTime() + ttlDays * 86_400_000).toISOString();
  const nowValue = now.toISOString();

  // Expired session generations are never resumed, and opportunistic global
  // cleanup prevents stale hints from growing the database forever.
  db.prepare('DELETE FROM ai_sessions WHERE expires_at <= ?').run(nowValue);
  const existing = db.prepare(`SELECT downstream_id FROM ai_sessions
    WHERE device_id = ? AND alias = ? AND profile_id = ? AND hint_hash = ?
      AND session_epoch = ? AND expires_at > ?`)
    .get(device.id, alias.alias, alias.profile_id, hintHash, epoch, nowValue);

  let downstreamId = existing?.downstream_id;
  if (downstreamId) {
    db.prepare(`UPDATE ai_sessions SET expires_at = ?, updated_at = ?
      WHERE device_id = ? AND alias = ? AND profile_id = ? AND hint_hash = ? AND session_epoch = ?`)
      .run(expiresAt, nowValue, device.id, alias.alias, alias.profile_id, hintHash, epoch);
  } else {
    const generation = crypto.randomUUID();
    downstreamId = cryptoService.sessionId(
      'ai-session-v2',
      device.id,
      alias.alias,
      alias.profile_id,
      alias.provider_id,
      alias.upstream_model,
      String(epoch),
      hintHash,
      generation
    );
    db.prepare(`INSERT INTO ai_sessions
        (id, device_id, alias, profile_id, hint_hash, downstream_id, session_epoch, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(crypto.randomUUID(), device.id, alias.alias, alias.profile_id, hintHash,
        downstreamId, epoch, expiresAt, nowValue, nowValue);
  }

  db.prepare(`DELETE FROM ai_sessions WHERE device_id = ? AND id NOT IN (
    SELECT id FROM ai_sessions WHERE device_id = ? ORDER BY updated_at DESC LIMIT 100
  )`).run(device.id, device.id);
  return { downstreamId, epoch };
}

function exactTarget(alias) {
  let base;
  try { base = new URL(alias.base_url); }
  catch { throw new GatewayError(503, 'backend_misconfigured', 'The AI backend is not configured correctly.', { upstream: true }); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new GatewayError(503, 'backend_misconfigured', 'The AI backend is not configured correctly.', { upstream: true });
  }
  if (typeof alias.chat_path !== 'string' || !alias.chat_path.startsWith('/') || alias.chat_path.includes('?') || alias.chat_path.includes('#')) {
    throw new GatewayError(503, 'backend_misconfigured', 'The AI backend is not configured correctly.', { upstream: true });
  }
  let decodedPath;
  try { decodedPath = decodeURIComponent(alias.chat_path); }
  catch { throw new GatewayError(503, 'backend_misconfigured', 'The AI backend is not configured correctly.', { upstream: true }); }
  if (decodedPath.split('/').includes('..') || decodedPath.includes('\u0000')) {
    throw new GatewayError(503, 'backend_misconfigured', 'The AI backend is not configured correctly.', { upstream: true });
  }

  const basePath = base.pathname === '/' ? '' : base.pathname.replace(/\/+$/, '');
  base.pathname = `${basePath}${alias.chat_path}`;
  base.search = '';
  base.hash = '';
  return base;
}

function outboundRequest(alias, normalized, session, device, cryptoService, requestId) {
  const headers = {
    Accept: normalized.stream ? 'text/event-stream' : 'application/json',
    'Content-Type': 'application/json',
    'X-Request-Id': requestId
  };
  if (alias.encrypted_credential) {
    let credential;
    try { credential = cryptoService.decrypt(alias.encrypted_credential); }
    catch { throw new GatewayError(503, 'backend_misconfigured', 'The AI backend credential is invalid.', { upstream: true }); }
    if (!credential || credential.length > 4096 || /[\r\n]/.test(credential)) {
      throw new GatewayError(503, 'backend_misconfigured', 'The AI backend credential is invalid.', { upstream: true });
    }
    headers.Authorization = `Bearer ${credential}`;
  }

  const body = { ...normalized.body };
  const type = String(alias.provider_type || '').toLowerCase();
  if (session) {
    if (type === 'hermes' || type === 'hermes-agent' || type === 'hermes-umbrel') {
      headers['X-Hermes-Session-Id'] = session.downstreamId;
      headers['X-Hermes-Session-Key'] = cryptoService.sessionId(
        'hermes-session-key-v1',
        device.id,
        alias.alias,
        alias.profile_id,
        String(session.epoch)
      );
    } else {
      // Generic OpenAI-compatible and OpenClaw adapters use the standard user field.
      body.user = session.downstreamId;
    }
  } else {
    delete body.user;
  }

  return { headers, body };
}

async function limitedResponseText(response, maximum) {
  if (!response.body) return '';
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > maximum) {
      try { await response.body.cancel(); } catch {}
      throw new GatewayError(502, 'invalid_backend_response', 'The AI backend returned an invalid response.', { upstream: true });
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function retryAfterHeader(response) {
  const value = response.headers.get('retry-after');
  if (!value || !/^\d{1,5}$/.test(value)) return {};
  return { 'Retry-After': value };
}

async function throwForUpstreamStatus(response, maxBytes) {
  if (response.status >= 200 && response.status < 300) return;
  // Drain only a bounded amount and intentionally discard the backend message.
  try { await limitedResponseText(response, Math.min(maxBytes, 65_536)); } catch {}
  if (response.status === 401 || response.status === 403) {
    throw new GatewayError(503, 'backend_misconfigured', 'The AI backend is not configured correctly.', { upstream: true });
  }
  if (response.status === 429) {
    throw new GatewayError(429, 'backend_rate_limited', 'The AI backend is temporarily rate limited.', {
      headers: retryAfterHeader(response), upstream: true, health: 'degraded'
    });
  }
  if (response.status === 400 || response.status === 404 || response.status === 409 || response.status === 422) {
    throw new GatewayError(400, 'backend_rejected_request', 'The AI backend rejected the request.', { upstream: true });
  }
  throw new GatewayError(503, 'backend_unavailable', 'The AI backend is temporarily unavailable.', {
    upstream: true,
    health: response.status >= 500 ? 'unavailable' : 'degraded'
  });
}

function normalizeUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const usage = {};
  for (const field of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    if (Number.isSafeInteger(value[field]) && value[field] >= 0) usage[field] = value[field];
  }
  return Object.keys(usage).length ? usage : undefined;
}

function normalizedFinishReason(value) {
  return FINISH_REASONS.has(value) ? value : value == null ? null : 'stop';
}

function normalizeCompletion(value, alias, publicId, created, maxChars) {
  try {
    requirePlainObject(value, 'backend response');
    if (!Array.isArray(value.choices) || value.choices.length < 1) {
      throw new GatewayError(502, 'invalid_backend_response', 'The AI backend returned an invalid response.', { upstream: true });
    }
    const choice = requirePlainObject(value.choices[0], 'backend choice');
    const message = requirePlainObject(choice.message, 'backend message');
    if (message.tool_calls || message.function_call) {
      throw new GatewayError(502, 'unsupported_backend_tool_call', 'The AI backend did not return a final response.', { upstream: true });
    }
    const content = textContent(message.content, 'backend message content', maxChars);
    const usage = normalizeUsage(value.usage);
    return {
      response: {
        id: publicId,
        object: 'chat.completion',
        created,
        model: alias,
        choices: [{
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: normalizedFinishReason(choice.finish_reason)
        }],
        ...(usage ? { usage } : {})
      },
      usage
    };
  } catch (error) {
    if (error instanceof GatewayError && error.upstream) throw error;
    throw new GatewayError(502, 'invalid_backend_response', 'The AI backend returned an invalid response.', { upstream: true });
  }
}

async function* sseEvents(body, maximumBytes) {
  if (!body) throw new GatewayError(502, 'invalid_backend_response', 'The AI backend returned no response.', { upstream: true });
  const decoder = new TextDecoder();
  let buffer = '';
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maximumBytes) {
      try { await body.cancel(); } catch {}
      throw new GatewayError(502, 'invalid_backend_response', 'The AI backend response was too large.', { upstream: true });
    }
    buffer = `${buffer}${decoder.decode(chunk, { stream: true })}`.replace(/\r\n/g, '\n');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseSseBlock(block);
      if (event) yield event;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const event = parseSseBlock(buffer);
    if (event) yield event;
  }
}

function parseSseBlock(block) {
  let event = '';
  const data = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  return { event, data: data.join('\n') };
}

function normalizeChunk(value, alias, publicId, created, maxChars) {
  try {
    requirePlainObject(value, 'backend stream event');
    if (typeof value.type === 'string' && value.type.startsWith('hermes.')) return null;
    if (value.error) throw new GatewayError(502, 'backend_stream_error', 'The AI backend stream failed.', { upstream: true });
    if (!Array.isArray(value.choices)) {
      throw new GatewayError(502, 'invalid_backend_response', 'The AI backend returned an invalid stream event.', { upstream: true });
    }
    const usage = normalizeUsage(value.usage);
    if (value.choices.length === 0) {
      if (!usage) return null;
      return {
        chunk: { id: publicId, object: 'chat.completion.chunk', created, model: alias, choices: [], usage },
        usage,
        terminal: false
      };
    }

    const choice = requirePlainObject(value.choices[0], 'backend stream choice');
    const deltaValue = choice.delta ?? {};
    const delta = requirePlainObject(deltaValue, 'backend stream delta');
    if (delta.tool_calls || delta.function_call) {
      throw new GatewayError(502, 'unsupported_backend_tool_call', 'The AI backend did not return a final response.', { upstream: true });
    }
    const normalizedDelta = {};
    if (delta.role !== undefined) {
      if (delta.role !== 'assistant') throw new GatewayError(502, 'invalid_backend_response', 'The AI backend returned an invalid role.', { upstream: true });
      normalizedDelta.role = 'assistant';
    }
    if (delta.content !== undefined && delta.content !== null) {
      normalizedDelta.content = textContent(delta.content, 'backend stream content', maxChars);
    }
    if (!Object.keys(normalizedDelta).length && choice.finish_reason == null && !usage) return null;

    return {
      chunk: {
        id: publicId,
        object: 'chat.completion.chunk',
        created,
        model: alias,
        choices: [{
          index: 0,
          delta: normalizedDelta,
          finish_reason: normalizedFinishReason(choice.finish_reason)
        }],
        ...(usage ? { usage } : {})
      },
      usage,
      terminal: choice.finish_reason != null
    };
  } catch (error) {
    if (error instanceof GatewayError && error.upstream) throw error;
    throw new GatewayError(502, 'invalid_backend_response', 'The AI backend returned an invalid stream event.', { upstream: true });
  }
}

async function writeChunk(res, value) {
  if (res.destroyed || res.writableEnded) throw new GatewayError(499, 'client_closed_request', 'Client closed the request.');
  if (res.write(value)) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', drained);
      res.off('close', closed);
      res.off('error', failed);
    };
    const drained = () => { cleanup(); resolve(); };
    const closed = () => {
      cleanup();
      reject(new GatewayError(499, 'client_closed_request', 'Client closed the request.'));
    };
    const failed = () => {
      cleanup();
      reject(new GatewayError(499, 'client_closed_request', 'Client closed the request.'));
    };
    res.once('drain', drained);
    res.once('close', closed);
    res.once('error', failed);
    if (res.destroyed || res.writableEnded) closed();
  });
}

function startSse(res, requestId) {
  res.writeHead(200, baseHeaders({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Request-Id': requestId,
    ...PUBLIC_HEADERS
  }));
}

async function streamCompletion(response, res, alias, requestId, publicId, created, maxBytes, maxChars) {
  let started = false;
  let completed = false;
  let terminal = false;
  let usage;
  try {
    for await (const event of sseEvents(response.body, maxBytes)) {
      if (event.event && event.event !== 'message' && event.event !== 'completion') continue;
      if (event.data === '[DONE]') {
        completed = true;
        break;
      }
      let value;
      try { value = JSON.parse(event.data); }
      catch { throw new GatewayError(502, 'invalid_backend_response', 'The AI backend returned invalid streaming data.', { upstream: true }); }
      const normalized = normalizeChunk(value, alias, publicId, created, maxChars);
      if (!normalized) continue;
      if (!started) {
        startSse(res, requestId);
        started = true;
      }
      if (normalized.usage) usage = normalized.usage;
      terminal ||= normalized.terminal === true;
      await writeChunk(res, `data: ${JSON.stringify(normalized.chunk)}\n\n`);
    }
    if (!started) throw new GatewayError(502, 'invalid_backend_response', 'The AI backend returned an empty stream.', { upstream: true });
    if (!completed && !terminal) {
      throw new GatewayError(502, 'backend_stream_truncated', 'The AI backend stream ended unexpectedly.', { upstream: true });
    }
    await writeChunk(res, 'data: [DONE]\n\n');
    res.end();
    return { usage, completed };
  } catch (error) {
    error.streamStarted = started;
    throw error;
  }
}

function markProvider(db, providerId, status, errorCode = null) {
  if (!providerId) return;
  try {
    const now = new Date().toISOString();
    db.prepare(`UPDATE ai_providers
      SET health_status = ?, last_health_at = ?, last_error = ?, updated_at = ?
      WHERE id = ?`)
      .run(status, now, errorCode, now, providerId);
  } catch {}
}

function audit(db, { requestId, deviceId, alias, status, duration, usage, errorCode }) {
  if (!deviceId) return;
  try {
    db.prepare(`INSERT INTO ai_request_audit
      (id, request_id, device_id, alias, status_code, duration_ms, usage_json, error_code, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        crypto.randomUUID(),
        requestId,
        deviceId,
        alias || null,
        status,
        Math.max(0, Math.round(duration)),
        usage ? JSON.stringify(usage) : null,
        errorCode || null,
        new Date().toISOString()
      );
  } catch {}
}

function releaseLease(lease) {
  try { lease?.release?.(); } catch {}
}

function attachAbort(req, res, controller) {
  let kind = '';
  const abortClient = () => {
    if (!res.writableEnded && !controller.signal.aborted) {
      kind = 'client';
      controller.abort(new Error('client disconnected'));
    }
  };
  req.once('aborted', abortClient);
  res.once('close', abortClient);
  return {
    kind: () => kind,
    timeout() {
      if (!controller.signal.aborted) {
        kind = 'timeout';
        controller.abort(new Error('upstream timeout'));
      }
    },
    detach() {
      req.off('aborted', abortClient);
      res.off('close', abortClient);
    }
  };
}

export function registerAiRoutes(router, deps) {
  const { db, cryptoService, config = {}, authenticate, limiter } = deps;
  if (!router?.add || !db?.prepare || !cryptoService || typeof authenticate !== 'function') {
    throw new TypeError('registerAiRoutes requires router, db, cryptoService, and authenticate dependencies');
  }

  router.add('GET', '/v1/models', async (req, res, context = {}) => {
    const requestId = context.requestId || crypto.randomUUID();
    let lease;
    try {
      const device = await authenticate(req, 'ai:chat');
      lease = limiter?.acquire ? await limiter.acquire(device) : null;
      const data = listAliases(db, device).map((row) => ({
        id: row.alias,
        object: 'model',
        created: Math.floor(Date.parse(row.created_at || 0) / 1000) || 0,
        owned_by: 'pebble-proxy'
      }));
      sendJson(res, 200, { object: 'list', data }, { ...PUBLIC_HEADERS, 'X-Request-Id': requestId });
    } catch (error) {
      if (!res.headersSent && !res.writableEnded) sendAiError(res, publicError(error), requestId);
    } finally {
      releaseLease(lease);
    }
  });

  router.add('POST', '/v1/chat/completions', async (req, res, context = {}) => {
    const startedAt = performance.now();
    const requestId = context.requestId || crypto.randomUUID();
    const publicId = `chatcmpl_${crypto.randomBytes(18).toString('base64url')}`;
    const created = Math.floor(Date.now() / 1000);
    let device;
    let alias;
    let lease;
    let usage;
    let status = 500;
    let errorCode = 'internal_error';
    let abortKind = '';
    let controller;
    let abortEvents;
    let timeout;

    try {
      device = await authenticate(req, 'ai:chat');
      lease = limiter?.acquire ? await limiter.acquire(device) : null;
      const input = await readJson(req, integer(config.maxJsonBytes, 256 * 1024, 1024, 2 * 1024 * 1024));

      if (typeof input.model !== 'string' || !canUseAlias(device, input.model)) {
        throw new GatewayError(404, 'model_not_found', 'The requested model does not exist or is not available to this credential.');
      }
      alias = selectAlias(db, device, input.model);
      if (!alias) throw new GatewayError(404, 'model_not_found', 'The requested model does not exist or is not available to this credential.');

      const profile = { id: alias.profile_id, instructions: alias.profile_instructions };
      const normalized = normalizeRequest(input, alias, profile, config);
      const hint = sessionHint(req);
      const session = resolveSession(db, cryptoService, device, alias, hint, config);
      const outbound = outboundRequest(alias, normalized, session, device, cryptoService, requestId);
      const target = exactTarget(alias);
      const providerConfig = safeJson(alias.provider_config_json, {}) || {};
      const destinationPolicy = {
        internal: providerConfig.internal !== false,
        allowLoopback: config.nodeEnv === 'test'
      };

      controller = new AbortController();
      abortEvents = attachAbort(req, res, controller);
      const configuredTimeout = integer(config.aiTimeoutMs, 90_000, 10, 600_000);
      const timeoutMs = Math.max(10, Math.min(integer(alias.timeout_ms, configuredTimeout, 10, 600_000), configuredTimeout));
      timeout = setTimeout(() => abortEvents.timeout(), timeoutMs);
      timeout.unref?.();

      let response;
      try {
        response = await secureFetch(target, {
          method: 'POST',
          headers: outbound.headers,
          body: JSON.stringify(outbound.body),
          redirect: 'manual',
          signal: controller.signal
        }, destinationPolicy);
      } catch (error) {
        abortKind = abortEvents.kind();
        if (abortKind) throw error;
        if (error instanceof HttpError && error.code === 'unsafe_backend') {
          throw new GatewayError(503, 'backend_misconfigured', 'The AI backend destination is not allowed.', { upstream: true });
        }
        throw new GatewayError(503, 'backend_unavailable', 'The AI backend is temporarily unavailable.', {
          upstream: true, health: 'unavailable'
        });
      }

      const maxResponseBytes = integer(config.aiMaxResponseBytes, 2 * 1024 * 1024, 1024, 32 * 1024 * 1024);
      const maxResponseChars = integer(config.aiMaxResponseChars, 262_144, 256, 4 * 1024 * 1024);
      await throwForUpstreamStatus(response, maxResponseBytes);

      if (normalized.stream) {
        const streamed = await streamCompletion(
          response,
          res,
          alias.alias,
          requestId,
          publicId,
          created,
          maxResponseBytes,
          maxResponseChars
        );
        usage = streamed.usage;
      } else {
        const text = await limitedResponseText(response, maxResponseBytes);
        let value;
        try { value = JSON.parse(text); }
        catch { throw new GatewayError(502, 'invalid_backend_response', 'The AI backend returned invalid JSON.', { upstream: true }); }
        const normalizedResponse = normalizeCompletion(value, alias.alias, publicId, created, maxResponseChars);
        usage = normalizedResponse.usage;
        sendJson(res, 200, normalizedResponse.response, { ...PUBLIC_HEADERS, 'X-Request-Id': requestId });
      }

      status = 200;
      errorCode = null;
      markProvider(db, alias.provider_id, 'healthy');
    } catch (error) {
      abortKind ||= abortEvents?.kind() || '';
      const details = publicError(error, abortKind);
      status = details.status;
      errorCode = details.code;
      if (alias?.provider_id && (error?.upstream || abortKind === 'timeout')) {
        markProvider(db, alias.provider_id, abortKind === 'timeout' ? 'unavailable' : error.health || 'degraded', details.code);
      }

      if (!res.destroyed && !res.writableEnded) {
        if (res.headersSent) {
          const payload = {
            error: {
              message: details.message,
              type: errorType(details.status),
              code: details.code,
              request_id: requestId
            }
          };
          try {
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
            res.end('data: [DONE]\n\n');
          } catch { try { res.destroy(); } catch {} }
        } else if (details.status !== 499) {
          sendAiError(res, details, requestId);
        }
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      abortEvents?.detach();
      releaseLease(lease);
      audit(db, {
        requestId,
        deviceId: device?.id,
        alias: alias?.alias,
        status,
        duration: performance.now() - startedAt,
        usage,
        errorCode
      });
    }
  });
}
