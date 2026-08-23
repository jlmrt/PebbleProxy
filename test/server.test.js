import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApplication } from '../src/server.js';

function captureResponse() {
  const chunks = [];
  return {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    headers: {},
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = String(value); },
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headersSent = true;
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    },
    end(value) {
      if (value) chunks.push(Buffer.from(value));
      this.headersSent = true;
      this.writableEnded = true;
    },
    destroy() { this.destroyed = true; },
    json() { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  };
}

test('malformed request targets return 400 instead of escaping async server handlers', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pebble-proxy-server-'));
  const app = createApplication({ DATA_DIR: dataDir, APP_SEED: 'server-test-seed', NODE_ENV: 'test' });
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  for (const server of [app.publicServer, app.adminServer]) {
    const handler = server.listeners('request')[0];
    const req = { method: 'GET', url: 'http://[::1', headers: {} };
    const res = captureResponse();
    await handler(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'invalid_url');
    assert.equal(res.destroyed, false);
  }
});
