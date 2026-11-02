import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOwnedWaitStatusReader } from '../dist/domains/ball-custody/OwnedWaitStatus.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { createTypedWaitCustodyFixture } from './helpers/typed-wait-custody-fixture.js';

const scope = { userId: 'user-1', catId: 'opus', threadId: 'thread-wait' };
const emptyScheduler = { findByDeliveryThreadAndCreatedBy: () => [] };
function hold() {
  return {
    id: 'hold-ball-1',
    templateId: 'reminder',
    enabled: true,
    createdBy: 'hold-ball:opus',
    deliveryThreadId: scope.threadId,
    params: {
      triggerUserId: scope.userId,
      targetCatId: scope.catId,
      holdLifecycle: { mode: 'timer', status: 'active', createdBy: 'hold-ball:opus' },
    },
  };
}

test('empty known stores and legacy PR records do not manufacture an active wait', async () => {
  const taskStore = new TaskStore();
  taskStore.create({
    ...scope,
    kind: 'pr_tracking',
    title: 'Old tracker',
    ownerCatId: scope.catId,
    createdBy: scope.catId,
  });
  assert.equal(await createOwnedWaitStatusReader({ taskStore, dynamicTaskStore: emptyScheduler })(scope), false);
  assert.equal(await createOwnedWaitStatusReader({ taskStore })(scope), undefined);
});

for (const [name, change, expected] of [
  ['active timer', () => {}, true],
  [
    'active managed command',
    (task) => {
      task.params.holdLifecycle.mode = 'wake_when';
    },
    true,
  ],
  [
    'disabled',
    (task) => {
      task.enabled = false;
    },
    false,
  ],
  [
    'retired',
    (task) => {
      task.params.holdLifecycle.status = 'retired_by_event';
    },
    false,
  ],
  [
    'cancelled',
    (task) => {
      task.params.holdLifecycle.status = 'cancelled_by_user';
    },
    false,
  ],
  [
    'another user',
    (task) => {
      task.params.triggerUserId = 'another';
    },
    false,
  ],
  [
    'another thread',
    (task) => {
      task.deliveryThreadId = 'another';
    },
    false,
  ],
  [
    'another cat',
    (task) => {
      task.createdBy = 'hold-ball:codex';
    },
    false,
  ],
  [
    'wrong target',
    (task) => {
      task.params.targetCatId = 'codex';
    },
    false,
  ],
  [
    'ordinary scheduled task',
    (task) => {
      task.id = 'dyn-1';
    },
    false,
  ],
]) {
  test(`scheduler projection: ${name}`, async () => {
    const task = hold();
    change(task);
    const read = createOwnedWaitStatusReader({
      taskStore: new TaskStore(),
      dynamicTaskStore: { findByDeliveryThreadAndCreatedBy: () => [task] },
    });
    assert.equal(await read(scope), expected);
  });
}

test('a live private Task registration counts, while terminal, stale and expired registrations do not', async () => {
  const h = await createTypedWaitCustodyFixture();
  const snapshot = h.taskStore.getWaitRegistration(h.task.id);
  assert.ok(snapshot.receipt);
  const read = (value) =>
    createOwnedWaitStatusReader({
      taskStore: { listByThread: () => [value.task], getWaitRegistration: () => value },
      dynamicTaskStore: emptyScheduler,
    })(scope);
  assert.equal(await read(snapshot), true);
  for (const mutate of [
    (s) => {
      s.task.status = 'done';
    },
    (s) => {
      s.task.deploymentWait.await.generation++;
    },
    (s) => {
      s.task.deploymentWait.await.expiresAt = s.receipt.expiresAt = 1;
    },
    (s) => {
      s.task.ownerCatId = 'codex';
    },
    (s) => {
      s.receipt = null;
    },
  ]) {
    const invalid = structuredClone(snapshot);
    mutate(invalid);
    assert.equal(await read(invalid), false);
  }
});

test('read failures remain unknown, but an independent positive scheduler fact can still be shown', async () => {
  const taskStore = {
    listByThread() {
      throw new Error('unavailable');
    },
  };
  assert.equal(await createOwnedWaitStatusReader({ taskStore, dynamicTaskStore: emptyScheduler })(scope), undefined);
  assert.equal(
    await createOwnedWaitStatusReader({
      taskStore,
      dynamicTaskStore: { findByDeliveryThreadAndCreatedBy: () => [hold()] },
    })(scope),
    true,
  );
  assert.equal(
    await createOwnedWaitStatusReader({
      taskStore: new TaskStore(),
      dynamicTaskStore: {
        findByDeliveryThreadAndCreatedBy() {
          throw new Error('unavailable');
        },
      },
    })(scope),
    undefined,
  );
});
