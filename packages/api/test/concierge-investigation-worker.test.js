/**
 * ConciergeInvestigationWorker tests (F229 Phase B2)
 *
 * Covers the async investigation execution:
 *   queued → running → search → report → done
 *   queued → running → error → failed
 *   running → deadline → cancelled (INV I3)
 *   queued → cancelled (race: cancelled before worker starts)
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/** @type {import('../dist/domains/concierge/ConciergeInvestigationJobStore.js').MemoryConciergeInvestigationJobStore} */
let jobStore;

/** @type {import('../dist/domains/concierge/ConciergeInvestigationWorker.js').executeInvestigation} */
let executeInvestigation;

/** @type {import('../dist/domains/concierge/ConciergeTriagePlanStore.js').MemoryConciergeTriagePlanStore} */
let triagePlanStore;

const DEFAULT_DEADLINE_MS = 60_000;

function makeJob(overrides = {}) {
  const now = Date.now();
  return {
    id: 'job-1',
    userId: 'user-1',
    triagePlanId: 'plan-1',
    query: '砚砚 Redis bug 修复状态',
    scope: ['memory', 'docs', 'feat_index'],
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    deadline: now + DEFAULT_DEADLINE_MS,
    ...overrides,
  };
}

/** Stub evidence store that returns canned results */
function makeEvidenceStore(items = []) {
  return {
    search: async () => items,
  };
}

/** Stub evidence store that throws */
function makeFailingEvidenceStore() {
  return {
    search: async () => {
      throw new Error('Search API unavailable');
    },
  };
}

describe('ConciergeInvestigationWorker', () => {
  beforeEach(async () => {
    const { MemoryConciergeInvestigationJobStore } = await import(
      '../dist/domains/concierge/ConciergeInvestigationJobStore.js'
    );
    const { MemoryConciergeTriagePlanStore } = await import('../dist/domains/concierge/ConciergeTriagePlanStore.js');
    ({ executeInvestigation } = await import('../dist/domains/concierge/ConciergeInvestigationWorker.js'));
    jobStore = new MemoryConciergeInvestigationJobStore();
    triagePlanStore = new MemoryConciergeTriagePlanStore();
  });

  it('happy path: queued → running → done with report', async () => {
    const job = makeJob();
    await jobStore.create(job);

    const evidenceStore = makeEvidenceStore([
      {
        anchor: 'thread-thread_xyz',
        title: 'F211 Redis keyPrefix 修复讨论',
        kind: 'thread',
        summary: '砚砚修了 ioredis keyPrefix 的 eval 前缀行为不一致',
        drillDown: { tool: 'read', params: { threadId: 'thread_xyz', messageId: 'msg-1' }, hint: '' },
      },
      {
        anchor: 'thread-thread_abc',
        title: 'Redis 测试隔离策略',
        kind: 'thread',
        summary: 'pnpm test:redis 用临时 Redis 实例',
      },
    ]);

    await executeInvestigation({ jobId: 'job-1', jobStore, evidenceStore });

    const result = await jobStore.get('job-1');
    assert.strictEqual(result.status, 'done');
    assert.ok(result.report, 'Should have a report');
    assert.ok(result.report.summary.length > 0, 'Summary should be non-empty');
    assert.strictEqual(result.report.anchors.length, 2, 'Should have 2 anchors');
    assert.strictEqual(result.report.anchors[0].handle, 'R1');
    assert.strictEqual(result.report.anchors[0].kind, 'thread');
    assert.strictEqual(result.report.anchors[0].threadId, 'thread_xyz');
    assert.strictEqual(result.report.anchors[1].handle, 'R2');
    assert.strictEqual(result.report.anchors[1].kind, 'thread');
    assert.strictEqual(result.report.anchors[1].title, 'Redis 测试隔离策略');
  });

  it('no results: creates report with empty anchors', async () => {
    const job = makeJob();
    await jobStore.create(job);

    const evidenceStore = makeEvidenceStore([]);

    await executeInvestigation({ jobId: 'job-1', jobStore, evidenceStore });

    const result = await jobStore.get('job-1');
    assert.strictEqual(result.status, 'done');
    assert.ok(result.report);
    assert.ok(result.report.summary.includes('没有找到'), 'Should mention no results');
    assert.strictEqual(result.report.anchors.length, 0);
  });

  it('search failure: transitions to failed', async () => {
    const job = makeJob();
    await jobStore.create(job);

    const evidenceStore = makeFailingEvidenceStore();

    await executeInvestigation({ jobId: 'job-1', jobStore, evidenceStore });

    const result = await jobStore.get('job-1');
    assert.strictEqual(result.status, 'failed');
  });

  it('already-cancelled job: worker skips (claim fails)', async () => {
    const job = makeJob({ status: 'cancelled' });
    await jobStore.create(job);

    const evidenceStore = makeEvidenceStore([]);

    await executeInvestigation({ jobId: 'job-1', jobStore, evidenceStore });

    // Should still be cancelled — worker couldn't claim it
    const result = await jobStore.get('job-1');
    assert.strictEqual(result.status, 'cancelled');
  });

  it('unknown job: worker is a no-op', async () => {
    const evidenceStore = makeEvidenceStore([]);
    // Should not throw
    await executeInvestigation({ jobId: 'nonexistent', jobStore, evidenceStore });
  });

  it('expired deadline: worker cancels instead of running', async () => {
    const now = Date.now();
    const job = makeJob({ deadline: now - 1000 }); // Already expired
    await jobStore.create(job);

    const evidenceStore = makeEvidenceStore([{ anchor: 'a', title: 't', kind: 'thread' }]);

    await executeInvestigation({ jobId: 'job-1', jobStore, evidenceStore });

    const result = await jobStore.get('job-1');
    assert.strictEqual(result.status, 'cancelled', 'Expired job should be cancelled, not run');
  });

  // ── P1 fix: race condition — cancelled-during-execution must not resurrect ──

  it('running job cancelled mid-execution stays cancelled (not overwritten to done)', async () => {
    const job = makeJob();
    await jobStore.create(job);

    // Evidence store that simulates slow search — cancels the job before returning
    const evidenceStore = {
      search: async () => {
        // Simulate: user cancels while search is in progress
        await jobStore.claimTransition('job-1', 'running', 'cancelled');
        return [{ anchor: 'thread-t1', title: 'result', kind: 'thread', summary: 's' }];
      },
    };

    await executeInvestigation({ jobId: 'job-1', jobStore, evidenceStore });

    const result = await jobStore.get('job-1');
    assert.strictEqual(result.status, 'cancelled', 'Cancelled job must NOT be overwritten to done');
    // Cloud P1 R2: cancelled jobs must NOT have orphaned reports (CAS-before-report ordering)
    assert.strictEqual(result.report, undefined, 'Cancelled job must NOT have an orphaned report');
  });

  it('running job cancelled mid-execution stays cancelled (not overwritten to failed)', async () => {
    const job = makeJob();
    await jobStore.create(job);

    // Evidence store that cancels during search, then throws
    const evidenceStore = {
      search: async () => {
        await jobStore.claimTransition('job-1', 'running', 'cancelled');
        throw new Error('Search failed after cancel');
      },
    };

    await executeInvestigation({ jobId: 'job-1', jobStore, evidenceStore });

    const result = await jobStore.get('job-1');
    assert.strictEqual(result.status, 'cancelled', 'Cancelled job must NOT be overwritten to failed');
  });

  // ── P2 fix: non-thread evidence gets kind-aware anchors ──

  it('doc evidence produces kind=doc anchor with path, not fake threadId', async () => {
    const job = makeJob();
    await jobStore.create(job);

    const evidenceStore = makeEvidenceStore([
      {
        anchor: 'docs/features/F229-cat-ball-concierge.md',
        title: 'F229 feature doc',
        kind: 'doc',
        summary: 'Cat Ball Concierge spec',
      },
    ]);

    await executeInvestigation({ jobId: 'job-1', jobStore, evidenceStore });

    const result = await jobStore.get('job-1');
    const a = result.report.anchors[0];
    assert.strictEqual(a.kind, 'doc', 'Should be kind=doc');
    assert.strictEqual(a.path, 'docs/features/F229-cat-ball-concierge.md');
    assert.strictEqual(a.threadId, undefined, 'Doc anchors must NOT have threadId');
  });

  it('mixed thread + doc evidence renders kind-appropriate summary markers', async () => {
    const job = makeJob();
    await jobStore.create(job);

    const evidenceStore = makeEvidenceStore([
      {
        anchor: 'thread-thread_xyz',
        title: '讨论记录',
        kind: 'thread',
        summary: 'thread discussion',
        drillDown: { tool: 'read', params: { threadId: 'thread_xyz' }, hint: '' },
      },
      {
        anchor: 'docs/plans/some-plan.md',
        title: '实施计划',
        kind: 'doc',
        summary: 'plan document',
      },
    ]);

    await executeInvestigation({ jobId: 'job-1', jobStore, evidenceStore });

    const result = await jobStore.get('job-1');
    // Thread anchor uses [跳过去 Rn], doc uses [查看 Rn]
    assert.ok(result.report.summary.includes('[跳过去 R1]'), 'Thread items get 跳过去 marker');
    assert.ok(result.report.summary.includes('[查看 R2]'), 'Doc items get 查看 marker');
  });

  // ── P1 fix R2: parent TriagePlan must propagate job terminal state ──

  it('worker done propagates parent TriagePlan to completed', async () => {
    // Seed a triage plan in dispatched state
    await triagePlanStore.create({
      id: 'plan-1',
      userId: 'user-1',
      sourceMessageId: 'msg-1',
      originalText: 'test',
      intent: 'investigate',
      target: { query: '砚砚 Redis bug' },
      status: 'dispatched',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const job = makeJob();
    await jobStore.create(job);
    const evidenceStore = makeEvidenceStore([{ anchor: 'thread-t1', title: 'result', kind: 'thread', summary: 's' }]);

    await executeInvestigation({ jobId: 'job-1', jobStore, evidenceStore, triagePlanStore });

    const plan = await triagePlanStore.get('plan-1');
    assert.strictEqual(plan.status, 'completed', 'Parent plan should be completed when job is done');
  });

  it('worker failed propagates parent TriagePlan to failed', async () => {
    await triagePlanStore.create({
      id: 'plan-1',
      userId: 'user-1',
      sourceMessageId: 'msg-1',
      originalText: 'test',
      intent: 'investigate',
      target: { query: 'test' },
      status: 'dispatched',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const job = makeJob();
    await jobStore.create(job);
    const evidenceStore = makeFailingEvidenceStore();

    await executeInvestigation({ jobId: 'job-1', jobStore, evidenceStore, triagePlanStore });

    const plan = await triagePlanStore.get('plan-1');
    assert.strictEqual(plan.status, 'failed', 'Parent plan should be failed when job fails');
  });

  // ── INV I2 contract: done ⇒ report (gpt52 P1 finding) ──

  it('INV I2: report persistence failure does not produce done-without-report', async () => {
    await triagePlanStore.create({
      id: 'plan-1',
      userId: 'user-1',
      sourceMessageId: 'msg-1',
      originalText: 'test',
      intent: 'investigate',
      target: { query: 'test' },
      status: 'dispatched',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const job = makeJob();
    await jobStore.create(job);
    const evidenceStore = makeEvidenceStore([{ anchor: 'thread-t1', title: 'result', kind: 'thread', summary: 's' }]);

    // Mock setReport to throw (simulates Redis write failure)
    const origSetReport = jobStore.setReport.bind(jobStore);
    jobStore.setReport = async () => {
      throw new Error('Redis write failed');
    };

    await executeInvestigation({ jobId: 'job-1', jobStore, evidenceStore, triagePlanStore });

    jobStore.setReport = origSetReport;

    const result = await jobStore.get('job-1');

    // INV I2: a job at status 'done' MUST have a report.
    // Acceptable outcomes when report write fails:
    //   - done WITH report (atomic write succeeded) ✅
    //   - failed (report write failed, job rolled back) ✅
    //   - done WITHOUT report ❌ (INV I2 violation)
    if (result.status === 'done') {
      assert.ok(result.report, 'INV I2 violation: done job has no report');
    }
    assert.ok(
      (result.status === 'done' && result.report) || result.status === 'failed',
      `Expected done-with-report or failed, got status=${result.status} report=${!!result.report}`,
    );

    // Parent plan must reach a terminal state regardless of which path
    const plan = await triagePlanStore.get('plan-1');
    assert.ok(
      plan.status === 'completed' || plan.status === 'failed',
      `Parent plan must be terminal, got ${plan.status}`,
    );
  });

  // ── Cloud P1: post-search deadline enforcement (INV I3 fail-closed) ──

  it('worker cancels when search exceeds deadline (INV I3 post-search)', async () => {
    const now = Date.now();
    // Deadline in 20ms — search will take longer
    const job = makeJob({ deadline: now + 20 });
    await jobStore.create(job);

    // Slow search that exceeds the tight deadline
    const evidenceStore = {
      search: async () => {
        await new Promise((r) => setTimeout(r, 80));
        return [{ anchor: 'thread-t1', title: 'result', kind: 'thread', summary: 's' }];
      },
    };

    await executeInvestigation({ jobId: 'job-1', jobStore, evidenceStore });

    const result = await jobStore.get('job-1');
    assert.strictEqual(result.status, 'cancelled', 'Job past deadline after search should be cancelled, not done');
  });

  it('report anchors parse drillDown params correctly', async () => {
    const job = makeJob();
    await jobStore.create(job);

    const evidenceStore = makeEvidenceStore([
      {
        anchor: 'thread-thread_abc',
        title: '讨论记录',
        kind: 'thread',
        summary: 'test',
        drillDown: {
          tool: 'read_session_events',
          params: { threadId: 'thread_real', messageId: 'msg-42' },
          hint: 'some hint',
        },
      },
    ]);

    await executeInvestigation({ jobId: 'job-1', jobStore, evidenceStore });

    const result = await jobStore.get('job-1');
    assert.strictEqual(result.report.anchors[0].threadId, 'thread_real', 'drillDown.params.threadId takes priority');
    assert.strictEqual(result.report.anchors[0].messageId, 'msg-42');
  });
});
