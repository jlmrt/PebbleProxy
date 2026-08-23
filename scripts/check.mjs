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
  'src/server.js', 'src/ai.js', 'src/recordings.js', 'src/mcp.js',
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
assert.match(compose, /APP_HOST:\s*pebble-proxy_admin_1/);
assert.match(compose, /ROLE:\s*public/);
assert.match(compose, /ROLE:\s*admin/);
assert.match(compose, /admin_internal:\s*\n\s*internal:\s*true/);
assert.doesNotMatch(compose, /ports:\s*\n\s*-\s*["']?8080:/, 'Public API must not bind a host port in the Umbrel package');
assert.match(manifest, /^port:\s*9432$/m, 'Umbrel app port must match the audited public port');
assert.match(manifest, /^version:\s*["']0\.1\.0-test\.3["']$/m);
assert.match(manifest, /^icon:\s*https:\/\/raw\.githubusercontent\.com\/jlmrt\/PebbleProxy\/main\/icon\.svg$/m,
  'Community-store manifests need an absolute HTTPS icon URL');

const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
const browserScript = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');
const browserStyles = fs.readFileSync(path.join(root, 'web/styles.css'), 'utf8');
assert.match(html, /id="pebble-webhook-url"/);
assert.match(html, /Authorization<\/code> with the value <code>Bearer &lt;one-time device token&gt;/);
assert.match(html, /id="new-device-token"[^>]*readonly/);
assert.match(html, /src="\/clipboard\.js/);
assert.match(browserScript, /PebbleClipboard\.copyText/);
assert.match(browserStyles, /font-size:\s*max\(1rem, 16px\)/,
  'Editable controls need a 16px iOS Safari font-size floor');

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
  db.close();
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log(`Pebble Proxy checks passed (${javascript.length} source modules).`);
