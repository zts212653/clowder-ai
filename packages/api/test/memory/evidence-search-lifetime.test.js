import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import Fastify from 'fastify';
import { evidenceRoutes } from '../../dist/routes/evidence.js';
import { executeMessageSearch } from '../../dist/routes/message-search-handler.js';

for (const intent of ['topk', 'coverage']) {
  test(`${intent} HTTP disconnect reaches running SQLite search and carries a finite deadline`, async (t) => {
    let entered;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    let captured;
    const store = {
      searchWithMeta: async (_query, options) => {
        captured = options;
        entered();
        return await new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
        });
      },
    };
    const app = Fastify();
    await app.register(evidenceRoutes, { evidenceStore: store });
    app.get('/health', async () => ({ ok: true }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    t.after(() => app.close());
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');
    const controller = new AbortController();
    const request = fetch(
      `http://127.0.0.1:${address.port}/api/evidence/search?q=fixture&scope=docs&intent=${intent}&include_expansion=false`,
      { signal: controller.signal },
    ).catch((error) => error);
    await started;
    assert.ok(captured?.signal);
    assert.ok(captured.deadlineAt && captured.deadlineAt <= Date.now() + 15_000);
    controller.abort();
    await request;
    for (let i = 0; i < 40 && !captured.signal.aborted; i++) await pause(5);
    assert.equal(captured.signal.aborted, true);
    assert.equal((await app.inject('/health')).statusCode, 200);
  });
}
test('topk expansion subqueries inherit the same cancellation and deadline', async () => {
  const calls = [];
  const store = {
    searchWithMeta: async (_query, options) => {
      calls.push(options);
      return {
        items:
          calls.length === 1
            ? [
                {
                  anchor: 'F001',
                  title: 'Fixture',
                  kind: 'feature',
                  status: 'active',
                  updatedAt: '2026-01-01',
                  keywords: ['probe'],
                },
              ]
            : [],
        meta: { degraded: false },
      };
    },
  };
  const app = Fastify();
  await app.register(evidenceRoutes, { evidenceStore: store });
  try {
    const response = await app.inject('/api/evidence/search?q=fixture&scope=docs');
    assert.equal(response.statusCode, 200);
    assert.ok(calls.length > 1);
    assert.equal(calls[1]?.signal, calls[0]?.signal);
    assert.equal(calls[1]?.deadlineAt, calls[0]?.deadlineAt);
  } finally {
    await app.close();
  }
});

test('message-unit HTTP disconnect reaches the service execution lifetime', async (t) => {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let context;
  const service = {
    search: async (_input, _principal, execution) => {
      context = execution;
      entered();
      return new Promise((_resolve, reject) =>
        execution.signal.addEventListener('abort', () => reject(execution.signal.reason), { once: true }),
      );
    },
  };
  const app = Fastify();
  app.get('/messages', (_request, reply) =>
    executeMessageSearch(service, { query: 'fixture' }, { userId: 'owner', viewer: { type: 'user' } }, reply),
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(() => app.close());
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const controller = new AbortController();
  const request = fetch(`http://127.0.0.1:${address.port}/messages`, { signal: controller.signal }).catch(
    (error) => error,
  );
  await started;
  assert.ok(context.deadlineAt <= Date.now() + 15000);
  controller.abort();
  await request;
  for (let i = 0; i < 40 && !context.signal.aborted; i++) await pause(5);
  assert.equal(context.signal.aborted, true);
});
