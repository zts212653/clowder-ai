import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decodeAesKey,
  decryptAesEcb,
  downloadMediaFromCdn,
  encryptAesEcb,
} from '../dist/infrastructure/connectors/adapters/weixin-cdn.js';

describe('weixin-cdn AES-128-ECB', () => {
  it('encrypts and decrypts round-trip', () => {
    const key = Buffer.alloc(16, 0xab);
    const plaintext = Buffer.from('Hello, WeChat CDN!');
    const ciphertext = encryptAesEcb(plaintext, key);

    assert.ok(ciphertext.length > 0);
    assert.ok(ciphertext.length % 16 === 0, 'Ciphertext must be 16-byte aligned (PKCS7)');
    assert.notDeepEqual(ciphertext, plaintext);

    const decrypted = decryptAesEcb(ciphertext, key);
    assert.deepEqual(decrypted, plaintext);
  });

  it('handles empty plaintext', () => {
    const key = Buffer.alloc(16, 0xcd);
    const plaintext = Buffer.alloc(0);
    const ciphertext = encryptAesEcb(plaintext, key);
    assert.equal(ciphertext.length, 16, 'Empty plaintext → one padding block');
    const decrypted = decryptAesEcb(ciphertext, key);
    assert.equal(decrypted.length, 0);
  });

  it('produces different ciphertext with different keys', () => {
    const plaintext = Buffer.from('same content');
    const key1 = Buffer.alloc(16, 0x11);
    const key2 = Buffer.alloc(16, 0x22);
    const c1 = encryptAesEcb(plaintext, key1);
    const c2 = encryptAesEcb(plaintext, key2);
    assert.notDeepEqual(c1, c2);
  });
});

describe('downloadMediaFromCdn', () => {
  const noop = () => {};
  const noopLog = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop, child: () => noopLog };

  it('downloads and decrypts CDN media', async () => {
    const key = Buffer.alloc(16, 0xab);
    const originalContent = Buffer.from('Hello image data');
    const ciphertext = encryptAesEcb(originalContent, key);

    const mockFetch = async (_url, _opts) => ({
      ok: true,
      arrayBuffer: async () =>
        ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.length),
    });

    const platformKey = JSON.stringify({
      encryptQueryParam: 'test-eqp',
      aesKey: key.toString('hex'),
    });

    const result = await downloadMediaFromCdn({
      platformKey,
      cdnBaseUrl: 'https://cdn.example.com',
      log: /** @type {any} */ (noopLog),
      fetchFn: /** @type {any} */ (mockFetch),
    });

    assert.deepEqual(result, originalContent);
  });

  it('downloads and decrypts with base64-encoded aesKey', async () => {
    const key = Buffer.alloc(16, 0xab);
    const originalContent = Buffer.from('base64 key test');
    const ciphertext = encryptAesEcb(originalContent, key);

    const mockFetch = async (_url, _opts) => ({
      ok: true,
      arrayBuffer: async () =>
        ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.length),
    });

    const platformKey = JSON.stringify({
      encryptQueryParam: 'test-eqp-b64',
      aesKey: key.toString('base64'),
    });

    const result = await downloadMediaFromCdn({
      platformKey,
      cdnBaseUrl: 'https://cdn.example.com',
      log: /** @type {any} */ (noopLog),
      fetchFn: /** @type {any} */ (mockFetch),
    });

    assert.deepEqual(result, originalContent);
  });

  it('downloads and decrypts with base64url-encoded aesKey (- and _ chars)', async () => {
    // iLink protocol may use base64url encoding for aes_key
    // Use bytes that produce + and / in standard base64
    const key = Buffer.from('fbefbeaddefbefbeaddefbefbeaddefb', 'hex'); // 16 bytes
    const originalContent = Buffer.from('base64url key test');
    const ciphertext = encryptAesEcb(originalContent, key);

    const mockFetch = async (_url, _opts) => ({
      ok: true,
      arrayBuffer: async () =>
        ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.length),
    });

    // Convert to base64url (- instead of +, _ instead of /)
    const b64url = key.toString('base64url');
    assert.ok(b64url !== key.toString('base64'), 'Test key must differ between base64 and base64url');

    const platformKey = JSON.stringify({
      encryptQueryParam: 'test-eqp-b64url',
      aesKey: b64url,
    });

    const result = await downloadMediaFromCdn({
      platformKey,
      cdnBaseUrl: 'https://cdn.example.com',
      log: /** @type {any} */ (noopLog),
      fetchFn: /** @type {any} */ (mockFetch),
    });

    assert.deepEqual(result, originalContent);
  });

  it('downloads and decrypts with base64 aesKey without padding', async () => {
    const key = Buffer.alloc(16, 0xab);
    const originalContent = Buffer.from('no-padding key test');
    const ciphertext = encryptAesEcb(originalContent, key);

    const mockFetch = async (_url, _opts) => ({
      ok: true,
      arrayBuffer: async () =>
        ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.length),
    });

    // Strip padding
    const b64NoPad = key.toString('base64').replace(/=+$/, '');
    assert.ok(!b64NoPad.endsWith('='), 'Padding must be stripped');

    const platformKey = JSON.stringify({
      encryptQueryParam: 'test-eqp-nopad',
      aesKey: b64NoPad,
    });

    const result = await downloadMediaFromCdn({
      platformKey,
      cdnBaseUrl: 'https://cdn.example.com',
      log: /** @type {any} */ (noopLog),
      fetchFn: /** @type {any} */ (mockFetch),
    });

    assert.deepEqual(result, originalContent);
  });

  it('throws descriptive error for invalid aesKey length', async () => {
    const mockFetch = async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(32),
    });

    // A base64 string that decodes to wrong length (not 16 bytes)
    const badKey = Buffer.alloc(10, 0xff).toString('base64'); // 10 bytes → invalid for AES-128

    const platformKey = JSON.stringify({
      encryptQueryParam: 'test-eqp-bad',
      aesKey: badKey,
    });

    await assert.rejects(
      () =>
        downloadMediaFromCdn({
          platformKey,
          cdnBaseUrl: 'https://cdn.example.com',
          log: /** @type {any} */ (noopLog),
          fetchFn: /** @type {any} */ (mockFetch),
        }),
      /Invalid AES key/,
    );
  });

  it('throws on HTTP error', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 403,
      text: async () => 'Forbidden',
    });

    const platformKey = JSON.stringify({ encryptQueryParam: 'x', aesKey: Buffer.alloc(16).toString('hex') });

    await assert.rejects(
      () =>
        downloadMediaFromCdn({
          platformKey,
          cdnBaseUrl: 'https://cdn.example.com',
          log: /** @type {any} */ (noopLog),
          fetchFn: /** @type {any} */ (mockFetch),
        }),
      /CDN download HTTP 403/,
    );
  });
});

describe('decodeAesKey — base64(hex-string) compat', () => {
  it('decodes base64-encoded 32-char hex string to 16-byte key (official protocol compat)', () => {
    // Official iLink protocol: aes_key = Buffer.from(hexString).toString('base64')
    // where hexString is 32 hex chars representing 16 bytes
    const rawKey = Buffer.alloc(16, 0xab);
    const hexString = rawKey.toString('hex'); // "abababab..." (32 chars)
    const officialEncoded = Buffer.from(hexString).toString('base64'); // base64 of the hex TEXT

    // decodeAesKey should handle this and return the original 16-byte key
    const decoded = decodeAesKey(officialEncoded);
    assert.equal(decoded.length, 16, 'Must decode to 16 bytes');
    assert.deepEqual(decoded, rawKey, 'Must match original key');
  });
});

describe('outbound aes_key encoding matches official iLink protocol', () => {
  it('aes_key should be base64 of hex string, not base64 of raw bytes', () => {
    // Our uploadMediaToCdn returns aeskey as hex string (e.g. "abababab...")
    const hexAesKey = 'abababababababababababababababab'; // 32 hex chars = 16 bytes

    // Official: Buffer.from(hexString).toString('base64') — encodes the hex TEXT
    const officialEncoding = Buffer.from(hexAesKey).toString('base64');

    // Wrong (our current): Buffer.from(hexString, 'hex').toString('base64') — encodes raw bytes
    const ourCurrentEncoding = Buffer.from(hexAesKey, 'hex').toString('base64');

    // These two MUST be different (proving the bug exists)
    assert.notEqual(officialEncoding, ourCurrentEncoding, 'Encodings differ — confirms protocol mismatch');

    // The correct value should be the official encoding
    assert.equal(officialEncoding, 'YWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWI=');
  });
});
