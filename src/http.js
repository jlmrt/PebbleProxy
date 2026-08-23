import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export class Router {
  #routes = [];

  add(method, pattern, handler) {
    const keys = [];
    const source = pattern
      .split('/')
      .map((part) => {
        if (!part.startsWith(':')) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        keys.push(part.slice(1));
        return '([^/]+)';
      })
      .join('/');
    this.#routes.push({ method: method.toUpperCase(), pattern, regex: new RegExp(`^${source}$`), keys, handler });
    return this;
  }

  async dispatch(req, res, context = {}) {
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    let pathname;
    try { pathname = decodeURIComponent(requestUrl.pathname); } catch { throw new HttpError(400, 'invalid_path', 'Invalid request path'); }
    if (pathname.includes('\u0000') || pathname.split('/').includes('..')) throw new HttpError(400, 'invalid_path', 'Invalid request path');

    for (const route of this.#routes) {
      if (route.method !== req.method) continue;
      const match = route.regex.exec(pathname);
      if (!match) continue;
      const params = Object.fromEntries(route.keys.map((key, index) => [key, match[index + 1]]));
      return route.handler(req, res, { ...context, params, url: requestUrl });
    }
    throw new HttpError(404, 'not_found', 'Route not found');
  }
}

export function requestId(req) {
  const supplied = req.headers['x-request-id'];
  return typeof supplied === 'string' && /^[a-zA-Z0-9_.:-]{1,80}$/.test(supplied) ? supplied : crypto.randomUUID();
}

export async function readBuffer(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new HttpError(413, 'request_too_large', 'Request body is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, maxBytes) {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  const buffer = await readBuffer(req, maxBytes);
  try { return JSON.parse(buffer.toString('utf8') || '{}'); }
  catch { throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON'); }
}

export function parseMultipart(buffer, contentType) {
  const match = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  const boundary = match?.[1] || match?.[2]?.trim();
  if (
    !boundary ||
    boundary.length > 70 ||
    !/^[0-9A-Za-z'()+_,./:=? -]+$/.test(boundary) ||
    boundary.endsWith(' ')
  ) {
    throw new HttpError(400, 'invalid_multipart', 'Multipart boundary is missing or invalid');
  }

  const marker = Buffer.from(`--${boundary}`);
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const headerSeparator = Buffer.from('\r\n\r\n');
  const crlf = Buffer.from('\r\n');
  const closing = Buffer.from('--');
  const parts = [];

  const malformed = () => {
    throw new HttpError(400, 'invalid_multipart', 'Multipart body framing is invalid');
  };
  const hasAt = (needle, offset) =>
    offset + needle.length <= buffer.length && buffer.subarray(offset, offset + needle.length).equals(needle);

  if (!hasAt(marker, 0)) malformed();
  let cursor = marker.length;

  while (true) {
    if (hasAt(closing, cursor)) {
      cursor += 2;
      if (hasAt(crlf, cursor)) cursor += 2;
      if (cursor !== buffer.length) malformed();
      return parts;
    }
    if (!hasAt(crlf, cursor)) malformed();

    const headerStart = cursor + 2;
    const headerEnd = buffer.indexOf(headerSeparator, headerStart);
    if (headerEnd < 0 || headerEnd - headerStart > 16 * 1024) malformed();
    const next = buffer.indexOf(delimiter, headerEnd + headerSeparator.length);
    if (next < 0) malformed();

    const rawHeaders = buffer.subarray(headerStart, headerEnd).toString('utf8');
    const headers = new Map();
    for (const line of rawHeaders.split('\r\n')) {
      const header = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*)$/.exec(line);
      if (!header) malformed();
      const name = header[1].toLowerCase();
      if (headers.has(name)) malformed();
      headers.set(name, header[2].trim());
    }

    const disposition = headers.get('content-disposition') || '';
    if (!/^form-data(?:\s*;|$)/i.test(disposition)) malformed();
    const name = /(?:^|;)\s*name="([^"\r\n]+)"(?:\s*;|\s*$)/i.exec(disposition)?.[1];
    if (!name) malformed();
    const filename = /(?:^|;)\s*filename="([^"\r\n]*)"(?:\s*;|\s*$)/i.exec(disposition)?.[1];
    const type = headers.get('content-type')?.toLowerCase();
    parts.push({
      name,
      filename,
      contentType: type,
      data: buffer.subarray(headerEnd + headerSeparator.length, next)
    });
    if (parts.length > 32) malformed();
    cursor = next + delimiter.length;
  }
}

export function bearerToken(req) {
  const value = req.headers.authorization;
  if (typeof value !== 'string') return '';
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1] || '';
}

export function baseHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    ...extra
  };
}

export function sendJson(res, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, baseHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    ...headers
  }));
  res.end(body);
}

export function sendText(res, status, value, contentType = 'text/plain; charset=utf-8', headers = {}) {
  const body = Buffer.from(String(value));
  res.writeHead(status, baseHeaders({ 'Content-Type': contentType, 'Content-Length': String(body.length), ...headers }));
  res.end(body);
}

export function sendOpenAiError(res, status, code, message, requestIdValue, headers = {}) {
  return sendJson(res, status, {
    error: {
      message,
      type: status === 400 ? 'invalid_request_error' : 'api_error',
      code,
      request_id: requestIdValue
    }
  }, headers);
}

export function safeJson(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

export function cleanError(error) {
  if (error instanceof HttpError) return error;
  return new HttpError(500, 'internal_error', 'Internal server error');
}
