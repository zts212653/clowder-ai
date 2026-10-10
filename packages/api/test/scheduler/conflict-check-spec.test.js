import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { TaskStore } = await import('../../dist/domains/cats/services/stores/ports/TaskStore.js');
const { createConflictCheckTaskSpec } = await import('../../dist/infrastructure/email/ConflictCheckTaskSpec.js');

/*
 * #1392 R5: only a matched conflict may drive the auto-resolver, and the matched outcome is the
 * authorization. Phase C AC-C1: a conflict the scheduler repairs itself must not disturb the owner.
 *
 * Those two hold together because terminalizing the outcome and announcing it are separate steps.
 * `route` returns `matched_pending` — durable authorization, nothing announced — and the spec then
 * owes exactly one of `publish` or `settleWithoutWake`. These cases observe that pair, which is
 * what production actually has; the old `invokeTrigger` they used to watch was never wired by
 * `github-schedule-factories.ts` at all.
 */
const conflictMatchedOutcome = {
  v: 1,
  outcomeId: 'wait:pr:owner/repo#7:g1:matched',
  generation: 1,
  subjectRef: 'pr:owner/repo#7',
  ownerFence: { kind: 'containing_task', generation: 1 },
  reason: 'matched',
  at: 1000,
  delivery: 'pending',
  matched: [{ kind: 'pr_became_conflicting', delta: 'mergeState MERGEABLE → CONFLICTING' }],
};

const CONFLICT_WORK_ITEM = {
  signal: { repoFullName: 'owner/repo', prNumber: 7, headSha: 'aaa', mergeState: 'CONFLICTING' },
  task: { userId: 'user_1' },
};

/** The two-step router contract: terminalize and hold, then either announce or close quietly. */
function routerStub({ routeResult, onRoute } = {}) {
  const calls = { routes: [], published: [], settled: [] };
  const router = {
    async route(signal) {
      calls.routes.push(signal);
      await onRoute?.();
      return (
        routeResult ?? {
          kind: 'matched_pending',
          taskId: 'task-1',
          threadId: 'thread_1',
          catId: 'codex-sol',
          outcome: conflictMatchedOutcome,
        }
      );
    },
    async publish(taskId, outcome) {
      calls.published.push({ taskId, outcomeId: outcome.outcomeId });
      return { kind: 'notified' };
    },
    async settleWithoutWake(taskId, outcome, reason) {
      calls.settled.push({ taskId, outcomeId: outcome.outcomeId, reason });
      return true;
    },
  };
  return { calls, router };
}

const noLog = { info() {}, warn() {}, error() {} };

describe('conflict scheduler F280 adapter', () => {
  test('collects merge state for active PR tasks', async () => {
    const taskStore = new TaskStore();
    await taskStore.create({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#7',
      threadId: 'thread_1',
      title: 'PR wait',
      ownerCatId: 'codex-sol',
      why: 'test',
      createdBy: 'codex-sol',
      userId: 'user_1',
    });
    const spec = createConflictCheckTaskSpec({
      taskStore,
      checkMergeable: async () => ({ mergeState: 'MERGEABLE', headSha: 'aaa' }),
      conflictRouter: routerStub({ routeResult: { kind: 'skipped', reason: 'state-only' } }).router,
      log: noLog,
    });
    const gate = await spec.admission.gate();
    assert.equal(gate.run, true);
    assert.equal(gate.workItems[0].signal.signal.mergeState, 'MERGEABLE');
  });

  test('neither repairs nor announces when the typed wait remains state-only', async () => {
    const resolves = [];
    const { calls, router } = routerStub({ routeResult: { kind: 'skipped', reason: 'predicates_not_matched' } });
    const spec = createConflictCheckTaskSpec({
      taskStore: new TaskStore(),
      checkMergeable: async () => ({ mergeState: 'CONFLICTING', headSha: 'aaa' }),
      conflictRouter: router,
      autoExecutor: { resolve: async () => resolves.push('resolve') },
      log: noLog,
    });
    await spec.run.execute(CONFLICT_WORK_ITEM, 'pr:owner/repo#7', {});

    assert.equal(calls.routes.length, 1, 'route is consulted exactly once');
    assert.equal(resolves.length, 0, 'an unmatched wait grants no repository mandate');
    assert.equal(calls.published.length, 0, 'and there is no outcome to announce');
  });

  test('a repaired conflict is closed without waking the owner (Phase C AC-C1)', async () => {
    const { calls, router } = routerStub();
    const spec = createConflictCheckTaskSpec({
      taskStore: new TaskStore(),
      checkMergeable: async () => ({ mergeState: 'CONFLICTING', headSha: 'aaa' }),
      conflictRouter: router,
      autoExecutor: { resolve: async () => ({ kind: 'resolved', method: 'clean-rebase', branch: 'feat/x' }) },
      log: noLog,
    });
    await spec.run.execute(CONFLICT_WORK_ITEM, 'pr:owner/repo#7', {});

    assert.equal(calls.published.length, 0, 'a conflict that no longer exists must not be announced');
    assert.equal(calls.settled.length, 1, 'but its wait must still be closed exactly once');
    assert.equal(calls.settled[0].outcomeId, conflictMatchedOutcome.outcomeId);
    assert.match(calls.settled[0].reason, /clean-rebase/);
  });

  test('an escalated conflict wakes the owner exactly once', async () => {
    const { calls, router } = routerStub();
    const spec = createConflictCheckTaskSpec({
      taskStore: new TaskStore(),
      checkMergeable: async () => ({ mergeState: 'CONFLICTING', headSha: 'aaa' }),
      conflictRouter: router,
      autoExecutor: { resolve: async () => ({ kind: 'escalated', files: ['a.ts'], branch: 'feat/x' }) },
      log: noLog,
    });
    await spec.run.execute(CONFLICT_WORK_ITEM, 'pr:owner/repo#7', {});

    assert.equal(calls.published.length, 1, 'an unrepaired conflict reaches its owner');
    assert.equal(calls.settled.length, 0, 'and it is never closed quietly');
  });

  test('a timeout that aborts during routing still announces the matched outcome', async () => {
    const controller = new AbortController();
    const resolves = [];
    const { calls, router } = routerStub({
      onRoute: async () => controller.abort(new DOMException('scheduler timeout', 'AbortError')),
    });
    const spec = createConflictCheckTaskSpec({
      taskStore: new TaskStore(),
      checkMergeable: async () => ({ mergeState: 'CONFLICTING', headSha: 'aaa' }),
      conflictRouter: router,
      autoExecutor: { resolve: async () => resolves.push('resolve') },
      log: noLog,
    });

    await assert.doesNotReject(() =>
      spec.run.execute(CONFLICT_WORK_ITEM, 'pr:owner/repo#7', { signal: controller.signal }),
    );

    // The outcome is already terminalized. An aborted run may skip the optional repair, but it may
    // not swallow a wait the owner registered — so the announcement still happens.
    assert.equal(resolves.length, 0, 'an aborted run must not start optional repository work');
    assert.equal(calls.published.length, 1, 'the matched wait still reaches its owner');
  });

  test('cancelled repair falls back to announcing, never to silence', async () => {
    const controller = new AbortController();
    const resolves = [];
    const { calls, router } = routerStub();
    const spec = createConflictCheckTaskSpec({
      taskStore: new TaskStore(),
      checkMergeable: async () => ({ mergeState: 'CONFLICTING', headSha: 'aaa' }),
      conflictRouter: router,
      autoExecutor: {
        resolve: async () => {
          resolves.push('resolve');
          controller.abort(new DOMException('scheduler timeout', 'AbortError'));
          throw controller.signal.reason;
        },
      },
      log: noLog,
    });

    await assert.doesNotReject(() =>
      spec.run.execute(CONFLICT_WORK_ITEM, 'pr:owner/repo#7', { signal: controller.signal }),
    );

    assert.equal(resolves.length, 1, 'remediation was attempted once and then cancelled');
    assert.equal(calls.published.length, 1, 'an unfinished repair is not a repair; the owner is told');
    assert.equal(calls.settled.length, 0);
  });
});
