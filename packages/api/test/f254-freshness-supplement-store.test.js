import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { InMemoryFreshnessClosureStore } = await import(
  '../dist/domains/cats/services/freshness/FreshnessClosureStore.js'
);

const base = {
  lineageId: 'message-original',
  originalMessageId: 'message-original',
  userId: 'user-1',
  threadId: 'thread-1',
  catId: 'codex-sol',
  requiredMessageIds: ['message-update-1'],
  requiredFrontierMessageId: 'message-update-1',
  replayUnsafeToolNames: ['mcp__cat-cafe__cat_cafe_hold_ball'],
  now: 100,
};

describe('F254 ADR-042 supplement store', () => {
  it('creates seq 1 and coalesces later messages while it is pending', async () => {
    const store = new InMemoryFreshnessClosureStore();

    const first = await store.offerSupplement(base);
    const merged = await store.offerSupplement({
      ...base,
      requiredMessageIds: ['message-update-2'],
      requiredFrontierMessageId: 'message-update-2',
      now: 110,
    });

    assert.equal(first.kind, 'offered');
    assert.equal(first.supplement.seq, 1);
    assert.equal(first.supplement.status, 'pending');
    assert.equal(merged.kind, 'offered');
    assert.equal(merged.supplement.id, first.supplement.id);
    assert.deepEqual(merged.supplement.requiredMessageIds, ['message-update-1', 'message-update-2']);
    assert.equal(merged.supplement.requiredFrontierMessageId, 'message-update-2');
    assert.deepEqual(merged.supplement.replayUnsafeToolNames, ['mcp__cat-cafe__cat_cafe_hold_ball']);
  });

  it('coalesces an older concurrent observation without regressing the pending frontier or clock', async () => {
    const store = new InMemoryFreshnessClosureStore();
    await store.offerSupplement({
      ...base,
      requiredMessageIds: ['message-update-3'],
      requiredFrontierMessageId: 'message-update-3',
      now: 130,
    });

    const merged = await store.offerSupplement({
      ...base,
      requiredMessageIds: ['message-update-2'],
      requiredFrontierMessageId: 'message-update-2',
      now: 120,
    });

    assert.equal(merged.kind, 'offered');
    assert.deepEqual(merged.supplement.requiredMessageIds, ['message-update-2', 'message-update-3']);
    assert.equal(merged.supplement.requiredFrontierMessageId, 'message-update-3');
    assert.equal(merged.supplement.updatedAt, 130);
  });

  it('keeps running input immutable and coalesces arrivals into one seq 2 pending', async () => {
    const store = new InMemoryFreshnessClosureStore();
    const first = await store.offerSupplement(base);
    const running = await store.claimSupplement(first.supplement.id, { invocationId: 'inv-s1', now: 120 });

    const second = await store.offerSupplement({
      ...base,
      requiredMessageIds: ['message-update-2'],
      requiredFrontierMessageId: 'message-update-2',
      now: 130,
    });
    const merged = await store.offerSupplement({
      ...base,
      requiredMessageIds: ['message-update-3'],
      requiredFrontierMessageId: 'message-update-3',
      now: 140,
    });

    assert.equal(running.status, 'running');
    assert.deepEqual(running.requiredMessageIds, ['message-update-1']);
    assert.equal(second.kind, 'offered');
    assert.equal(second.supplement.seq, 2);
    assert.equal(second.supplement.status, 'pending');
    assert.equal(merged.supplement.id, second.supplement.id);
    assert.deepEqual(merged.supplement.requiredMessageIds, ['message-update-2', 'message-update-3']);
    assert.equal(merged.supplement.requiredFrontierMessageId, 'message-update-3');
  });

  it('enforces one running lease per lineage', async () => {
    const store = new InMemoryFreshnessClosureStore();
    const first = await store.offerSupplement(base);
    await store.claimSupplement(first.supplement.id, { invocationId: 'inv-s1', now: 120 });
    const second = await store.offerSupplement({
      ...base,
      requiredMessageIds: ['message-update-2'],
      requiredFrontierMessageId: 'message-update-2',
      now: 130,
    });

    await assert.rejects(
      store.claimSupplement(second.supplement.id, { invocationId: 'inv-s2', now: 140 }),
      /already has a running supplement/,
    );
  });

  it('commits only from the claimed invocation and then releases seq 2', async () => {
    const store = new InMemoryFreshnessClosureStore();
    const first = await store.offerSupplement(base);
    await store.claimSupplement(first.supplement.id, { invocationId: 'inv-s1', now: 120 });
    const second = await store.offerSupplement({
      ...base,
      requiredMessageIds: ['message-update-2'],
      requiredFrontierMessageId: 'message-update-2',
      now: 130,
    });

    await assert.rejects(
      store.commitSupplement(first.supplement.id, {
        invocationId: 'inv-wrong',
        messageId: 'message-supplement-1',
        now: 140,
      }),
      /claimed invocation/,
    );
    const committed = await store.commitSupplement(first.supplement.id, {
      invocationId: 'inv-s1',
      messageId: 'message-supplement-1',
      now: 150,
    });
    const runningSecond = await store.claimSupplement(second.supplement.id, {
      invocationId: 'inv-s2',
      now: 160,
    });

    assert.equal(committed.status, 'committed');
    assert.equal(committed.committedMessageId, 'message-supplement-1');
    assert.equal(runningSecond.status, 'running');
  });

  it('persists decline and failure as hydratable terminal states', async () => {
    const declinedStore = new InMemoryFreshnessClosureStore();
    const declinedOffer = await declinedStore.offerSupplement(base);
    await declinedStore.claimSupplement(declinedOffer.supplement.id, { invocationId: 'inv-decline', now: 110 });
    const declined = await declinedStore.declineSupplement(declinedOffer.supplement.id, {
      invocationId: 'inv-decline',
      now: 120,
    });

    const failedStore = new InMemoryFreshnessClosureStore();
    const failedOffer = await failedStore.offerSupplement(base);
    const failed = await failedStore.failSupplement(failedOffer.supplement.id, {
      reason: 'read_only_policy_unavailable',
      now: 120,
    });

    assert.equal(declined.status, 'declined');
    assert.equal(declined.declineReason, 'checked_no_supplement_needed');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureReason, 'read_only_policy_unavailable');
    assert.deepEqual(
      (await declinedStore.listSupplementsByLineage(base.lineageId)).map((item) => item.status),
      ['declined'],
    );
    assert.deepEqual(
      (await failedStore.listSupplementsByThread(base.threadId)).map((item) => item.status),
      ['failed'],
    );
  });

  it('caps the lineage at two sequences and records visible budget exhaustion', async () => {
    const store = new InMemoryFreshnessClosureStore();
    const first = await store.offerSupplement(base);
    await store.claimSupplement(first.supplement.id, { invocationId: 'inv-s1', now: 110 });
    await store.commitSupplement(first.supplement.id, {
      invocationId: 'inv-s1',
      messageId: 'message-supplement-1',
      now: 120,
    });
    const second = await store.offerSupplement({
      ...base,
      requiredMessageIds: ['message-update-2'],
      requiredFrontierMessageId: 'message-update-2',
      now: 130,
    });
    await store.claimSupplement(second.supplement.id, { invocationId: 'inv-s2', now: 140 });
    await store.commitSupplement(second.supplement.id, {
      invocationId: 'inv-s2',
      messageId: 'message-supplement-2',
      now: 150,
    });

    const exhausted = await store.offerSupplement({
      ...base,
      requiredMessageIds: ['message-update-3'],
      requiredFrontierMessageId: 'message-update-3',
      now: 160,
    });

    assert.equal(exhausted.kind, 'budget_exhausted');
    assert.equal(exhausted.supplement.seq, 2);
    assert.deepEqual(exhausted.supplement.budgetExhausted, {
      unseenMessageIds: ['message-update-3'],
      observedAt: 160,
    });
    assert.equal((await store.listSupplementsByLineage(base.lineageId)).length, 2);
  });

  it('deletes supplement records with their thread without touching other threads', async () => {
    const store = new InMemoryFreshnessClosureStore();
    await store.offerSupplement(base);
    await store.offerSupplement({
      ...base,
      lineageId: 'message-other',
      originalMessageId: 'message-other',
      threadId: 'thread-2',
    });

    const deleted = await store.deleteByThread(base.threadId);

    assert.equal(deleted, 1);
    assert.deepEqual(await store.listSupplementsByLineage(base.lineageId), []);
    assert.equal((await store.listSupplementsByThread('thread-2')).length, 1);
  });
});
