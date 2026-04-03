import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const noopLog = { info: () => {}, warn: () => {}, error: () => {} };

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
    ...overrides,
  };
}

function mockTaskStore(tasks) {
  return { listByKind: async () => tasks };
}

describe('ConflictAutoExecutor', () => {
  it('skips when PR branch is not feat/*', async () => {
    const { ConflictAutoExecutor } = await import('../../dist/infrastructure/email/ConflictAutoExecutor.js');
    const executor = new ConflictAutoExecutor({ log: noopLog });
    // Mock getPrBranch to return a non-feat branch
    executor.getPrBranch = async () => 'main';
    const result = await executor.resolve('a/b', 1);
    assert.equal(result.kind, 'skipped');
    assert.ok(result.reason.includes('not feat/*'));
  });

  it('skips when no worktree found for branch', async () => {
    const { ConflictAutoExecutor } = await import('../../dist/infrastructure/email/ConflictAutoExecutor.js');
    const executor = new ConflictAutoExecutor({ log: noopLog });
    executor.getPrBranch = async () => 'feat/some-feature';
    executor.findWorktree = async () => null;
    const result = await executor.resolve('a/b', 1);
    assert.equal(result.kind, 'skipped');
    assert.ok(result.reason.includes('no local worktree'));
  });

  it('skips when worktree path contains -runtime', async () => {
    const { ConflictAutoExecutor } = await import('../../dist/infrastructure/email/ConflictAutoExecutor.js');
    const executor = new ConflictAutoExecutor({ log: noopLog });
    executor.getPrBranch = async () => 'feat/test';
    executor.findWorktree = async () => '/projects/cat-cafe-runtime';
    const result = await executor.resolve('a/b', 1);
    assert.equal(result.kind, 'skipped');
    assert.ok(result.reason.includes('runtime'));
  });

  it('skips when PR branch cannot be determined', async () => {
    const { ConflictAutoExecutor } = await import('../../dist/infrastructure/email/ConflictAutoExecutor.js');
    const executor = new ConflictAutoExecutor({ log: noopLog });
    executor.getPrBranch = async () => null;
    const result = await executor.resolve('a/b', 1);
    assert.equal(result.kind, 'skipped');
    assert.ok(result.reason.includes('cannot determine'));
  });

  it('exports correct result types', async () => {
    const mod = await import('../../dist/infrastructure/email/ConflictAutoExecutor.js');
    assert.ok(mod.ConflictAutoExecutor);
    const executor = new mod.ConflictAutoExecutor({ log: noopLog });
    assert.ok(typeof executor.resolve === 'function');
  });
});

describe('ConflictCheckTaskSpec + AutoExecutor integration', () => {
  it('auto-resolved conflict does NOT trigger cat (Phase C AC-C1)', async () => {
    const { createConflictCheckTaskSpec } = await import('../../dist/infrastructure/email/ConflictCheckTaskSpec.js');
    const triggered = [];
    const autoExecutor = {
      async resolve() {
        return { kind: 'resolved', method: 'clean-rebase', branch: 'feat/test' };
      },
    };
    const tasks = [mockTask({ repoFullName: 'a/b', prNumber: 1, threadId: 't1', catId: 'opus', userId: 'u1' })];
    const spec = createConflictCheckTaskSpec({
      taskStore: mockTaskStore(tasks),
      checkMergeable: async () => ({ mergeState: 'CONFLICTING', headSha: 'sha1' }),
      conflictRouter: {
        async route() {
          return { kind: 'notified', threadId: 't1', catId: 'opus', messageId: 'm1', content: 'conflict!' };
        },
      },
      invokeTrigger: { trigger: (...args) => triggered.push(args) },
      autoExecutor,
      log: noopLog,
    });
    const gateResult = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(gateResult.run, true);
    await spec.run.execute(gateResult.workItems[0].signal, 'pr:a/b#1', {});
    assert.equal(triggered.length, 0, 'cat should NOT be triggered when auto-resolve succeeds');
  });

  it('escalated conflict DOES trigger cat (Phase C AC-C2)', async () => {
    const { createConflictCheckTaskSpec } = await import('../../dist/infrastructure/email/ConflictCheckTaskSpec.js');
    const triggered = [];
    const autoExecutor = {
      async resolve() {
        return { kind: 'escalated', files: ['src/index.ts', 'docs/README.md'], branch: 'feat/test' };
      },
    };
    const tasks = [mockTask({ repoFullName: 'a/b', prNumber: 1, threadId: 't1', catId: 'opus', userId: 'u1' })];
    const spec = createConflictCheckTaskSpec({
      taskStore: mockTaskStore(tasks),
      checkMergeable: async () => ({ mergeState: 'CONFLICTING', headSha: 'sha1' }),
      conflictRouter: {
        async route() {
          return { kind: 'notified', threadId: 't1', catId: 'opus', messageId: 'm1', content: 'conflict!' };
        },
      },
      invokeTrigger: { trigger: (...args) => triggered.push(args) },
      autoExecutor,
      log: noopLog,
    });
    const gateResult = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    await spec.run.execute(gateResult.workItems[0].signal, 'pr:a/b#1', {});
    assert.equal(triggered.length, 1, 'cat SHOULD be triggered when auto-resolve escalates');
  });

  it('cloud-P1: mergeState uses mergeable vocabulary (CONFLICTING not DIRTY)', async () => {
    const { createConflictCheckTaskSpec } = await import('../../dist/infrastructure/email/ConflictCheckTaskSpec.js');
    const triggered = [];
    const autoExecutor = {
      async resolve() {
        return { kind: 'resolved', method: 'clean-rebase', branch: 'feat/test' };
      },
    };
    const tasks = [mockTask({ repoFullName: 'a/b', prNumber: 1, threadId: 't1', catId: 'opus', userId: 'u1' })];
    const spec = createConflictCheckTaskSpec({
      taskStore: mockTaskStore(tasks),
      // Simulate what production checkMergeable returns — must use CONFLICTING not DIRTY
      checkMergeable: async () => ({ mergeState: 'CONFLICTING', headSha: 'sha1' }),
      conflictRouter: {
        async route() {
          return { kind: 'notified', threadId: 't1', catId: 'opus', messageId: 'm1', content: 'conflict!' };
        },
      },
      invokeTrigger: { trigger: (...args) => triggered.push(args) },
      autoExecutor,
      log: noopLog,
    });
    const gateResult = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(gateResult.run, true);
    // The key assertion: mergeState must be 'CONFLICTING' (from gh mergeable field)
    // NOT 'DIRTY' (from mergeStateStatus field) — otherwise autoExecutor is never invoked
    const signal = gateResult.workItems[0].signal;
    assert.equal(signal.signal.mergeState, 'CONFLICTING', 'mergeState must use mergeable vocabulary');
    await spec.run.execute(signal, 'pr:a/b#1', {});
    assert.equal(triggered.length, 0, 'auto-resolved conflict should not trigger cat');
  });

  it('P1-3 regression: checkMergeable returning object provides mergeState to workItems', async () => {
    const { createConflictCheckTaskSpec } = await import('../../dist/infrastructure/email/ConflictCheckTaskSpec.js');
    const tasks = [mockTask({ repoFullName: 'a/b', prNumber: 1, threadId: 't1', catId: 'opus', userId: 'u1' })];
    const spec = createConflictCheckTaskSpec({
      taskStore: mockTaskStore(tasks),
      checkMergeable: async () => ({ mergeState: 'CONFLICTING', headSha: 'abc123' }),
      conflictRouter: {
        async route() {
          return { kind: 'notified', threadId: 't1', catId: 'opus', messageId: 'm1', content: 'conflict!' };
        },
      },
      invokeTrigger: { trigger: () => {} },
      log: noopLog,
    });
    const gateResult = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(gateResult.run, true);
    const signal = gateResult.workItems[0].signal;
    assert.equal(signal.signal.mergeState, 'CONFLICTING', 'mergeState must not be undefined (P1-3)');
    assert.equal(signal.signal.headSha, 'abc123', 'headSha must not be undefined (P1-3)');
  });

  it('no autoExecutor → always triggers cat (backward compat)', async () => {
    const { createConflictCheckTaskSpec } = await import('../../dist/infrastructure/email/ConflictCheckTaskSpec.js');
    const triggered = [];
    const tasks = [mockTask({ repoFullName: 'a/b', prNumber: 1, threadId: 't1', catId: 'opus', userId: 'u1' })];
    const spec = createConflictCheckTaskSpec({
      taskStore: mockTaskStore(tasks),
      checkMergeable: async () => ({ mergeState: 'CONFLICTING', headSha: 'sha1' }),
      conflictRouter: {
        async route() {
          return { kind: 'notified', threadId: 't1', catId: 'opus', messageId: 'm1', content: 'conflict!' };
        },
      },
      invokeTrigger: { trigger: (...args) => triggered.push(args) },
      // no autoExecutor
      log: noopLog,
    });
    const gateResult = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    await spec.run.execute(gateResult.workItems[0].signal, 'pr:a/b#1', {});
    assert.equal(triggered.length, 1, 'without autoExecutor, cat should always be triggered');
  });
});
