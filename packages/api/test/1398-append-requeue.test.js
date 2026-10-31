import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { InMemoryQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { appendRecoveryFixture as fixture } from './helpers/append-recovery-fixture.js';

test('memory native read removes only the held target beside a live sibling claim', async () => {
  const ledger = new InMemoryQueueLedgerStore();
  let inputRead;
  const f = await fixture(
    async (input) => {
      inputRead = input.onInputRead;
      return { accepted: false, reason: 'exception', acceptance: 'unknown' };
    },
    { ledgerStore: ledger },
  );
  await f.queue.reconcileQueuedMessageTargetsDurable('thread', 'owner', f.admission.entry.id, ['codex'], [], {});
  await f.append();
  await ledger.claim('thread', f.admission.entry.id, 'sibling', Date.now(), 'codex');
  assert.equal(
    (await ledger.reconcileTargets('thread', f.admission.entry.id, [], ['codex'], {})).outcome,
    'state_changed',
  );
  assert.equal(
    (await ledger.reconcileTargets('thread', f.admission.entry.id, ['kimi'], [], {})).outcome,
    'state_changed',
  );
  await inputRead();
  const entry = await ledger.get('thread', f.admission.entry.id);
  assert.deepEqual(entry.targets, ['codex']);
  assert.equal(entry.claimId, 'sibling');
  assert.deepEqual(entry.claimedTargetIds, ['codex']);
});

for (const closeTiming of ['after', 'during']) {
  test(`a definite refusal starts one original-source turn when the old run closes ${closeTiming} recovery`, async () => {
    const starts = [];
    const f = await fixture(
      async () => {
        if (closeTiming === 'during') f.invocationTracker.completeSlot('thread', 'opus');
        return { accepted: false, reason: 'active_run_closed', acceptance: 'not_accepted' };
      },
      {
        routeExecution: async function* (userId, content, threadId, messageId, targets, _meta, options) {
          starts.push({ content, messageId, targets });
          const startedAt = Date.now();
          await options.onLifecycleInvocationStarted({
            threadId,
            userId,
            catId: 'opus',
            invocationId: 'next-turn',
            parentInvocationId: options.parentInvocationId,
            startedAt,
          });
          await options.onPromptMessagesExposed({
            threadId,
            userId,
            catId: 'opus',
            invocationId: 'next-turn',
            messageIds: [messageId],
            seenAt: startedAt + 1,
          });
          yield { type: 'text', catId: 'opus', content: 'received in next turn', timestamp: startedAt + 2 };
          yield { type: 'done', catId: 'opus', isFinal: true, timestamp: startedAt + 3 };
        },
      },
    );
    await f.append();
    if (closeTiming === 'after') {
      await f.processor.requestDrain('thread');
      await f.processor.reconcileAppendDeliveries('thread');
      assert.equal(starts.length, 0);
      f.invocationTracker.completeSlot('thread', 'opus');
      await f.processor.requestDrain('thread');
      await f.processor.reconcileAppendDeliveries('thread');
    }
    for (let i = 0; i < 100 && (await f.queue.getDurableEntry('thread', f.admission.entry.id)); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(starts, [{ content: 'one original input', messageId: f.admission.message.id, targets: ['opus'] }]);
    assert.equal(await f.queue.getDurableEntry('thread', f.admission.entry.id), null);
    const source = f.messageStore.getById(f.admission.message.id);
    assert.notEqual(source.lifecycle.dispatchRefs[0].statusMessageId, f.response.id);
    assert.equal(
      f.messageStore.getById(source.lifecycle.dispatchRefs[0].statusMessageId).lifecycle.invocationId,
      'next-turn',
    );
  });
}

for (const reason of ['active_run_closed', 'active_run_mismatch', 'provider_rejected']) {
  test(`definite ${reason} keeps the original source and admission queued for the same cat`, async () => {
    const dispatch = mock.fn(async () => ({ accepted: false, reason, acceptance: 'not_accepted' }));
    const f = await fixture(dispatch);
    await f.append();
    const queued = await f.queue.getDurableEntry('thread', f.admission.entry.id);
    assert.ok(queued, 'unaccepted input must have a durable next Queue owner');
    assert.equal(queued.status, 'queued');
    assert.deepEqual(queued.from, f.admission.entry.from);
    assert.deepEqual(queued.owner, f.admission.entry.owner);
    assert.deepEqual(queued.execution, f.admission.entry.execution);
    assert.deepEqual(queued.payload, f.admission.entry.payload);
    assert.deepEqual(queued.targets, ['opus']);
    assert.equal(queued.delivery.appendRecoveryByTarget.opus.reason, reason);
    assert.equal(f.messageStore.getById(f.admission.message.id).content, 'one original input');
    assert.deepEqual(f.messageStore.getById(f.admission.message.id).lifecycle.dispatchRefs, []);
    assert.deepEqual(f.messageStore.getById(f.response.id).lifecycle.inputMessageIds, []);
    assert.equal(
      await f.queue.claimExactExposureDurable('thread', 'owner', queued.id, 'opus', f.admission.message.id),
      null,
      'an old run cannot adopt next-work recovery through a full-body read',
    );
    await f.processor.requestDrain('thread');
    await f.processor.reconcileAppendDeliveries('thread');
    assert.equal(dispatch.mock.calls.length, 1, 'recovery waits for the next run instead of appending again');
    assert.equal(
      f.messageStore.getByThread('thread', 100, 'owner').filter((m) => m.lifecycle?.kind === 'delivery_failure').length,
      0,
    );
  });
}

test('inputRead before a contradictory rejection keeps this run as the only receiver', async () => {
  const f = await fixture(async (input) => {
    await input.onInputRead();
    return { accepted: false, reason: 'active_run_closed', acceptance: 'not_accepted' };
  });
  await f.append();
  assert.equal(await f.queue.getDurableEntry('thread', f.admission.entry.id), null);
  const ref = f.messageStore.getById(f.admission.message.id).lifecycle.dispatchRefs[0];
  assert.equal(ref.statusMessageId, f.response.id);
  assert.equal(ref.inputRead.status, 'read');
  assert.equal(
    f.messageStore.getByThread('thread', 100, 'owner').filter((m) => m.lifecycle?.kind === 'delivery_failure').length,
    0,
  );
});

for (const outcome of ['throw', 'unknown', 'legacy-provider-rejected']) {
  test(`${outcome} never auto-resends; a late native receipt settles the original run`, async () => {
    let inputRead;
    const dispatch = mock.fn(async (input) => {
      inputRead = input.onInputRead;
      if (outcome === 'throw') throw new Error('transport lost after write');
      return {
        accepted: false,
        reason: 'provider_rejected',
        ...(outcome === 'unknown' ? { acceptance: 'unknown' } : {}),
      };
    });
    const f = await fixture(dispatch);
    await f.append();
    const queued = await f.queue.getDurableEntry('thread', f.admission.entry.id);
    assert.equal(queued.delivery.appendRecoveryByTarget.opus.acceptance, 'unknown');
    assert.equal(
      queued.delivery.appendRecoveryByTarget.opus.reason,
      outcome === 'throw' ? 'exception' : 'provider_rejected',
    );
    assert.deepEqual(queued.delivery.routingHeldTargetIds, ['opus']);
    await f.processor.requestDrain('thread');
    await f.processor.reconcileAppendDeliveries('thread');
    assert.equal(dispatch.mock.calls.length, 1);
    await inputRead();
    assert.equal(
      await f.queue.getDurableEntry('thread', f.admission.entry.id),
      null,
      'native receipt retires the uncertain retry without another execution',
    );
    const ref = f.messageStore.getById(f.admission.message.id).lifecycle.dispatchRefs[0];
    assert.equal(ref.statusMessageId, f.response.id);
    assert.equal(ref.inputRead.status, 'read');
    assert.equal(
      f.messageStore.getByThread('thread', 100, 'owner').filter((m) => m.lifecycle?.kind === 'delivery_failure').length,
      0,
    );
  });
}

test('same-ID retry cannot release an uncertain target, even after reconciliation', async () => {
  const dispatch = mock.fn(async () => ({ accepted: false, reason: 'provider_rejected', acceptance: 'unknown' }));
  const f = await fixture(dispatch);
  await f.append();
  await f.processor.requestDrain('thread');
  await f.processor.reconcileAppendDeliveries('thread');
  assert.deepEqual(await f.processor.retryRoutingTarget('thread', 'owner', f.admission.entry.id, 'opus'), {
    started: false,
  });
  const queued = await f.queue.getDurableEntry('thread', f.admission.entry.id);
  assert.deepEqual(queued.payload, f.admission.entry.payload);
  assert.deepEqual(queued.delivery.routingHeldTargetIds, ['opus']);
  assert.ok(queued.delivery.appendRecoveryByTarget.opus.checkedAt);
  assert.equal(f.messageStore.getById(f.admission.message.id).lifecycle.dispatchRefs[0].statusMessageId, f.response.id);
  assert.equal(dispatch.mock.calls.length, 1);
});
