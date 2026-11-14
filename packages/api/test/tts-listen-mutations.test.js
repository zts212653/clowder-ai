import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { DocumentListenRepository } from '../dist/domains/cats/services/tts/DocumentListenRepository.js';
import { MlxAudioTtsProvider } from '../dist/domains/cats/services/tts/MlxAudioTtsProvider.js';
import { TtsRegistry } from '../dist/domains/cats/services/tts/TtsRegistry.js';
import { setServiceConfig } from '../dist/domains/services/service-config.js';
import { ttsRoutes } from '../dist/routes/tts.js';

const headers = { 'x-cat-cafe-user': 'operator', 'content-type': 'application/json' };
const identity = { projectPath: '/repo', relativePath: 'paper.md', contentDigest: 'digest-a' };
const state = {
  identity,
  sentences: [{ anchor: 'sentence-a' }],
  position: { anchor: 'sentence-a', offsetSeconds: 2 },
  playbackRate: 1,
  retention: 'forever',
  updatedAt: 100,
};

async function fixture(t) {
  const original = {
    fetch: globalThis.fetch,
    config: process.env.CAT_CAFE_SERVICES_CONFIG,
    model: process.env.TTS_MODEL,
  };
  const root = await mkdtemp(join(tmpdir(), 'tts-listen-mutations-'));
  process.env.CAT_CAFE_SERVICES_CONFIG = join(root, 'services.json');
  delete process.env.TTS_MODEL;
  setServiceConfig('mlx-tts', { installed: true, enabled: true });
  let nextHealth;
  const gates = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/health')) {
      const gate = nextHealth;
      nextHealth = undefined;
      if (gate) {
        gate.entered.resolve();
        await gate.release.promise;
      }
      return Response.json({
        model: 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16',
        backend: 'qwen3-clone',
        capabilities: ['speech-stream-route-v1'],
      });
    }
    assert.match(String(url), /speech\/stream$/);
    return new Response(
      new ReadableStream({
        start(controller) {
          if (init.signal.aborted) controller.close();
          else init.signal.addEventListener('abort', () => controller.close(), { once: true });
        },
      }),
    );
  };
  const repository = new DocumentListenRepository(join(root, 'listen.sqlite'));
  await repository.initialize();
  const registry = new TtsRegistry();
  registry.register(new MlxAudioTtsProvider({ baseUrl: 'http://127.0.0.1:19999' }));
  const app = Fastify();
  let nextArrival;
  app.addHook('preHandler', (_request, _reply, done) => {
    nextArrival?.resolve();
    nextArrival = undefined;
    done();
  });
  await app.register(ttsRoutes, { ttsRegistry: registry, cacheDir: root, documentListenRepository: repository });
  await app.ready();
  t.after(async () => {
    for (const gate of gates) gate.release.resolve();
    await app.close();
    repository.close();
    globalThis.fetch = original.fetch;
    for (const [key, value] of [
      ['CAT_CAFE_SERVICES_CONFIG', original.config],
      ['TTS_MODEL', original.model],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  return {
    app,
    repository,
    observeNextRequest() {
      nextArrival = Promise.withResolvers();
      return nextArrival.promise;
    },
    blockHealth() {
      const gate = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
      gates.push(gate);
      nextHealth = gate;
      return gate;
    },
    put(payload) {
      return app
        .inject({ method: 'PUT', url: '/api/tts/listen/document', headers, payload })
        .then((response) => response);
    },
  };
}

for (const contentDigest of ['digest-a', 'digest-b']) {
  test(`slow model discovery cannot overwrite a later document save (${contentDigest})`, async (t) => {
    const f = await fixture(t);
    const gate = f.blockHealth();
    const older = f.put(state);
    await gate.entered.promise;
    const arrival = f.observeNextRequest();
    const newer = f.put({
      ...state,
      identity: { ...identity, contentDigest },
      position: { anchor: 'sentence-a', offsetSeconds: 10 },
      updatedAt: 200,
    });
    await arrival;
    await new Promise(setImmediate);
    gate.release.resolve();
    const responses = await Promise.all([older, newer]);
    assert.ok(responses.every((response) => response.statusCode === 200));
    const saved = f.repository.loadDocument({ userId: 'operator', ...identity });
    assert.equal(saved.position.offsetSeconds, 10);
    assert.equal(saved.updatedAt, 200);
    assert.equal(saved.identity.contentDigest, contentDigest);
  });
}

for (const suffix of ['cache', 'audio']) {
  test(`document ${suffix} cancellation orders after pending cache model discovery`, async (t) => {
    const f = await fixture(t);
    const saved = await f.put(state);
    assert.equal(saved.statusCode, 200);
    const gate = f.blockHealth();
    const start = f.app
      .inject({
        method: 'POST',
        url: '/api/tts/listen/document/cache',
        headers,
        payload: { identity, sentences: [{ anchor: 'sentence-a', text: '等待模型身份后再缓存。' }] },
      })
      .then((response) => response);
    await gate.entered.promise;
    const arrival = f.observeNextRequest();
    const cancel = f.app
      .inject({
        method: 'DELETE',
        url: `/api/tts/listen/document/${suffix}`,
        headers,
        payload: { ...identity, synthesisFingerprint: saved.json().synthesisFingerprint },
      })
      .then((response) => response);
    await arrival;
    await new Promise(setImmediate);
    gate.release.resolve();
    const [started, cancelled] = await Promise.all([start, cancel]);
    assert.equal(started.statusCode, 200, started.body);
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    if (suffix === 'cache') assert.equal(cancelled.json().cancelled, true);
    const loaded = await f.app.inject({
      method: 'GET',
      url: '/api/tts/listen/document?projectPath=%2Frepo&relativePath=paper.md',
      headers,
    });
    assert.equal(loaded.statusCode, 200, loaded.body);
    assert.equal(loaded.json().cacheRun.active, false);
  });
}

test('slow model discovery in one document does not block another document', async (t) => {
  const f = await fixture(t);
  const gate = f.blockHealth();
  const older = f.put(state);
  await gate.entered.promise;
  let timer;
  try {
    const unrelated = f.put({ ...state, identity: { ...identity, relativePath: 'other.md' } });
    const response = await Promise.race([
      unrelated,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('an unrelated document was blocked')), 2000);
      }),
    ]);
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(f.repository.loadDocument({ userId: 'operator', ...identity, relativePath: 'other.md' }));
  } finally {
    clearTimeout(timer);
    gate.release.resolve();
    await older;
  }
});
