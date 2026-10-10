import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.ts';
import { InMemoryQueueLedgerStore } from '../src/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.ts';
import { settleLifecycleResponseInputs } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { createCanonicalLiveSourceFixture as fixture } from './helpers/1398-live-source-fixture.mjs';

const intent = { requested: 'continue_current', boundParentInvocationId: 'live-parent' };
for (const status of ['succeeded', 'failed', 'canceled']) {
  test('native Live ' + status + ' cannot deliver an unaccepted pending source', async (t) => {
    const ledger = new InMemoryQueueLedgerStore();
    const f = await fixture(intent, 'agent', { ledgerStore: ledger });
    t.after(f.close);
    f.turns.transitionTerminal(f.auth.invocationId, {
      status,
      endedAt: Date.now(),
      terminalReason: 'fixture_' + status,
    });
    const drain = t.mock.method(f.processor, 'requestDrain', async () => {});
    await f.processor.onInvocationComplete(
      'home',
      'codex-astra',
      status,
      'live-parent',
      ['codex-astra'],
      false,
      { 'codex-astra': f.auth.invocationId },
      [],
      {},
      true,
    );
    assert.equal(drain.mock.callCount(), 1, 'completion requests ordinary Queue progression, not a synthetic delivery');
    assert.deepEqual((await f.queue.getDurableEntry('home', f.entry.id)).targets, ['codex-astra', 'kimi']);
    assert.equal(f.store.getById(f.message.id).lifecycle.dispatchRefs.length, 0);
    const cold = new InvocationQueue(ledger);
    await cold.hydrateFromLedger(f.store);
    assert.deepEqual(
      cold.list('home', 'owner').map((e) => e.targets),
      [['codex-astra', 'kimi']],
    );
  });
}
for (const status of ['completed', 'failed', 'interrupted']) {
  test('accepted Live input stays delivered when its original result becomes ' + status, async (t) => {
    const f = await fixture(intent, 'agent');
    t.after(f.close);
    assert.equal((await f.read()).statusCode, 200);
    const result = f.store.commitLifecycleResponseTerminal(f.response.id, {
      invocationId: f.auth.invocationId,
      status,
      completedAt: Date.now(),
      content: 'original result',
      mentions: [],
      origin: 'stream',
    });
    assert.equal(result.kind, 'applied');
    await settleLifecycleResponseInputs(f.store, result.message, f.response.id);
    const source = f.store.getById(f.message.id);
    assert.equal(source.lifecycle.dispatchRefs[0].statusMessageId, f.response.id);
    assert.equal(source.lifecycle.dispatchRefs[0].phase, 'settled');
    assert.deepEqual((await f.queue.getDurableEntry('home', f.entry.id)).targets, ['kimi']);
  });
}
test('a naked reply cannot substitute for canonical admission, and Live policy cannot change on the same child', async (t) => {
  const f = await fixture(intent, 'agent');
  t.after(f.close);
  const input = {
    ...f.scope,
    executionKind: 'ordinary',
    queueCompletionPolicy: 'explicit_source',
    startedAt: f.turns.get(f.auth.invocationId).startedAt,
  };
  assert.equal(f.turns.createRunning(input).outcome, 'replayed');
  const { queueCompletionPolicy, ...other } = input;
  assert.equal(f.turns.createRunning(other).outcome, 'conflict');
  f.store.append({
    from: { kind: 'agent', catId: 'codex-astra' },
    userId: 'owner',
    threadId: 'home',
    content: 'reply before admission',
    mentions: [],
    replyTo: f.message.id,
    timestamp: Date.now(),
  });
  assert.equal(f.store.getById(f.message.id).lifecycle.dispatchRefs.length, 0);
  assert.deepEqual((await f.queue.getDurableEntry('home', f.entry.id)).targets, ['codex-astra', 'kimi']);
});
