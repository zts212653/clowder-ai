import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
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
