/**
 * ConciergeTriagePlanStore tests (F229 Phase B)
 *
 * Covers TriagePlan state machine:
 *   proposed → confirmed → dispatched → completed
 *   proposed → cancelled
 *   dispatched → failed → confirmed (retry)
 *
 * INV T1: 先落 proposed 再出确认卡
 * INV T2: 确认后才 dispatch
 * INV T3: failed 可手动重试
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/** @type {import('../dist/domains/concierge/ConciergeTriagePlanStore.js').MemoryConciergeTriagePlanStore} */
let store;

function makePlan(overrides = {}) {
  const now = Date.now();
  return {
    id: 'plan-1',
    userId: 'user-1',
    sourceMessageId: 'msg-1',
    originalText: '帮我问一下砚砚那个 bug 修了没',
    intent: 'relay',
    target: {
      threadId: 'thread-abc',
      threadTitle: '砚砚的 thread',
      targetCats: ['codex'],
    },
    status: 'proposed',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('ConciergeTriagePlanStore (Memory)', () => {
  beforeEach(async () => {
    const { MemoryConciergeTriagePlanStore } = await import('../dist/domains/concierge/ConciergeTriagePlanStore.js');
    store = new MemoryConciergeTriagePlanStore();
  });

  it('create + get round-trip', async () => {
    const plan = makePlan();
    await store.create(plan);
    const got = await store.get('plan-1');
    assert.deepStrictEqual(got, plan);
  });

  it('get returns null for unknown id', async () => {
    const got = await store.get('nonexistent');
    assert.strictEqual(got, null);
  });

  it('listByUser returns sorted by createdAt desc', async () => {
    const plan1 = makePlan({ id: 'p1', createdAt: 100, updatedAt: 100 });
    const plan2 = makePlan({ id: 'p2', createdAt: 300, updatedAt: 300 });
    const plan3 = makePlan({ id: 'p3', createdAt: 200, updatedAt: 200 });
    await store.create(plan1);
    await store.create(plan2);
    await store.create(plan3);

    const list = await store.listByUser('user-1');
    assert.strictEqual(list.length, 3);
    assert.deepStrictEqual(
      list.map((p) => p.id),
      ['p2', 'p3', 'p1'],
    );
  });

  it('listByUser filters by userId', async () => {
    await store.create(makePlan({ id: 'p1', userId: 'user-1' }));
    await store.create(makePlan({ id: 'p2', userId: 'user-2' }));

    const list = await store.listByUser('user-1');
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, 'p1');
  });

  // -- State transitions --

  it('proposed → confirmed', async () => {
    await store.create(makePlan());
    await store.updateStatus('plan-1', 'confirmed');
    const got = await store.get('plan-1');
    assert.strictEqual(got.status, 'confirmed');
    assert.ok(got.updatedAt >= got.createdAt);
  });

  it('proposed → cancelled', async () => {
    await store.create(makePlan());
    await store.updateStatus('plan-1', 'cancelled');
    const got = await store.get('plan-1');
    assert.strictEqual(got.status, 'cancelled');
  });

  it('confirmed → dispatched sets dispatchedAt', async () => {
    await store.create(makePlan({ status: 'confirmed' }));
    await store.updateStatus('plan-1', 'dispatched');
    const got = await store.get('plan-1');
    assert.strictEqual(got.status, 'dispatched');
    assert.ok(got.dispatchedAt > 0);
  });

  it('dispatched → completed sets completedAt', async () => {
    await store.create(makePlan({ status: 'dispatched', dispatchedAt: Date.now() }));
    await store.updateStatus('plan-1', 'completed');
    const got = await store.get('plan-1');
    assert.strictEqual(got.status, 'completed');
    assert.ok(got.completedAt > 0);
  });

  it('dispatched → failed', async () => {
    await store.create(makePlan({ status: 'dispatched', dispatchedAt: Date.now() }));
    await store.updateStatus('plan-1', 'failed');
    const got = await store.get('plan-1');
    assert.strictEqual(got.status, 'failed');
  });

  it('failed → confirmed (retry)', async () => {
    await store.create(makePlan({ status: 'failed' }));
    await store.updateStatus('plan-1', 'confirmed');
    const got = await store.get('plan-1');
    assert.strictEqual(got.status, 'confirmed');
  });

  it('updateStatus no-ops for unknown id', async () => {
    // Should not throw
    await store.updateStatus('nonexistent', 'confirmed');
  });

  it('setResult writes result field', async () => {
    await store.create(makePlan({ status: 'dispatched', dispatchedAt: Date.now() }));
    await store.setResult('plan-1', { relayReceiptId: 'receipt-1' });
    const got = await store.get('plan-1');
    assert.deepStrictEqual(got.result, { relayReceiptId: 'receipt-1' });
  });

  it('P1: setConfirmationMessageId links terminal recovery to the assistant message', async () => {
    await store.create(makePlan());
    await store.setConfirmationMessageId('plan-1', 'msg-assistant-1');
    const got = await store.get('plan-1');

    assert.strictEqual(got.sourceMessageId, 'msg-1');
    assert.strictEqual(got.confirmationMessageId, 'msg-assistant-1');
  });

  it('create returns deep copy (no mutation leak)', async () => {
    const plan = makePlan();
    await store.create(plan);
    plan.status = 'cancelled';
    const got = await store.get('plan-1');
    assert.strictEqual(got.status, 'proposed', 'store should hold an independent copy');
  });

  // -- claimTransition (cloud P1: atomic CAS) --

  it('claimTransition succeeds when status matches expected', async () => {
    await store.create(makePlan());
    const ok = await store.claimTransition('plan-1', 'proposed', 'confirmed');
    assert.strictEqual(ok, true);
    const got = await store.get('plan-1');
    assert.strictEqual(got.status, 'confirmed');
    assert.ok(got.updatedAt >= got.createdAt);
  });

  it('claimTransition fails when status does not match expected', async () => {
    await store.create(makePlan({ status: 'cancelled' }));
    const ok = await store.claimTransition('plan-1', 'proposed', 'confirmed');
    assert.strictEqual(ok, false);
    const got = await store.get('plan-1');
    assert.strictEqual(got.status, 'cancelled', 'status should not change on failed claim');
  });

  it('claimTransition fails for unknown planId', async () => {
    const ok = await store.claimTransition('nonexistent', 'proposed', 'confirmed');
    assert.strictEqual(ok, false);
  });

  it('claimTransition sets dispatchedAt when transitioning to dispatched', async () => {
    await store.create(makePlan({ status: 'confirmed' }));
    const ok = await store.claimTransition('plan-1', 'confirmed', 'dispatched');
    assert.strictEqual(ok, true);
    const got = await store.get('plan-1');
    assert.strictEqual(got.status, 'dispatched');
    assert.ok(got.dispatchedAt > 0);
  });

  it('claimTransition: only first caller wins (double-click race)', async () => {
    await store.create(makePlan());
    // Simulate two concurrent claimTransition calls
    const [r1, r2] = await Promise.all([
      store.claimTransition('plan-1', 'proposed', 'confirmed'),
      store.claimTransition('plan-1', 'proposed', 'cancelled'),
    ]);
    // Exactly one should win (Memory store is sync so first always wins,
    // but the contract says at most one succeeds)
    const winners = [r1, r2].filter(Boolean);
    assert.strictEqual(winners.length, 1, 'exactly one caller should win the race');
    const got = await store.get('plan-1');
    assert.ok(got.status === 'confirmed' || got.status === 'cancelled');
  });
});
