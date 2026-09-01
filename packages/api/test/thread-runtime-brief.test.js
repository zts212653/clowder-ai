import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('ThreadRuntimeBriefAssembler', () => {
  test('projects exact current plan plus owner sessions, usage, anchors and latest progress', async () => {
    const { ThreadRuntimeBriefAssembler } = await import(
      '../dist/domains/thread-progress/ThreadRuntimeBriefAssembler.js'
    );
    const assembler = new ThreadRuntimeBriefAssembler({
      receiptStore: {
        listByThread: async () => [receipt()],
      },
      taskStore: {
        listByThread: async () => [
          { id: 'task-1', kind: 'work', status: 'doing', userId: 'user-1' },
          { id: 'task-2', kind: 'work', status: 'done', userId: 'user-1' },
        ],
      },
      taskProgressStore: {
        getThreadSnapshots: async () => ({
          opus: {
            threadId: 'thread-1',
            catId: 'opus',
            status: 'running',
            updatedAt: 90,
            lastInvocationId: 'turn-current',
            tasks: [{ id: 'step-1', subject: '验证 Phase C', status: 'in_progress', activeForm: '验证空态' }],
          },
          stale: {
            threadId: 'thread-1',
            catId: 'stale',
            status: 'running',
            updatedAt: 80,
            lastInvocationId: 'old-turn',
            tasks: [{ id: 'step-old', subject: '旧计划', status: 'in_progress' }],
          },
        }),
      },
      sessionChainStore: {
        getChainByThread: async () => [
          session('session-owner-old', 'user-1', 100),
          session('session-foreign', 'user-2', 300),
          session('session-owner-new', 'user-1', 200),
        ],
      },
      readLiveExecutions: async () => [
        { catId: 'opus', startedAt: 70, turnInvocationId: 'turn-current', degraded: false },
        { catId: 'stale', startedAt: 60, turnInvocationId: 'turn-new', degraded: false },
      ],
      now: () => 500,
    });

    const result = await assembler.assemble(thread(), 'user-1');
    assert.equal(result.availability, 'ok');
    assert.equal(result.currentExecutions[0].plan.tasks[0].activeForm, '验证空态');
    assert.equal(result.currentExecutions[1].plan, undefined, 'stale plan must not attach to a new turn');
    assert.deepEqual(
      result.recentSessions.map((item) => item.sessionId),
      ['session-owner-new', 'session-owner-old'],
    );
    assert.equal(result.recentSessions[0].usage.inputTokens, 10);
    assert.equal(result.latestProgress.headline, '完成 Phase B');
    assert.equal(result.nextStep, '推进 Phase C');
    assert.equal(result.openWorkTaskCount, 1);
    assert.deepEqual(result.anchors.features, ['F308']);
    assert.equal(result.generatedAt, 500);
  });

  test('fails closed for current execution while retaining persistent empty-state facts', async () => {
    const { ThreadRuntimeBriefAssembler } = await import(
      '../dist/domains/thread-progress/ThreadRuntimeBriefAssembler.js'
    );
    const assembler = new ThreadRuntimeBriefAssembler({
      receiptStore: { listByThread: async () => [receipt()] },
      taskStore: { listByThread: async () => [] },
      taskProgressStore: { getThreadSnapshots: async () => ({}) },
      sessionChainStore: { getChainByThread: async () => [session('session-1', 'user-1', 100)] },
      readLiveExecutions: async () => {
        throw new Error('liveness unavailable');
      },
    });

    const result = await assembler.assemble(thread(), 'user-1');
    assert.equal(result.availability, 'partial');
    assert.deepEqual(result.currentExecutions, []);
    assert.equal(result.recentSessions.length, 1);
    assert.equal(result.latestProgress.headline, '完成 Phase B');
  });
});

function thread() {
  return {
    id: 'thread-1',
    title: 'F308 长程任务',
    projectPath: 'default',
    createdBy: 'user-1',
    participants: [],
    lastActiveAt: 1,
    createdAt: 1,
    threadMetadata: {
      v: 1,
      worktrees: ['/workspace/f308'],
      prs: [{ repo: 'clowder-ai', number: 1 }],
      issues: [{ repo: 'clowder-ai', number: 2 }],
      features: ['F308'],
    },
  };
}

function receipt() {
  return {
    v: 1,
    id: 'receipt-1',
    ownerUserId: 'user-1',
    threadId: 'thread-1',
    kind: 'milestone',
    impactAxes: ['verified_outcome'],
    actor: { kind: 'cat', catId: 'opus' },
    headline: '完成 Phase B',
    nextStep: '推进 Phase C',
    provenance: [{ kind: 'invocation', invocationId: 'turn-current' }],
    sourceKey: 'source-1',
    occurredAt: 100,
    createdAt: 100,
  };
}

function session(id, userId, updatedAt) {
  return {
    id,
    cliSessionId: `cli-${id}`,
    workingDirectory: `/workspace/${id}`,
    threadId: 'thread-1',
    catId: 'opus',
    userId,
    seq: updatedAt,
    status: 'sealed',
    messageCount: 5,
    compressionCount: 0,
    lastUsage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
    contextHealth: { fillRatio: 0.5, source: 'exact', measuredAt: updatedAt },
    createdAt: updatedAt - 10,
    updatedAt,
    sealedAt: updatedAt,
  };
}
