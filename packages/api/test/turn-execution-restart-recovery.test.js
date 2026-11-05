import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TurnExecutionStartupReconciler } from '../dist/domains/cats/services/agents/invocation/TurnExecutionStartupReconciler.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { serializeTurnExecutionIdentity } from '../dist/domains/cats/services/stores/ports/TurnExecutionStore.js';
import { RedisTurnExecutionStore } from '../dist/domains/cats/services/stores/redis/RedisTurnExecutionStore.js';

for (const startedAt of [0, 50])
  test(`restart interrupts every prior-Host child even when teardown was never recorded; started=${startedAt}`, async () => {
    const store = new InMemoryTurnExecutionStore();
    const create = (invocationId, tracked = true) =>
      store.createRunning({
        invocationId,
        parentInvocationId: 'owned-parent',
        threadId: 'owned-thread',
        userId: 'owned-user',
        catId: invocationId,
        executionKind: 'ordinary',
        startedAt,
        ...(tracked ? { providerLifecycleTracked: true } : {}),
      });
    create('started-without-teardown');
    assert.equal(store.markProviderStarted('started-without-teardown', startedAt), true);
    create('closed');
    assert.equal(store.markProviderStarted('closed', startedAt), true);
    store.recordProviderTeardown('closed', 70);
    create('not-dispatched');
    create('legacy', false);
    const settled = [];
    const reconciler = new TurnExecutionStartupReconciler({
      store,
      now: () => 200,
      settleEndedTurnResponse: async (turn) => {
        settled.push(turn.invocationId);
        store.clearResponsePending(turn.invocationId);
      },
    });
    const first = await reconciler.reconcile({ processStartedAt: 100 });
    assert.equal(
      store.get('started-without-teardown').status,
      'interrupted',
      'the new Host retires all prior-Host ownership',
    );
    assert.equal(store.get('started-without-teardown').providerTeardownAt, undefined);
    assert.deepEqual(store.listRunningByUser('owned-user'), []);
    assert.deepEqual(
      new Set(first.invocationIds),
      new Set(['started-without-teardown', 'closed', 'not-dispatched', 'legacy']),
    );
    assert.equal(settled.filter((id) => id === 'started-without-teardown').length, 1);
  });

test('the Redis store terminalizes a prior-Host child without teardown telemetry and removes its running index', async () => {
  const input = {
    invocationId: 'owned-redis-child',
    parentInvocationId: 'owned-parent',
    threadId: 'owned-thread',
    userId: 'owned-user',
    catId: 'owned-cat',
    executionKind: 'ordinary',
    startedAt: 0,
    providerLifecycleTracked: true,
  };
  const hash = {
    ...Object.fromEntries(Object.entries(input).map(([key, value]) => [key, String(value)])),
    providerLifecycleTracked: '1',
    providerStartedAt: '0',
    status: 'running',
    outputFence: 'open',
    immutableIdentity: serializeTurnExecutionIdentity(input),
  };
  const writes = [];
  const store = new RedisTurnExecutionStore({
    smembers: async () => [input.invocationId],
    hgetall: async () => hash,
    eval: async (...args) => {
      writes.push(['eval', ...args]);
      hash.status = 'interrupted';
      hash.endedAt = '200';
      hash.terminalReason = 'process_restart';
      return 1;
    },
    srem: async (...args) => {
      writes.push(['srem', ...args]);
      return 1;
    },
  });
  assert.equal((await store.get(input.invocationId)).providerStartedAt, 0);
  const interrupted = await store.interruptRunningBefore(100, {
    endedAt: 200,
    terminalReason: 'process_restart',
  });
  assert.deepEqual(
    interrupted.map((record) => record.invocationId),
    [input.invocationId],
  );
  assert.equal(interrupted[0].status, 'interrupted');
  assert.equal(interrupted[0].providerTeardownAt, undefined);
  assert.equal(
    writes.some(([kind]) => kind === 'eval'),
    true,
  );
});
