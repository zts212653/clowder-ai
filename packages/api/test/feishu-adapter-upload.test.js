import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, mock, test } from 'node:test';

import { FeishuAdapter } from '../dist/infrastructure/connectors/adapters/FeishuAdapter.js';
import { FeishuTokenManager } from '../dist/infrastructure/connectors/adapters/FeishuTokenManager.js';

const TMP = join(tmpdir(), 'feishu-upload-test');

/** Create a minimal valid WAV file (44-byte header + 160 bytes silence = 0.01s mono 16kHz) */
function createMinimalWav() {
  const sampleRate = 16000;
  const numSamples = 160; // 0.01s
  const dataSize = numSamples * 2; // 16-bit = 2 bytes per sample
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  // samples are all zeros (silence)
  return buf;
}

/** Check if ffmpeg is available on this machine */
let ffmpegAvailable = false;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  ffmpegAvailable = true;
} catch {
  ffmpegAvailable = false;
}

describe('FeishuAdapter sendMedia with upload', () => {
  /** @type {ReturnType<typeof mock.fn>} */
  let sendMessageCalls;
  /** @type {FeishuAdapter} */
  let adapter;
  /** @type {ReturnType<typeof mock.fn>} */
  let mockUploadFetch;

  beforeEach(async () => {
    await mkdir(TMP, { recursive: true });

    sendMessageCalls = mock.fn(() => Promise.resolve({}));

    // Mock fetch for both token + upload
    mockUploadFetch = mock.fn((/** @type {string} */ url) => {
      if (url.includes('/auth/v3/tenant_access_token')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ tenant_access_token: 'tok-test', expire: 7200 }),
        });
      }
      if (url.includes('/im/v1/images')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { image_key: 'img_uploaded_123' } }),
        });
      }
      if (url.includes('/im/v1/files')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { file_key: 'file_uploaded_456' } }),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    const tokenManager = new FeishuTokenManager({
      appId: 'app1',
      appSecret: 'sec1',
      fetchFn: /** @type {any} */ (mockUploadFetch),
    });

    adapter = new FeishuAdapter(
      'app1',
      'sec1',
      /** @type {any} */ ({
        info: () => {},
        error: () => {},
        warn: () => {},
        debug: () => {},
        child: () => /** @type {any} */ ({}),
      }),
    );
    adapter._injectSendMessage(sendMessageCalls);
    adapter._injectTokenManager(tokenManager);
    adapter._injectUploadFetch(/** @type {any} */ (mockUploadFetch));
  });

  test('uploads image via /im/v1/images when absPath provided', async () => {
    const imgPath = join(TMP, 'test-img.jpg');
    await writeFile(imgPath, Buffer.from('fake-jpg-data'));

    await adapter.sendMedia('chat_123', {
      type: 'image',
      url: '/api/connector-media/test-img.jpg',
      absPath: imgPath,
    });

    // Should have called upload API
    const uploadCalls = mockUploadFetch.mock.calls.filter(
      (c) => typeof c.arguments[0] === 'string' && c.arguments[0].includes('/im/v1/images'),
    );
    assert.equal(uploadCalls.length, 1);

    // Should send native image message with uploaded key
    assert.equal(sendMessageCalls.mock.calls.length, 1);
    const sentParams = sendMessageCalls.mock.calls[0].arguments[0];
    assert.equal(sentParams.msgType, 'image');
    const content = JSON.parse(sentParams.content);
    assert.equal(content.image_key, 'img_uploaded_123');
  });

  test('uploads audio via /im/v1/files when absPath provided', async () => {
    const audioPath = join(TMP, 'test-audio.opus');
    await writeFile(audioPath, Buffer.from('fake-audio-data'));

    await adapter.sendMedia('chat_123', {
      type: 'audio',
      url: '/api/tts/audio/test-audio.opus',
      absPath: audioPath,
    });

    const uploadCalls = mockUploadFetch.mock.calls.filter(
      (c) => typeof c.arguments[0] === 'string' && c.arguments[0].includes('/im/v1/files'),
    );
    assert.equal(uploadCalls.length, 1);

    assert.equal(sendMessageCalls.mock.calls.length, 1);
    const sentParams = sendMessageCalls.mock.calls[0].arguments[0];
    assert.equal(sentParams.msgType, 'audio');
    const content = JSON.parse(sentParams.content);
    assert.equal(content.file_key, 'file_uploaded_456');
  });

  test('falls back to text link when no tokenManager', async () => {
    // Create adapter WITHOUT tokenManager
    const plainAdapter = new FeishuAdapter(
      'app1',
      'sec1',
      /** @type {any} */ ({
        info: () => {},
        error: () => {},
        warn: () => {},
        debug: () => {},
        child: () => /** @type {any} */ ({}),
      }),
    );
    const plainSend = mock.fn(() => Promise.resolve({}));
    plainAdapter._injectSendMessage(plainSend);

    await plainAdapter.sendMedia('chat_123', {
      type: 'image',
      url: '/api/connector-media/test-img.jpg',
      absPath: '/tmp/test-img.jpg',
    });

    // Should fall back to text link
    assert.equal(plainSend.mock.calls.length, 1);
    const sentParams = plainSend.mock.calls[0].arguments[0];
    assert.equal(sentParams.msgType, 'text');
    assert.ok(JSON.parse(sentParams.content).text.includes('🖼️'));
  });

  test('still uses platform keys when available (no upload needed)', async () => {
    await adapter.sendMedia('chat_123', {
      type: 'image',
      imageKey: 'img_existing_key',
    });

    // Should NOT call upload API
    const uploadCalls = mockUploadFetch.mock.calls.filter(
      (c) => typeof c.arguments[0] === 'string' && c.arguments[0].includes('/im/v1/images'),
    );
    assert.equal(uploadCalls.length, 0);

    // Should send with existing key
    assert.equal(sendMessageCalls.mock.calls.length, 1);
    const content = JSON.parse(sendMessageCalls.mock.calls[0].arguments[0].content);
    assert.equal(content.image_key, 'img_existing_key');
  });

  test('audio upload always sends file_type=opus and file_name=*.opus', async () => {
    const audioPath = join(TMP, 'test-audio.opus');
    await writeFile(audioPath, Buffer.from('fake-opus-data'));

    let capturedBody;
    const captureFetch = mock.fn((/** @type {string} */ url, /** @type {any} */ opts) => {
      if (url.includes('/auth/v3/tenant_access_token')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ tenant_access_token: 'tok-test', expire: 7200 }),
        });
      }
      if (url.includes('/im/v1/files')) {
        capturedBody = opts?.body;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { file_key: 'file_opus_789' } }),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    const tokenManager2 = new FeishuTokenManager({
      appId: 'app1',
      appSecret: 'sec1',
      fetchFn: /** @type {any} */ (captureFetch),
    });
    const adapter2 = new FeishuAdapter(
      'app1',
      'sec1',
      /** @type {any} */ ({
        info: () => {},
        error: () => {},
        warn: () => {},
        debug: () => {},
        child: () => /** @type {any} */ ({}),
      }),
    );
    adapter2._injectSendMessage(mock.fn(() => Promise.resolve({})));
    adapter2._injectTokenManager(tokenManager2);
    adapter2._injectUploadFetch(/** @type {any} */ (captureFetch));

    await adapter2.sendMedia('chat_123', {
      type: 'audio',
      url: '/api/tts/audio/test-audio.opus',
      absPath: audioPath,
    });

    assert.ok(capturedBody instanceof FormData, 'upload body should be FormData');
    assert.equal(capturedBody.get('file_type'), 'opus');
    assert.equal(capturedBody.get('file_name'), 'test-audio.opus');
  });

  test(
    'WAV audio: converts to opus via ffmpeg then uploads',
    { skip: !ffmpegAvailable && 'ffmpeg not available' },
    async () => {
      const wavPath = join(TMP, 'test-tts-output.wav');
      await writeFile(wavPath, createMinimalWav());

      let capturedBody;
      const captureFetch = mock.fn((/** @type {string} */ url, /** @type {any} */ opts) => {
        if (url.includes('/auth/v3/tenant_access_token')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ tenant_access_token: 'tok-test', expire: 7200 }),
          });
        }
        if (url.includes('/im/v1/files')) {
          capturedBody = opts?.body;
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ data: { file_key: 'file_wav_converted' } }),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });

      const tokenManager3 = new FeishuTokenManager({
        appId: 'app1',
        appSecret: 'sec1',
        fetchFn: /** @type {any} */ (captureFetch),
      });
      const logCalls = [];
      const adapter3 = new FeishuAdapter(
        'app1',
        'sec1',
        /** @type {any} */ ({
          info: (/** @type {any} */ ...args) => logCalls.push(['info', ...args]),
          error: () => {},
          warn: (/** @type {any} */ ...args) => logCalls.push(['warn', ...args]),
          debug: () => {},
          child: () => /** @type {any} */ ({}),
        }),
      );
      adapter3._injectSendMessage(mock.fn(() => Promise.resolve({})));
      adapter3._injectTokenManager(tokenManager3);
      adapter3._injectUploadFetch(/** @type {any} */ (captureFetch));

      await adapter3.sendMedia('chat_123', {
        type: 'audio',
        url: '/api/tts/audio/test-tts-output.wav',
        absPath: wavPath,
      });

      assert.ok(capturedBody instanceof FormData, 'upload body should be FormData');
      assert.equal(capturedBody.get('file_type'), 'opus');
      assert.equal(capturedBody.get('file_name'), 'test-tts-output.opus');

      const conversionLog = logCalls.find((c) => c[0] === 'info' && typeof c[1] === 'object' && c[1].opusPath);
      assert.ok(conversionLog, 'should log successful opus conversion');

      const tempPath = conversionLog[1].opusPath;
      assert.ok(!existsSync(tempPath), 'temp opus file should be cleaned up after upload');
    },
  );

  test('external https:// image URL: downloads then uploads as native image', async () => {
    const fakePngData = Buffer.from('fake-png-image-data');

    const captureFetch = mock.fn((/** @type {string} */ url, /** @type {any} */ opts) => {
      if (url.includes('/auth/v3/tenant_access_token')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ tenant_access_token: 'tok-test', expire: 7200 }),
        });
      }
      if (url.startsWith('https://upload.wikimedia.org/')) {
        return Promise.resolve({
          ok: true,
          headers: new Map([['content-type', 'image/jpeg']]),
          arrayBuffer: () =>
            Promise.resolve(
              fakePngData.buffer.slice(fakePngData.byteOffset, fakePngData.byteOffset + fakePngData.byteLength),
            ),
        });
      }
      if (url.includes('/im/v1/images')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { image_key: 'img_downloaded_ext' } }),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    const tokenManager4 = new FeishuTokenManager({
      appId: 'app1',
      appSecret: 'sec1',
      fetchFn: /** @type {any} */ (captureFetch),
    });
    const sendCalls4 = mock.fn(() => Promise.resolve({}));
    const adapter4 = new FeishuAdapter(
      'app1',
      'sec1',
      /** @type {any} */ ({
        info: () => {},
        error: () => {},
        warn: () => {},
        debug: () => {},
        child: () => /** @type {any} */ ({}),
      }),
    );
    adapter4._injectSendMessage(sendCalls4);
    adapter4._injectTokenManager(tokenManager4);
    adapter4._injectUploadFetch(/** @type {any} */ (captureFetch));

    await adapter4.sendMedia('chat_123', {
      type: 'image',
      url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4d/Cat.jpg/800px-Cat.jpg',
    });

    const downloadCall = captureFetch.mock.calls.find(
      (c) => typeof c.arguments[0] === 'string' && c.arguments[0].startsWith('https://upload.wikimedia.org/'),
    );
    assert.ok(downloadCall, 'should have fetched the external image URL');

    const uploadCall = captureFetch.mock.calls.find(
      (c) => typeof c.arguments[0] === 'string' && c.arguments[0].includes('/im/v1/images'),
    );
    assert.ok(uploadCall, 'should have uploaded the downloaded image to Feishu');

    assert.equal(sendCalls4.mock.calls.length, 1);
    const sentParams = sendCalls4.mock.calls[0].arguments[0];
    assert.equal(sentParams.msgType, 'image', 'should send native image, not text');
    const content = JSON.parse(sentParams.content);
    assert.equal(content.image_key, 'img_downloaded_ext');
  });

  test('external URL download failure falls back to text link', async () => {
    const captureFetch5 = mock.fn((/** @type {string} */ url) => {
      if (url.includes('/auth/v3/tenant_access_token')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ tenant_access_token: 'tok-test', expire: 7200 }),
        });
      }
      if (url.startsWith('https://broken.example.com/')) {
        return Promise.resolve({ ok: false, status: 404 });
      }
      return Promise.resolve({ ok: false, status: 500 });
    });

    const tokenManager5 = new FeishuTokenManager({
      appId: 'app1',
      appSecret: 'sec1',
      fetchFn: /** @type {any} */ (captureFetch5),
    });
    const sendCalls5 = mock.fn(() => Promise.resolve({}));
    const adapter5 = new FeishuAdapter(
      'app1',
      'sec1',
      /** @type {any} */ ({
        info: () => {},
        error: () => {},
        warn: () => {},
        debug: () => {},
        child: () => /** @type {any} */ ({}),
      }),
    );
    adapter5._injectSendMessage(sendCalls5);
    adapter5._injectTokenManager(tokenManager5);
    adapter5._injectUploadFetch(/** @type {any} */ (captureFetch5));

    await adapter5.sendMedia('chat_123', {
      type: 'image',
      url: 'https://broken.example.com/image.jpg',
    });

    assert.equal(sendCalls5.mock.calls.length, 1);
    const sentParams = sendCalls5.mock.calls[0].arguments[0];
    assert.equal(sentParams.msgType, 'text', 'should fall back to text when download fails');
    assert.ok(JSON.parse(sentParams.content).text.includes('🖼️'), 'text should contain image emoji');
  });

  test('P1-1 SSRF: rejects http:// (non-TLS) URLs and falls back to text', async () => {
    const sendCalls6 = mock.fn(() => Promise.resolve({}));
    const captureFetch6 = mock.fn((/** @type {string} */ url) => {
      if (url.includes('/auth/v3/tenant_access_token')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ tenant_access_token: 'tok-test', expire: 7200 }),
        });
      }
      return Promise.resolve({ ok: false, status: 500 });
    });
    const tokenManager6 = new FeishuTokenManager({
      appId: 'app1',
      appSecret: 'sec1',
      fetchFn: /** @type {any} */ (captureFetch6),
    });
    const adapter6 = new FeishuAdapter(
      'app1',
      'sec1',
      /** @type {any} */ ({
        info: () => {},
        error: () => {},
        warn: () => {},
        debug: () => {},
        child: () => /** @type {any} */ ({}),
      }),
    );
    adapter6._injectSendMessage(sendCalls6);
    adapter6._injectTokenManager(tokenManager6);
    adapter6._injectUploadFetch(/** @type {any} */ (captureFetch6));

    await adapter6.sendMedia('chat_123', {
      type: 'image',
      url: 'http://169.254.169.254/latest/meta-data/',
    });

    // Should NOT have fetched the URL (SSRF blocked at entry point — http:// not https://)
    const fetchCalls = captureFetch6.mock.calls.filter(
      (c) => typeof c.arguments[0] === 'string' && c.arguments[0].startsWith('http://169.254'),
    );
    assert.equal(fetchCalls.length, 0, 'must not fetch internal metadata URL');

    assert.equal(sendCalls6.mock.calls.length, 1);
    assert.equal(sendCalls6.mock.calls[0].arguments[0].msgType, 'text', 'should fall back to text');
  });

  test('P1-1 SSRF: rejects https:// to private IPs and falls back to text', async () => {
    const warnLogs = [];
    const captureFetch7 = mock.fn((/** @type {string} */ url) => {
      if (url.includes('/auth/v3/tenant_access_token')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ tenant_access_token: 'tok-test', expire: 7200 }),
        });
      }
      // This should never be called for private IPs
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)), headers: new Map() });
    });
    const tokenManager7 = new FeishuTokenManager({
      appId: 'app1',
      appSecret: 'sec1',
      fetchFn: /** @type {any} */ (captureFetch7),
    });
    const sendCalls7 = mock.fn(() => Promise.resolve({}));
    const adapter7 = new FeishuAdapter(
      'app1',
      'sec1',
      /** @type {any} */ ({
        info: () => {},
        error: () => {},
        warn: (/** @type {any} */ ...args) => warnLogs.push(args),
        debug: () => {},
        child: () => /** @type {any} */ ({}),
      }),
    );
    adapter7._injectSendMessage(sendCalls7);
    adapter7._injectTokenManager(tokenManager7);
    adapter7._injectUploadFetch(/** @type {any} */ (captureFetch7));

    await adapter7.sendMedia('chat_123', {
      type: 'image',
      url: 'https://192.168.1.1/internal-image.jpg',
    });

    // isSafeExternalUrl should block bare IPv4 addresses
    const fetchToPrivate = captureFetch7.mock.calls.filter(
      (c) => typeof c.arguments[0] === 'string' && c.arguments[0].includes('192.168'),
    );
    assert.equal(fetchToPrivate.length, 0, 'must not fetch private IP URL');

    const ssrfWarn = warnLogs.find((w) => typeof w[0] === 'object' && JSON.stringify(w).includes('rejected unsafe'));
    assert.ok(ssrfWarn, 'should log warning about rejected URL');

    assert.equal(sendCalls7.mock.calls.length, 1);
    assert.equal(sendCalls7.mock.calls[0].arguments[0].msgType, 'text', 'should fall back to text');
  });

  test('P1-3 SSRF: rejects https:// to private IPv6 addresses', async () => {
    const warnLogs9 = [];
    const captureFetch9 = mock.fn((/** @type {string} */ url) => {
      if (url.includes('/auth/v3/tenant_access_token')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ tenant_access_token: 'tok-test', expire: 7200 }),
        });
      }
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)), headers: new Map() });
    });
    const tokenManager9 = new FeishuTokenManager({
      appId: 'app1',
      appSecret: 'sec1',
      fetchFn: /** @type {any} */ (captureFetch9),
    });
    const sendCalls9 = mock.fn(() => Promise.resolve({}));
    const adapter9 = new FeishuAdapter(
      'app1',
      'sec1',
      /** @type {any} */ ({
        info: () => {},
        error: () => {},
        warn: (/** @type {any} */ ...args) => warnLogs9.push(args),
        debug: () => {},
        child: () => /** @type {any} */ ({}),
      }),
    );
    adapter9._injectSendMessage(sendCalls9);
    adapter9._injectTokenManager(tokenManager9);
    adapter9._injectUploadFetch(/** @type {any} */ (captureFetch9));

    await adapter9.sendMedia('chat_123', {
      type: 'image',
      url: 'https://[fd00::1]/internal-image.jpg',
    });

    const fetchToIPv6 = captureFetch9.mock.calls.filter(
      (c) => typeof c.arguments[0] === 'string' && c.arguments[0].includes('fd00'),
    );
    assert.equal(fetchToIPv6.length, 0, 'must not fetch private IPv6 URL');

    const ssrfWarn = warnLogs9.find((w) => JSON.stringify(w).includes('rejected unsafe'));
    assert.ok(ssrfWarn, 'should log warning about rejected IPv6 URL');

    assert.equal(sendCalls9.mock.calls.length, 1);
    assert.equal(sendCalls9.mock.calls[0].arguments[0].msgType, 'text', 'should fall back to text');
  });

  test('P1-2: opus conversion failure aborts audio upload (falls back to text)', async () => {
    // Create a non-audio file that ffmpeg will reject as audio input
    const badAudioPath = join(TMP, 'corrupt-audio.wav');
    await writeFile(badAudioPath, Buffer.from('not-a-real-wav-file'));

    const warnLogs8 = [];
    const captureFetch8 = mock.fn((/** @type {string} */ url) => {
      if (url.includes('/auth/v3/tenant_access_token')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ tenant_access_token: 'tok-test', expire: 7200 }),
        });
      }
      if (url.includes('/im/v1/files')) {
        // This should NOT be called — conversion failure means no upload
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { file_key: 'should_not_reach' } }),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    const tokenManager8 = new FeishuTokenManager({
      appId: 'app1',
      appSecret: 'sec1',
      fetchFn: /** @type {any} */ (captureFetch8),
    });
    const sendCalls8 = mock.fn(() => Promise.resolve({}));
    const adapter8 = new FeishuAdapter(
      'app1',
      'sec1',
      /** @type {any} */ ({
        info: () => {},
        error: () => {},
        warn: (/** @type {any} */ ...args) => warnLogs8.push(args),
        debug: () => {},
        child: () => /** @type {any} */ ({}),
      }),
    );
    adapter8._injectSendMessage(sendCalls8);
    adapter8._injectTokenManager(tokenManager8);
    adapter8._injectUploadFetch(/** @type {any} */ (captureFetch8));

    await adapter8.sendMedia('chat_123', {
      type: 'audio',
      url: '/api/tts/audio/corrupt-audio.wav',
      absPath: badAudioPath,
    });

    // Should NOT have called the file upload API (conversion failed → abort)
    const uploadCalls = captureFetch8.mock.calls.filter(
      (c) => typeof c.arguments[0] === 'string' && c.arguments[0].includes('/im/v1/files'),
    );
    assert.equal(uploadCalls.length, 0, 'must not upload when opus conversion fails');

    // Should fall back to text
    assert.equal(sendCalls8.mock.calls.length, 1);
    const sentParams = sendCalls8.mock.calls[0].arguments[0];
    assert.equal(sentParams.msgType, 'text', 'should fall back to text link when conversion fails');
    assert.ok(JSON.parse(sentParams.content).text.includes('🔊'), 'text should contain audio emoji');
  });
});
