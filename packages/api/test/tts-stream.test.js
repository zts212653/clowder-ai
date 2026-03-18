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
});
