import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { ModificationRuntimeControlStore } from '../src/domains/collaborative-content/modification/control/runtime-control-store.js';
import { type QueueRoutesOptions, queueRoutes } from '../src/routes/queue.js';
import { cancellationFixture } from './helpers/content-modification-cancellation-fixture.js';

test('whole-execution confirmation persists the exact original child and cannot be retargeted on retry', async (t) => {
  const f = await cancellationFixture(t);
  const submitted = await f.integration.requests.submit(f.payload, f.human);
  assert.ok(submitted.delivery?.messageId);
  const childId = await f.dispatch.waitForAwakening(submitted.delivery.messageId);
  const child = f.dispatch.turns.get(childId)!;
  const confirm = (invocationId = childId) =>
    f.app.inject({
      method: 'POST',
      url: `/api/content-modifications/${f.requestId}/runtime-controls`,
      headers: { 'x-cat-cafe-user': 'operator' },
      payload: { kind: 'stop_execution', executionId: child.parentInvocationId, invocationId },
    });
  const before = await confirm();
  assert.equal(before.statusCode, 409, before.body);
  assert.equal((await f.cancel()).statusCode, 200);
  const first = await confirm();
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().target.invocationId, childId);
  assert.equal(first.json().state, 'confirmed', 'confirmation must not claim execution has stopped');
  assert.deepEqual((await confirm()).json(), first.json());
  assert.equal((await confirm('new-child')).statusCode, 409);
  const detail = await f.app.inject({
    url: `/api/content-modifications/${f.requestId}`,
    headers: { 'x-cat-cafe-user': 'operator' },
  });
  assert.deepEqual(detail.json().runtimeControls, [{ ...first.json(), executionState: 'running' }]);
  const foreign = await f.app.inject({
    method: 'POST',
    url: `/api/content-modifications/${f.requestId}/runtime-controls`,
    headers: { 'x-cat-cafe-user': 'other' },
    payload: { kind: 'stop_execution', executionId: child.parentInvocationId, invocationId: childId },
  });
  assert.equal(foreign.statusCode, 404);
});

async function nativeFixture(t: Parameters<typeof cancellationFixture>[0]) {
  const f = await cancellationFixture(t);
  await f.app.register(queueRoutes, {
    threadStore: f.threads,
    invocationQueue: f.queue,
    queueProcessor: f.dispatch.processor,
    invocationTracker: f.dispatch.tracker,
    messageStore: f.messages,
    turnExecutionStore: f.dispatch.turns,
    invocationRecordStore: f.dispatch.records,
    queueCustodyCoordinator: f.dispatch.coordinator,
    controlReceipts: () => f.integration.runtimeControls,
    socketManager: {
      emitToUser() {},
      broadcastAgentMessage() {},
      broadcastToRoom() {},
    } as unknown as QueueRoutesOptions['socketManager'],
  });
  const detail = async () =>
    (
      await f.app.inject({
        url: `/api/content-modifications/${f.requestId}`,
        headers: { 'x-cat-cafe-user': 'operator' },
      })
    ).json();
  return { ...f, detail };
}

for (const merged of [false, true])
  test(`native queue acknowledgement survives another connection (merged=${merged})`, async (t) => {
    const f = await nativeFixture(t);
    f.dispatch.tracker.start(f.thread.id, 'codex-astra', 'operator', ['codex-astra'], 'occupied-parent');
    const submitted = await f.integration.requests.submit(f.payload, f.human);
    assert.ok(submitted.delivery?.messageId);
    const messageId = submitted.delivery.messageId;
    const entry = f.queue.findEntryWithMessageId(f.thread.id, messageId)!;
    assert.ok(entry);
    if (merged) {
      const another = f.messages.append({
        userId: 'operator',
        threadId: f.thread.id,
        catId: null,
        content: '另一项请求',
        mentions: ['codex-astra'],
        timestamp: Date.now(),
      });
      f.queue.backfillMessageId(f.thread.id, 'operator', entry.id, another.id);
      await f.dispatch.coordinator.persistEntry(f.queue.getEntrySnapshot(f.thread.id, 'operator', entry.id)!);
    }
    assert.equal((await f.cancel()).statusCode, 200);
    const confirm = (kind: string) =>
      f.app.inject({
        method: 'POST',
        url: `/api/content-modifications/${f.requestId}/runtime-controls`,
        headers: { 'x-cat-cafe-user': 'operator' },
        payload: { kind, entryId: entry.id, messageId },
      });
    const single = await confirm('withdraw_single');
    assert.equal(single.statusCode, 200, single.body);
    const scopedUrl = `/api/threads/${f.thread.id}/queue/${entry.id}?controlReceiptRef=${encodeURIComponent(single.json().receiptRef)}&expectedSourceMessageId=${messageId}&expectedTargetCatId=codex-astra`;
    const foreign = await f.app.inject({ method: 'DELETE', url: scopedUrl, headers: { 'x-cat-cafe-user': 'other' } });
    assert.equal(foreign.statusCode, 409);
    assert.ok(f.queue.getEntrySnapshot(f.thread.id, 'operator', entry.id));
    if (!merged) {
      const original = f.dispatch.coordinator.withdrawEntry.bind(f.dispatch.coordinator);
      f.dispatch.coordinator.withdrawEntry = async () => {
        throw new Error('owner unavailable');
      };
      const unavailable = await f.app.inject({
        method: 'DELETE',
        url: scopedUrl,
        headers: { 'x-cat-cafe-user': 'operator' },
      });
      assert.equal(unavailable.statusCode, 503);
      const observed = (await f.detail()).runtimeControls[0];
      assert.equal(observed.state, 'confirmed');
      assert.equal(observed.observation.code, 'QUEUE_WITHDRAWAL_FAILED');
      assert.ok(f.queue.getEntrySnapshot(f.thread.id, 'operator', entry.id));
      f.dispatch.coordinator.withdrawEntry = original;
    }
    const wrongScope = await f.app.inject({
      method: 'DELETE',
      url: scopedUrl.replace('&expectedTargetCatId=codex-astra', ''),
      headers: { 'x-cat-cafe-user': 'operator' },
    });
    assert.equal(wrongScope.statusCode, 409);
    assert.ok(f.queue.getEntrySnapshot(f.thread.id, 'operator', entry.id));
    const removed = await f.app.inject({
      method: 'DELETE',
      url: scopedUrl,
      headers: { 'x-cat-cafe-user': 'operator' },
    });
    assert.equal(removed.statusCode, merged ? 409 : 200, removed.body);
    const actions = (await f.detail()).runtimeControls;
    assert.equal(actions[0].state, merged ? 'confirmed' : 'acknowledged');
    let acknowledgedRef = single.json().receiptRef;
    if (merged) {
      assert.equal(actions[0].observation.code, 'ENTRY_SCOPE_CHANGED');
      assert.ok(f.queue.getEntrySnapshot(f.thread.id, 'operator', entry.id));
      const whole = await confirm('withdraw_queue');
      assert.equal(whole.statusCode, 200, whole.body);
      acknowledgedRef = whole.json().receiptRef;
      const response = await f.app.inject({
        method: 'DELETE',
        url: `/api/threads/${f.thread.id}/queue/${entry.id}?controlReceiptRef=${encodeURIComponent(acknowledgedRef)}`,
        headers: { 'x-cat-cafe-user': 'operator' },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().removed.id, entry.id);
    }
    const reopened = new Database(join(f.root, 'collaborative-content', 'artifact-reviews.sqlite'));
    try {
      const receipts = new ModificationRuntimeControlStore(reopened);
      assert.equal(receipts.get(acknowledgedRef, 'operator')?.state, 'acknowledged');
      assert.equal(receipts.get(acknowledgedRef, 'other'), undefined);
      receipts.observe(acknowledgedRef, 'operator', 404, false, 'ENTRY_NOT_FOUND');
      assert.equal(
        receipts.get(acknowledgedRef, 'operator')?.state,
        'acknowledged',
        'late failure cannot erase an owner acknowledgement',
      );
    } finally {
      reopened.close();
    }
    assert.equal(f.queue.getEntrySnapshot(f.thread.id, 'operator', entry.id), null);
    assert.ok(f.messages.getById(messageId), 'withdrawal preserves author history');
  });
