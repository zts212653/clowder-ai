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
    executor.getPrHead = async () => ({ branch: 'main', headSha: 'sha1' });
    const result = await executor.resolve('a/b', 1, 'sha1');
    assert.equal(result.kind, 'skipped');
    assert.ok(result.reason.includes('not feat/*'));
  });

  it('skips when no worktree found for branch', async () => {
    const { ConflictAutoExecutor } = await import('../../dist/infrastructure/email/ConflictAutoExecutor.js');
    const executor = new ConflictAutoExecutor({ log: noopLog });
    executor.getPrHead = async () => ({ branch: 'feat/some-feature', headSha: 'sha1' });
    executor.findWorktree = async () => null;
    const result = await executor.resolve('a/b', 1, 'sha1');
    assert.equal(result.kind, 'skipped');
    assert.ok(result.reason.includes('no local worktree'));
  });

  it('skips when worktree path contains -runtime', async () => {
    const { ConflictAutoExecutor } = await import('../../dist/infrastructure/email/ConflictAutoExecutor.js');
    const executor = new ConflictAutoExecutor({ log: noopLog });
    executor.getPrHead = async () => ({ branch: 'feat/test', headSha: 'sha1' });
    executor.findWorktree = async () => '/projects/cat-cafe-runtime';
    const result = await executor.resolve('a/b', 1, 'sha1');
    assert.equal(result.kind, 'skipped');
    assert.ok(result.reason.includes('runtime'));
  });

  it('skips when PR branch cannot be determined', async () => {
    const { ConflictAutoExecutor } = await import('../../dist/infrastructure/email/ConflictAutoExecutor.js');
    const executor = new ConflictAutoExecutor({ log: noopLog });
    executor.getPrHead = async () => null;
    const result = await executor.resolve('a/b', 1, 'sha1');
    assert.equal(result.kind, 'skipped');
    assert.ok(result.reason.includes('cannot determine PR head'));
  });

  it('rejects a stale conflict observation before touching a worktree', async () => {
    const { ConflictAutoExecutor } = await import('../../dist/infrastructure/email/ConflictAutoExecutor.js');
    const executor = new ConflictAutoExecutor({ log: noopLog });
    let worktreeLookups = 0;
    executor.getPrHead = async () => ({ branch: 'feat/test', headSha: 'sha-new' });
    executor.findWorktree = async () => {
      worktreeLookups += 1;
      return '/tmp/unused';
    };

    const result = await executor.resolve('a/b', 1, 'sha-observed');
    assert.equal(result.kind, 'skipped');
    assert.match(result.reason, /HEAD changed.*refusing stale auto-rebase/);
    assert.equal(worktreeLookups, 0);
  });

  it('pins the force-with-lease to the observed PR HEAD', async () => {
    const { ConflictAutoExecutor } = await import('../../dist/infrastructure/email/ConflictAutoExecutor.js');
    const commands = [];
    const executor = new ConflictAutoExecutor({ log: noopLog });
    executor.getPrHead = async () => ({ branch: 'feat/test', headSha: 'sha-observed' });
    executor.findWorktree = async () => '/tmp/cat-cafe-conflict-lease-test';
    executor.git = async (_cwd, args) => {
      commands.push(args);
      return { stdout: args[0] === 'rev-parse' ? 'sha-observed\n' : '' };
    };

    const result = await executor.resolve('a/b', 1, 'sha-observed');
    assert.equal(result.kind, 'resolved');
    assert.deepEqual(commands, [
      ['rev-parse', 'HEAD'],
      ['fetch', 'origin', 'main'],
      ['rebase', 'origin/main'],
      ['push', '--force-with-lease=refs/heads/feat/test:sha-observed', 'origin', 'HEAD:refs/heads/feat/test'],
    ]);
  });

  it('exports correct result types', async () => {
    const mod = await import('../../dist/infrastructure/email/ConflictAutoExecutor.js');
    assert.ok(mod.ConflictAutoExecutor);
    const executor = new mod.ConflictAutoExecutor({ log: noopLog });
    assert.ok(typeof executor.resolve === 'function');
  });

  it('finishes rebase cleanup before surfacing scheduler cancellation', async () => {
    const { ConflictAutoExecutor } = await import('../../dist/infrastructure/email/ConflictAutoExecutor.js');
    const controller = new AbortController();
    const commands = [];
    const executor = new ConflictAutoExecutor({ log: noopLog });
    executor.getPrHead = async () => ({ branch: 'feat/cancelled-rebase', headSha: 'sha1' });
    executor.findWorktree = async () => '/tmp/cat-cafe-cancelled-rebase-test';
    executor.git = async (_cwd, args, signal) => {
      commands.push({ args, signal });
      if (args[0] === 'rev-parse') return { stdout: 'sha1\n' };
      if (args[0] === 'fetch') {
        controller.abort(new Error('scheduler timeout'));
        throw controller.signal.reason;
      }
      return { stdout: '' };
    };

    await assert.rejects(() => executor.resolve('a/b', 1, 'sha1', controller.signal), /scheduler timeout/);
    assert.deepEqual(
      commands.map((command) => command.args),
      [
        ['rev-parse', 'HEAD'],
        ['fetch', 'origin', 'main'],
        ['rebase', '--abort'],
      ],
    );
    assert.equal(commands[2].signal, undefined, 'cleanup keeps its own bounded process timeout');
  });

  it('warns when cancellation cleanup cannot abort the rebase', async () => {
    const { ConflictAutoExecutor } = await import('../../dist/infrastructure/email/ConflictAutoExecutor.js');
    const controller = new AbortController();
    const warnings = [];
    const executor = new ConflictAutoExecutor({
      log: { info() {}, error() {}, warn: (...args) => warnings.push(args) },
    });
    executor.getPrHead = async () => ({ branch: 'feat/cancelled-rebase', headSha: 'sha1' });
    executor.findWorktree = async () => '/tmp/cat-cafe-cancelled-rebase-test';
    executor.git = async (_cwd, args) => {
      if (args[0] === 'rev-parse') return { stdout: 'sha1\n' };
      if (args[0] === 'fetch') {
        controller.abort(new Error('scheduler timeout'));
        throw controller.signal.reason;
      }
      throw new Error('rebase abort failed');
    };

    await assert.rejects(() => executor.resolve('a/b', 1, 'sha1', controller.signal), /scheduler timeout/);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][1]), /abort rebase cleanup/i);
  });
});

describe('ConflictCheckTaskSpec + AutoExecutor integration', () => {
  it('passes the scheduler cancellation signal to the git/gh auto-executor chain', async () => {
    const { createConflictCheckTaskSpec } = await import('../../dist/infrastructure/email/ConflictCheckTaskSpec.js');
    const controller = new AbortController();
    let receivedExpectedHeadSha;
    let receivedSignal;
    const spec = createConflictCheckTaskSpec({
      taskStore: mockTaskStore([
        mockTask({ repoFullName: 'a/b', prNumber: 1, threadId: 't1', catId: 'opus', userId: 'u1' }),
      ]),
      checkMergeable: async () => ({ mergeState: 'CONFLICTING', headSha: 'sha1', isBehind: false }),
      conflictRouter: {
        async route() {
          // These cases are ABOUT the conflict path, so the stub must say the conflict matched;
          // without it the gate correctly refuses to rewrite the branch.
          return {
            kind: 'notified',
            threadId: 't1',
            catId: 'opus',
            messageId: 'm1',
            content: 'conflict!',
            matchedKinds: ['pr_became_conflicting'],
          };
        },
      },
      autoExecutor: {
        async resolve(_repo, _pr, expectedHeadSha, signal) {
          receivedExpectedHeadSha = expectedHeadSha;
          receivedSignal = signal;
          return { kind: 'resolved', method: 'clean-rebase', branch: 'feat/test' };
        },
      },
      log: noopLog,
    });
    const gateResult = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    await spec.run.execute(gateResult.workItems[0].signal, 'pr:a/b#1', {
      assignedCatId: null,
      signal: controller.signal,
    });
    assert.equal(receivedExpectedHeadSha, 'sha1');
    assert.equal(receivedSignal, controller.signal);
  });

  /*
   * codex R28, at the layer where the damage happens.
   *
   * The router emits `pr_head_changed` on every poll, so a tracker that subscribed to
   * head_changed and EXCLUDED conflict still gets `notified` on a conflicting poll. Reading that
   * as authorization ran F140 auto-resolve, which rebases and force-pushes the branch — a write
   * the owner never subscribed to, which then swallowed the head wake they did.
   *
   * Both halves are asserted: the rewrite must NOT run, and the wake must still fire. Gating the
   * wake too would trade a write bug for a silent-mute bug, which A26 ranks as the worse one.
   */
  it('a head-only match neither rewrites the branch nor loses the wake', async () => {
    const { createConflictCheckTaskSpec } = await import('../../dist/infrastructure/email/ConflictCheckTaskSpec.js');
    let resolveCalls = 0;
    const triggered = [];
    const spec = createConflictCheckTaskSpec({
      taskStore: mockTaskStore([
        mockTask({ repoFullName: 'a/b', prNumber: 1, threadId: 't1', catId: 'opus', userId: 'u1' }),
      ]),
      checkMergeable: async () => ({ mergeState: 'CONFLICTING', headSha: 'sha1', isBehind: false }),
      conflictRouter: {
        async route() {
          return {
            kind: 'notified',
            threadId: 't1',
            catId: 'opus',
            messageId: 'm1',
            content: 'HEAD changed',
            matchedKinds: ['pr_head_changed'],
          };
        },
      },
      autoExecutor: {
        async resolve() {
          resolveCalls += 1;
          return { kind: 'resolved', method: 'clean-rebase', branch: 'feat/test' };
        },
      },
      invokeTrigger: {
        trigger: async (...args) => {
          triggered.push(args);
        },
      },
      log: noopLog,
    });
    const gateResult = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    await spec.run.execute(gateResult.workItems[0].signal, 'pr:a/b#1', { assignedCatId: null });
    assert.equal(resolveCalls, 0, 'a head-only match must not authorize a rebase/push');
    assert.equal(triggered.length, 1, 'but the head wake it did subscribe to must still fire');
  });

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
      checkMergeable: async () => ({ mergeState: 'CONFLICTING', headSha: 'sha1', isBehind: false }),
      conflictRouter: {
        async route() {
          // These cases are ABOUT the conflict path, so the stub must say the conflict matched;
          // without it the gate correctly refuses to rewrite the branch.
          return {
            kind: 'notified',
            threadId: 't1',
            catId: 'opus',
            messageId: 'm1',
            content: 'conflict!',
            matchedKinds: ['pr_became_conflicting'],
          };
        },
      },
      invokeTrigger: {
        trigger: (...args) => {
          triggered.push(args);
          return Promise.resolve();
        },
      },
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
      checkMergeable: async () => ({ mergeState: 'CONFLICTING', headSha: 'sha1', isBehind: false }),
      conflictRouter: {
        async route() {
          // These cases are ABOUT the conflict path, so the stub must say the conflict matched;
          // without it the gate correctly refuses to rewrite the branch.
          return {
            kind: 'notified',
            threadId: 't1',
            catId: 'opus',
            messageId: 'm1',
            content: 'conflict!',
            matchedKinds: ['pr_became_conflicting'],
          };
        },
      },
      invokeTrigger: {
        trigger: (...args) => {
          triggered.push(args);
          return Promise.resolve();
        },
      },
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
      checkMergeable: async () => ({ mergeState: 'CONFLICTING', headSha: 'sha1', isBehind: false }),
      conflictRouter: {
        async route() {
          // These cases are ABOUT the conflict path, so the stub must say the conflict matched;
          // without it the gate correctly refuses to rewrite the branch.
          return {
            kind: 'notified',
            threadId: 't1',
            catId: 'opus',
            messageId: 'm1',
            content: 'conflict!',
            matchedKinds: ['pr_became_conflicting'],
          };
        },
      },
      invokeTrigger: {
        trigger: (...args) => {
          triggered.push(args);
          return Promise.resolve();
        },
      },
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
      checkMergeable: async () => ({ mergeState: 'CONFLICTING', headSha: 'abc123', isBehind: false }),
      conflictRouter: {
        async route() {
          // These cases are ABOUT the conflict path, so the stub must say the conflict matched;
          // without it the gate correctly refuses to rewrite the branch.
          return {
            kind: 'notified',
            threadId: 't1',
            catId: 'opus',
            messageId: 'm1',
            content: 'conflict!',
            matchedKinds: ['pr_became_conflicting'],
          };
        },
      },
      invokeTrigger: { trigger: () => Promise.resolve() },
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
      checkMergeable: async () => ({ mergeState: 'CONFLICTING', headSha: 'sha1', isBehind: false }),
      conflictRouter: {
        async route() {
          // These cases are ABOUT the conflict path, so the stub must say the conflict matched;
          // without it the gate correctly refuses to rewrite the branch.
          return {
            kind: 'notified',
            threadId: 't1',
            catId: 'opus',
            messageId: 'm1',
            content: 'conflict!',
            matchedKinds: ['pr_became_conflicting'],
          };
        },
      },
      invokeTrigger: {
        trigger: (...args) => {
          triggered.push(args);
          return Promise.resolve();
        },
      },
      // no autoExecutor
      log: noopLog,
    });
    const gateResult = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    await spec.run.execute(gateResult.workItems[0].signal, 'pr:a/b#1', {});
    assert.equal(triggered.length, 1, 'without autoExecutor, cat should always be triggered');
  });
});
