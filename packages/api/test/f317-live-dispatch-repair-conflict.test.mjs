import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DispatchReceiptService } from '../dist/domains/ball-custody/DispatchReceiptService.js';
import { createA2ADispositionAuth } from './helpers/a2a-dispatch-disposition-harness.js';
import { createLiveDispatchReceiptFixture } from './helpers/f317-live-dispatch-receipt-fixture.mjs';

test('event-first repair rejects a later ordinary outcome instead of accepting a timestamp as terminal identity', async () => {
  const h = await createLiveDispatchReceiptFixture({ failReceipt: true });
  const auth = createA2ADispositionAuth(h);
  await assert.rejects(h.service.completeAdopted(auth, h.source.id, 'completed'), /receipt unavailable/);
  const outcome = {
    invocationId: 'inv-1',
    disposition: 'completed_with_turn',
    handledAt: Date.now() + 100,
    evidenceRef: { kind: 'invocation_lineage', invocationId: 'inv-1' },
  };
  await h.coordinator.commitSuccessfulTargetsForMessages(
    h.queue.getEntrySnapshot('thread-1', 'user-1', h.entry.id),
    [h.source.id],
    ['codex-sol'],
    'inv-1',
    outcome.handledAt,
    { [h.source.id]: { 'codex-sol': outcome } },
  );
  const before = h.messageStore.getById(h.source.id).queueCustody;
  assert.deepEqual(before.targetOutcomeByCatId['codex-sol'], outcome);
  const receipts = new DispatchReceiptService({
    messageStore: h.messageStore,
    queue: h.queue,
    coordinator: h.coordinator,
    eventLog: h.eventLog,
    onSettled() {
      assert.fail('conflicting receipt must not publish success');
    },
  });
  await assert.rejects(
    receipts.repair({ threadId: 'thread-1', catId: 'codex-sol', sourceMessageId: h.source.id }),
    /conflicts with an existing outcome/,
  );
  assert.deepEqual(h.messageStore.getById(h.source.id).queueCustody, before);
  assert.equal(h.eventLog.events.filter((event) => event.kind === 'ball.dispatch_dispositioned').length, 1);
});

for (const patch of [
  { sourceMessageId: 'another-source' },
  { handoffEventId: 'another-handoff' },
  { invocationId: 'another-invocation' },
  { dispositionEventId: 'another-terminal' },
  { disposition: 'handled' },
  { dispositionAt: -1 },
]) {
  test(`receipt replay rejects mismatched ${Object.keys(patch)[0]} even with the original event ID`, async () => {
    const h = await createLiveDispatchReceiptFixture();
    await h.service.completeAdopted(createA2ADispositionAuth(h), h.source.id, 'completed');
    const source = structuredClone(h.messageStore.getById(h.source.id));
    Object.assign(source.queueCustody.targetOutcomeByCatId['codex-sol'].evidenceRef, patch);
    const receipts = new DispatchReceiptService({
      messageStore: { getById: async () => source },
      queue: h.queue,
      coordinator: h.coordinator,
      eventLog: h.eventLog,
      onSettled() {
        assert.fail('conflicting receipt must not publish success');
      },
    });
    await assert.rejects(
      receipts.repair({ threadId: 'thread-1', catId: 'codex-sol', sourceMessageId: h.source.id }),
      /conflicts with an existing outcome/,
    );
  });
}
