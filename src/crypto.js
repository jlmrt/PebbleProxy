import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function loadOrCreateKey(dataDir) {
  const keyPath = path.join(dataDir, 'master.key');
  try {
    return fs.readFileSync(keyPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const key = crypto.randomBytes(32);
  try {
    const fd = fs.openSync(keyPath, 'wx', 0o600);
    try { fs.writeFileSync(fd, key); } finally { fs.closeSync(fd); }
    return key;
  } catch (error) {
    if (error.code === 'EEXIST') return fs.readFileSync(keyPath);
    throw error;
  }
}

export function createCryptoService({ dataDir, appSeed }) {
  const masterKey = appSeed
    ? Buffer.from(crypto.hkdfSync('sha256', Buffer.from(appSeed), Buffer.from('pebble-proxy'), Buffer.from('credential-encryption-v1'), 32))
    : loadOrCreateKey(dataDir);
  const tokenKey = Buffer.from(crypto.hkdfSync('sha256', masterKey, Buffer.from('pebble-proxy'), Buffer.from('device-token-v1'), 32));
  const sessionKey = Buffer.from(crypto.hkdfSync('sha256', masterKey, Buffer.from('pebble-proxy'), Buffer.from('session-v1'), 32));

  return Object.freeze({
    encrypt(value) {
      if (!value) return null;
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
      const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
    },

    decrypt(box) {
      if (!box) return '';
      const [version, ivText, tagText, encryptedText] = String(box).split('.');
      if (version !== 'v1' || !ivText || !tagText || !encryptedText) throw new Error('Unsupported encrypted value');
      const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, Buffer.from(ivText, 'base64url'));
      decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64url')), decipher.final()]).toString('utf8');
    },

    createDeviceToken() {
      const id = crypto.randomBytes(8).toString('hex');
      const secret = crypto.randomBytes(32).toString('base64url');
      const token = `pp_${id}_${secret}`;
      return { id, token, prefix: `pp_${id}`, hash: this.hashToken(token) };
    },

    hashToken(token) {
      return crypto.createHmac('sha256', tokenKey).update(String(token)).digest('base64url');
    },

    verifyToken(token, expectedHash) {
      const actual = Buffer.from(this.hashToken(token));
      const expected = Buffer.from(String(expectedHash));
      return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    },

    sessionId(...parts) {
      return `pps_${crypto.createHmac('sha256', sessionKey).update(parts.join('\u0000')).digest('base64url').slice(0, 40)}`;
    },

    hashHint(value) {
      return crypto.createHmac('sha256', sessionKey).update(String(value)).digest('base64url');
    }
  });
}
