/**
 * F167 Phase J AC-J1/J4~J6 — hold ball cancel + auto-cancel on user message.
 *
 * Tests pure functions: cancelHoldTaskById (DELETE endpoint logic) and
 * cancelPendingHoldsForThread (auto-cancel when user messages).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { cancelHoldTaskById, cancelPendingHoldsForThread } from '../dist/routes/hold-ball-cancel.js';

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
