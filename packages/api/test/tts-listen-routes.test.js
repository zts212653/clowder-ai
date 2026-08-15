import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { DocumentListenRepository } from '../dist/domains/cats/services/tts/DocumentListenRepository.js';
import { TtsRegistry } from '../dist/domains/cats/services/tts/TtsRegistry.js';
import { securityHeadersPlugin } from '../dist/infrastructure/security-headers.js';
import { ttsRoutes } from '../dist/routes/tts.js';

describe('F279 TTS listen routes', () => {
  let app;
  let appAddress;
  let repository;
  let synthesisRequests;
  let streamRequests;
  let tempDir;

  before(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'tts-listen-routes-'));
    repository = new DocumentListenRepository(path.join(tempDir, 'listen-mode.sqlite'));
    await repository.initialize();
    synthesisRequests = [];
    streamRequests = [];
    const registry = new TtsRegistry();
    registry.register({
      id: 'test-tts',
      model: 'test-model',
      synthesize: async (request) => {
        synthesisRequests.push(request);
        return { audio: Buffer.from('audio'), format: 'wav', durationSec: 1 };
      },
      stream: async function* (request) {
        streamRequests.push(request);
        yield { type: 'chunk', audio: Buffer.from('chunk-audio'), format: 'wav', durationSec: 0.5, isFinalChunk: true };
        yield {
          type: 'final',
          result: { audio: Buffer.from('complete-audio'), format: 'wav', durationSec: 1 },
        };
      },
    });
    app = Fastify({ logger: false });
    await app.register(cors, { origin: 'http://localhost:3003', credentials: true });
    await app.register(securityHeadersPlugin, { allowedOrigins: ['http://localhost:3003'] });
    await app.register(ttsRoutes, { ttsRegistry: registry, cacheDir: tempDir, documentListenRepository: repository });
    appAddress = await app.listen({ host: '127.0.0.1', port: 0 });
  });

  after(async () => {
    await app.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns a controlled reusable asset identity from synthesis', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/tts/synthesize',
      headers: { 'x-cat-cafe-user': 'you', 'content-type': 'application/json' },
      payload: { text: '普通合成缓存。' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/tts/synthesize',
      headers: { 'x-cat-cafe-user': 'you', 'content-type': 'application/json' },
      payload: { text: '普通合成缓存。' },
    });

    assert.equal(first.statusCode, 200);
    assert.match(first.json().assetId, /^[0-9a-f]{64}\.wav$/);
    assert.equal(first.json().cached, false);
    assert.equal(first.json().bytes, 5);
    assert.equal(second.json().assetId, first.json().assetId);
    assert.equal(second.json().cached, true);
    assert.equal(
      repository.listAssetPolicies().some(({ assetId }) => assetId === first.json().assetId),
      false,
      'generic synthesis must keep the legacy cache lifecycle until a listen sentence links the asset',
    );
  });

  it('accepts listen-purpose synthesis without putting playback rate into the asset fingerprint', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tts/synthesize',
      headers: { 'x-cat-cafe-user': 'you', 'content-type': 'application/json' },
      payload: { text: '听读运行健康。', purpose: 'listen' },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().cached, false);
    assert.equal(response.json().durationSec, 1);
    assert.equal(typeof response.json().synthesisMs, 'number');
    assert.equal(synthesisRequests.at(-1).speed, 1);
  });

  it('streams a cold listen sentence immediately, persists the complete asset, then serves the cache', async () => {
    const request = {
      method: 'POST',
      url: '/api/tts/listen/stream',
      headers: {
        origin: 'http://localhost:3003',
        'x-cat-cafe-user': 'you',
        'content-type': 'application/json',
      },
      payload: { text: '只为流式缓存测试。' },
    };
    const first = await app.inject(request);
    const second = await app.inject(request);
    const parseEvents = (body) =>
      body
        .split('\n\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)));
    const firstEvents = parseEvents(first.body);
    const secondEvents = parseEvents(second.body);

    assert.equal(first.statusCode, 200);
    assert.equal(first.headers['content-type'], 'text/event-stream');
    assert.equal(first.headers['access-control-allow-origin'], 'http://localhost:3003');
    assert.equal(first.headers['access-control-allow-credentials'], 'true');
    assert.deepEqual(
      firstEvents.map((event) => event.type),
      ['chunk', 'asset'],
    );
    assert.equal(Buffer.from(firstEvents[0].audioBase64, 'base64').toString(), 'chunk-audio');
    assert.equal(firstEvents[0].isFinalChunk, true);
    assert.equal(firstEvents[1].cached, false);
    assert.match(firstEvents[1].assetId, /^[0-9a-f]{64}\.wav$/);
    assert.equal(firstEvents[1].bytes, Buffer.byteLength('complete-audio'));
    assert.deepEqual(
      secondEvents.map((event) => event.type),
      ['asset'],
    );
    assert.equal(secondEvents[0].cached, true);
    assert.equal(secondEvents[0].assetId, firstEvents[1].assetId);
    assert.equal(streamRequests.length, 1, 'cache hit must not invoke the model stream twice');
  });

  it('preserves shared CORS and security headers on both real SSE responses', async () => {
    for (const [route, text, expectedEvent] of [
      ['/api/tts/listen/stream', '真实跨源听读响应头。', '"type":"asset"'],
      ['/api/tts/stream', '真实跨源通用响应头。', '"type":"done"'],
    ]) {
      const response = await fetch(`${appAddress}${route}`, {
        method: 'POST',
        headers: {
          origin: 'http://localhost:3003',
          'x-cat-cafe-user': 'you',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text }),
      });
      const body = await response.text();

      assert.equal(response.status, 200, route);
      assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:3003', route);
      assert.equal(response.headers.get('access-control-allow-credentials'), 'true', route);
      assert.equal(response.headers.get('x-frame-options'), 'DENY', route);
      assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'none'", route);
      assert.match(body, /"type":"chunk"/, route);
      assert.match(body, new RegExp(expectedEvent), route);
    }
  });

  it('aborts the provider stream when the listening client disconnects', async () => {
    const disconnectDir = await mkdtemp(path.join(tmpdir(), 'tts-listen-disconnect-'));
    const disconnectRegistry = new TtsRegistry();
    let providerSignal;
    let releaseStream;
    disconnectRegistry.register({
      id: 'disconnect-tts',
      model: 'test-model',
      synthesize: async () => ({ audio: Buffer.from('unused'), format: 'wav' }),
      stream: async function* (_request, options) {
        providerSignal = options?.signal;
        yield {
          type: 'chunk',
          audio: Buffer.from('first-chunk'),
          format: 'wav',
          durationSec: 0.5,
          isFinalChunk: false,
        };
        await new Promise((resolve) => {
          releaseStream = resolve;
          options?.signal?.addEventListener('abort', resolve, { once: true });
        });
      },
    });
    const disconnectApp = Fastify({ logger: false });
    await disconnectApp.register(ttsRoutes, { ttsRegistry: disconnectRegistry, cacheDir: disconnectDir });
    const address = await disconnectApp.listen({ host: '127.0.0.1', port: 0 });
    let aborted = false;
    try {
      const response = await fetch(`${address}/api/tts/listen/stream`, {
        method: 'POST',
        headers: { 'x-cat-cafe-user': 'you', 'content-type': 'application/json' },
        body: JSON.stringify({ text: '客户端会取消这一句。' }),
      });
      const reader = response.body.getReader();
      await reader.read();
      await reader.cancel();
      for (let attempt = 0; attempt < 40 && !providerSignal?.aborted; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      aborted = providerSignal?.aborted === true;
    } finally {
      releaseStream?.();
      await disconnectApp.close();
      await rm(disconnectDir, { recursive: true, force: true });
    }

    assert.equal(aborted, true, 'socket close must abort the provider stream');
  });

  it('persists a manifest and clears audio references without clearing user state', async () => {
    const identity = { projectPath: '/repo', relativePath: 'paper.md', contentDigest: 'digest' };
    const state = {
      identity,
      sentences: [{ anchor: 'sentence-a' }],
      position: { anchor: 'sentence-a', offsetSeconds: 2 },
      playbackRate: 1.5,
      retention: '30d',
      updatedAt: 100,
    };
    const headers = { 'x-cat-cafe-user': 'you', 'content-type': 'application/json' };
    assert.equal(
      (await app.inject({ method: 'PUT', url: '/api/tts/listen/document', headers, payload: state })).statusCode,
      200,
    );

    const synthesis = await app.inject({
      method: 'POST',
      url: '/api/tts/synthesize',
      headers,
      payload: { text: '第一句。' },
    });
    const assetId = synthesis.json().assetId;
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/tts/listen/document/asset',
          headers,
          payload: { projectPath: '/repo', relativePath: 'paper.md', anchor: 'sentence-a', assetId },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url: '/api/tts/listen/document/audio',
          headers,
          payload: { projectPath: '/repo', relativePath: 'paper.md' },
        })
      ).statusCode,
      200,
    );

    const loaded = await app.inject({
      method: 'GET',
      url: '/api/tts/listen/document?projectPath=%2Frepo&relativePath=paper.md',
      headers: { 'x-cat-cafe-user': 'you' },
    });
    assert.equal(loaded.statusCode, 200);
    assert.deepEqual(loaded.json().position, state.position);
    assert.equal(loaded.json().playbackRate, 1.5);
    assert.equal(loaded.json().retention, '30d');
    assert.deepEqual(loaded.json().sentences, [{ anchor: 'sentence-a' }]);
    assert.deepEqual(loaded.json().cache, { cachedSentences: 0, totalSentences: 1, totalBytes: 0 });
  });

  it('auth-gates document state and rejects malformed asset identifiers', async () => {
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/api/tts/listen/document?projectPath=%2Frepo&relativePath=paper.md',
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/tts/listen/document/asset',
          headers: { 'x-cat-cafe-user': 'you', 'content-type': 'application/json' },
          payload: {
            projectPath: '/repo',
            relativePath: 'paper.md',
            anchor: 'sentence-a',
            assetId: '../../secret.wav',
          },
        })
      ).statusCode,
      400,
    );
  });

  it('rejects every browser mutation without a session instead of writing default-user state', async () => {
    const headers = {
      origin: 'http://localhost:3000',
      'x-cat-cafe-user': 'you',
      'content-type': 'application/json',
    };
    const state = {
      identity: { projectPath: '/repo', relativePath: 'browser-write.md', contentDigest: 'digest' },
      sentences: [{ anchor: 'sentence' }],
      position: { anchor: 'sentence', offsetSeconds: 0 },
      playbackRate: 1,
      retention: '7d',
      updatedAt: 100,
    };

    const responses = await Promise.all([
      app.inject({ method: 'PUT', url: '/api/tts/listen/document', headers, payload: state }),
      app.inject({
        method: 'PUT',
        url: '/api/tts/listen/document/asset',
        headers,
        payload: {
          projectPath: '/repo',
          relativePath: 'browser-write.md',
          anchor: 'sentence',
          assetId: `${'1'.repeat(64)}.wav`,
        },
      }),
      app.inject({
        method: 'DELETE',
        url: '/api/tts/listen/document/audio',
        headers,
        payload: { projectPath: '/repo', relativePath: 'browser-write.md' },
      }),
    ]);

    assert.deepEqual(
      responses.map((response) => response.statusCode),
      [401, 401, 401],
    );
  });

  it("does not expose one user's listen state to another explicit identity", async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/tts/listen/document?projectPath=%2Frepo&relativePath=paper.md',
      headers: { 'x-cat-cafe-user': 'intruder' },
    });
    assert.equal(response.statusCode, 404);
  });

  it('does not report a manifest asset as cached after its file disappeared', async () => {
    const headers = { 'x-cat-cafe-user': 'you', 'content-type': 'application/json' };
    const identity = { projectPath: '/repo', relativePath: 'missing-audio.md', contentDigest: 'digest' };
    const missingAssetId = `${'c'.repeat(64)}.wav`;
    await app.inject({
      method: 'PUT',
      url: '/api/tts/listen/document',
      headers,
      payload: {
        identity,
        sentences: [{ anchor: 'sentence-missing' }],
        position: { anchor: 'sentence-missing', offsetSeconds: 0 },
        playbackRate: 1,
        retention: '7d',
        updatedAt: 100,
      },
    });
    repository.setSentenceAsset(
      { userId: 'you', projectPath: identity.projectPath, relativePath: identity.relativePath },
      'sentence-missing',
      missingAssetId,
    );

    const loaded = await app.inject({
      method: 'GET',
      url: '/api/tts/listen/document?projectPath=%2Frepo&relativePath=missing-audio.md',
      headers,
    });

    assert.equal(loaded.statusCode, 200);
    assert.deepEqual(loaded.json().sentences, [{ anchor: 'sentence-missing' }]);
    assert.deepEqual(loaded.json().cache, { cachedSentences: 0, totalSentences: 1, totalBytes: 0 });
    assert.equal(
      repository.listAssetPolicies().some(({ assetId }) => assetId === missingAssetId),
      false,
    );
  });

  it('does not forget asset metadata or report success when filesystem deletion fails', async () => {
    const headers = { 'x-cat-cafe-user': 'you', 'content-type': 'application/json' };
    const identity = { projectPath: '/repo', relativePath: 'undeletable.md', contentDigest: 'digest' };
    const assetId = `${'d'.repeat(64)}.wav`;
    await app.inject({
      method: 'PUT',
      url: '/api/tts/listen/document',
      headers,
      payload: {
        identity,
        sentences: [{ anchor: 'sentence-undeletable' }],
        position: { anchor: 'sentence-undeletable', offsetSeconds: 0 },
        playbackRate: 1,
        retention: '7d',
        updatedAt: 100,
      },
    });
    repository.setSentenceAsset(
      { userId: 'you', projectPath: identity.projectPath, relativePath: identity.relativePath },
      'sentence-undeletable',
      assetId,
    );
    await mkdir(path.join(tempDir, assetId));

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/tts/listen/document/audio',
      headers,
      payload: { projectPath: identity.projectPath, relativePath: identity.relativePath },
    });

    assert.equal(response.statusCode, 500);
    assert.equal(response.json().failed, 1);
    assert.equal(
      repository.listAssetPolicies().some((policy) => policy.assetId === assetId),
      true,
      'failed deletion must retain metadata so cleanup can retry instead of losing truth',
    );
  });
});
