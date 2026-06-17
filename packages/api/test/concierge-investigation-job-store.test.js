/**
 * ConciergeInvestigationJobStore tests (F229 Phase B2)
 *
 * Covers InvestigationJob state machine:
 *   queued → running → done (happy path)
 *   running → failed (API error)
 *   running → cancelled (deadline / user cancel)
 *   queued → cancelled (user cancel before start)
 *
 * INV I1: queued/running → cancelled (fail-closed on deadline)
 * INV I2: running → done must have report
 * INV I3: 60s deadline auto-cancel
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/** @type {import('../dist/domains/concierge/ConciergeInvestigationJobStore.js').MemoryConciergeInvestigationJobStore} */
let store;

const DEFAULT_DEADLINE_MS = 60_000;

function makeJob(overrides = {}) {
  const now = Date.now();
  return {
    id: 'job-1',
    userId: 'user-1',
    triagePlanId: 'plan-1',
    query: '砚砚之前那个 Redis bug 修了没',
    scope: ['memory', 'docs', 'feat_index'],
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    deadline: now + DEFAULT_DEADLINE_MS,
    ...overrides,
  };
}

describe('ConciergeInvestigationJobStore (Memory)', () => {
  beforeEach(async () => {
    const { MemoryConciergeInvestigationJobStore } = await import(
      '../dist/domains/concierge/ConciergeInvestigationJobStore.js'
    );
    store = new MemoryConciergeInvestigationJobStore();
  });

  // -- CRUD --

  it('create + get round-trip', async () => {
    const job = makeJob();
    await store.create(job);
    const got = await store.get('job-1');
    assert.deepStrictEqual(got, job);
  });

  it('get returns null for unknown id', async () => {
    const got = await store.get('nonexistent');
    assert.strictEqual(got, null);
  });

  it('create returns deep copy (no mutation leak)', async () => {
    const job = makeJob();
    await store.create(job);
    job.status = 'done';
    const got = await store.get('job-1');
    assert.strictEqual(got.status, 'queued', 'store should hold an independent copy');
  });

  it('getByTriagePlan returns job linked to triagePlanId', async () => {
    await store.create(makeJob({ id: 'job-1', triagePlanId: 'plan-1' }));
    await store.create(makeJob({ id: 'job-2', triagePlanId: 'plan-2' }));
    const got = await store.getByTriagePlan('plan-1');
    assert.strictEqual(got.id, 'job-1');
  });

  it('getByTriagePlan returns null for unknown triagePlanId', async () => {
    const got = await store.getByTriagePlan('nonexistent');
    assert.strictEqual(got, null);
  });

  // -- State transitions (updateStatus) --

  it('queued → running sets startedAt', async () => {
    await store.create(makeJob());
    await store.updateStatus('job-1', 'running');
    const got = await store.get('job-1');
    assert.strictEqual(got.status, 'running');
    assert.ok(got.startedAt > 0);
    assert.ok(got.updatedAt >= got.createdAt);
  });

  it('running → done sets completedAt', async () => {
    await store.create(makeJob({ status: 'running', startedAt: Date.now() }));
    await store.updateStatus('job-1', 'done');
    const got = await store.get('job-1');
    assert.strictEqual(got.status, 'done');
    assert.ok(got.completedAt > 0);
  });

  it('running → failed', async () => {
    await store.create(makeJob({ status: 'running', startedAt: Date.now() }));
    await store.updateStatus('job-1', 'failed');
    const got = await store.get('job-1');
    assert.strictEqual(got.status, 'failed');
    assert.ok(got.completedAt > 0);
  });

  it('running → cancelled (user cancel / deadline)', async () => {
    await store.create(makeJob({ status: 'running', startedAt: Date.now() }));
    await store.updateStatus('job-1', 'cancelled');
    const got = await store.get('job-1');
    assert.strictEqual(got.status, 'cancelled');
    assert.ok(got.completedAt > 0);
  });

  it('queued → cancelled (user cancel before start)', async () => {
    await store.create(makeJob());
    await store.updateStatus('job-1', 'cancelled');
    const got = await store.get('job-1');
    assert.strictEqual(got.status, 'cancelled');
    assert.ok(got.completedAt > 0);
  });

  it('updateStatus no-ops for unknown id', async () => {
    // Should not throw
    await store.updateStatus('nonexistent', 'running');
  });

  // -- claimTransition (atomic CAS) --

  it('claimTransition succeeds when status matches expected', async () => {
    await store.create(makeJob());
    const ok = await store.claimTransition('job-1', 'queued', 'running');
    assert.strictEqual(ok, true);
    const got = await store.get('job-1');
    assert.strictEqual(got.status, 'running');
    assert.ok(got.startedAt > 0);
  });

  it('claimTransition fails when status does not match', async () => {
    await store.create(makeJob({ status: 'cancelled' }));
    const ok = await store.claimTransition('job-1', 'queued', 'running');
    assert.strictEqual(ok, false);
    const got = await store.get('job-1');
    assert.strictEqual(got.status, 'cancelled', 'status should not change on failed claim');
  });

  it('claimTransition fails for unknown jobId', async () => {
    const ok = await store.claimTransition('nonexistent', 'queued', 'running');
    assert.strictEqual(ok, false);
  });

  it('claimTransition: only first caller wins (double-click race)', async () => {
    await store.create(makeJob());
    const [r1, r2] = await Promise.all([
      store.claimTransition('job-1', 'queued', 'running'),
      store.claimTransition('job-1', 'queued', 'cancelled'),
    ]);
    const winners = [r1, r2].filter(Boolean);
    assert.strictEqual(winners.length, 1, 'exactly one caller should win the race');
    const got = await store.get('job-1');
    assert.ok(got.status === 'running' || got.status === 'cancelled');
  });

  // -- setReport --

  it('setReport writes report on done job', async () => {
    await store.create(makeJob({ status: 'done', startedAt: Date.now(), completedAt: Date.now() }));
    const report = {
      summary: '砚砚的 Redis bug 在 F211 Phase C 已修复（PR #1984）',
      anchors: [
        {
          handle: 'R1',
          threadId: 'thread-xyz',
          messageId: 'msg-abc',
          title: 'F211 Redis keyPrefix 修复讨论',
          relevance: '直接相关：bug 修复 PR 讨论',
        },
      ],
    };
    await store.setReport('job-1', report);
    const got = await store.get('job-1');
    assert.deepStrictEqual(got.report, report);
    assert.ok(got.updatedAt > 0);
  });

  it('setReport no-ops for unknown id', async () => {
    // Should not throw
    await store.setReport('nonexistent', { summary: 'test', anchors: [] });
  });

  // -- isExpired helper --

  it('isExpired returns true when current time exceeds deadline', async () => {
    const { isJobExpired } = await import('../dist/domains/concierge/ConciergeInvestigationJobStore.js');
    const pastDeadline = Date.now() - 1000;
    const job = makeJob({ deadline: pastDeadline, status: 'running' });
    assert.strictEqual(isJobExpired(job), true);
  });

  it('isExpired returns false when deadline not reached', async () => {
    const { isJobExpired } = await import('../dist/domains/concierge/ConciergeInvestigationJobStore.js');
    const futureDeadline = Date.now() + 30_000;
    const job = makeJob({ deadline: futureDeadline, status: 'running' });
    assert.strictEqual(isJobExpired(job), false);
  });

  it('isExpired returns false for terminal statuses', async () => {
    const { isJobExpired } = await import('../dist/domains/concierge/ConciergeInvestigationJobStore.js');
    const pastDeadline = Date.now() - 1000;
    assert.strictEqual(isJobExpired(makeJob({ deadline: pastDeadline, status: 'done' })), false);
    assert.strictEqual(isJobExpired(makeJob({ deadline: pastDeadline, status: 'failed' })), false);
    assert.strictEqual(isJobExpired(makeJob({ deadline: pastDeadline, status: 'cancelled' })), false);
  });
});
