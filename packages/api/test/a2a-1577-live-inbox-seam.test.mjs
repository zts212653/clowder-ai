import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.ts';
import { queueEntryId } from '../src/domains/cats/services/agents/invocation/queue-ledger/QueueLedger.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { MessageLiveInboxSource } from '../src/domains/concierge/live/inbox/MessageLiveInboxSource.ts';

const scope = {
  userId: 'isolated-owner',
  threadId: 'isolated-live',
  catId: 'codex',
  invocationId: 'isolated-child',
  parentInvocationId: 'isolated-parent',
  callId: 'isolated-call',
  generation: 1,
};
async function fixture(extra = {}) {
  const store = new MessageStore();
  const queue = new InvocationQueue();
  const message = {
    userId: scope.userId,
    threadId: scope.threadId,
    from: { kind: 'external', connectorId: 'isolated' },
    content: 'secret body',
    mentions: ['codex', 'opus'],
    timestamp: 1,
    deliveryStatus: 'queued',
  };
  const admitted = await queue.send(store, message, {
    ...message,
    kind: 'conversation_input',
    ownerAuthProvenance: 'unknown',
    targetCats: ['codex', 'opus'],
    intent: 'execute',
    sourceCategory: 'producer_return',
    ...extra,
  });
  const source = new MessageLiveInboxSource({
    store,
    queue,
    authorize: async () => true,
    retainsCurrentInvocationReads: () => true,
  });
  return { store, queue, source, admitted };
}
test('real pending ledger source produces a bodyless reference without Message custody shadow', async () => {
  const f = await fixture();
  const { items } = await f.source.page(scope, undefined, 10);
  assert.equal(items.length, 1);
  assert.equal(items[0].queueEntryId, f.admitted.entry.id);
  assert.equal(items[0].nextWork, false);
  assert.deepEqual(items[0].facts, {
    persisted: true,
    notified: false,
    readByInvocationIds: [],
    readInCurrentContext: false,
    handled: false,
    playback: 'unknown',
  });
  assert.doesNotMatch(JSON.stringify(items), /secret body/);
  assert.deepEqual((await f.queue.getDurableEntry(scope.threadId, f.admitted.entry.id)).targets, ['codex', 'opus']);
});
test('structured owner is succession-only; cross-owner and unauthorized projections stay closed', async () => {
  const f = await fixture({ sourceCategory: 'scheduled' });
  assert.equal((await f.source.read(scope, f.admitted.message.id)).nextWork, true);
  assert.equal(await f.source.read({ ...scope, userId: 'other' }, f.admitted.message.id), null);
  const denied = new MessageLiveInboxSource({ store: f.store, queue: f.queue, authorize: async () => false });
  await assert.rejects(denied.page(scope, undefined, 10), /authority unavailable/);
});
for (const unread of [false, true])
  test(`canonical History ${unread ? 'unread' : 'read'} is projected from exact response lineage`, async () => {
    const f = await fixture();
    const id = f.admitted.message.id;
    const original = f.store.getById(id);
    assert.ok(await f.queue.claimExactExposureDurable(scope.threadId, scope.userId, f.admitted.entry.id, 'codex', id));
    const response = f.store.append({
      userId: scope.userId,
      threadId: scope.threadId,
      from: { kind: 'agent', catId: 'codex' },
      content: 'response',
      mentions: [],
      timestamp: 2,
      lifecycle: {
        kind: 'response',
        orderKey: 'response-order',
        invocationId: scope.invocationId,
        targetId: 'codex',
        inputEntryIds: [queueEntryId(id)],
        inputMessageIds: [id],
        status: 'completed',
        startedAt: 2,
        completedAt: 3,
      },
    });
    assert.equal(
      f.store.advanceLifecycleInputDispatch(id, {
        orderKey: original.lifecycle.orderKey,
        targetId: 'codex',
        phase: 'dispatched',
        statusMessageId: response.id,
        dispatchedAt: 2,
        ...(unread ? { readState: 'awaiting' } : {}),
      }).kind,
      'applied',
    );
    assert.equal(
      f.store.advanceLifecycleInputDispatch(id, {
        orderKey: original.lifecycle.orderKey,
        targetId: 'codex',
        phase: 'settled',
        statusMessageId: response.id,
      }).kind,
      'applied',
    );
    const item = await f.source.read(scope, id);
    assert.deepEqual(item.facts.readByInvocationIds, unread ? [] : [scope.invocationId]);
    assert.equal(item.facts.readInCurrentContext, !unread);
    assert.equal(item.facts.handled, true);
    assert.equal(item.nextWork, true, 'a stale pending cache cannot re-expose already dispatched History');
    await f.queue.hydrateFromLedger(f.store);
    assert.deepEqual((await f.queue.getDurableEntry(scope.threadId, f.admitted.entry.id)).targets, ['opus']);
    assert.deepEqual(
      (await f.source.read(scope, id)).facts,
      item.facts,
      'source facts survive removal of the exact pending target',
    );
  });

for (const [label, overrides] of [
  ['another thread', { threadId: 'other' }],
  ['another owner', { userId: 'other' }],
  ['another cat', { from: { kind: 'agent', catId: 'opus' } }],
  ['another input', { inputMessageIds: ['other'] }],
  ['another entry', { inputEntryIds: ['other'] }],
])
  test(`History ref to ${label} cannot establish a read or handled witness`, async () => {
    const f = await fixture();
    const id = f.admitted.message.id;
    const { inputMessageIds, inputEntryIds, ...messageOverrides } = overrides;
    const response = f.store.append({
      userId: scope.userId,
      threadId: scope.threadId,
      from: { kind: 'agent', catId: 'codex' },
      content: 'reply',
      mentions: [],
      timestamp: 2,
      ...messageOverrides,
      lifecycle: {
        kind: 'response',
        orderKey: 'reply',
        invocationId: scope.invocationId,
        targetId: 'codex',
        inputEntryIds: inputEntryIds ?? [queueEntryId(id)],
        inputMessageIds: inputMessageIds ?? [id],
        status: 'completed',
        startedAt: 2,
        completedAt: 3,
      },
    });
    const orderKey = f.admitted.message.lifecycle.orderKey;
    f.store.advanceLifecycleInputDispatch(id, {
      orderKey,
      targetId: 'codex',
      phase: 'dispatched',
      statusMessageId: response.id,
      dispatchedAt: 2,
    });
    f.store.advanceLifecycleInputDispatch(id, {
      orderKey,
      targetId: 'codex',
      phase: 'settled',
      statusMessageId: response.id,
    });
    const item = await f.source.read(scope, id);
    assert.deepEqual(item.facts.readByInvocationIds, []);
    assert.equal(item.facts.handled, false);
  });

test('exact terminal delivery failure is handled, not a model read, even after pending target retirement', async () => {
  const f = await fixture();
  assert.ok(
    await f.queue.claimExactExposureDurable(
      scope.threadId,
      scope.userId,
      f.admitted.entry.id,
      'codex',
      f.admitted.message.id,
    ),
  );
  const failure = f.store.commitLifecyclePreAdmissionFailure({
    sourceMessageId: f.admitted.message.id,
    expectedEntryId: f.admitted.entry.id,
    requestedTargets: ['codex'],
    failedAt: 3,
    reason: 'no_available_target',
    content: 'owned delivery failure',
  });
  assert.equal(failure.kind, 'applied');
  await f.queue.hydrateFromLedger(f.store);
  const item = await f.source.read(scope, f.admitted.message.id);
  assert.equal(item.facts.handled, true);
  assert.deepEqual(item.facts.readByInvocationIds, []);
  assert.equal(item.nextWork, true);
});
