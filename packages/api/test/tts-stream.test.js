import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import Fastify from 'fastify';
import { TtsRegistry } from '../dist/domains/cats/services/tts/TtsRegistry.js';
import { ttsRoutes } from '../dist/routes/tts.js';

function createMockProvider() {
  const fakeWav = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0]); // Minimal RIFF header
  return {
    id: 'mock-tts',
    model: 'mock-model',
    synthesize: async (req) => ({
      audio: fakeWav,
      format: 'wav',
      durationSec: 1.5,
      metadata: { provider: 'mock-tts', model: 'mock-model', voice: req.voice },
    }),
  };
}

describe('POST /api/tts/stream (SSE)', () => {
  let app;
  let tempDir;

  before(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'tts-stream-test-'));
    app = Fastify({ logger: false });
    const registry = new TtsRegistry();
    registry.register(createMockProvider());
    await app.register(ttsRoutes, { ttsRegistry: registry, cacheDir: tempDir });
    await app.ready();
  });

  after(async () => {
    await app.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns 401 without auth header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tts/stream',
      payload: { text: '你好世界。' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 400 for empty text', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tts/stream',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: { text: '' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('returns SSE events for valid text with multiple sentences', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tts/stream',
      headers: {
        'x-cat-cafe-user': 'test-user',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ text: '第一句话。第二句话。第三句话。' }),
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'text/event-stream');

    const body = res.body;
    const events = body
      .split('\n\n')
      .filter((s) => s.startsWith('data: '))
      .map((s) => JSON.parse(s.replace('data: ', '')));

    const chunkEvents = events.filter((e) => e.type === 'chunk');
    const doneEvents = events.filter((e) => e.type === 'done');

    assert.equal(chunkEvents.length, 3, `Expected 3 chunks, got ${chunkEvents.length}`);
    assert.equal(doneEvents.length, 1, 'Expected 1 done event');

    assert.equal(chunkEvents[0].index, 0);
    assert.equal(chunkEvents[0].total, 3);
    assert.ok(chunkEvents[0].audioBase64, 'Chunk should have audioBase64');
    assert.ok(chunkEvents[0].format, 'Chunk should have format');
    assert.equal(chunkEvents[0].text, '第一句话。');
    assert.equal(chunkEvents[1].index, 1);
    assert.equal(chunkEvents[2].index, 2);
    assert.equal(chunkEvents[2].text, '第三句话。');
  });

  it('returns single chunk for short text without breakpoints', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tts/stream',
      headers: {
        'x-cat-cafe-user': 'test-user',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ text: '你好世界' }),
    });

    assert.equal(res.statusCode, 200);
    const events = res.body
      .split('\n\n')
      .filter((s) => s.startsWith('data: '))
      .map((s) => JSON.parse(s.replace('data: ', '')));

    const chunkEvents = events.filter((e) => e.type === 'chunk');
    assert.equal(chunkEvents.length, 1);
    assert.equal(chunkEvents[0].text, '你好世界');
  });

  it('existing /api/tts/synthesize still works (regression)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tts/synthesize',
      headers: {
        'x-cat-cafe-user': 'test-user',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ text: '测试回归' }),
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.audioUrl, 'Should have audioUrl');
    assert.ok(body.audioUrl.startsWith('/api/tts/audio/'));
  });

  // ── Text limit boundary tests (pin the raised caps) ──────────

  it('stream accepts text >10000 chars (old limit was 10K)', async () => {
    const longText = '你好。'.repeat(3500); // ~10500 chars
    const res = await app.inject({
      method: 'POST',
      url: '/api/tts/stream',
      headers: { 'x-cat-cafe-user': 'test-user', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: longText }),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'text/event-stream');
  });

  it('stream rejects text >50000 chars', async () => {
    const tooLong = 'a'.repeat(50001);
    const res = await app.inject({
      method: 'POST',
      url: '/api/tts/stream',
      headers: { 'x-cat-cafe-user': 'test-user', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: tooLong }),
    });
    assert.equal(res.statusCode, 400);
  });

  it('synthesize accepts text >5000 chars (old limit was 5K)', async () => {
    const longText = '测试'.repeat(2600); // 5200 chars
    const res = await app.inject({
      method: 'POST',
      url: '/api/tts/synthesize',
      headers: { 'x-cat-cafe-user': 'test-user', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: longText }),
    });
    assert.equal(res.statusCode, 200);
  });

  it('synthesize rejects text >20000 chars', async () => {
    const tooLong = 'b'.repeat(20001);
    const res = await app.inject({
      method: 'POST',
      url: '/api/tts/synthesize',
      headers: { 'x-cat-cafe-user': 'test-user', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: tooLong }),
    });
    assert.equal(res.statusCode, 400);
  });
});

describe('POST /api/tts/stream — chunk failure resilience', () => {
  it('sends error event when all chunks fail (provider fully down)', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'tts-allfail-'));
    const failApp = Fastify({ logger: false });
    const registry = new TtsRegistry();
    registry.register({
      id: 'fail-tts',
      model: 'fail-model',
      synthesize: async () => {
        throw new Error('TTS server down');
      },
    });
    await failApp.register(ttsRoutes, { ttsRegistry: registry, cacheDir: tempDir });
    await failApp.ready();

    const res = await failApp.inject({
      method: 'POST',
      url: '/api/tts/stream',
      headers: { 'x-cat-cafe-user': 'test-user', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: '第一句。第二句。第三句。' }),
    });

    assert.equal(res.statusCode, 200);
    const events = res.body
      .split('\n\n')
      .filter((s) => s.startsWith('data: '))
      .map((s) => JSON.parse(s.replace('data: ', '')));

    const errorEvents = events.filter((e) => e.type === 'error');
    const doneEvents = events.filter((e) => e.type === 'done');
    const chunkEvents = events.filter((e) => e.type === 'chunk');

    assert.equal(chunkEvents.length, 0, 'No chunks should succeed');
    assert.equal(errorEvents.length, 1, 'Should emit exactly one error event');
    assert.equal(doneEvents.length, 0, 'Should NOT emit done when all chunks failed');
    assert.ok(errorEvents[0].error.includes('All chunks failed'));

    await failApp.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('skips failed chunks and still sends done when some succeed', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'tts-midfail-'));
    const partialApp = Fastify({ logger: false });
    let callIndex = 0;
    const registry = new TtsRegistry();
    registry.register({
      id: 'partial-tts',
      model: 'partial-model',
      synthesize: async (req) => {
        const idx = callIndex++;
        if (idx === 1) throw new Error('Chunk 1 timeout');
        return {
          audio: new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0]),
          format: 'wav',
          durationSec: 1.0,
          metadata: { provider: 'partial-tts', model: 'partial-model', voice: req.voice },
        };
      },
    });
    await partialApp.register(ttsRoutes, { ttsRegistry: registry, cacheDir: tempDir });
    await partialApp.ready();

    const res = await partialApp.inject({
      method: 'POST',
      url: '/api/tts/stream',
      headers: { 'x-cat-cafe-user': 'test-user', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: '第一句。第二句。第三句。' }),
    });

    assert.equal(res.statusCode, 200);
    const events = res.body
      .split('\n\n')
      .filter((s) => s.startsWith('data: '))
      .map((s) => JSON.parse(s.replace('data: ', '')));

    const chunkEvents = events.filter((e) => e.type === 'chunk');
    const doneEvents = events.filter((e) => e.type === 'done');
    const errorEvents = events.filter((e) => e.type === 'error');

    assert.equal(chunkEvents.length, 2, 'Two chunks should succeed (0 and 2)');
    assert.equal(doneEvents.length, 1, 'Should still emit done');
    assert.equal(errorEvents.length, 0, 'Partial failure should not emit error');
    assert.equal(chunkEvents[0].index, 0);
    assert.equal(chunkEvents[0].total, 3);
    assert.equal(chunkEvents[0].sourceIndex, 0);
    assert.equal(chunkEvents[0].sourceTotal, 3);
    assert.equal(chunkEvents[1].index, 1);
    assert.equal(chunkEvents[1].total, 3);
    assert.equal(chunkEvents[1].sourceIndex, 2);
    assert.equal(chunkEvents[1].sourceTotal, 3);
    assert.equal(doneEvents[0].total, 2);

    await partialApp.close();
    await rm(tempDir, { recursive: true, force: true });
  });
});
