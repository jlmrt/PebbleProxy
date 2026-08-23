import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';

import { HttpError } from './http.js';

const LOOPBACK_HOSTS = new Set(['localhost', 'localhost.localdomain']);
const BLOCKED_HOSTS = new Set([
  'host.docker.internal',
  'gateway.docker.internal',
  'metadata.google.internal'
]);
const DEFAULT_DNS_TIMEOUT_MS = 5_000;
const MAX_DNS_TIMEOUT_MS = 60_000;

function normalizeAddress(value) {
  let address = String(value || '').trim().toLowerCase();
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  const zone = address.indexOf('%');
  if (zone >= 0) address = address.slice(0, zone);
  return address;
}

function ipv4Number(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts.reduce((value, part) => value * 256 + part, 0);
}

function ipv6Number(address) {
  let source = normalizeAddress(address);
  if (net.isIP(source) !== 6) return null;

  if (source.includes('.')) {
    const separator = source.lastIndexOf(':');
    const embedded = ipv4Number(source.slice(separator + 1));
    if (embedded === null) return null;
    source = `${source.slice(0, separator)}:${Math.floor(embedded / 65_536).toString(16)}:${(embedded % 65_536).toString(16)}`;
  }

  let groups;
  if (source.includes('::')) {
    if (source.indexOf('::') !== source.lastIndexOf('::')) return null;
    const [leftText, rightText] = source.split('::');
    const left = leftText ? leftText.split(':') : [];
    const right = rightText ? rightText.split(':') : [];
    const omitted = 8 - left.length - right.length;
    if (omitted < 1) return null;
    groups = [...left, ...Array(omitted).fill('0'), ...right];
  } else {
    groups = source.split(':');
  }
  if (groups.length !== 8) return null;

  let result = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    result = (result << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return result;
}

function inIpv4Cidr(value, network, prefix) {
  const divisor = 2 ** (32 - prefix);
  return Math.floor(value / divisor) === Math.floor(network / divisor);
}

function inIpv6Cidr(value, network, prefix) {
  const shift = BigInt(128 - prefix);
  return (value >> shift) === (network >> shift);
}

function ipv4Ranges(definitions) {
  return definitions.map(([network, prefix]) => [ipv4Number(network), prefix]);
}

function ipv6Ranges(definitions) {
  return definitions.map(([network, prefix]) => [ipv6Number(network), prefix]);
}

const IPV4_INTERNAL = ipv4Ranges([
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16]
]);

const IPV4_SPECIAL = ipv4Ranges([
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
]);

const IPV6_ULA = ipv6Ranges([['fc00::', 7]]);
const IPV6_GLOBAL = ipv6Ranges([['2000::', 3]]);
const IPV6_SPECIAL = ipv6Ranges([
  ['::', 128],
  ['::1', 128],
  ['::', 96],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['2620:4f:8000::', 48],
  ['3fff::', 20],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8]
]);

function inRanges(value, ranges, matcher) {
  return ranges.some(([network, prefix]) => matcher(value, network, prefix));
}

function mappedIpv4(value) {
  if ((value >> 32n) !== 0xffffn) return null;
  return Number(value & 0xffff_ffffn);
}

function isIpv4Loopback(value) {
  return inIpv4Cidr(value, ipv4Number('127.0.0.0'), 8);
}

function isInternalAddress(address) {
  const normalized = normalizeAddress(address);
  const family = net.isIP(normalized);
  if (family === 4) {
    const value = ipv4Number(normalized);
    return inRanges(value, IPV4_INTERNAL, inIpv4Cidr);
  }
  if (family === 6) {
    const value = ipv6Number(normalized);
    const mapped = mappedIpv4(value);
    if (mapped !== null) return inRanges(mapped, IPV4_INTERNAL, inIpv4Cidr);
    return inRanges(value, IPV6_ULA, inIpv6Cidr);
  }
  return false;
}

function isLoopbackAddress(address) {
  const normalized = normalizeAddress(address);
  const family = net.isIP(normalized);
  if (family === 4) return isIpv4Loopback(ipv4Number(normalized));
  if (family !== 6) return false;
  const value = ipv6Number(normalized);
  if (value === 1n) return true;
  const mapped = mappedIpv4(value);
  return mapped !== null && isIpv4Loopback(mapped);
}

function isPublicAddress(address) {
  const normalized = normalizeAddress(address);
  const family = net.isIP(normalized);
  if (family === 4) {
    const value = ipv4Number(normalized);
    return !inRanges(value, IPV4_SPECIAL, inIpv4Cidr);
  }
  if (family === 6) {
    const value = ipv6Number(normalized);
    const mapped = mappedIpv4(value);
    if (mapped !== null) return !inRanges(mapped, IPV4_SPECIAL, inIpv4Cidr);
    return inRanges(value, IPV6_GLOBAL, inIpv6Cidr) && !inRanges(value, IPV6_SPECIAL, inIpv6Cidr);
  }
  return false;
}

export function isPrivateAddress(address) {
  return isInternalAddress(address);
}

function normalizedHostname(url) {
  return normalizeAddress(url.hostname).replace(/\.$/, '');
}

function assertAllowedHostname(hostname, allowLoopback) {
  if (BLOCKED_HOSTS.has(hostname)) throw new HttpError(400, 'unsafe_backend', 'Backend destination is not allowed');
  if (LOOPBACK_HOSTS.has(hostname)) {
    if (allowLoopback) return;
    throw new HttpError(400, 'unsafe_backend', 'Backend destination is not allowed');
  }
  if (hostname.endsWith('.localhost')) throw new HttpError(400, 'unsafe_backend', 'Backend destination is not allowed');
}

function assertAllowedAddress(address, { internal, allowLoopback }) {
  if (allowLoopback && isLoopbackAddress(address)) return;
  if (internal && isInternalAddress(address)) return;
  if (!internal && isPublicAddress(address)) return;
  throw new HttpError(
    400,
    'unsafe_backend',
    internal ? 'Internal backend must resolve to an RFC1918 or ULA address' : 'External backend cannot use a private or special address'
  );
}

function dnsTimeout(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isSafeInteger(parsed)) return DEFAULT_DNS_TIMEOUT_MS;
  return Math.max(1, Math.min(MAX_DNS_TIMEOUT_MS, parsed));
}

function abortReason(signal) {
  return signal?.reason || new DOMException('The operation was aborted', 'AbortError');
}

async function lookupAll(hostname, { signal, dnsTimeoutMs }, lookup) {
  if (signal?.aborted) throw abortReason(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortReason(signal));
    const timer = setTimeout(() => {
      finish(reject, new HttpError(504, 'backend_dns_timeout', 'Backend hostname resolution timed out'));
    }, dnsTimeout(dnsTimeoutMs));
    signal?.addEventListener('abort', onAbort, { once: true });

    Promise.resolve()
      .then(() => lookup(hostname, { all: true, verbatim: true }))
      .then(
        (records) => finish(resolve, records),
        () => finish(reject, new HttpError(503, 'backend_dns_failed', 'Backend hostname could not be resolved'))
      );
  });
}

function backendUrl(value) {
  let url;
  try { url = value instanceof URL ? new URL(value.href) : new URL(String(value)); }
  catch { throw new HttpError(400, 'invalid_backend_url', 'Backend URL is invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new HttpError(400, 'invalid_backend_url', 'Backend URL must use HTTP or HTTPS and cannot contain credentials');
  }
  return url;
}

/** Resolve and validate every result, then return one address that may be pinned to a socket. */
export async function resolveSafeBackendDestination(value, options = {}, dependencies = {}) {
  const url = backendUrl(value);
  const internal = options.internal !== false;
  const allowLoopback = options.allowLoopback === true;
  const hostname = normalizedHostname(url);
  assertAllowedHostname(hostname, allowLoopback);

  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    assertAllowedAddress(hostname, { internal, allowLoopback });
    return Object.freeze({ hostname, address: hostname, family: literalFamily });
  }

  const lookup = dependencies.lookup || dns.lookup;
  if (typeof lookup !== 'function') throw new TypeError('DNS lookup dependency must be a function');
  const records = await lookupAll(hostname, options, lookup);
  if (!Array.isArray(records) || records.length === 0) {
    throw new HttpError(503, 'backend_dns_failed', 'Backend hostname could not be resolved');
  }

  const safeRecords = records.map((record) => {
    const address = normalizeAddress(record?.address);
    const family = net.isIP(address);
    if (!family) throw new HttpError(503, 'backend_dns_failed', 'Backend hostname returned an invalid address');
    assertAllowedAddress(address, { internal, allowLoopback });
    return { address, family };
  });
  return Object.freeze({ hostname, ...safeRecords[0] });
}

export async function assertSafeBackendDestination(value, options = {}) {
  return resolveSafeBackendDestination(value, options);
}

export function parseBackendBaseUrl(value, { allowExternal = false, allowLoopback = false } = {}) {
  const url = backendUrl(value);
  if (url.search || url.hash) throw new HttpError(400, 'invalid_backend_url', 'Backend URL cannot include a query or a fragment');
  const hostname = normalizedHostname(url);
  try { assertAllowedHostname(hostname, allowLoopback); }
  catch { throw new HttpError(400, 'invalid_backend_url', 'Loopback and host-gateway destinations are not allowed'); }
  if (url.protocol === 'http:' && allowExternal) throw new HttpError(400, 'invalid_backend_url', 'External backends must use HTTPS');
  if (url.protocol === 'https:' && !allowExternal && !allowLoopback) {
    throw new HttpError(400, 'invalid_backend_url', 'Internal backends must use a private HTTP destination');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

export function validateEndpointPath(value, field = 'Endpoint path') {
  const path = String(value || '');
  let decoded;
  try { decoded = decodeURIComponent(path); }
  catch { throw new HttpError(400, 'invalid_backend_path', `${field} must be a fixed absolute path`); }
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(path)
    || decoded.split('/').includes('..')
    || /[\\\u0000]/.test(decoded)
    || decoded.includes('//')
    || path.includes('//')
    || path.includes('?')
    || path.includes('#')) {
    throw new HttpError(400, 'invalid_backend_path', `${field} must be a fixed absolute path`);
  }
  return path;
}

export function joinBackendUrl(baseUrl, endpointPath) {
  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/+$/, '');
  base.pathname = `${prefix}${validateEndpointPath(endpointPath)}` || '/';
  return base;
}

const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'expect',
  'host',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

function prepareRequest(url, init) {
  const method = String(init.method || 'GET').toUpperCase();
  const requestInit = { method, headers: init.headers, signal: init.signal };
  if (init.body !== undefined && init.body !== null) {
    requestInit.body = init.body;
    requestInit.duplex = 'half';
  }
  const request = new Request(url, requestInit);
  const headers = new Headers(request.headers);
  for (const name of HOP_BY_HOP_REQUEST_HEADERS) headers.delete(name);
  headers.set('Host', url.host);
  return { request, headers };
}

function pinnedLookup(resolution) {
  return (_hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    if (options?.all) return callback(null, [{ address: resolution.address, family: resolution.family }]);
    return callback(null, resolution.address, resolution.family);
  };
}

function responseHeaders(incoming) {
  const headers = new Headers();
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
  }
  return headers;
}

function requestOnce(url, prepared, resolution, init, requestImpl) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const requestOptions = {
      method: prepared.request.method,
      headers: Object.fromEntries(prepared.headers.entries()),
      lookup: pinnedLookup(resolution),
      family: resolution.family,
      autoSelectFamily: false,
      agent: false,
      signal: init.signal
    };
    if (net.isIP(resolution.hostname) === 0 && url.protocol === 'https:') requestOptions.servername = resolution.hostname;

    let outgoing;
    try {
      outgoing = requestImpl(url, requestOptions, (incoming) => {
        const status = Number(incoming.statusCode || 0);
        if (init.redirect === 'error' && status >= 300 && status < 400) {
          incoming.destroy();
          return finish(reject, new TypeError('Redirect response is not allowed'));
        }
        try {
          const hasBody = prepared.request.method !== 'HEAD' && ![204, 205, 304].includes(status);
          const body = hasBody ? Readable.toWeb(incoming) : null;
          const response = new Response(body, {
            status,
            statusText: incoming.statusMessage || '',
            headers: responseHeaders(incoming)
          });
          Object.defineProperty(response, 'url', { configurable: true, value: url.href });
          finish(resolve, response);
        } catch (error) {
          incoming.destroy(error);
          finish(reject, error);
        }
      });
    } catch (error) {
      return finish(reject, error);
    }
    outgoing.once('error', (error) => finish(reject, error));

    if (!prepared.request.body) {
      outgoing.end();
      return;
    }
    const body = Readable.fromWeb(prepared.request.body);
    body.once('error', (error) => outgoing.destroy(error));
    body.pipe(outgoing);
  });
}

/**
 * A fetch-like HTTP/1.1 client that validates DNS once and pins that exact IP.
 * Redirects are manual by default and `redirect: "follow"` is deliberately rejected.
 */
export function createSecureFetch(dependencies = {}) {
  const lookup = dependencies.lookup || dns.lookup;
  const httpRequest = dependencies.httpRequest || http.request;
  const httpsRequest = dependencies.httpsRequest || https.request;
  return async function secureFetch(value, init = {}, policy = {}) {
    if (init.redirect === 'follow') throw new TypeError('secureFetch does not follow redirects');
    if (init.redirect !== undefined && !['manual', 'error'].includes(init.redirect)) {
      throw new TypeError('redirect must be "manual" or "error"');
    }
    const url = backendUrl(value);
    if (url.hash) throw new HttpError(400, 'invalid_backend_url', 'Backend request URL cannot contain a fragment');
    if (init.signal?.aborted) throw abortReason(init.signal);
    const resolution = await resolveSafeBackendDestination(url, { ...policy, signal: init.signal }, { lookup });
    if (init.signal?.aborted) throw abortReason(init.signal);
    const prepared = prepareRequest(url, init);
    const requestImpl = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return requestOnce(url, prepared, resolution, { ...init, redirect: init.redirect || 'manual' }, requestImpl);
  };
}

export const secureFetch = createSecureFetch();

export function validateProviderInput(input = {}) {
  const type = String(input.type || 'generic');
  const supported = ['generic', 'openclaw-umbrel', 'hermes-umbrel'];
  if (!supported.includes(type)) throw new HttpError(400, 'invalid_provider_type', 'Unsupported backend type');
  const allowExternal = Boolean(input.allowExternal);
  const presets = {
    'openclaw-umbrel': {
      baseUrl: 'http://openclaw_gateway_1:18789', chatPath: '/v1/chat/completions', modelsPath: '/v1/models', healthPath: '/readyz'
    },
    'hermes-umbrel': {
      baseUrl: 'http://hermes-agent_web_1:8642', chatPath: '/p/pebble/v1/chat/completions', modelsPath: '/p/pebble/v1/models', healthPath: '/health'
    }
  };
  const preset = presets[type];
  const baseUrl = parseBackendBaseUrl(preset?.baseUrl || input.baseUrl, { allowExternal });
  const name = String(input.name || (type === 'generic' ? 'OpenAI-compatible backend' : type)).trim();
  if (!name || name.length > 100) throw new HttpError(400, 'invalid_provider_name', 'Backend name is required and must be at most 100 characters');
  return {
    name,
    type,
    baseUrl: baseUrl.toString().replace(/\/$/, ''),
    chatPath: validateEndpointPath(preset?.chatPath || input.chatPath || '/v1/chat/completions', 'Chat path'),
    modelsPath: validateEndpointPath(preset?.modelsPath || input.modelsPath || '/v1/models', 'Models path'),
    healthPath: validateEndpointPath(preset?.healthPath || input.healthPath || '/healthz', 'Health path'),
    credential: String(input.credential || ''),
    enabled: input.enabled !== false,
    config: { internal: !allowExternal, allowExternal }
  };
}

export function adminMutationAllowed(req) {
  const fetchSite = String(req.headers['sec-fetch-site'] || 'same-origin');
  const marker = req.headers['x-pebble-admin'];
  return marker === '1' && ['same-origin', 'same-site', 'none'].includes(fetchSite);
}
