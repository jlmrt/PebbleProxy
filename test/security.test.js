import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import {
  assertSafeBackendDestination,
  createSecureFetch,
  isPrivateAddress,
  joinBackendUrl,
  parseBackendBaseUrl,
  resolveSafeBackendDestination,
  validateEndpointPath,
  validateProviderInput
} from '../src/security.js';

function fakeTransport({ status = 200, responseBody = 'ok', responseHeaders = ['Content-Type', 'text/plain'] } = {}) {
  const calls = [];
  const request = (url, options, onResponse) => {
    const chunks = [];
    const outgoing = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      }
    });
    calls.push({ url, options, chunks });
    outgoing.once('finish', () => {
      const incoming = new PassThrough();
      incoming.statusCode = status;
      incoming.statusMessage = status === 200 ? 'OK' : 'Found';
      incoming.rawHeaders = responseHeaders;
      queueMicrotask(() => {
        onResponse(incoming);
        if (!incoming.destroyed) incoming.end(responseBody);
      });
    });
    return outgoing;
  };
  return { calls, request };
}

test('backend URL policy blocks ambiguous and host-gateway destinations', () => {
  assert.throws(() => parseBackendBaseUrl('http://localhost:8080'), (error) => error.code === 'invalid_backend_url');
  assert.throws(() => parseBackendBaseUrl('http://host.docker.internal:8080'), (error) => error.code === 'invalid_backend_url');
  assert.throws(() => parseBackendBaseUrl('http://user:pass@localai_api_1:8080'), (error) => error.code === 'invalid_backend_url');
  assert.throws(() => parseBackendBaseUrl('http://localai_api_1:8080?next=http://evil.example'), (error) => error.code === 'invalid_backend_url');
  assert.throws(() => parseBackendBaseUrl('http://api.example.com', { allowExternal: true }), (error) => error.code === 'invalid_backend_url');
  assert.equal(parseBackendBaseUrl('http://localai_api_1:8080').hostname, 'localai_api_1');
  assert.equal(parseBackendBaseUrl('https://api.example.com', { allowExternal: true }).hostname, 'api.example.com');
});

test('Umbrel presets ignore supplied destinations and use fixed paths', () => {
  const openclaw = validateProviderInput({ type: 'openclaw-umbrel', name: 'OpenClaw', baseUrl: 'https://evil.example' });
  assert.equal(openclaw.baseUrl, 'http://openclaw_gateway_1:18789');
  assert.equal(joinBackendUrl(openclaw.baseUrl, openclaw.chatPath).href, 'http://openclaw_gateway_1:18789/v1/chat/completions');

  const hermes = validateProviderInput({ type: 'hermes-umbrel', name: 'Hermes', chatPath: '/admin' });
  assert.equal(joinBackendUrl(hermes.baseUrl, hermes.chatPath).href, 'http://hermes-agent_web_1:8642/p/pebble/v1/chat/completions');
});

test('private IP classification excludes link-local and unspecified ranges', () => {
  assert.equal(isPrivateAddress('10.0.0.2'), true);
  assert.equal(isPrivateAddress('172.18.0.4'), true);
  assert.equal(isPrivateAddress('192.168.1.10'), true);
  assert.equal(isPrivateAddress('169.254.169.254'), false);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('fd00::10'), true);
  assert.equal(isPrivateAddress('::ffff:10.0.0.2'), true);
  assert.equal(isPrivateAddress('fe80::1'), false);
});

test('destination policy allows only RFC1918 or ULA internally and globally routable addresses externally', async () => {
  for (const value of [
    'http://10.0.0.2',
    'http://172.31.255.254',
    'http://192.168.10.20',
    'http://[fd00::10]',
    'http://[::ffff:10.0.0.2]'
  ]) {
    await assert.doesNotReject(assertSafeBackendDestination(new URL(value), { internal: true }));
  }
  for (const value of ['http://127.0.0.1', 'http://[::1]', 'http://[::ffff:127.0.0.1]']) {
    await assert.doesNotReject(assertSafeBackendDestination(new URL(value), { internal: true, allowLoopback: true }));
  }
  for (const value of ['https://8.8.8.8', 'https://[2606:4700:4700::1111]']) {
    await assert.doesNotReject(assertSafeBackendDestination(new URL(value), { internal: false }));
  }

  const blockedExternal = [
    'https://10.0.0.1',
    'https://100.64.0.1',
    'https://127.0.0.1',
    'https://169.254.169.254',
    'https://192.0.2.1',
    'https://198.18.0.1',
    'https://203.0.113.1',
    'https://224.0.0.1',
    'https://[::1]',
    'https://[::ffff:169.254.169.254]',
    'https://[64:ff9b::a00:1]',
    'https://[2001:db8::1]',
    'https://[fc00::1]',
    'https://[fe80::1]'
  ];
  for (const value of blockedExternal) {
    await assert.rejects(
      assertSafeBackendDestination(new URL(value), { internal: false }),
      (error) => error.code === 'unsafe_backend',
      value
    );
  }
});

test('DNS validation rejects mixed answers and is bounded by abort and timeout', async () => {
  const privateLookup = async () => [
    { address: '10.20.30.40', family: 4 },
    { address: 'fd00::20', family: 6 }
  ];
  const resolved = await resolveSafeBackendDestination(
    'http://umbrel-service.test/path',
    { internal: true },
    { lookup: privateLookup }
  );
  assert.deepEqual(resolved, { hostname: 'umbrel-service.test', address: '10.20.30.40', family: 4 });

  await assert.rejects(
    resolveSafeBackendDestination(
      'https://provider.example/path',
      { internal: false },
      { lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }] }
    ),
    (error) => error.code === 'unsafe_backend'
  );

  const neverLookup = () => new Promise(() => {});
  const neverRequest = () => { throw new Error('request must not start'); };
  const secureFetch = createSecureFetch({ lookup: neverLookup, httpRequest: neverRequest });
  await assert.rejects(
    secureFetch('http://slow-dns.test/path', {}, { internal: true, dnsTimeoutMs: 5 }),
    (error) => error.code === 'backend_dns_timeout'
  );

  const controller = new AbortController();
  const aborted = secureFetch(
    'http://slow-dns.test/path',
    { signal: controller.signal },
    { internal: true, dnsTimeoutMs: 1_000 }
  );
  controller.abort(new DOMException('cancelled', 'AbortError'));
  await assert.rejects(aborted, (error) => error.name === 'AbortError');
});

test('secureFetch pins the validated address while preserving Host, TLS SNI, and FormData', async () => {
  let dnsCalls = 0;
  const transport = fakeTransport({ responseBody: '{"ok":true}', responseHeaders: ['Content-Type', 'application/json'] });
  const secureFetch = createSecureFetch({
    lookup: async () => {
      dnsCalls += 1;
      return [{ address: '93.184.216.34', family: 4 }];
    },
    httpsRequest: transport.request
  });
  const form = new FormData();
  form.append('model', 'whisper-1');
  form.append('file', new Blob(['audio-bytes'], { type: 'audio/mp4' }), 'voice.m4a');

  const response = await secureFetch('https://provider.example:8443/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Host: 'attacker.example', Connection: 'keep-alive', 'X-Test': 'kept' },
    body: form,
    redirect: 'manual'
  }, { internal: false });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.url, 'https://provider.example:8443/v1/audio/transcriptions');
  assert.equal(dnsCalls, 1);
  assert.equal(transport.calls.length, 1);

  const call = transport.calls[0];
  assert.equal(call.options.headers.host, 'provider.example:8443');
  assert.equal(call.options.headers.connection, undefined);
  assert.equal(call.options.headers['x-test'], 'kept');
  assert.match(call.options.headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.equal(call.options.servername, 'provider.example');
  assert.equal(call.options.agent, false);
  const pinned = await new Promise((resolve, reject) => {
    call.options.lookup('provider.example', {}, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
  assert.deepEqual(pinned, { address: '93.184.216.34', family: 4 });
  assert.equal(dnsCalls, 1, 'the socket lookup must not resolve DNS again');

  const encoded = Buffer.concat(call.chunks).toString('utf8');
  assert.match(encoded, /name="model"/);
  assert.match(encoded, /whisper-1/);
  assert.match(encoded, /filename="voice.m4a"/);
  assert.match(encoded, /audio-bytes/);
});

test('secureFetch never follows redirects', async () => {
  const transport = fakeTransport({ status: 302, responseHeaders: ['Location', 'http://169.254.169.254/latest'] });
  const secureFetch = createSecureFetch({
    lookup: async () => [{ address: '10.10.0.5', family: 4 }],
    httpRequest: transport.request
  });

  const manual = await secureFetch('http://service.internal/start', { redirect: 'manual' }, { internal: true });
  assert.equal(manual.status, 302);
  assert.equal(manual.headers.get('location'), 'http://169.254.169.254/latest');
  await manual.text();

  await assert.rejects(
    secureFetch('http://service.internal/start', { redirect: 'error' }, { internal: true }),
    /Redirect response is not allowed/
  );
  await assert.rejects(
    secureFetch('http://service.internal/start', { redirect: 'follow' }, { internal: true }),
    /does not follow redirects/
  );
  assert.equal(transport.calls.length, 2);
});

test('endpoint paths reject encoded traversal and separators', () => {
  assert.equal(validateEndpointPath('/v1/chat/completions'), '/v1/chat/completions');
  for (const value of ['/%2e%2e/admin', '/safe/%2Fadmin', '/safe/%5cadmin', '/safe/%00admin']) {
    assert.throws(() => validateEndpointPath(value), (error) => error.code === 'invalid_backend_path');
  }
});
