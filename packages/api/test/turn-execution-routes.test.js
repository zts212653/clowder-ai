import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { invocationsRoutes } from '../dist/routes/invocations.js';

function child(invocationId, executionKind, startedAt) {
  return {
    invocationId,
    parentInvocationId: 'parent-glass-box-1',
    threadId: 'thread-1',
    userId: 'user-1',
    catId: 'codex-sol',
    executionKind,
    startedAt,
    causal: { triggerMessageId: 'message-1' },
  };
}

async function createApp(turnExecutionStore) {
  const app = Fastify();
  await app.register(invocationsRoutes, {
    invocationRecordStore: {
      async get() {
        return null;
      },
    },
    ...(turnExecutionStore ? { turnExecutionStore } : {}),
    messageStore: {},
    socketManager: {},
    router: {},
    invocationTracker: {},
  });
  return app;
}

describe('turn execution glass-box route', () => {
  const apps = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  test('hydrates every typed child and immutable terminal under one parent', async () => {
    const store = new InMemoryTurnExecutionStore();
    const ordinary = child('child-ordinary', 'ordinary', 100);
    const guard = child('child-guard', 'routing_guard', 200);
    const supplement = child('child-supplement', 'freshness_supplement', 300);
    for (const input of [supplement, guard, ordinary]) store.createRunning(input);
    store.transitionTerminal(ordinary.invocationId, { status: 'succeeded', endedAt: 150 });
    store.transitionTerminal(guard.invocationId, { status: 'failed', endedAt: 250, terminalReason: 'provider_error' });
    store.transitionTerminal(supplement.invocationId, {
      status: 'canceled',
      endedAt: 350,
      terminalReason: 'user_cancel',
    });
    const app = await createApp(store);
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/invocations/parent-glass-box-1/executions' });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.parentInvocationId, 'parent-glass-box-1');
    assert.equal(body.executionCount, 3);
    assert.deepEqual(
      body.executions.map(({ invocationId, executionKind, status, terminalReason }) => ({
        invocationId,
        executionKind,
        status,
        ...(terminalReason ? { terminalReason } : {}),
      })),
      [
        { invocationId: 'child-ordinary', executionKind: 'ordinary', status: 'succeeded' },
        {
          invocationId: 'child-guard',
          executionKind: 'routing_guard',
          status: 'failed',
          terminalReason: 'provider_error',
        },
        {
          invocationId: 'child-supplement',
          executionKind: 'freshness_supplement',
          status: 'canceled',
          terminalReason: 'user_cancel',
        },
      ],
    );
  });

  test('does not invent history when a parent has no durable children', async () => {
    const app = await createApp(new InMemoryTurnExecutionStore());
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/invocations/missing/executions' });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, 'TURN_EXECUTIONS_NOT_FOUND');
  });

  test('fails explicitly when production wiring omitted the ledger', async () => {
    const app = await createApp();
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/invocations/parent/executions' });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, 'TURN_EXECUTION_LEDGER_UNAVAILABLE');
  });
});
