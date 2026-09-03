import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';

async function fixture({ enabled = true, ownerId = 'owner-1', invocationId = 'invocation-alpha' } = {}) {
  const { f296AlphaDynamicCanaryRoutes } = await import('../dist/routes/f296-alpha-dynamic-canary-routes.js');
  const app = Fastify();
  const calls = [];
  await app.register(f296AlphaDynamicCanaryRoutes, {
    enabled,
    threadStore: {
      get: async (id) => (id === 'thread-1' ? { id, createdBy: ownerId, deletedAt: undefined } : null),
    },
    dispatcher: {
      deliverAlphaDynamicCanary: async (input) => {
        calls.push(input);
        return {
          queueEntryId: 'q-alpha',
          sourceMessageId: 'msg-alpha',
          targetCatId: 'codex-sol',
          deduped: false,
          started: true,
        };
      },
    },
    invocationTracker: { getExecutionId: () => invocationId },
  });
  await app.ready();
  return { app, calls };
}

test('Alpha dynamic canary authenticates the owner and returns the real queue invocation', async (t) => {
  const { app, calls } = await fixture();
  t.after(() => app.close());
  const denied = await app.inject({
    method: 'POST',
    url: '/api/threads/thread-1/f296-alpha-dynamic-canary',
    headers: { 'x-cat-cafe-user': 'other-user' },
    payload: { runId: 'a'.repeat(40) },
  });
  assert.equal(denied.statusCode, 403);
  const response = await app.inject({
    method: 'POST',
    url: '/api/threads/thread-1/f296-alpha-dynamic-canary',
    headers: { 'x-cat-cafe-user': 'owner-1' },
    payload: { runId: 'a'.repeat(40) },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: 'processing',
    invocationId: 'invocation-alpha',
    producer: 'meeting_artifact',
    opportunityKind: 'memory_write_opportunity',
  });
  assert.deepEqual(calls, [{ ownerId: 'owner-1', threadId: 'thread-1', runId: 'a'.repeat(40) }]);
});

test('Alpha dynamic canary never accepts a synthetic ledger payload', async (t) => {
  const { app, calls } = await fixture();
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/api/threads/thread-1/f296-alpha-dynamic-canary',
    headers: { 'x-cat-cafe-user': 'owner-1' },
    payload: { runId: 'a'.repeat(40), ledgerOutcome: 'committed', opportunityId: 'forged' },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(calls.length, 0);
});

test('Alpha dynamic canary is absent outside the explicit Alpha deployment', async (t) => {
  const { app, calls } = await fixture({ enabled: false });
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/api/threads/thread-1/f296-alpha-dynamic-canary',
    headers: { 'x-cat-cafe-user': 'owner-1' },
    payload: { runId: 'a'.repeat(40) },
  });
  assert.equal(response.statusCode, 404);
  assert.equal(calls.length, 0);
});
