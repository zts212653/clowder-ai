import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildQueueEntry,
  groupActiveMessages,
} from '../src/domains/cats/services/agents/invocation/QueuedMessageCustodyStartupQueueEntry.js';
import {
  catId,
  reconsiderationQueueFixture,
  threadId,
  until,
  userId,
} from './f290-communication-reconsideration-queue.fixture.js';

for (const restarted of [false, true]) {
  test(`permanently refused exact old-g1 wake releases new-g2 and B (restart=${restarted})`, async () => {
    const f = reconsiderationQueueFixture();
    const stale = f.enqueue('old-g1');
    const current = f.enqueue('new-g2');
    const b = f.enqueue('independent-B');
    if (restarted) {
      for (const entry of f.queue.list(threadId, userId))
        assert.equal(f.queue.removeEntrySnapshotIfUnchanged(entry), true);
      const sources = [stale, current, b]
        .map(({ message }) => f.messages.getById(message.id))
        .filter((row) => row !== null);
      for (const [id, rows] of groupActiveMessages(sources)) {
        const rebuilt = buildQueueEntry(rows, id);
        assert.ok(rebuilt);
        assert.equal(
          rebuilt.idempotencyKey,
          undefined,
          'Startup recovers custody identity without operational idempotencyKey',
        );
        f.queue.restoreDurableEntry(rebuilt);
      }
    }
    assert.equal((await f.processor.processNext(threadId, userId)).started, true);
    await until(() => f.messages.getById(stale.message.id)?.deliveryStatus === 'canceled', 'g1 canceled');
    await until(() => f.queue.list(threadId, userId).length === 0, 'g2 and B proceed');
    assert.deepEqual(f.routed, ['old-g1', 'new-g2', 'independent-B']);
    assert.deepEqual(f.delivered, ['new-g2', 'independent-B']);
    assert.equal(f.messages.getById(stale.message.id)?.queueCustody, undefined);
    assert.equal(f.messages.getById(current.message.id)?.deliveryStatus, 'delivered');
    assert.equal(f.messages.getById(b.message.id)?.deliveryStatus, 'delivered');
    const record = f.parentRecords().find((row) => row?.userMessageId === stale.message.id);
    assert.equal(record?.status, 'canceled');
    assert.match(record?.error ?? '', /collective_reconsideration_refused:permission_not_current/);
    const rows = [stale, current, b].map(({ message }) => f.messages.getById(message.id)).filter((row) => row !== null);
    assert.deepEqual(
      [...groupActiveMessages(rows)].map(([id, messages]) => buildQueueEntry(messages, id)),
      [],
    );
    assert.equal(f.processor.isPaused(threadId, catId), false);
  });
}

for (const corruption of ['marker-absent', 'purpose-mismatch', 'target-mismatch']) {
  test(`typed public refusal with ${corruption} retains source rather than applying trusted-wake retirement`, async () => {
    const f = reconsiderationQueueFixture(false);
    const source = f.enqueue('old-g1', corruption !== 'marker-absent');
    const stored = f.messages.getById(source.message.id);
    assert.ok(stored);
    if (corruption === 'purpose-mismatch') {
      const marker = stored.source?.meta?.reconsideration as { purposeKey: string };
      marker.purposeKey = `collective-reconsider:${'4'.repeat(64)}`;
    }
    if (corruption === 'target-mismatch') {
      const identity = stored.source?.meta?.participation as { catId: string };
      identity.catId = 'another-cat';
    }
    await f.processor.processNext(threadId, userId);
    await until(
      () => f.messages.getById(source.message.id)?.queueCustody?.targetAttempts?.at(-1)?.state === 'failed',
      'retained refusal',
    );
    assert.equal(f.messages.getById(source.message.id)?.deliveryStatus, 'queued');
    assert.equal(f.messages.getById(source.message.id)?.queueCustody?.entryId, source.entry.id);
    assert.deepEqual(
      f.queue.list(threadId, userId).map((entry) => entry.id),
      [source.entry.id],
    );
    assert.deepEqual(f.delivered, []);
  });
}

for (const writer of ['terminal-record', 'source-cancellation']) {
  test(`trusted wake ${writer} failure preserves exact source and custody`, async () => {
    const f = reconsiderationQueueFixture();
    const source = f.enqueue('old-g1');
    if (writer === 'terminal-record') {
      const update = f.records.update.bind(f.records);
      f.records.update = (id, input) => (input.status === 'canceled' ? null : update(id, input));
    } else
      f.messages.markCanceled = () => {
        throw new Error('source writer unavailable');
      };
    await f.processor.processNext(threadId, userId);
    await until(
      () => f.messages.getById(source.message.id)?.queueCustody?.targetAttempts?.at(-1)?.state === 'failed',
      'writer failure',
    );
    assert.equal(f.messages.getById(source.message.id)?.deliveryStatus, 'queued');
    assert.equal(f.messages.getById(source.message.id)?.queueCustody?.entryId, source.entry.id);
    assert.deepEqual(
      f.queue.list(threadId, userId).map((entry) => entry.id),
      [source.entry.id],
    );
    assert.deepEqual(f.delivered, []);
  });
}

test('trusted wake transient transport retains its exact source and recovers without cancellation', async () => {
  const f = reconsiderationQueueFixture();
  f.transportUnavailable(true);
  const source = f.enqueue('new-g2');
  await f.processor.processNext(threadId, userId);
  await until(
    () => f.messages.getById(source.message.id)?.queueCustody?.targetAttempts?.at(-1)?.state === 'failed',
    'transport failed',
  );
  const attempt = f.messages.getById(source.message.id)?.queueCustody?.targetAttempts?.at(-1);
  assert.ok(attempt);
  assert.equal(f.messages.getById(source.message.id)?.deliveryStatus, 'queued');
  f.transportUnavailable(false);
  const result = await f.processor.retryFailedTarget(
    threadId,
    userId,
    source.entry.id,
    catId,
    attempt.id,
    async (transitions) => {
      for (const transition of transitions)
        assert.equal(
          f.messages.transitionQueueCustody(transition.messageId, {
            expectedRevision: transition.current.revision,
            next: transition.next,
          }).kind,
          'updated',
        );
      return { outcome: 'committed' };
    },
  );
  assert.equal(result.outcome, 'retried');
  await until(() => f.messages.getById(source.message.id)?.deliveryStatus === 'delivered', 'transport recovered');
  assert.deepEqual(f.routed, ['new-g2', 'new-g2']);
  assert.deepEqual(f.delivered, ['new-g2']);
});
