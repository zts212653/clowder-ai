import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TurnExecutionStartupReconciler } from '../src/domains/cats/services/agents/invocation/TurnExecutionStartupReconciler.js';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';

test('restart retires abandoned Host turns without claiming provider death and preserves real live owners', async () => {
  const store = new InMemoryTurnExecutionStore();
  for (const [invocationId, startedAt] of [
    ['lost', 10],
    ['live-owner', 20],
    ['current-boot', 110],
  ] as const) {
    store.createRunning({
      invocationId,
      parentInvocationId: `parent-${invocationId}`,
      threadId: 'original-thread',
      userId: 'owner',
      catId: 'opus55',
      executionKind: 'ordinary',
      startedAt,
      providerLifecycleTracked: true,
    });
    store.markProviderStarted(invocationId, startedAt);
  }
  const settled: string[] = [];
  const reconciler = new TurnExecutionStartupReconciler({
    store,
    now: () => 200,
    settleEndedTurnResponse: async (turn) => {
      settled.push(turn.invocationId);
      assert.equal(
        store.markResponseSettled(turn.invocationId, {
          kind: 'no_response',
          reason: 'recovered_no_response',
          settledAt: 200,
        }).outcome,
        'settled',
      );
    },
  });
  const result = await reconciler.reconcile({ processStartedAt: 100, protectedInvocationIds: ['live-owner'] });
  assert.deepEqual(result.invocationIds, ['lost'], 'only an abandoned turn from an earlier Host is retired');
  assert.deepEqual(settled, ['lost']);
  assert.equal(store.get('lost')?.status, 'interrupted');
  assert.equal(store.get('lost')?.terminalReason, 'process_restart');
  assert.equal(store.get('lost')?.providerTeardownAt, undefined, 'Host closure is not a fabricated stop receipt');
  assert.equal(store.get('live-owner')?.status, 'running');
  assert.equal(store.get('current-boot')?.status, 'running');
  assert.equal(store.markProviderStarted('lost', 210), false, 'retired turns cannot be dispatched again');
  assert.deepEqual(store.listResponsePending(), [], 'the abandoned response must settle too');
  assert.equal(
    (await reconciler.reconcile({ processStartedAt: 100, protectedInvocationIds: ['live-owner'] })).interruptedCount,
    0,
  );
});

test('an uncontrollable Host turn can fail without a teardown receipt', () => {
  const store = new InMemoryTurnExecutionStore();
  store.createRunning({
    invocationId: 'lost',
    parentInvocationId: 'parent',
    threadId: 'original-thread',
    userId: 'owner',
    catId: 'opus55',
    executionKind: 'ordinary',
    startedAt: 10,
    providerLifecycleTracked: true,
  });
  store.markProviderStarted('lost', 10);
  const result = store.transitionTerminal('lost', {
    status: 'failed',
    endedAt: 200,
    terminalReason: 'control_plane_unavailable',
  });
  assert.equal(result.outcome, 'transitioned');
  assert.equal(result.record?.providerTeardownAt, undefined);
  assert.deepEqual(store.listRunningByUser('owner'), []);
});
