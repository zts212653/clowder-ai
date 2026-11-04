import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { RedisQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';
import { stopFixture, waitFor } from './helpers/stop-private-fixture.js';

const owned = ownedRedisFixture('queue-independent-claims');

for (const dispatch of ['drain', 'processNext']) {
  test(`${dispatch}: a pre-receiver claim preserves its unclaimed sibling's position`, async (t) => {
    const h = await stopFixture(t, { idle: true });
    h.tracker.start('thread', 'opus', 'owner', ['opus'], 'busy-original');
    const shared = await h.send('shared', ['opus', 'codex']);
    let release;
    let entered = false;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    const create = h.records.create.bind(h.records);
    h.records.create = async (...args) => {
      if (!entered) {
        entered = true;
        await gate;
      }
      return create(...args);
    };
    await h.processor.requestDrain('thread');
    await waitFor(() => entered);
    assert.equal((await h.queue.getDurableEntry('thread', shared.entry.id)).status, 'claimed');
    h.tracker.complete('thread', 'opus');
    await h.send('later-opus', ['opus']);
    if (dispatch === 'drain') {
      await h.send('unrelated-gemini', ['gemini']);
      await h.processor.requestDrain('thread');
      await waitFor(() => h.starts.includes('unrelated-gemini'));
    } else {
      const next = await h.processor.processNext('thread', 'owner');
      assert.equal(next.started, false, 'manual next cannot overtake a claimed earlier source');
    }
    assert.equal(h.starts.includes('later-opus'), false, 'opus must receive shared before later-opus');
    release();
    await waitFor(() => h.starts.includes('later-opus'));
    assert.equal(h.starts.filter((content) => content === 'shared').length, 2);
  });
}

for (const storage of ['memory', 'redis']) {
  const options = () => {
    if (storage === 'memory') return { idle: true };
    const client = owned.client(`${randomUUID()}:`);
    return {
      idle: true,
      ledger: new RedisQueueLedgerStore(client),
      messages: new RedisMessageStore(client, { ttlSeconds: 0 }),
    };
  };

  test(`${storage}: a pre-receiver failure retires only the claimed target`, async (t) => {
    const h = await stopFixture(t, options());
    h.tracker.start('thread', 'opus', 'owner', ['opus'], 'busy-original');
    const shared = await h.send('shared', ['opus', 'codex']);
    let failed = false;
    h.records.create = async () => {
      failed = true;
      throw new Error('record store unavailable before receiver');
    };
    await h.processor.requestDrain('thread');
    await waitFor(() => failed && !h.processor.hasProcessingSlotReservation('thread', 'codex'));
    const remaining = await h.queue.getDurableEntry('thread', shared.entry.id);
    assert.deepEqual(remaining?.targets, ['opus'], 'failure must preserve the recipient that was never attempted');
    assert.equal(remaining.status, 'queued');
    assert.deepEqual(h.starts, []);
  });

  test(`${storage}: a later pre-receiver failure cannot clear the first sibling's live attempt`, async (t) => {
    const h = await stopFixture(t, options());
    h.tracker.start('thread', 'opus', 'owner', ['opus'], 'busy-original');
    const shared = await h.send('active', ['opus', 'codex']);
    await h.processor.requestDrain('thread');
    await waitFor(() => h.starts.length === 1);
    let failed = false;
    h.records.create = async () => {
      failed = true;
      throw new Error('later record store unavailable');
    };
    h.tracker.complete('thread', 'opus');
    await h.processor.requestDrain('thread');
    await waitFor(() => failed && !h.processor.hasProcessingSlotReservation('thread', 'opus'));
    assert.equal(
      await h.queue.getDurableEntry('thread', shared.entry.id),
      null,
      'the failed target must release its short claim',
    );
    assert.equal(h.queue.findAdmittedEntriesForMessages('thread', [shared.message.id], 'owner', 'codex').length, 1);
    assert.equal(h.tracker.has('thread', 'codex'), true);
    h.finishMember('codex');
    await waitFor(() => !h.processor.hasProcessingSlotReservation('thread', 'codex'));
  });

  test(`${storage}: reconciling a sibling short claim preserves already admitted execution evidence`, async (t) => {
    const h = await stopFixture(t, options());
    h.tracker.start('thread', 'opus', 'owner', ['opus'], 'busy-original');
    const shared = await h.send('active', ['opus', 'codex']);
    await h.processor.requestDrain('thread');
    await waitFor(() => h.starts.length === 1);
    const claimed = await h.queue.markProcessingByIdDurable('thread', shared.entry.id, 'opus');
    assert.ok(claimed?.claimId);
    assert.equal(await h.queue.reconcileClaimedLifecycleTargets('thread', [shared.entry.id], h.messages), true);
    assert.equal((await h.queue.getDurableEntry('thread', shared.entry.id)).status, 'queued');
    assert.equal(h.queue.findAdmittedEntriesForMessages('thread', [shared.message.id], 'owner', 'codex').length, 1);
    h.finishMember('codex');
    await waitFor(() => !h.processor.hasProcessingSlotReservation('thread', 'codex'));
  });

  test(`${storage}: a stale finally cannot borrow a replacement claim on the same source`, async (t) => {
    const h = await stopFixture(t, options());
    const shared = await h.send('shared', ['opus', 'codex']);
    const original = await h.queue.markProcessingByIdDurable('thread', shared.entry.id, 'opus');
    assert.ok(original?.claimId);
    await h.queue.restoreClaimedEntries('thread', [shared.entry.id]);
    const replacement = await h.queue.markProcessingByIdDurable('thread', shared.entry.id, 'codex');
    assert.notEqual(replacement.claimId, original.claimId);
    // Exercise the production finally operation with the immutable original claim.
    await h.processor.settleAttemptQueueEntry(original, 'failed');
    const current = await h.queue.getDurableEntry('thread', shared.entry.id);
    assert.equal(current?.claimId, replacement.claimId);
    assert.deepEqual(current.targets, ['opus', 'codex']);
    await h.queue.restoreClaimedEntries('thread', [shared.entry.id]);
  });

  test(`${storage}: recovery after a lost retirement reply releases only this execution's admitted evidence`, async (t) => {
    const h = await stopFixture(t, options());
    h.tracker.start('thread', 'opus', 'owner', ['opus'], 'busy-original');
    const shared = await h.send('active', ['opus', 'codex']);
    await h.processor.requestDrain('thread');
    await waitFor(() => h.starts.length === 1);
    const retire = h.queue.retireClaimedLifecycleTarget.bind(h.queue);
    let replyLost = false;
    h.queue.retireClaimedLifecycleTarget = async (...args) => {
      const result = await retire(...args);
      if (args[2] === 'opus') {
        replyLost = true;
        throw new Error('retirement reply lost after durable commit');
      }
      return result;
    };
    h.tracker.complete('thread', 'opus');
    await h.processor.requestDrain('thread');
    await waitFor(() => replyLost && !h.processor.hasProcessingSlotReservation('thread', 'opus'));
    assert.equal(h.queue.findAdmittedEntriesForMessages('thread', [shared.message.id], 'owner', 'opus').length, 0);
    assert.equal(h.queue.findAdmittedEntriesForMessages('thread', [shared.message.id], 'owner', 'codex').length, 1);
    assert.equal(await h.queue.getDurableEntry('thread', shared.entry.id), null);
    h.finishMember('codex');
    await waitFor(() => !h.processor.hasProcessingSlotReservation('thread', 'codex'));
  });

  test(`${storage}: delayed reconciliation cannot release another execution's replacement claim`, async (t) => {
    const h = await stopFixture(t, options());
    const shared = await h.send('shared', ['opus', 'codex']);
    const original = await h.queue.markProcessingByIdDurable('thread', shared.entry.id, 'opus');
    await h.queue.restoreClaimedEntries('thread', [shared.entry.id]);
    const replacement = await h.queue.markProcessingByIdDurable('thread', shared.entry.id, 'codex');
    await h.queue.reconcileClaimedLifecycleTargets('thread', [shared.entry.id], h.messages, [original]);
    assert.equal((await h.queue.getDurableEntry('thread', shared.entry.id)).claimId, replacement.claimId);
    await h.queue.restoreClaimedEntries('thread', [shared.entry.id]);
  });
}
