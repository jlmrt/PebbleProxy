import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createDatabase } from './db.js';
import { createCryptoService } from './crypto.js';
import { createAuthenticator, DeviceLimiter } from './auth.js';
import { HttpError, Router, cleanError, requestId, sendJson, sendOpenAiError, sendText } from './http.js';
import { registerAiRoutes } from './ai.js';
import { registerMcpRoutes } from './mcp.js';
import { registerRecordingRoutes, startSttWorker } from './recordings.js';
import { registerAdminRoutes, startHealthWorker } from './admin.js';
import { adminMutationAllowed } from './security.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function log(level, message, fields = {}) {
  const record = { time: new Date().toISOString(), level, message, ...fields };
  const output = JSON.stringify(record);
  if (level === 'error') console.error(output);
  else console.log(output);
}

function publicCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Pebble-Session, Idempotency-Key, MCP-Protocol-Version',
    'Access-Control-Expose-Headers': 'X-Request-Id, Retry-After, MCP-Protocol-Version',
    'Access-Control-Max-Age': '86400'
  };
}

function validPublicHost(req, config) {
  if (!config.allowedPublicHosts.length) return true;
  const raw = String(req.headers.host || '').toLowerCase();
  const host = raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.split(':')[0];
  return config.allowedPublicHosts.includes(host);
}

function publicError(res, error, id, pathname) {
  const clean = cleanError(error);
  const headers = { ...clean.headers, ...publicCorsHeaders(), 'X-Request-Id': id };
  if (pathname.startsWith('/v1/')) return sendOpenAiError(res, clean.status, clean.code, clean.message, id, headers);
  return sendJson(res, clean.status, { error: { code: clean.code, message: clean.message, requestId: id } }, headers);
}

function adminError(res, error, id) {
  const clean = cleanError(error);
  return sendJson(res, clean.status, { error: { code: clean.code, message: clean.message, requestId: id } }, {
    ...clean.headers,
    'X-Request-Id': id,
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"
  });
}

function createNodeServer(handler) {
  const server = http.createServer(handler);
  server.requestTimeout = 180_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 80;
  return server;
}

function staticAssets() {
  const webDir = path.join(ROOT, 'web');
  const definitions = [
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/index.html', 'index.html', 'text/html; charset=utf-8'],
    ['/clipboard.js', 'clipboard.js', 'text/javascript; charset=utf-8'],
    ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
    ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
    ['/favicon.svg', 'favicon.svg', 'image/svg+xml']
  ];
  const map = new Map();
  for (const [url, file, contentType] of definitions) {
    try { map.set(url, { body: fs.readFileSync(path.join(webDir, file)), contentType }); } catch {}
  }
  return map;
}

export function createApplication(overrides = {}) {
  const config = loadConfig(overrides);
  const db = createDatabase(config.databasePath);
  const cryptoService = createCryptoService(config);
  const authenticate = createAuthenticator({ db, cryptoService });
  const limiter = new DeviceLimiter();
  const deps = { db, cryptoService, config, authenticate, limiter, log };
  const publicRouter = new Router();
  const adminRouter = new Router();

  publicRouter.add('GET', '/healthz', (_req, res) => sendJson(res, 200, { status: 'ok' }, publicCorsHeaders()));
  adminRouter.add('GET', '/healthz', (_req, res) => sendJson(res, 200, { status: 'ok' }));
  registerAiRoutes(publicRouter, deps);
  registerMcpRoutes(publicRouter, deps);
  registerRecordingRoutes(publicRouter, adminRouter, deps);
  registerAdminRoutes(adminRouter, deps);

  const assets = staticAssets();
  const publicServer = createNodeServer(async (req, res) => {
    const id = requestId(req);
    let pathname = '/';
    res.setHeader('X-Request-Id', id);
    for (const [name, value] of Object.entries(publicCorsHeaders())) res.setHeader(name, value);
    const started = Date.now();
    try {
      try { pathname = new URL(req.url || '/', 'http://localhost').pathname; }
      catch { throw new HttpError(400, 'invalid_url', 'Request URL is invalid'); }
      if (!validPublicHost(req, config)) throw new HttpError(421, 'invalid_host', 'Request host is not allowed');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, publicCorsHeaders());
        return res.end();
      }
      await publicRouter.dispatch(req, res, { requestId: id });
      log('info', 'public_request', { requestId: id, method: req.method, path: pathname, status: res.statusCode, durationMs: Date.now() - started });
    } catch (error) {
      if (!(error instanceof HttpError)) log('error', 'public_request_failed', { requestId: id, method: req.method, path: pathname, error: error?.message });
      if (!res.headersSent) publicError(res, error, id, pathname);
      else res.destroy();
    }
  });

  const adminServer = createNodeServer(async (req, res) => {
    const id = requestId(req);
    let pathname = '/';
    res.setHeader('X-Request-Id', id);
    try {
      try { pathname = new URL(req.url || '/', 'http://localhost').pathname; }
      catch { throw new HttpError(400, 'invalid_url', 'Request URL is invalid'); }
      if (pathname.startsWith('/admin/api/') && !['GET', 'HEAD'].includes(req.method || '') && !adminMutationAllowed(req)) {
        throw new HttpError(403, 'admin_request_rejected', 'Admin mutation requires a same-origin request');
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && assets.has(pathname)) {
        const asset = assets.get(pathname);
        const headers = {
          'Content-Type': asset.contentType,
          'Content-Length': String(asset.body.length),
          // Admin assets are small and version-coupled. Revalidation prevents a
          // cached script from running against newer dashboard markup after an app update.
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          'X-Frame-Options': 'SAMEORIGIN',
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'"
        };
        res.writeHead(200, headers);
        return res.end(req.method === 'HEAD' ? undefined : asset.body);
      }
      if (pathname === '/favicon.ico' && req.method === 'GET') {
        res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
        return res.end();
      }
      await adminRouter.dispatch(req, res, { requestId: id });
    } catch (error) {
      if (!(error instanceof HttpError)) log('error', 'admin_request_failed', { requestId: id, method: req.method, path: pathname, error: error?.message });
      if (!res.headersSent) adminError(res, error, id);
      else res.destroy();
    }
  });

  let stopWorker = () => {};
  let stopHealthWorker = () => {};
  return {
    config,
    db,
    publicServer,
    adminServer,
    async start() {
      const listeners = [];
      if (config.role === 'all' || config.role === 'public') {
        listeners.push(new Promise((resolve, reject) => {
          publicServer.once('error', reject);
          publicServer.listen(config.publicPort, config.publicHost, () => {
            log('info', 'public_server_listening', { host: config.publicHost, port: config.publicPort });
            resolve();
          });
        }));
        stopWorker = startSttWorker(deps) || (() => {});
        stopHealthWorker = startHealthWorker(deps) || (() => {});
      }
      if (config.role === 'all' || config.role === 'admin') {
        listeners.push(new Promise((resolve, reject) => {
          adminServer.once('error', reject);
          adminServer.listen(config.adminPort, config.adminHost, () => {
            log('info', 'admin_server_listening', { host: config.adminHost, port: config.adminPort });
            resolve();
          });
        }));
      }
      await Promise.all(listeners);
      return this;
    },
    async close() {
      await Promise.resolve(stopWorker());
      await Promise.resolve(stopHealthWorker());
      const close = (server) => server.listening ? new Promise((resolve) => server.close(resolve)) : Promise.resolve();
      await Promise.all([close(publicServer), close(adminServer)]);
      db.close();
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApplication();
  app.start().catch((error) => {
    log('error', 'startup_failed', { error: error.message });
    process.exitCode = 1;
  });
  const shutdown = async (signal) => {
    log('info', 'shutdown', { signal });
    try { await app.close(); } finally { process.exit(0); }
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}
