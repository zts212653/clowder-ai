import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TurnExecutionStartupReconciler } from '../dist/domains/cats/services/agents/invocation/TurnExecutionStartupReconciler.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';

for (const startedAt of [0, 50])
  test(`restart retires abandoned Host turns while preserving unknown provider exit; started=${startedAt}`, async () => {
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
        store.markResponseSettled(turn.invocationId, {
          kind: 'no_response',
          reason: 'recovered_no_response',
          settledAt: now,
        });
      },
    });
    const first = await reconciler.reconcile({ processStartedAt: 100 });
    assert.equal(
      store.get('unconfirmed').status,
      'interrupted',
      'Host recovery does not claim that a native writer stopped',
    );
    assert.equal(store.get('unconfirmed').providerTeardownAt, undefined);
    assert.deepEqual(
      store.listRunningByUser('owned-user').map((record) => record.invocationId),
      [],
    );
    assert.deepEqual(new Set(first.invocationIds), new Set(['unconfirmed', 'confirmed', 'not-dispatched', 'legacy']));
    assert.equal(
      settled.includes('unconfirmed'),
      true,
      'the abandoned Host response can close without claiming physical exit',
    );
    store.recordProviderTeardown('unconfirmed', 220);
    now = 250;
    const second = await reconciler.reconcile({ processStartedAt: 100 });
    assert.deepEqual(second.invocationIds, []);
    assert.equal(store.get('unconfirmed').status, 'interrupted');
    assert.equal(settled.filter((id) => id === 'unconfirmed').length, 1);
  });
