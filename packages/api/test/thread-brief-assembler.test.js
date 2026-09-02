import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const thread = {
  id: 'thread-1',
  projectPath: '/project',
  title: '深入学习 runtime harness',
  createdBy: 'user-1',
  participants: [],
  lastActiveAt: 1,
  createdAt: 1,
};

async function createAssembler(overrides = {}) {
  const [{ ThreadBriefAssembler }, { ThreadProgressReceiptStore }] = await Promise.all([
    import('../dist/domains/thread-progress/ThreadBriefAssembler.js'),
    import('../dist/domains/thread-progress/ThreadProgressReceiptStore.js'),
  ]);
  const receiptStore = new ThreadProgressReceiptStore();
  const deps = {
    receiptStore,
    taskStore: { listByThread: async () => [] },
    taskProgressStore: { getThreadSnapshots: async () => ({}) },
    readLiveExecutions: async () => [],
    readAttention: async () => [],
    readWaits: async () => [],
    now: () => 500,
    ...overrides,
  };
  return { assembler: new ThreadBriefAssembler(deps), receiptStore };
}

describe('ThreadBriefAssembler', () => {
  test('combines confirmed child execution, exact TaskProgress action and latest Receipt', async () => {
    const { assembler, receiptStore } = await createAssembler({
      readLiveExecutions: async () => [{ catId: 'opus', startedAt: 200, turnInvocationId: 'child-2', degraded: false }],
      taskProgressStore: {
        getThreadSnapshots: async () => ({
          opus: {
            threadId: 'thread-1',
            catId: 'opus',
            status: 'running',
            updatedAt: 300,
            lastInvocationId: 'child-2',
            tasks: [
              { id: 'step-1', subject: '实现 read model', status: 'in_progress', activeForm: '组装 ThreadBrief' },
            ],
          },
        }),
      },
      taskStore: {
        listByThread: async () => [
          { id: 'todo-1', kind: 'work', status: 'todo', threadId: 'thread-1', userId: 'user-1' },
          { id: 'done-1', kind: 'work', status: 'done', threadId: 'thread-1', userId: 'user-1' },
        ],
      },
    });
    await receiptStore.appendIfAbsent({
      v: 1,
      id: 'receipt-1',
      ownerUserId: 'user-1',
      threadId: 'thread-1',
      kind: 'decision',
      impactAxes: ['next_action'],
      actor: { kind: 'cat', catId: 'opus' },
      headline: '确定 Phase A 的边界',
      nextStep: '完成单会话验收',
      provenance: [{ kind: 'invocation', invocationId: 'child-2' }],
      sourceKey: 'source-1',
      occurredAt: 400,
      createdAt: 400,
    });

    const brief = await assembler.assemble(thread, 'user-1');
    assert.equal(brief.presentationState, 'running');
    assert.equal(brief.availability, 'ok');
    assert.equal(brief.currentExecutions[0].action, '组装 ThreadBrief');
    assert.equal(brief.recentProgress[0].headline, '确定 Phase A 的边界');
    assert.equal(brief.nextStep, '完成单会话验收');
    assert.equal(brief.openWorkTaskCount, 1);
    assert.equal(brief.generatedAt, 500);
  });

  test('does not use parent or stale TaskProgress as current action', async () => {
    for (const lastInvocationId of ['parent-1', 'old-child']) {
      const { assembler } = await createAssembler({
        readLiveExecutions: async () => [
          { catId: 'opus', startedAt: 200, turnInvocationId: 'child-2', degraded: false },
        ],
        taskProgressStore: {
          getThreadSnapshots: async () => ({
            opus: {
              lastInvocationId,
              tasks: [{ id: 'step-1', subject: '旧动作', status: 'in_progress', activeForm: '旧动作进行中' }],
            },
          }),
        },
      });
      const brief = await assembler.assemble(thread, 'user-1');
      assert.equal(brief.currentExecutions[0].action, undefined);
    }
  });

  test('keeps degraded and failed liveness out of running state', async () => {
    const degraded = await createAssembler({
      readLiveExecutions: async () => [{ catId: 'opus', startedAt: 200, degraded: true }],
    });
    assert.equal((await degraded.assembler.assemble(thread, 'user-1')).presentationState, 'unknown');

    const failed = await createAssembler({ readLiveExecutions: async () => Promise.reject(new Error('down')) });
    const failedBrief = await failed.assembler.assemble(thread, 'user-1');
    assert.equal(failedBrief.presentationState, 'unknown');
    assert.equal(failedBrief.availability, 'partial');
  });

  test('needs-user has visual priority without hiding a confirmed execution', async () => {
    const { assembler } = await createAssembler({
      readLiveExecutions: async () => [{ catId: 'opus', startedAt: 200, degraded: false }],
      readAttention: async () => [{ kind: 'approval', label: '需要你确认范围', createdAt: 250 }],
      readWaits: async () => [{ kind: 'external', label: '等待 CI', createdAt: 240 }],
    });
    const brief = await assembler.assemble(thread, 'user-1');
    assert.equal(brief.presentationState, 'needs_user');
    assert.equal(brief.currentExecutions.length, 1);
    assert.equal(brief.waits.length, 1);
  });
});
