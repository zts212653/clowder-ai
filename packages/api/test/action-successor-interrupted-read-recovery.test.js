// F117 replaces read-dependent startup refusal with canonical History replay.
// Actual compiled admission/QueueProcessor; controlled provider, no native-run claim.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { PersistedQueueDelivery } from '../dist/domains/cats/services/agents/invocation/PersistedQueueDelivery.js';
import { createPersistedQueueFixture } from './helpers/persisted-queue-fixture.ts';

for (const read of [false, true]) {
  test(`receiver restart acknowledges the original A2A source with read=${read}, without refusal or replacement`, async (t) => {
    const f = createPersistedQueueFixture();
    t.after(() => f.close());
    const message = {
      userId: 'isolated-owner',
      threadId: 'isolated-action-restart',
      idempotencyKey: 'one-action',
      content: 'continue the original entrusted work',
      from: { kind: 'agent', catId: 'codex' },
      mentions: ['opus'],
      timestamp: Date.now(),
      deliveryStatus: 'queued',
    };
    const work = {
      userId: message.userId,
      threadId: message.threadId,
      sourceId: message.idempotencyKey,
      idempotencyKey: message.idempotencyKey,
      content: message.content,
      from: message.from,
      kind: 'conversation_input',
      intent: 'execute',
      ownerAuthProvenance: 'strict',
      sourceCategory: 'a2a',
      targetCats: ['opus'],
    };
    const first = await f.queue.send(f.messages, message, work);
    await f.waitForAwakening(first.message.id);
    const source = f.messages.getById(first.message.id);
    const ref = source.lifecycle.dispatchRefs[0];
    const patch = {
      orderKey: source.lifecycle.orderKey,
      targetId: 'opus',
      phase: ref.phase,
      statusMessageId: ref.statusMessageId,
    };
    assert.equal(
      f.messages.advanceLifecycleInputDispatch(source.id, {
        ...patch,
        inputRead: { status: 'pending' },
      }).kind,
      'applied',
    );
    if (read)
      assert.equal(
        f.messages.advanceLifecycleInputDispatch(source.id, {
          ...patch,
          inputRead: { status: 'read', at: ref.dispatchedAt },
        }).kind,
        'applied',
      );
    // A fresh process-local Queue restores the same durable ledger and History.
    // It does not decide whether to execute from read evidence.
    const restored = new InvocationQueue(f.ledger);
    await restored.hydrateFromLedger(f.messages);
    const replay = await restored.send(f.messages, message, work);
    assert.equal(replay.deduped, true);
    assert.equal(replay.message.id, first.message.id);
    assert.equal(replay.entry, undefined);
    assert.equal(f.starts.length, 1);
    assert.deepEqual(await f.ledger.list(message.threadId), []);
    assert.equal(Object.hasOwn(replay.message, 'queueCustody'), false);
    await assert.rejects(
      restored.send(f.messages, { ...message, content: 'different action' }, { ...work, content: 'different action' }),
      /identity conflict/,
    );
    assert.equal(f.messages.getById(source.id).lifecycle.dispatchRefs[0].inputRead.status, read ? 'read' : 'pending');
  });
}

test('pending A2A replay after a Queue restart keeps one source, target and admission', async () => {
  const f = createPersistedQueueFixture(undefined, { autoDrain: false });
  const noProgress = async () => 'owned_deferred_busy';
  const input = {
    ownerUserId: 'isolated-owner',
    threadId: 'isolated-pending-action',
    targetCatId: 'opus',
    idempotencyKey: 'pending-action',
    content: 'pending action',
    ownerAuthProvenance: 'strict',
    sourceCategory: 'a2a',
    source: { connector: 'a2a', label: 'A2A' },
  };
  const firstDelivery = new PersistedQueueDelivery({ messages: f.messages, queue: f.queue, progress: noProgress });
  const first = await firstDelivery.deliver(input);
  const restored = new InvocationQueue(f.ledger);
  await restored.hydrateFromLedger(f.messages);
  const replay = await new PersistedQueueDelivery({
    messages: f.messages,
    queue: restored,
    progress: noProgress,
  }).deliver(input);
  assert.equal(replay.message.id, first.message.id);
  assert.equal(replay.entryId, first.entryId);
  assert.deepEqual(
    restored.list(input.threadId, input.ownerUserId).map((row) => row.targets),
    [['opus']],
  );
  assert.equal(f.starts.length, 0);
  await f.close();
});
