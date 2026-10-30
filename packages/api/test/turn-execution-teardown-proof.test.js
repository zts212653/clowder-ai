import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';

const input = (invocationId, tracked = true) => ({
  invocationId,
  parentInvocationId: 'proof-parent',
  threadId: 'proof-thread',
  userId: 'proof-user',
  catId: 'codex',
  executionKind: 'ordinary',
  startedAt: 0,
  ...(tracked ? { providerLifecycleTracked: true } : {}),
});

for (const status of ['succeeded', 'failed', 'canceled', 'interrupted'])
  test(`the canonical writer rejects ${status} without dispatched provider teardown`, () => {
    const store = new InMemoryTurnExecutionStore();
    store.createRunning(input('unknown'));
    store.markProviderStarted('unknown', 0);
    assert.throws(
      () => store.transitionTerminal('unknown', { status, endedAt: 100, terminalReason: 'host_only' }),
      /provider_teardown_unconfirmed/,
    );
    assert.equal(store.get('unknown').status, 'running');
    assert.equal(store.listRunningByUser('proof-user').length, 1);
    assert.deepEqual(store.listResponsePending(), []);
    store.recordProviderTeardown('unknown', 0);
    assert.equal(
      store.transitionTerminal('unknown', { status, endedAt: 100, terminalReason: 'exact_stop' }).outcome,
      'transitioned',
    );
  });

test('atomic explicit proof, not dispatched, legacy, and terminal replay retain their existing semantics', () => {
  const store = new InMemoryTurnExecutionStore();
  for (const id of ['proof', 'not-dispatched', 'legacy']) store.createRunning(input(id, id !== 'legacy'));
  store.markProviderStarted('proof', 0);
  assert.equal(
    store.transitionTerminal('proof', { status: 'succeeded', endedAt: 100, providerTeardownAt: 0 }).outcome,
    'transitioned',
  );
  assert.equal(store.get('proof').providerTeardownAt, 0);
  for (const id of ['not-dispatched', 'legacy']) {
    assert.equal(store.transitionTerminal(id, { status: 'succeeded', endedAt: 100 }).outcome, 'transitioned');
    assert.equal(store.transitionTerminal(id, { status: 'succeeded', endedAt: 101 }).outcome, 'already_terminal');
  }
});
