import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import { registerThreadIndexCatchUp } from '../dist/domains/memory/thread-index-startup.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('listens and answers readiness while the history source is still blocked', async () => {
  const app = Fastify();
  const entered = deferred(),
    release = deferred(),
    finished = deferred();
  app.get('/ready', async () => ({ status: 'ready' }));
  registerThreadIndexCatchUp(app, {
    async refreshThreadIndex() {
      assert.equal(app.server.listening, true);
      entered.resolve();
      await release.promise;
      return { docsIndexed: 1, docsSkipped: 0, durationMs: 1 };
    },
    startPassageEmbeddingWarmup() {
      finished.resolve();
    },
  });
  try {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    await entered.promise;
    const response = await fetch(`${address}/ready`, { signal: AbortSignal.timeout(1000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ready' });
  } finally {
    release.resolve();
    await finished.promise;
    await app.close();
  }
});

test('closing the server aborts and drains a running history catch-up', async () => {
  const app = Fastify();
  const entered = deferred();
  let cancelled = false;
  registerThreadIndexCatchUp(app, {
    async refreshThreadIndex({ signal }) {
      entered.resolve();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      cancelled = true;
      signal.throwIfAborted();
    },
    startPassageEmbeddingWarmup() {
      assert.fail('cancelled catch-up must not start embedding');
    },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  await entered.promise;
  await app.close();
  assert.equal(cancelled, true);
});

test('failed catch-up leaves the HTTP service available and close cancels its retry', async () => {
  const app = Fastify();
  let attempts = 0;
  const entered = deferred();
  app.get('/ready', async () => ({ status: 'ready' }));
  registerThreadIndexCatchUp(app, {
    async refreshThreadIndex() {
      attempts++;
      entered.resolve();
      throw new Error('source unavailable');
    },
    startPassageEmbeddingWarmup() {
      assert.fail('failed catch-up must not start embedding');
    },
  });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  try {
    await entered.promise;
    assert.equal((await fetch(`${address}/ready`)).status, 200);
  } finally {
    await app.close();
  }
  await delay(5);
  assert.equal(attempts, 1);
});

test('production startup opts into deferred history and registers the background listener', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /memoryServices\.indexBuilder\.rebuild\(\{\s*deferThreadIndexing: true/);
  assert.match(source, /registerThreadIndexCatchUp\(app, memoryServices\.indexBuilder,/);
});
