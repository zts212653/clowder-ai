import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.ts';
import { InMemoryQueueLedgerStore } from '../src/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.ts';
import { queueLedgerAdmissionFingerprint } from '../src/domains/cats/services/agents/invocation/queue-ledger/QueueLedger.ts';
import { createQueueLedgerAdmission } from '../src/domains/cats/services/agents/invocation/queue-ledger/QueueLedgerAdmission.ts';
import { hydrateQueueLedgerEntry } from '../src/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerCodec.ts';

// Actual Queue/cache and codec, with an owned in-memory ledger. No service,
// MessageStore transaction, active child, Redis process or UI claim is made here.
function input(extra = {}) {
  return {
    threadId: 'isolated-integration',
    userId: 'isolated-owner',
    kind: 'conversation_input',
    from: { kind: 'external', connectorId: 'isolated-connector' },
    ownerAuthProvenance: 'unknown',
    content: 'owned input',
    messageId: 'isolated-message',
    targetCats: ['codex'],
    intent: 'execute',
    ...extra,
  };
}

test('source notification sees the committed canonical projection, not an uncommitted entry', async () => {
  const ledger = new InMemoryQueueLedgerStore();
  const queue = new InvocationQueue(ledger);
  const observed = [];
  queue.onSourceChanged((threadId, userId) => observed.push(queue.list(threadId, userId)));
  const admitted = await queue.enqueueDurable(input());
  assert.equal(observed.length, 1);
  assert.equal(observed[0][0].id, admitted.entry.id);
  assert.deepEqual(observed[0][0], await ledger.get(input().threadId, admitted.entry.id));
  assert.equal(
    await queue.enqueueDurable(input({ content: 'different identity envelope' })).then(
      () => 'unexpected admission',
      () => 'conflict',
    ),
    'conflict',
  );
  assert.equal(observed.length, 1, 'refused admission cannot publish a source notification');
});

test('listener failure cannot roll back admission; unsubscribe and private rows are quiet', async () => {
  const queue = new InvocationQueue();
  let calls = 0;
  const stop = queue.onSourceChanged(() => {
    calls++;
    throw new Error('disposable listener');
  });
  assert.equal((await queue.enqueueDurable(input())).outcome, 'enqueued');
  assert.equal(calls, 1);
  stop();
  await queue.enqueueDurable(input({ messageId: 'another-message' }));
  assert.equal(calls, 1);
  queue.onSourceChanged(() => {
    calls++;
  });
  await queue.enqueueDurable(input({ kind: 'private_input', sourceId: 'isolated-private', messageId: undefined }));
  assert.equal(calls, 1, 'private work does not become a public inbox body');
});

for (const owner of [
  { sourceCategory: 'scheduled' },
  { actionSuccessorFence: { leaseId: 'isolated-lease', generation: 1, dispatchId: 'isolated-dispatch' } },
  { waitContinuationCarrier: { v: 1, waitId: 'isolated-wait' } },
]) {
  test(`ordinary full-body History selection cannot take ${Object.keys(owner)[0]} work`, async () => {
    const queue = new InvocationQueue();
    const admitted = await queue.enqueueDurable(input(owner));
    assert.deepEqual(queue.getQueuedBodyMessagesForCat(input().threadId, input().userId, 'codex'), []);
    assert.equal(
      await queue.claimExactExposureDurable(
        input().threadId,
        input().userId,
        admitted.entry.id,
        'codex',
        input().messageId,
      ),
      null,
    );
    assert.equal((await queue.getDurableEntry(input().threadId, admitted.entry.id)).status, 'queued');
  });
}

test('explicit producer_return remains an ordinary readable pending source, without fabricated authority', async () => {
  const queue = new InvocationQueue();
  await queue.enqueueDurable(input({ sourceCategory: 'producer_return' }));
  const [body] = queue.getQueuedBodyMessagesForCat(input().threadId, input().userId, 'codex');
  assert.equal(body.content, input().content);
  assert.equal(body.readDisposition, 'adopt');
});

test('restart after durable History adoption retires only the exact target, not a pending sibling', async () => {
  const ledger = new InMemoryQueueLedgerStore();
  const queue = new InvocationQueue(ledger);
  const admitted = await queue.enqueueDurable(
    input({ targetCats: ['codex', 'opus'], sourceCategory: 'producer_return' }),
  );
  assert.equal(
    (await ledger.claim(input().threadId, admitted.entry.id, 'isolated-short-claim', 2, 'codex')).outcome,
    'claimed',
  );
  const restored = new InvocationQueue(ledger);
  await restored.hydrateFromLedger({ getById: async () => ({ lifecycle: { dispatchRefs: [{ targetId: 'codex' }] } }) });
  const [pending] = restored.list(input().threadId, input().userId);
  assert.deepEqual(pending.targets, ['opus']);
  assert.equal(pending.sourceCategory, 'producer_return');
  assert.equal(pending.status, 'queued');
  assert.deepEqual(restored.getQueuedBodyMessagesForCat(input().threadId, input().userId, 'codex'), []);
});

test('uncommitted full-body adoption can be restored; committed target never reappears on restart', async () => {
  const ledger = new InMemoryQueueLedgerStore();
  const queue = new InvocationQueue(ledger);
  const admitted = await queue.enqueueDurable(input());
  const claim = await queue.claimExactExposureDurable(
    input().threadId,
    input().userId,
    admitted.entry.id,
    'codex',
    input().messageId,
  );
  assert.equal(claim.status, 'claimed');
  assert.equal(await queue.restoreClaimedEntries(input().threadId, [admitted.entry.id]), true);
  assert.equal((await queue.getDurableEntry(input().threadId, admitted.entry.id)).status, 'queued');
  await queue.claimExactExposureDurable(
    input().threadId,
    input().userId,
    admitted.entry.id,
    'codex',
    input().messageId,
  );
  assert.ok(
    await queue.commitClaimedAdoptionDurable(
      input().threadId,
      input().userId,
      admitted.entry.id,
      'codex',
      'isolated-exact-child',
      3,
    ),
  );
  const restored = new InvocationQueue(ledger);
  await restored.hydrateFromLedger();
  assert.deepEqual(restored.list(input().threadId, input().userId), []);
});

test('retired private input preserves immutable scope/category receipt without resurrecting work', async () => {
  const queue = new InvocationQueue();
  const original = input({
    kind: 'private_input',
    messageId: undefined,
    sourceId: 'isolated-private-retired',
    sourceCategory: 'producer_return',
    executionScope: 'collective-participation',
  });
  const admitted = await queue.enqueueDurable(original);
  assert.ok(await queue.claimQueuedEntryForWithdrawal(original.threadId, original.userId, admitted.entry.id));
  assert.ok(await queue.commitClaimedWithdrawal(original.threadId, admitted.entry.id));
  assert.deepEqual((await queue.enqueueDurable(original)).entries, []);
  await assert.rejects(queue.enqueueDurable({ ...original, executionScope: undefined }), /identity conflict/);
  await assert.rejects(queue.enqueueDurable({ ...original, sourceCategory: 'review' }), /identity conflict/);
  assert.deepEqual(queue.list(original.threadId, original.userId), []);
});

for (const executionScope of ['collective-participation', 'collective-work']) {
  test(`${executionScope} survives admission, codec and restart without managed owner elevation`, async () => {
    const ledger = new InMemoryQueueLedgerStore();
    const queue = new InvocationQueue(ledger);
    const from = executionScope === 'collective-work' ? { kind: 'system', service: 'collective-work' } : input().from;
    const admitted = await queue.enqueueDurable(input({ executionScope, from }));
    const roundTrip = hydrateQueueLedgerEntry(JSON.stringify(admitted.entry));
    assert.equal(roundTrip.execution.executionScope, executionScope);
    assert.equal(roundTrip.execution.ownerAuthProvenance, 'unknown');
    const restored = new InvocationQueue(ledger);
    await restored.hydrateFromLedger();
    assert.equal(restored.list(input().threadId, input().userId)[0].execution.executionScope, executionScope);
    await assert.rejects(queue.enqueueDurable(input({ from })), /identity conflict/);
  });
}

test('codec rejects malformed or elevated collective scope; legacy unscoped rows remain readable', () => {
  const [entry] = createQueueLedgerAdmission({
    sourceId: 'isolated-codec',
    threadId: input().threadId,
    owner: { kind: 'user', userId: input().userId },
    kind: 'conversation_input',
    from: input().from,
    targetCatIds: ['codex'],
    content: input().content,
    intent: 'execute',
    ownerAuthProvenance: 'unknown',
    enqueuedAt: 1,
  });
  assert.deepEqual(hydrateQueueLedgerEntry(JSON.stringify(entry)), entry);
  for (const executionScope of ['bogus-scope', 'collective-participation']) {
    const invalid = structuredClone(entry);
    invalid.execution.executionScope = executionScope;
    if (executionScope === 'collective-participation') invalid.execution.ownerAuthProvenance = 'strict';
    assert.throws(() => hydrateQueueLedgerEntry(JSON.stringify(invalid)), /scope/i);
  }
  const scoped = structuredClone(entry);
  scoped.execution.executionScope = 'collective-participation';
  assert.notEqual(queueLedgerAdmissionFingerprint(entry), queueLedgerAdmissionFingerprint(scoped));
});
