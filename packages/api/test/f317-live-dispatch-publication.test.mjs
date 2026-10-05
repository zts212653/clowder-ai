import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enrichQueueEntries } from '../dist/utils/queue-enrichment.js';
import { createDispatchReceiptPublisher } from '../src/domains/ball-custody/dispatch-receipt-publication.ts';
import { createA2ADispositionAuth } from './helpers/a2a-dispatch-disposition-harness.js';
import { createLiveDispatchReceiptFixture } from './helpers/f317-live-dispatch-receipt-fixture.mjs';

for (const mode of ['consumed', 'coalesced', 'multi-target']) {
  test(`adopted receipt publishes the canonical owner Queue live/F5 projection: ${mode}`, async () => {
    const events = [];
    let publish;
    const h = await createLiveDispatchReceiptFixture({
      targetCats: mode === 'multi-target' ? ['codex-sol', 'opus'] : ['codex-sol'],
      coalesced: mode === 'coalesced',
      onSettled: (input) => publish(input),
    });
    publish = createDispatchReceiptPublisher({
      queue: h.queue,
      messageStore: h.messageStore,
      socketManager: {
        emitToUser(ownerId, event, payload) {
          events.push({ ownerId, event, payload });
        },
        broadcastToRoom(room, event, payload) {
          events.push({ room, event, payload });
        },
      },
    });
    await h.service.completeAdopted(createA2ADispositionAuth(h), h.source.id, 'completed');
    const update = events.find(({ event }) => event === 'queue_updated');
    assert.ok(update, 'settled dispatch must publish Queue replacement immediately');
    assert.equal(update.ownerId, 'user-1');
    assert.equal(update.payload.threadId, 'thread-1');
    assert.equal(update.payload.action, 'queued_handled');
    const f5 = await enrichQueueEntries(h.queue.list('thread-1', 'user-1'), h.messageStore);
    assert.deepEqual(update.payload.queue, f5, 'same canonical enrichment as GET /queue');
    const receipt = update.payload.messageReceipts.find((item) => item.messageId === h.source.id);
    assert.ok(receipt, 'removed source still needs its exact original-message receipt');
    assert.equal(receipt.queueReceipt.targets.find((target) => target.catId === 'codex-sol').state, 'handled');
    if (mode === 'consumed') assert.deepEqual(f5, []);
    if (mode === 'coalesced') {
      assert.equal(f5.length, 1);
      assert.equal(f5[0].messageId, h.sibling.id);
      assert.deepEqual(f5[0].targetCats, ['codex-sol']);
    }
    if (mode === 'multi-target') assert.deepEqual(f5[0].targetCats, ['opus']);
    assert.ok(
      events.some(({ event, payload }) => event === 'message_receipt_updated' && payload.messageId === h.source.id),
    );
    events.length = 0;
    await h.service.completeAdopted(createA2ADispositionAuth(h), h.source.id, 'completed');
    assert.ok(
      events.some(({ event }) => event === 'queue_updated'),
      'replay heals a missed socket publication too',
    );
  });
}

test('replay republishes a failed socket delivery after the exact carrier was already removed', async () => {
  let publish;
  let fail = true;
  const events = [];
  const h = await createLiveDispatchReceiptFixture({ targetCats: ['codex-sol'], onSettled: (input) => publish(input) });
  publish = createDispatchReceiptPublisher({
    queue: h.queue,
    messageStore: h.messageStore,
    socketManager: {
      emitToUser(ownerId, event, payload) {
        if (fail) {
          fail = false;
          throw new Error('fixture socket unavailable');
        }
        events.push({ ownerId, event, payload });
      },
      broadcastToRoom() {},
    },
  });
  await assert.rejects(
    h.service.completeAdopted(createA2ADispositionAuth(h), h.source.id, 'completed'),
    /socket unavailable/,
  );
  assert.deepEqual(h.queue.list('thread-1', 'user-1'), []);
  const result = await h.service.completeAdopted(createA2ADispositionAuth(h), h.source.id, 'completed');
  assert.equal(result.outcome, 'replayed');
  assert.deepEqual(events[0].payload.queue, []);
  assert.equal(events[0].payload.messageReceipts[0].messageId, h.source.id);
  assert.equal(h.eventLog.events.filter((event) => event.kind === 'ball.dispatch_dispositioned').length, 1);
});
