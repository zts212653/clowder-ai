import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';

const originalServicesConfig = process.env.CAT_CAFE_SERVICES_CONFIG;
const originalWhisperUrl = process.env.WHISPER_URL;

afterEach(() => {
  if (originalServicesConfig === undefined) delete process.env.CAT_CAFE_SERVICES_CONFIG;
  else process.env.CAT_CAFE_SERVICES_CONFIG = originalServicesConfig;
  if (originalWhisperUrl === undefined) delete process.env.WHISPER_URL;
  else process.env.WHISPER_URL = originalWhisperUrl;
});

describe('WhisperSttProvider', () => {
  it('sends audio file to Whisper API and returns transcript', async () => {
    const { WhisperSttProvider } = await import('../dist/infrastructure/connectors/media/WhisperSttProvider.js');

    const tempDir = await mkdtemp(path.join(tmpdir(), 'whisper-test-'));
    const audioPath = path.join(tempDir, 'test.wav');
    await writeFile(audioPath, Buffer.from('fake-audio'));

    const mockFetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({ text: '你好世界', duration: 2.5 }),
      text: async () => '',
    }));

    const provider = new WhisperSttProvider({
      baseUrl: 'http://localhost:9876',
      _fetchFn: mockFetch,
    });

    assert.equal(provider.id, 'whisper-local');

    const result = await provider.transcribe({ audioPath });

    assert.equal(result.text, '你好世界');
    assert.equal(result.durationSec, 2.5);
    assert.equal(result.metadata.provider, 'whisper-local');
    assert.equal(mockFetch.mock.calls.length, 1);

    const [url, opts] = mockFetch.mock.calls[0].arguments;
    assert.equal(url, 'http://127.0.0.1:9876/v1/audio/transcriptions');
    assert.equal(opts.method, 'POST');

    await rm(tempDir, { recursive: true });
  });

  it('throws on non-ok response', async () => {
    const { WhisperSttProvider } = await import('../dist/infrastructure/connectors/media/WhisperSttProvider.js');

    const tempDir = await mkdtemp(path.join(tmpdir(), 'whisper-test-'));
    const audioPath = path.join(tempDir, 'test.wav');
    await writeFile(audioPath, Buffer.from('fake-audio'));

    const provider = new WhisperSttProvider({
      baseUrl: 'http://localhost:9876',
      _fetchFn: async () => ({ ok: false, status: 500, text: async () => 'internal error', json: async () => ({}) }),
    });

    await assert.rejects(() => provider.transcribe({ audioPath }), /STT request failed.*500/);

    await rm(tempDir, { recursive: true });
  });

  it('passes language parameter when provided', async () => {
    const { WhisperSttProvider } = await import('../dist/infrastructure/connectors/media/WhisperSttProvider.js');

    const tempDir = await mkdtemp(path.join(tmpdir(), 'whisper-test-'));
    const audioPath = path.join(tempDir, 'test.ogg');
    await writeFile(audioPath, Buffer.from('fake-audio'));

    let capturedBody = null;
    const mockFetch = mock.fn(async (_url, opts) => {
      capturedBody = opts.body;
      return { ok: true, json: async () => ({ text: 'hello' }), text: async () => '' };
    });

    const provider = new WhisperSttProvider({
      baseUrl: 'http://test:9876',
      _fetchFn: mockFetch,
    });

    await provider.transcribe({ audioPath, language: 'zh' });

    // FormData should contain language field
    assert.ok(capturedBody instanceof FormData);
    assert.equal(capturedBody.get('language'), 'zh');

    await rm(tempDir, { recursive: true });
  });

  it('uses the persisted Whisper service port when baseUrl is omitted', async () => {
    const { setServiceConfig } = await import('../dist/domains/services/service-config.js');
    const { WhisperSttProvider } = await import('../dist/infrastructure/connectors/media/WhisperSttProvider.js');

    const configDir = mkdtempSync(path.join(tmpdir(), 'whisper-provider-config-'));
    const tempDir = await mkdtemp(path.join(tmpdir(), 'whisper-test-'));
    const audioPath = path.join(tempDir, 'test.wav');
    await writeFile(audioPath, Buffer.from('fake-audio'));
    process.env.CAT_CAFE_SERVICES_CONFIG = path.join(configDir, 'services.json');
    delete process.env.WHISPER_URL;
    setServiceConfig('whisper-stt', { enabled: true, installed: true, port: 19981 });

    const mockFetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({ text: 'hello' }),
      text: async () => '',
    }));

    try {
      const provider = new WhisperSttProvider({ _fetchFn: mockFetch });
      await provider.transcribe({ audioPath });

      assert.equal(mockFetch.mock.calls[0].arguments[0], 'http://127.0.0.1:19981/v1/audio/transcriptions');
    } finally {
      await rm(tempDir, { recursive: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  // codex P1 2026-05-25 (outdated): a long-lived API process built before
  // /reconfigure changed the persisted Whisper port was stuck on the old
  // endpoint because baseUrl was cached at construction. The provider must
  // re-read the persisted port on every request when no explicit override
  // was given, so reconfigure takes effect without restarting the API.
  it('picks up a reconfigured Whisper port on the next transcribe without rebuild', async () => {
    const { setServiceConfig } = await import('../dist/domains/services/service-config.js');
    const { WhisperSttProvider } = await import('../dist/infrastructure/connectors/media/WhisperSttProvider.js');

    const configDir = mkdtempSync(path.join(tmpdir(), 'whisper-provider-reconfig-'));
    const tempDir = await mkdtemp(path.join(tmpdir(), 'whisper-test-'));
    const audioPath = path.join(tempDir, 'test.wav');
    await writeFile(audioPath, Buffer.from('fake-audio'));
    process.env.CAT_CAFE_SERVICES_CONFIG = path.join(configDir, 'services.json');
    delete process.env.WHISPER_URL;
    setServiceConfig('whisper-stt', { enabled: false, installed: true, port: 19981 });

    const mockFetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({ text: 'hello' }),
      text: async () => '',
    }));

    try {
      const provider = new WhisperSttProvider({ _fetchFn: mockFetch });
      await provider.transcribe({ audioPath });

      // Simulate /reconfigure persisting a new port while the provider
      // instance is still alive.
      setServiceConfig('whisper-stt', { enabled: false, installed: true, port: 19982 });
      await provider.transcribe({ audioPath });

      assert.equal(mockFetch.mock.calls[0].arguments[0], 'http://127.0.0.1:19981/v1/audio/transcriptions');
      assert.equal(
        mockFetch.mock.calls[1].arguments[0],
        'http://127.0.0.1:19982/v1/audio/transcriptions',
        'reconfigure must take effect on the next request without restarting the API',
      );
    } finally {
      await rm(tempDir, { recursive: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('keeps an explicit Whisper baseUrl override stable across requests', async () => {
    const { WhisperSttProvider } = await import('../dist/infrastructure/connectors/media/WhisperSttProvider.js');

    const tempDir = await mkdtemp(path.join(tmpdir(), 'whisper-test-'));
    const audioPath = path.join(tempDir, 'test.wav');
    await writeFile(audioPath, Buffer.from('fake-audio'));

    const mockFetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({ text: 'hello' }),
      text: async () => '',
    }));

    try {
      const provider = new WhisperSttProvider({ baseUrl: 'http://test:9876', _fetchFn: mockFetch });
      await provider.transcribe({ audioPath });
      await provider.transcribe({ audioPath });

      assert.equal(mockFetch.mock.calls[0].arguments[0], 'http://test:9876/v1/audio/transcriptions');
      assert.equal(mockFetch.mock.calls[1].arguments[0], 'http://test:9876/v1/audio/transcriptions');
    } finally {
      await rm(tempDir, { recursive: true });
    }
  });
});
