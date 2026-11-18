import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PersistedQueueDelivery } from '../dist/domains/cats/services/agents/invocation/PersistedQueueDelivery.js';
import { MessageQueueRuntimeConversationReturnGateway } from '../dist/domains/runtime-interaction/MessageQueueRuntimeConversationReturnGateway.js';
import { appendA2ASourceWithLedgerAdmission } from '../dist/routes/callback-a2a-trigger.js';
import { stopFixture, waitFor } from './helpers/stop-private-fixture.js';

async function settled(h, cat) {
  await waitFor(() => !h.processor.hasProcessingSlotReservation('thread', cat) && !h.tracker.has('thread', cat));
}

for (const timing of ['before', 'after']) {
  for (const actor of ['system', 'external']) {
    test(`#2008 ${actor} connector queued ${timing} completion retains its suppressed result`, async (t) => {
      const h = await stopFixture(t, { idle: true });
      h.processor.suppressAutoResume('thread', 'sonnet', ['old-stop']);
      if (timing === 'after') {
        await h.send('ordinary input', ['sonnet']);
        await h.processor.onInvocationComplete('thread', 'sonnet', 'canceled_by_user', 'new-completion', []);
        await settled(h, 'sonnet');
        assert.ok(h.starts.includes('ordinary input'));
      }
      const delivery = new PersistedQueueDelivery({
        messages: h.messages,
        queue: h.queue,
        progress: (entry, cat) => h.processor.progressOwnedCarrier(entry, cat),
      });
      const result = await delivery.deliver({
        ownerUserId: 'owner',
        threadId: 'thread',
        targetCatId: 'sonnet',
        idempotencyKey: 'connector-wake',
        content: 'connector wake',
        source: { connector: 'hold-ball', label: 'wake' },
        ...(actor === 'system' ? { from: { kind: 'system', service: 'hold-ball' }, sourceCategory: 'scheduled' } : {}),
      });
      assert.equal(result.state, 'owned_deferred_suppressed');
      if (timing === 'before') {
        await h.processor.onInvocationComplete('thread', 'sonnet', 'canceled_by_user', 'new-completion', []);
        await settled(h, 'sonnet');
      }
      let otherCompleted = false;
      const complete = h.processor.onInvocationComplete.bind(h.processor);
      h.processor.onInvocationComplete = async (...args) => {
        await complete(...args);
        if (args[1] === 'gemini' && args[2] === 'succeeded') otherCompleted = true;
      };
      await h.send('unrelated signal', ['gemini']);
      await h.processor.requestDrain('thread');
      await waitFor(() => otherCompleted);
      assert.equal(h.starts.includes('connector wake'), false);
      assert.equal((await h.queue.getDurableEntry('thread', result.entryId)).status, 'queued');
      assert.equal(h.processor.isAutoResumeSuppressed('thread', 'sonnet'), true);
    });
  }
}

test('#2008 real A2A message_wake retains its exact epoch across another member starting', async (t) => {
  const h = await stopFixture(t, { idle: true });
  await h.send('middle', ['gemini']);
  await appendA2ASourceWithLedgerAdmission(
    { messageStore: h.messages, invocationQueue: h.queue },
    {
      userId: 'owner',
      threadId: 'thread',
      from: { kind: 'agent', catId: 'gemini' },
      content: 'real A2A',
      mentions: ['sonnet'],
      timestamp: Date.now() + 1,
    },
    {
      plan: { requestedTargetCats: ['sonnet'], acceptedTargetCats: ['sonnet'], streakTargetCats: ['sonnet'] },
      ownerAuthProvenance: 'strict',
    },
  );
  h.processor.suppressAutoResume('thread', 'sonnet', ['old-stop']);
  let otherCompleted = false;
  const complete = h.processor.onInvocationComplete.bind(h.processor);
  h.processor.onInvocationComplete = async (...args) => {
    await complete(...args);
    if (args[1] === 'gemini' && args[2] === 'succeeded') otherCompleted = true;
  };
  await h.processor.onInvocationComplete('thread', 'sonnet', 'canceled_by_user', 'new-completion', []);
  await waitFor(() => otherCompleted);
  assert.ok(h.starts.includes('real A2A'));
});

for (const author of ['owner', 'host']) {
  test(`#2008 real ${author} decision return retains its own authority under suppression`, async (t) => {
    const h = await stopFixture(t, { idle: true });
    h.processor.suppressAutoResume('thread', 'sonnet', ['old-stop']);
    const gateway = new MessageQueueRuntimeConversationReturnGateway({
      messageStore: h.messages,
      queue: h.queue,
      socketManager: h.processor.deps.socketManager,
      tryAutoExecute: (thread) => h.processor.requestDrain(thread),
    });
    await gateway.deliver({
      interactionId: 'decision',
      operationId: 'answer',
      author,
      content: 'decision answer',
      record: {
        request: { kind: 'conversation_decision', owner: { userId: 'owner', threadId: 'thread', catId: 'sonnet' } },
        cardRef: { messageId: 'decision-card' },
      },
    });
    const [entry] = h.queue.listPendingAcrossUsers('thread');
    assert.equal(entry.kind, 'message_wake');
    assert.equal(entry.sourceCategory, 'producer_return');
    assert.equal(entry.from.kind, author === 'owner' ? 'user' : 'system');
    assert.deepEqual(h.starts, []);
    await h.processor.onInvocationComplete('thread', 'sonnet', 'canceled_by_user', 'new-completion', []);
    await settled(h, 'sonnet');
    assert.equal(h.starts.includes('decision answer'), author === 'owner');
  });
}

for (const intent of ['execute', 'session_handoff_continuation']) {
  test(`#2008 post-Stop private ${intent} remains with its own scheduling custody`, async (t) => {
    const h = await stopFixture(t, { idle: true });
    h.processor.suppressAutoResume('thread', 'sonnet', ['old-stop']);
    const { entry } = await h.queue.enqueueDurable(
      h.privateInput(`private-${intent}`, {
        from: { kind: 'agent', catId: 'sonnet' },
        targetCats: ['sonnet'],
        sourceCategory: 'continuation',
        intent,
      }),
    );
    await h.processor.onInvocationComplete('thread', 'sonnet', 'canceled_by_user', 'new-completion', []);
    await settled(h, 'sonnet');
    assert.deepEqual(h.starts, []);
    assert.equal(
      (await h.queue.getDurableEntry('thread', entry.id)).status,
      'queued',
      'new private work was not retired',
    );
    if (intent === 'session_handoff_continuation') {
      assert.equal(
        (await h.processor.processNext('thread', 'owner')).started,
        true,
        'explicit owner scheduling remains available',
      );
    }
  });
}

for (const restoreOwnedClaim of [true, false]) {
  test(`#2008 claimed-only completion preserves custody: exact owned restore=${restoreOwnedClaim}`, async (t) => {
    const h = await stopFixture(t, { idle: true });
    const source = await h.send('claimed input', ['sonnet']);
    const claim = await h.queue.markProcessingGroupAcrossUsersDurable(
      'thread',
      { entryId: source.entry.id, targetCats: ['sonnet'] },
      [source.entry.id],
    );
    assert.ok(claim.entry.claimId);
    h.processor.suppressAutoResume('thread', 'sonnet', ['old-stop']);
    assert.equal(h.queue.hasDispatchableQueuedForThread('thread'), false);
    await h.processor.onInvocationComplete('thread', 'sonnet', 'canceled_by_user', 'new-completion', []);
    assert.deepEqual(h.starts, []);
    assert.equal((await h.queue.getDurableEntry('thread', source.entry.id)).claimId, claim.entry.claimId);
    if (restoreOwnedClaim) {
      assert.equal(
        await h.queue.rollbackProcessingDurable('thread', source.entry.id),
        true,
        'this fixture owns the exact unchanged claim',
      );
      await h.processor.requestDrain('thread');
      await settled(h, 'sonnet');
      assert.deepEqual(h.starts, ['claimed input']);
    }
  });
}
