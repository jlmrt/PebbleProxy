import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../src/db.js';
import { createCryptoService } from '../src/crypto.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const required = [
  'Dockerfile', 'docker-compose.yml', 'umbrel-app.yml', 'exports.sh',
  'data/.gitkeep', 'hooks/pre-start', 'icon.svg',
  'src/server.js', 'src/ai.js', 'src/recordings.js', 'src/mcp.js', 'src/actions.js', 'src/processing.js',
  'needle-sidecar/Dockerfile', 'needle-sidecar/server.py', 'needle-sidecar/fetch_engine.py', 'needle-sidecar/requirements.txt',
  'web/index.html', 'web/app.js', 'web/clipboard.js', 'web/styles.css'
];
for (const relative of required) assert.ok(fs.existsSync(path.join(root, relative)), `Missing ${relative}`);

const javascript = ['src', 'web'].flatMap((directory) => fs.readdirSync(path.join(root, directory))
  .filter((name) => name.endsWith('.js'))
  .map((name) => path.join(root, directory, name)));
for (const file of javascript) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || `Syntax check failed for ${file}`);
}

const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
const manifest = fs.readFileSync(path.join(root, 'umbrel-app.yml'), 'utf8');
const manifestId = manifest.match(/^id:\s*([a-z0-9-]+)$/m)?.[1];
const renderComposeDefaults = (source, environment = {}) => source.replace(
  /\$\{([A-Z0-9_]+):-([^}]*)\}/g,
  (_match, name, fallback) => environment[name] || fallback
);
assert.match(compose, /APP_HOST:\s*\$\{APP_ID:-pebble-proxy\}_admin_1/);
assert.match(compose, /UMBREL_APP_ID:\s*\$\{APP_ID:-pebble-proxy\}/);
assert.match(renderComposeDefaults(compose, { APP_ID: 'jlmrt-pebble-proxy' }), /APP_HOST:\s*jlmrt-pebble-proxy_admin_1/);
assert.match(renderComposeDefaults(compose, { APP_ID: 'another-store-pebble-proxy' }), /APP_HOST:\s*another-store-pebble-proxy_admin_1/);
assert.match(renderComposeDefaults(compose), /APP_HOST:\s*pebble-proxy_admin_1/);
assert.equal(manifestId, 'pebble-proxy');
assert.match(renderComposeDefaults(compose, { APP_ID: manifestId }), new RegExp(`APP_HOST:\\s*${manifestId}_admin_1`));
assert.match(compose, /ROLE:\s*public/);
assert.match(compose, /ROLE:\s*admin/);
assert.match(compose, /admin_internal:\s*\n\s*internal:\s*true/);
assert.match(compose, /processing_internal:\s*\n\s*internal:\s*true/);
assert.match(compose, /NEEDLE_ROUTER_URL:\s*http:\/\/needle:8090/);
assert.match(compose, /admin:[\s\S]*?networks:\s*\n\s*-\s*admin_internal\s*\n\s*-\s*processing_internal/,
  'The private admin service must reach Needle for health checks');
assert.match(compose, /NEEDLE_TELEMETRY:\s*["']0["']/);
assert.match(compose, /HF_HUB_OFFLINE:\s*["']1["']/);
assert.doesNotMatch(compose, /^\s+ports:\s*$/m, 'Pebble Proxy must not publish a raw host port');
assert.match(compose, /PUBLIC_PORT:\s*8080[\s\S]*?expose:\s*\n\s*-\s*["']8080["']/,
  'Public API port 8080 must remain Docker-network-only');
assert.match(manifest, /^port:\s*9432$/m, 'Umbrel admin launcher must stay on its assigned host port');
assert.match(manifest, /^version:\s*["']0\.1\.0-test\.10["']$/m);
assert.match(manifest, /^icon:\s*https:\/\/raw\.githubusercontent\.com\/jlmrt\/PebbleProxy\/main\/icon\.svg$/m,
  'Community-store manifests need an absolute HTTPS icon URL');

const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
const browserScript = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');
const browserStyles = fs.readFileSync(path.join(root, 'web/styles.css'), 'utf8');
assert.match(html, /id="pebble-webhook-url"/);
assert.match(html, /id="page-setup"/);
assert.match(html, /X-Widget-Token/);
assert.match(html, /id="processing-form"/);
assert.match(html, /Custom header → Name/);
assert.match(html, /umbrel\.local:9432<\/code>[\s\S]*?Do not tunnel this for Pebble clients/);
assert.match(html, /id="tts-form"/);
assert.match(html, /id="new-device-token"[^>]*readonly/);
assert.match(html, /src="\/clipboard\.js/);
assert.match(browserScript, /PebbleClipboard\.copyText/);
assert.match(html, /name="deviceType" value="index"/);
assert.match(html, /name="connectionType" value="webhook"/);
assert.match(html, /name="connectionType" value="mcp"/);
assert.match(html, /Streamable HTTP/);
assert.match(html, /id="new-device-authorization-value"/);
assert.match(html, /id="connection-form"/);
assert.match(browserScript, /api\("\/device-groups"\)/);
assert.match(browserScript, /body\.connectionType = plainText\(data\.get\("connectionType"\), "webhook"\)/);
assert.match(browserScript, /Pebble Index custom MCP server/);
assert.match(browserScript, /\["proxy_decision"\]/);
assert.match(browserScript, /Raw router response/);
assert.match(html, /id="setup-cloudflare-target"[^>]*placeholder="Loading from Pebble Proxy"[^>]*>[\s\S]*?data-copy-target="setup-cloudflare-target" disabled/);
assert.match(html, /id="cloudflare-service-url"[^>]*placeholder="Loading from Pebble Proxy"[^>]*>[\s\S]*?data-copy-target="cloudflare-service-url" disabled/);
assert.match(browserScript, /\["serviceUrl", "service_url", "publicTarget", "public_target"\], ""/);
for (const [name, source] of [['web/index.html', html], ['web/app.js', browserScript]]) {
  assert.doesNotMatch(source, /(?:jlmrt-)?pebble-proxy_(?:admin|api)_1/, `${name} must not hardcode an installed container address`);
}
assert.match(browserStyles, /font-size:\s*max\(1rem, 16px\)/,
  'Editable controls need a 16px iOS Safari font-size floor');
for (const id of ['device-form', 'connection-form', 'backend-form', 'alias-form', 'note-form', 'reminder-form']) {
  const form = html.match(new RegExp(`<form[^>]+id="${id}"[\\s\\S]*?<\\/form>`))?.[0] || '';
  const controls = form.match(/<button\b[^>]*\bdata-dialog-dismiss\b[^>]*>/g) || [];
  assert.equal(controls.length, 2, `${id} must have two dialog dismiss controls`);
  for (const control of controls) {
    assert.match(control, /\btype="button"/, `${id} dismiss controls must not submit the form`);
  }
}
assert.doesNotMatch(html, /<button\b[^>]*\bvalue="cancel"[^>]*>/,
  'Dialog dismissal must not depend on submit validation');
const fixedFontSizes = [...browserStyles.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)]
  .map((match) => Number(match[1]));
assert.ok(Math.min(...fixedFontSizes) >= 12, 'Fixed text must remain at least 12px');
assert.match(browserStyles, /\.panel small,[\s\S]*?font-size:\s*14px/,
  'Secondary interface copy must remain readable inside the Umbrel app frame');

function exportedApiAddress(exportsAppId) {
  const result = spawnSync('bash', ['-c', 'set -u; source "$1"; printf "%s\\n%s\\n" "$APP_PEBBLE_PROXY_API_HOST" "$APP_PEBBLE_PROXY_API_URL"', 'bash', path.join(root, 'exports.sh')], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH || '', EXPORTS_APP_ID: exportsAppId }
  });
  assert.equal(result.status, 0, result.stderr || 'Failed to source exports.sh');
  return result.stdout.trim().split('\n');
}

for (const appId of ['jlmrt-pebble-proxy', 'another-store-pebble-proxy', '']) {
  const expectedId = appId || 'pebble-proxy';
  assert.deepEqual(exportedApiAddress(appId), [
    `${expectedId}_api_1`,
    `http://${expectedId}_api_1:8080`
  ]);
}
assert.deepEqual(exportedApiAddress('INVALID'), [
  'pebble-proxy_api_1',
  'http://pebble-proxy_api_1:8080'
]);

const preStart = path.join(root, 'hooks/pre-start');
assert.ok(fs.statSync(preStart).mode & 0o111, 'Umbrel pre-start hook must be executable');
const hookSyntax = spawnSync('bash', ['-n', preStart], { encoding: 'utf8' });
assert.equal(hookSyntax.status, 0, hookSyntax.stderr || 'Umbrel pre-start hook syntax check failed');
const hook = fs.readFileSync(preStart, 'utf8');
assert.match(hook, /mkdir -p/);
assert.match(hook, /chown 1000:1000/);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pebble-proxy-check-'));
try {
  const db = createDatabase(path.join(temporary, 'check.sqlite'));
  const cryptoService = createCryptoService({ dataDir: temporary, appSeed: 'check-only-seed' });
  const boxed = cryptoService.encrypt('secret');
  assert.equal(cryptoService.decrypt(boxed), 'secret');
  assert.ok(db.prepare("SELECT id FROM agent_profiles WHERE id = 'pebble'").get());
  assert.ok(db.prepare('SELECT id FROM stt_config WHERE id = 1').get());
  assert.ok(db.prepare('SELECT id FROM tts_config WHERE id = 1').get());
  assert.ok(db.prepare('SELECT id FROM processing_config WHERE id = 1').get());
  db.close();
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log(`Pebble Proxy checks passed (${javascript.length} source modules).`);
