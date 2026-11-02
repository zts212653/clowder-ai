import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TurnExecutionStartupReconciler } from '../dist/domains/cats/services/agents/invocation/TurnExecutionStartupReconciler.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { serializeTurnExecutionIdentity } from '../dist/domains/cats/services/stores/ports/TurnExecutionStore.js';
import { RedisTurnExecutionStore } from '../dist/domains/cats/services/stores/redis/RedisTurnExecutionStore.js';

for (const startedAt of [0, 50])
  test(`restart retains an unconfirmed provider and its response until exact teardown proof; started=${startedAt}`, async () => {
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
    create('unconfirmed');
    assert.equal(store.markProviderStarted('unconfirmed', startedAt), true);
    create('confirmed');
    assert.equal(store.markProviderStarted('confirmed', startedAt), true);
    store.recordProviderTeardown('confirmed', 70);
    create('not-dispatched');
    create('legacy', false);
    const settled = [];
    let now = 200;
    const reconciler = new TurnExecutionStartupReconciler({
      store,
      now: () => now,
      settleEndedTurnResponse: async (turn) => {
        settled.push(turn.invocationId);
        store.clearResponsePending(turn.invocationId);
      },
    });
    const first = await reconciler.reconcile({ processStartedAt: 100 });
    assert.equal(store.get('unconfirmed').status, 'running', 'restart time cannot prove that a native writer stopped');
    assert.equal(store.get('unconfirmed').providerTeardownAt, undefined);
    assert.deepEqual(
      store.listRunningByUser('owned-user').map((record) => record.invocationId),
      ['unconfirmed'],
    );
    assert.deepEqual(new Set(first.invocationIds), new Set(['confirmed', 'not-dispatched', 'legacy']));
    assert.equal(settled.includes('unconfirmed'), false, 'the existing response must remain nonterminal');
    store.recordProviderTeardown('unconfirmed', 220);
    now = 250;
    const second = await reconciler.reconcile({ processStartedAt: 100 });
    assert.deepEqual(second.invocationIds, ['unconfirmed']);
    assert.equal(store.get('unconfirmed').status, 'interrupted');
    assert.equal(settled.filter((id) => id === 'unconfirmed').length, 1);
  });

test('the real Redis owner hydrates the unconfirmed fact and does not issue a restart terminal write', async () => {
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
  let writes = 0;
  const store = new RedisTurnExecutionStore({
    smembers: async () => [input.invocationId],
    hgetall: async () => hash,
    eval: async () => {
      writes++;
      throw new Error('unexpected terminal write');
    },
    srem: async () => {
      writes++;
      throw new Error('unexpected running-index removal');
    },
  });
  assert.equal((await store.get(input.invocationId)).providerStartedAt, 0);
  assert.deepEqual(await store.interruptRunningBefore(100, { endedAt: 200, terminalReason: 'process_restart' }), []);
  assert.equal(writes, 0);
});
