import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/** Convert old PrTrackingEntry-style mock to TaskItem shape for #320 unified model */
function mockTask(pr, overrides = {}) {
  return {
    id: `task-${pr.repoFullName}-${pr.prNumber}`,
    kind: 'pr_tracking',
    threadId: pr.threadId ?? 't-default',
    subjectKey: `pr:${pr.repoFullName}#${pr.prNumber}`,
    title: `PR ${pr.repoFullName}#${pr.prNumber}`,
    ownerCatId: pr.catId ?? 'opus',
    status: 'todo',
    why: '',
    createdBy: pr.catId ?? 'opus',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    userId: pr.userId ?? 'u-default',
    automationState: pr.ciTrackingEnabled === false ? { ci: { enabled: false } } : undefined,
    ...overrides,
  };
}

function mockTaskStore(tasks) {
  return { listByKind: async () => tasks };
}

describe('CiCdCheckTaskSpec', () => {
  it('has correct id and profile', async () => {
    const { createCiCdCheckTaskSpec } = await import('../../dist/infrastructure/email/CiCdCheckTaskSpec.js');
    const spec = createCiCdCheckTaskSpec({
      taskStore: mockTaskStore([]),
      cicdRouter: { route: async () => ({ kind: 'noop' }) },
      log: { info: () => {}, error: () => {}, warn: () => {} },
    });
    assert.equal(spec.id, 'cicd-check');
    assert.equal(spec.profile, 'poller');
    assert.equal(spec.trigger.ms, 60_000);
  });

  it('gate returns run:false when no tracked PRs', async () => {
    const { createCiCdCheckTaskSpec } = await import('../../dist/infrastructure/email/CiCdCheckTaskSpec.js');
    const spec = createCiCdCheckTaskSpec({
      taskStore: mockTaskStore([]),
      cicdRouter: { route: async () => ({ kind: 'noop' }) },
      log: { info: () => {}, error: () => {}, warn: () => {} },
    });
    const result = await spec.admission.gate({ taskId: 'cicd-check', lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, false);
  });

  it('gate returns run:true with per-PR workItems when PRs are tracked', async () => {
    const { createCiCdCheckTaskSpec } = await import('../../dist/infrastructure/email/CiCdCheckTaskSpec.js');
    const tasks = [mockTask({ repoFullName: 'a/b', prNumber: 1 }), mockTask({ repoFullName: 'c/d', prNumber: 42 })];
    const spec = createCiCdCheckTaskSpec({
      taskStore: mockTaskStore(tasks),
      cicdRouter: { route: async () => ({ kind: 'noop' }) },
      log: { info: () => {}, error: () => {}, warn: () => {} },
    });
    const result = await spec.admission.gate({ taskId: 'cicd-check', lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, true);
    assert.equal(result.workItems.length, 2);
    assert.equal(result.workItems[0].subjectKey, 'pr:a/b#1');
    assert.equal(result.workItems[1].subjectKey, 'pr:c/d#42');
  });

  // ── F140 Phase C 部分回退：CI pass 由 tracking 的 wake intent 分流（显式声明，不猜 approval）──
  // intent=review（默认）→ CI pass 静默（猫等 review，pass 是噪音，只留 thread 消息）。
  // intent=merge → CI pass 唤醒（猫等 CI 绿去 merge，pass 是动作信号 → merge-gate）。
  // CI fail 两种 intent 都 urgent 唤醒。intent 是显式任务意图，不是 repo 类型。

  /** Build a CI-pass spec over a task whose tracking intent is `intent` (undefined → field absent). */
  function passSpec(createCiCdCheckTaskSpec, triggered, intent) {
    const overrides = intent === undefined ? {} : { automationState: { intent } };
    const tasks = [mockTask({ repoFullName: 'a/b', prNumber: 1, userId: 'u1' }, overrides)];
    return createCiCdCheckTaskSpec({
      taskStore: mockTaskStore(tasks),
      cicdRouter: {
        route: async () => ({
          kind: 'notified',
          bucket: 'pass',
          threadId: 't1',
          catId: 'opus',
          messageId: 'm1',
          content: 'CI passed',
        }),
      },
      fetchPrStatus: async () => ({
        checks: [],
        headSha: 'sha1',
        prNumber: 1,
        repoFullName: 'a/b',
        aggregateBucket: 'pass',
      }),
      invokeTrigger: { trigger: (...args) => triggered.push(args) },
      log: { info: () => {}, error: () => {}, warn: () => {} },
    });
  }

  it('execute stays SILENT for CI pass with intent=review (review-wait noise)', async () => {
    const { createCiCdCheckTaskSpec } = await import('../../dist/infrastructure/email/CiCdCheckTaskSpec.js');
    const triggered = [];
    const spec = passSpec(createCiCdCheckTaskSpec, triggered, 'review');
    const gateResult = await spec.admission.gate({ taskId: 'cicd-check', lastRunAt: null, tickCount: 1 });
    assert.equal(gateResult.run, true);
    await spec.run.execute(gateResult.workItems[0].signal, 'pr:a/b#1', {});
    assert.equal(triggered.length, 0, 'intent=review → CI pass must not wake (noise)');
  });

  it('execute stays SILENT for CI pass when intent is absent (defaults to review)', async () => {
    const { createCiCdCheckTaskSpec } = await import('../../dist/infrastructure/email/CiCdCheckTaskSpec.js');
    const triggered = [];
    const spec = passSpec(createCiCdCheckTaskSpec, triggered, undefined); // no intent → default review
    const gateResult = await spec.admission.gate({ taskId: 'cicd-check', lastRunAt: null, tickCount: 1 });
    await spec.run.execute(gateResult.workItems[0].signal, 'pr:a/b#1', {});
    assert.equal(triggered.length, 0, 'absent intent defaults to review → silent');
  });

  it('execute WAKES for CI pass with intent=merge (action signal → merge-gate)', async () => {
    const { createCiCdCheckTaskSpec } = await import('../../dist/infrastructure/email/CiCdCheckTaskSpec.js');
    const triggered = [];
    const spec = passSpec(createCiCdCheckTaskSpec, triggered, 'merge');
    const gateResult = await spec.admission.gate({ taskId: 'cicd-check', lastRunAt: null, tickCount: 1 });
    await spec.run.execute(gateResult.workItems[0].signal, 'pr:a/b#1', {});
    assert.equal(triggered.length, 1, 'intent=merge → CI pass must wake');
    const policy = triggered[0][6];
    assert.equal(policy.priority, 'normal');
    assert.equal(policy.reason, 'github_ci_pass');
    assert.equal(policy.suggestedSkill, 'merge-gate');
  });

  it('execute triggers invokeTrigger for CI fail with urgent priority (unchanged)', async () => {
    const { createCiCdCheckTaskSpec } = await import('../../dist/infrastructure/email/CiCdCheckTaskSpec.js');
    const triggered = [];
    const tasks = [mockTask({ repoFullName: 'a/b', prNumber: 1, userId: 'u1' })];
    const spec = createCiCdCheckTaskSpec({
      taskStore: mockTaskStore(tasks),
      cicdRouter: {
        route: async () => ({
          kind: 'notified',
          bucket: 'fail',
          threadId: 't1',
          catId: 'opus',
          messageId: 'm1',
          content: 'CI failed',
        }),
      },
      fetchPrStatus: async () => ({ checks: [], headSha: 'sha1', prNumber: 1, repoFullName: 'a/b' }),
      invokeTrigger: { trigger: (...args) => triggered.push(args) },
      log: { info: () => {}, error: () => {}, warn: () => {} },
    });
    const gateResult = await spec.admission.gate({ taskId: 'cicd-check', lastRunAt: null, tickCount: 1 });
    await spec.run.execute(gateResult.workItems[0].signal, 'pr:a/b#1', {});
    assert.equal(triggered.length, 1);
    const policy = triggered[0][6];
    assert.equal(policy.priority, 'urgent');
    assert.equal(policy.reason, 'github_ci_failure');
  });

  it('gate filters out ci.enabled=false', async () => {
    const { createCiCdCheckTaskSpec } = await import('../../dist/infrastructure/email/CiCdCheckTaskSpec.js');
    const tasks = [
      mockTask({ repoFullName: 'a/b', prNumber: 1 }),
      mockTask({ repoFullName: 'c/d', prNumber: 2, ciTrackingEnabled: false }),
    ];
    const spec = createCiCdCheckTaskSpec({
      taskStore: mockTaskStore(tasks),
      cicdRouter: { route: async () => ({ kind: 'noop' }) },
      log: { info: () => {}, error: () => {}, warn: () => {} },
    });
    const result = await spec.admission.gate({ taskId: 'cicd-check', lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, true);
    assert.equal(result.workItems.length, 1);
  });
});
