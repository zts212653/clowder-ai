/**
 * F167 Phase J AC-J1/J4~J6 — hold ball cancel + auto-cancel on user message.
 *
 * Tests pure functions: cancelHoldTaskById (DELETE endpoint logic) and
 * cancelPendingHoldsForThread (auto-cancel when user messages).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  cancelHoldTaskById,
  cancelPendingHoldsForThread,
  retirePendingHoldsForSatisfiedWait,
} from '../dist/routes/hold-ball-cancel.js';

function makeTask(overrides = {}) {
  return {
    id: `hold-ball-${Date.now()}-abc123`,
    templateId: 'reminder',
    trigger: { type: 'once', fireAt: Date.now() + 60_000 },
    params: { message: '持球唤醒', targetCatId: 'codex', triggerUserId: 'user1' },
    display: { label: '持球唤醒 (codex)', category: 'system', description: '...' },
    deliveryThreadId: 'thread-1',
    enabled: true,
    createdBy: 'hold-ball:codex',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeStubDeps(tasks = []) {
  const unregistered = [];
  const removed = [];
  return {
    dynamicTaskStore: {
      getById(id) {
        return tasks.find((t) => t.id === id) ?? null;
      },
      getAll() {
        return tasks.filter((t) => !removed.includes(t.id));
      },
      remove(id) {
        removed.push(id);
        return true;
      },
      setEnabled(id, enabled) {
        const task = tasks.find((t) => t.id === id);
        if (!task) return false;
        task.enabled = enabled;
        return true;
      },
      updateParams(id, params) {
        const task = tasks.find((t) => t.id === id);
        if (!task) return false;
        task.params = params;
        return true;
      },
    },
    taskRunner: {
      unregister(id) {
        unregistered.push(id);
      },
    },
    _unregistered: unregistered,
    _removed: removed,
  };
}

describe('F167 Phase J AC-J1: cancelHoldTaskById', () => {
  test('cancels valid hold-ball task and returns it', () => {
    const task = makeTask({ id: 'hold-ball-123-abc' });
    const deps = makeStubDeps([task]);

    const result = cancelHoldTaskById('hold-ball-123-abc', deps);
    assert.ok(result, 'should return cancelled task');
    assert.equal(result.id, 'hold-ball-123-abc');
    assert.deepEqual(deps._unregistered, ['hold-ball-123-abc']);
    assert.deepEqual(deps._removed, ['hold-ball-123-abc']);
  });

  test('returns null when taskId not found', () => {
    const deps = makeStubDeps([]);
    const result = cancelHoldTaskById('hold-ball-999-xxx', deps);
    assert.equal(result, null);
    assert.equal(deps._unregistered.length, 0);
    assert.equal(deps._removed.length, 0);
  });

  test('returns null when task exists but is not a hold-ball task (dyn-* prefix)', () => {
    const nonHoldTask = makeTask({ id: 'dyn-panel-12345', createdBy: 'panel-user' });
    const deps = makeStubDeps([nonHoldTask]);
    const result = cancelHoldTaskById('dyn-panel-12345', deps);
    assert.equal(result, null);
    assert.equal(deps._unregistered.length, 0, 'must not unregister non-hold task');
    assert.equal(deps._removed.length, 0, 'must not remove non-hold task');
  });

  test('returns null when task has hold-ball prefix but wrong templateId', () => {
    const wrongTemplate = makeTask({ id: 'hold-ball-123-wrong', templateId: 'cron-job' });
    const deps = makeStubDeps([wrongTemplate]);
    const result = cancelHoldTaskById('hold-ball-123-wrong', deps);
    assert.equal(result, null);
  });

  test('P2-1 review fix: returns null when id+templateId match but createdBy is not hold-ball:*', () => {
    const wrongCreator = makeTask({ id: 'hold-ball-123-fake', createdBy: 'manual-admin' });
    const deps = makeStubDeps([wrongCreator]);
    const result = cancelHoldTaskById('hold-ball-123-fake', deps);
    assert.equal(result, null, 'defense-in-depth: must check createdBy prefix');
    assert.equal(deps._unregistered.length, 0);
    assert.equal(deps._removed.length, 0);
  });

  test('F167-Q cloud P2: does not cancel retired-by-event tombstones by task id', () => {
    const retired = makeTask({
      id: 'hold-ball-retired-by-event',
      enabled: false,
      params: {
        message: 'retired wake',
        targetCatId: 'codex',
        triggerUserId: 'user1',
        holdLifecycle: {
          mode: 'timer',
          status: 'retired_by_event',
          subjectKey: 'pr:owner/repo#42',
          expectedSignalKey: 'review_posted',
          wakeAt: Date.now() + 60_000,
          createdBy: 'hold-ball:codex',
        },
      },
    });
    const deps = makeStubDeps([retired]);

    const result = cancelHoldTaskById('hold-ball-retired-by-event', deps);

    assert.equal(result, null, 'terminal lifecycle tombstone is readable but no longer cancelable');
    assert.deepEqual(deps._unregistered, []);
    assert.deepEqual(deps._removed, []);
    assert.equal(deps.dynamicTaskStore.getById('hold-ball-retired-by-event'), retired);
  });
});

describe('F167 Phase J AC-J4~J6: cancelPendingHoldsForThread', () => {
  test('cancels all pending hold tasks in the thread', () => {
    const t1 = makeTask({ id: 'hold-ball-1-aaa', deliveryThreadId: 'thread-X', createdBy: 'hold-ball:codex' });
    const t2 = makeTask({ id: 'hold-ball-2-bbb', deliveryThreadId: 'thread-X', createdBy: 'hold-ball:opus' });
    const deps = makeStubDeps([t1, t2]);

    const cancelled = cancelPendingHoldsForThread('thread-X', deps);
    assert.equal(cancelled.length, 2);
    assert.deepEqual(deps._unregistered.sort(), ['hold-ball-1-aaa', 'hold-ball-2-bbb']);
    assert.deepEqual(deps._removed.sort(), ['hold-ball-1-aaa', 'hold-ball-2-bbb']);
  });

  test('returns empty array when no pending holds (no-op)', () => {
    const deps = makeStubDeps([]);
    const cancelled = cancelPendingHoldsForThread('thread-empty', deps);
    assert.equal(cancelled.length, 0);
    assert.equal(deps._unregistered.length, 0);
    assert.equal(deps._removed.length, 0);
  });

  test('does not let unrelated user text retire a dispatch-pending typed wake', () => {
    const completed = makeTask({
      id: 'hold-ball-completion-pending',
      deliveryThreadId: 'thread-completion-pending',
      params: {
        message: 'fallback',
        targetCatId: 'codex',
        triggerUserId: 'user1',
        holdLifecycle: {
          mode: 'wake_when',
          status: 'active',
          wakeAt: Date.now() + 60_000,
          createdBy: 'hold-ball:codex',
          managedCommand: {
            state: 'dispatch_pending',
            command: 'pnpm gate',
            startedAt: Date.now() - 10_000,
            conditionMetAt: Date.now() - 1_000,
            wakeContent: 'gate finished',
            result: { exitCode: 0, timedOut: false, durationMs: 9_000 },
            messageId: 'completion-message-1',
          },
        },
      },
    });
    const deps = makeStubDeps([completed]);

    const cancelled = cancelPendingHoldsForThread('thread-completion-pending', deps);

    assert.deepEqual(cancelled, [], 'ordinary prose is not an invocation-bound disposition');
    assert.deepEqual(deps._unregistered, []);
    assert.deepEqual(deps._removed, []);
    assert.equal(completed.enabled, true);
    assert.equal(completed.params.holdLifecycle.status, 'active');
    assert.equal(completed.params.holdLifecycle.managedCommand.messageId, 'completion-message-1');
  });

  test('does not let unrelated user text cancel a running managed command', () => {
    const running = makeTask({
      id: 'hold-ball-running-command',
      deliveryThreadId: 'thread-running-command',
      params: {
        message: 'fallback',
        targetCatId: 'codex',
        triggerUserId: 'user1',
        holdLifecycle: {
          mode: 'wake_when',
          status: 'active',
          wakeAt: Date.now() + 60_000,
          createdBy: 'hold-ball:codex',
          managedCommand: {
            state: 'command_running',
            command: 'pnpm gate',
            startedAt: Date.now() - 10_000,
          },
        },
      },
    });
    const deps = makeStubDeps([running]);

    const cancelled = cancelPendingHoldsForThread('thread-running-command', deps);

    assert.deepEqual(cancelled, [], 'ordinary prose is not an explicit command cancellation');
    assert.deepEqual(deps._removed, []);
    assert.deepEqual(deps._unregistered, []);
    assert.equal(running.enabled, true);
    assert.equal(running.params.holdLifecycle.status, 'active');
    assert.equal(running.params.holdLifecycle.managedCommand.state, 'command_running');
  });

  for (const dispatchedState of ['condition_met', 'message_written', 'enqueued', 'dispatched']) {
    test(`does not retire an accepted ${dispatchedState} wake before its invocation-bound disposition`, () => {
      const accepted = makeTask({
        id: `hold-ball-accepted-${dispatchedState}`,
        deliveryThreadId: 'thread-accepted-wake',
        params: {
          message: 'wake carrier',
          targetCatId: 'codex-sol',
          triggerUserId: 'user1',
          holdLifecycle: {
            mode: 'wake_when',
            status: 'active',
            wakeAt: Date.now() + 60_000,
            createdBy: 'hold-ball:codex-sol',
            managedCommand: {
              state: dispatchedState,
              command: 'pnpm gate',
              startedAt: Date.now() - 10_000,
              conditionMetAt: Date.now() - 1_000,
              wakeContent: 'gate finished',
              result: { exitCode: 0, timedOut: false, durationMs: 9_000 },
              messageId: 'completion-message-accepted',
            },
          },
        },
      });
      const deps = makeStubDeps([accepted]);

      const cancelled = cancelPendingHoldsForThread('thread-accepted-wake', deps);

      assert.deepEqual(cancelled, [], 'an accepted wake has a live child invocation and is no longer cancelable');
      assert.deepEqual(deps._unregistered, []);
      assert.deepEqual(deps._removed, []);
      assert.equal(accepted.enabled, true);
      assert.equal(accepted.params.holdLifecycle.status, 'active');
      assert.equal(accepted.params.holdLifecycle.managedCommand.state, dispatchedState);
    });
  }

  test('does not cancel tasks from other threads', () => {
    const sameThread = makeTask({ id: 'hold-ball-1-here', deliveryThreadId: 'thread-A' });
    const otherThread = makeTask({ id: 'hold-ball-2-there', deliveryThreadId: 'thread-B' });
    const deps = makeStubDeps([sameThread, otherThread]);

    const cancelled = cancelPendingHoldsForThread('thread-A', deps);
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0].id, 'hold-ball-1-here');
    assert.ok(!deps._unregistered.includes('hold-ball-2-there'), 'must not touch other thread');
    assert.ok(!deps._removed.includes('hold-ball-2-there'), 'must not remove other thread');
  });

  test('does not cancel non-hold-ball tasks (dyn-* prefix)', () => {
    const holdTask = makeTask({ id: 'hold-ball-1-real', deliveryThreadId: 'thread-C' });
    const panelTask = makeTask({ id: 'dyn-panel-fake', deliveryThreadId: 'thread-C', templateId: 'reminder' });
    const deps = makeStubDeps([holdTask, panelTask]);

    const cancelled = cancelPendingHoldsForThread('thread-C', deps);
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0].id, 'hold-ball-1-real');
    assert.ok(!deps._unregistered.includes('dyn-panel-fake'));
  });

  test('P2-1 review fix: does not cancel tasks with wrong createdBy even if id+templateId match', () => {
    const real = makeTask({ id: 'hold-ball-1-real', deliveryThreadId: 'thread-D', createdBy: 'hold-ball:opus' });
    const fake = makeTask({ id: 'hold-ball-2-fake', deliveryThreadId: 'thread-D', createdBy: 'manual-admin' });
    const deps = makeStubDeps([real, fake]);

    const cancelled = cancelPendingHoldsForThread('thread-D', deps);
    assert.equal(cancelled.length, 1, 'only real hold-ball task should be cancelled');
    assert.equal(cancelled[0].id, 'hold-ball-1-real');
    assert.ok(!deps._unregistered.includes('hold-ball-2-fake'));
  });

  test('F167-Q cloud P2: user-message auto-cancel skips retired-by-event tombstones', () => {
    const active = makeTask({ id: 'hold-ball-active', deliveryThreadId: 'thread-retire-skip' });
    const retired = makeTask({
      id: 'hold-ball-retired-tombstone',
      deliveryThreadId: 'thread-retire-skip',
      enabled: false,
      params: {
        message: 'retired wake',
        targetCatId: 'codex',
        triggerUserId: 'user1',
        holdLifecycle: {
          mode: 'timer',
          status: 'retired_by_event',
          subjectKey: 'pr:owner/repo#42',
          expectedSignalKey: 'review_posted',
          wakeAt: Date.now() + 60_000,
          createdBy: 'hold-ball:codex',
        },
      },
    });
    const deps = makeStubDeps([active, retired]);

    const cancelled = cancelPendingHoldsForThread('thread-retire-skip', deps);

    assert.deepEqual(
      cancelled.map((task) => task.id),
      ['hold-ball-active'],
    );
    assert.deepEqual(deps._unregistered, ['hold-ball-active']);
    assert.deepEqual(deps._removed, ['hold-ball-active']);
    assert.equal(deps.dynamicTaskStore.getById('hold-ball-retired-tombstone'), retired);
  });

  test('AC-J6: system message does not trigger cancel (function only cancels, caller decides when)', () => {
    // cancelPendingHoldsForThread is a pure operation — the caller (messages.ts)
    // decides WHEN to call it (only on user messages, not system messages).
    // This test verifies the function itself is side-effect-clean: calling it
    // with no matching tasks is a no-op.
    const unrelatedTask = makeTask({ id: 'hold-ball-sys', deliveryThreadId: 'thread-sys' });
    const deps = makeStubDeps([unrelatedTask]);
    const cancelled = cancelPendingHoldsForThread('thread-other', deps);
    assert.equal(cancelled.length, 0);
    assert.equal(deps._unregistered.length, 0);
  });
});

describe('F167 Phase Q: retirePendingHoldsForSatisfiedWait', () => {
  test('retires only the pending hold whose subject and signal key match the satisfied event', () => {
    const reviewHold = makeTask({
      id: 'hold-ball-review',
      deliveryThreadId: 'thread-Q',
      params: {
        message: 'review wake',
        targetCatId: 'codex',
        triggerUserId: 'user1',
        holdLifecycle: {
          mode: 'timer',
          status: 'active',
          subjectKey: 'pr:owner/repo#42',
          expectedSignalKey: 'review_posted',
          wakeAt: Date.now() + 60_000,
          createdBy: 'hold-ball:codex',
        },
      },
    });
    const ciHold = makeTask({
      id: 'hold-ball-ci',
      deliveryThreadId: 'thread-Q',
      params: {
        message: 'ci wake',
        targetCatId: 'codex',
        triggerUserId: 'user1',
        holdLifecycle: {
          mode: 'timer',
          status: 'active',
          subjectKey: 'pr:owner/repo#42',
          expectedSignalKey: 'ci_complete',
          wakeAt: Date.now() + 60_000,
          createdBy: 'hold-ball:codex',
        },
      },
    });
    const freeTextHold = makeTask({
      id: 'hold-ball-free-text',
      deliveryThreadId: 'thread-Q',
      params: {
        message: 'legacy wake',
        targetCatId: 'codex',
        triggerUserId: 'user1',
      },
    });
    const deps = makeStubDeps([reviewHold, ciHold, freeTextHold]);

    const retired = retirePendingHoldsForSatisfiedWait(
      {
        threadId: 'thread-Q',
        subjectKey: 'pr:owner/repo#42',
        expectedSignalKey: 'review_posted',
        sourceKind: 'review_feedback',
        sourceMessageId: 'msg-review-1',
      },
      deps,
    );

    assert.equal(retired.length, 1);
    assert.equal(retired[0].id, 'hold-ball-review');
    assert.deepEqual(deps._unregistered, ['hold-ball-review']);
    assert.deepEqual(deps._removed, []);
    assert.equal(deps.dynamicTaskStore.getById('hold-ball-review').enabled, false);
    assert.equal(deps.dynamicTaskStore.getById('hold-ball-review').params.holdLifecycle.status, 'retired_by_event');
    assert.equal(
      deps.dynamicTaskStore.getById('hold-ball-review').params.holdLifecycle.resolvedBy.sourceMessageId,
      'msg-review-1',
    );
    assert.equal(deps.dynamicTaskStore.getById('hold-ball-ci').enabled, true);
    assert.equal(deps.dynamicTaskStore.getById('hold-ball-free-text').enabled, true);
  });

  test('does not retire when event signal key is missing or unstructured', () => {
    const hold = makeTask({
      id: 'hold-ball-review-safe',
      deliveryThreadId: 'thread-Q-safe',
      params: {
        message: 'review wake',
        targetCatId: 'codex',
        triggerUserId: 'user1',
        holdLifecycle: {
          mode: 'timer',
          status: 'active',
          subjectKey: 'pr:owner/repo#42',
          expectedSignalKey: 'review_posted',
          wakeAt: Date.now() + 60_000,
          createdBy: 'hold-ball:codex',
        },
      },
    });
    const deps = makeStubDeps([hold]);

    const retired = retirePendingHoldsForSatisfiedWait(
      {
        threadId: 'thread-Q-safe',
        subjectKey: 'pr:owner/repo#42',
        expectedSignalKey: 'review complete',
        sourceKind: 'review_feedback',
      },
      deps,
    );

    assert.equal(retired.length, 0);
    assert.deepEqual(deps._unregistered, []);
    assert.equal(deps.dynamicTaskStore.getById('hold-ball-review-safe').enabled, true);
  });
});
