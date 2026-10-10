import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import {
  reconsiderationQueueFixture,
  threadId,
  until,
  userId,
} from './f290-communication-reconsideration-queue.fixture.js';

for (const restarted of [false, true]) {
  test(`permanently refused exact old-g1 wake releases new-g2 and B (restart=${restarted})`, async () => {
    const f = reconsiderationQueueFixture();
    const stale = await f.enqueue('old-g1');
    const current = await f.enqueue('new-g2');
    const b = await f.enqueue('independent-B');
    if (restarted) {
      assert.equal(await f.queue.hydrateFromLedger(f.messages), 3);
      assert.deepEqual(
        f.queue.list(threadId, userId).map((row) => row.id),
        [stale, current, b].map(({ entry }) => entry.id),
      );
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
    assert.equal(record?.status, 'failed');
    assert.match(record?.error ?? '', /collective_reconsideration_refused:permission_not_current/);
    const restartedQueue = new InvocationQueue(f.ledger);
    assert.equal(await restartedQueue.hydrateFromLedger(f.messages), 0);
    assert.deepEqual(restartedQueue.list(threadId, userId), []);
    assert.equal(f.messages.getById(stale.message.id)?.lifecycle?.kind, 'input');
    assert.equal(f.messages.getById(stale.message.id)?.lifecycle?.dispatchRefs?.length ?? 0, 0);
    for (const source of [current, b]) {
      const input = f.messages.getById(source.message.id);
      assert.equal(input?.lifecycle?.kind, 'input');
      if (input?.lifecycle?.kind !== 'input') assert.fail('Missing canonical input');
      const [ref] = input.lifecycle.dispatchRefs ?? [];
      assert.equal(ref?.phase, 'settled');
      const response = f.messages.getById(ref.statusMessageId);
      assert.equal(response?.lifecycle?.kind, 'response');
      if (response?.lifecycle?.kind !== 'response') assert.fail('Missing actual child response');
      assert.equal(response.lifecycle.status, 'completed');
      assert.notEqual(
        response.lifecycle.invocationId,
        f.parentRecords().find((row) => row?.userMessageId === source.message.id)?.invocationId,
      );
    }
    assert.deepEqual(await f.ledger.list(threadId), [], 'no paused or hidden pending owner remains');
  });
}

for (const corruption of ['marker-absent', 'purpose-mismatch', 'target-mismatch']) {
  test(`typed public refusal with ${corruption} retains source rather than applying trusted-wake retirement`, async () => {
    const f = reconsiderationQueueFixture(false);
    const source = await f.enqueue('old-g1', corruption !== 'marker-absent');
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
      () => f.settlementErrors.some((args) => String(args[1]).includes('Queue attempt settlement failed')),
      'retained refusal',
    );
    assert.equal(f.messages.getById(source.message.id)?.deliveryStatus, 'queued');
    assert.equal(f.messages.getById(source.message.id)?.queueCustody, undefined);
    assert.equal((await f.ledger.get(threadId, source.entry.id))?.status, 'claimed');
    assert.equal(f.messages.getByThread(threadId).filter((row) => row.lifecycle?.kind === 'response').length, 0);
    assert.deepEqual(
      f.queue.list(threadId, userId).map((entry) => entry.id),
      [source.entry.id],
    );
    assert.deepEqual(f.delivered, []);
  });
}

for (const writer of ['terminal-record', 'source-cancellation']) {
  test(`trusted wake ${writer} failure preserves exact source and canonical claim`, async () => {
    const f = reconsiderationQueueFixture();
    const source = await f.enqueue('old-g1');
    if (writer === 'terminal-record') {
      const update = f.records.update.bind(f.records);
      f.records.update = (id, input) =>
        input.error?.startsWith('collective_reconsideration_refused') ? null : update(id, input);
    } else
      f.messages.markCanceled = () => {
        throw new Error('source writer unavailable');
      };
    await f.processor.processNext(threadId, userId);
    await until(
      () => f.settlementErrors.some((args) => String(args[1]).includes('Queue attempt settlement failed')),
      'writer failure',
    );
    assert.equal(f.messages.getById(source.message.id)?.deliveryStatus, 'queued');
    assert.equal(f.messages.getById(source.message.id)?.queueCustody, undefined);
    assert.equal((await f.ledger.get(threadId, source.entry.id))?.status, 'claimed');
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
  const source = await f.enqueue('new-g2');
  await f.processor.processNext(threadId, userId);
  await until(
    () => f.parentRecords().at(-1)?.status === 'failed' && f.queue.list(threadId, userId)[0]?.status === 'queued',
    'transport failed',
  );
  assert.equal(f.messages.getByThread(threadId).filter((row) => row.lifecycle?.kind === 'response').length, 0);
  const before = await f.ledger.get(threadId, source.entry.id);
  assert.ok(before);
  assert.equal(f.messages.getById(source.message.id)?.deliveryStatus, 'queued');
  f.transportUnavailable(false);
  // No receiver/provider was admitted on the failed transport. Only the
  // same canonical pending source is retried, not a terminal child or carrier.
  assert.equal((await f.processor.processNext(threadId, userId)).started, true);
  await until(() => f.messages.getById(source.message.id)?.deliveryStatus === 'delivered', 'transport recovered');
  assert.deepEqual(f.routed, ['new-g2', 'new-g2']);
  assert.deepEqual(f.delivered, ['new-g2']);
  const stored = f.messages.getById(source.message.id);
  assert.equal(stored?.queueCustody, undefined);
  assert.deepEqual(await f.ledger.list(threadId), []);
  const marker = stored?.source?.meta?.reconsideration as { purposeKey: string };
  assert.equal(f.messages.getByIdempotencyKey(userId, threadId, marker.purposeKey)?.id, source.message.id);
});

for (const [label, patch] of [
  ['wrong source', { userMessageId: 'other-source' }],
  ['wrong owner', { userId: 'other-owner' }],
  ['wrong target', { targetCats: ['another-cat'] }],
  ['different terminal error', { error: 'unrelated failure' }],
  ['different terminal status', { status: 'succeeded' }],
] as const) {
  test(`an existing ${label} record cannot prove this exact refusal`, async () => {
    const f = reconsiderationQueueFixture();
    const source = await f.enqueue('old-g1');
    const get = f.records.get.bind(f.records);
    f.records.get = (id) => {
      const record = get(id);
      return record?.status === 'failed' ? ({ ...record, ...patch } as typeof record) : record;
    };
    await f.processor.processNext(threadId, userId);
    await until(
      () => f.settlementErrors.some((args) => String(args[1]).includes('Queue attempt settlement failed')),
      label,
    );
    assert.equal(f.messages.getById(source.message.id)?.deliveryStatus, 'queued');
    assert.equal((await f.ledger.get(threadId, source.entry.id))?.status, 'claimed');
    assert.deepEqual(f.delivered, []);
  });
}

test('unknown durable refusal evidence fails closed despite an earlier successful error write', async () => {
  const f = reconsiderationQueueFixture();
  const source = await f.enqueue('old-g1');
  const get = f.records.get.bind(f.records);
  f.records.get = (id) => {
    const record = get(id);
    if (record?.status === 'failed') throw new Error('owned evidence read unavailable');
    return record;
  };
  await f.processor.processNext(threadId, userId);
  await until(
    () => f.settlementErrors.some((args) => String(args[1]).includes('Queue attempt settlement failed')),
    'unknown evidence',
  );
  assert.equal(f.messages.getById(source.message.id)?.deliveryStatus, 'queued');
  assert.equal((await f.ledger.get(threadId, source.entry.id))?.status, 'claimed');
});

test('a store with no durable reader cannot retire a refusal from update acknowledgement alone', async () => {
  const f = reconsiderationQueueFixture();
  const source = await f.enqueue('old-g1');
  f.processor.deps.invocationRecordStore.get = undefined;
  await f.processor.processNext(threadId, userId);
  await until(
    () => f.settlementErrors.some((args) => String(args[1]).includes('Queue attempt settlement failed')),
    'missing durable reader',
  );
  assert.equal(f.messages.getById(source.message.id)?.deliveryStatus, 'queued');
  assert.equal((await f.ledger.get(threadId, source.entry.id))?.status, 'claimed');
});
