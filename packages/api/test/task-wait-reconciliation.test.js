import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createOwnedWaitStatusReader } from '../dist/domains/ball-custody/OwnedWaitStatus.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { EntrustedWorkLifecycleService } from '../dist/domains/growing/EntrustedWorkLifecycleService.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';

const scope = { userId: 'owner', threadId: 'thread-work', catId: 'codex' };
const taskInput = {
  userId: scope.userId,
  threadId: scope.threadId,
  createdBy: 'codex',
  ownerCatId: 'codex',
  title: '继续完成原任务',
  why: '原授权',
};

async function setup(t, readWait) {
  const tasks = new TaskStore();
  const registry = new InvocationRegistry();
  const credentials = await registry.create(scope.userId, scope.catId, scope.threadId);
  const app = Fastify();
  t.after(() => app.close());
  await app.register(callbacksRoutes, {
    registry,
    taskStore: tasks,
    messageStore: new MessageStore(),
    socketManager: { broadcastToRoom() {}, emitToUser() {} },
    ownedWaitStatusReader:
      readWait ??
      createOwnedWaitStatusReader({
        taskStore: tasks,
        dynamicTaskStore: { findByDeliveryThreadAndCreatedBy: () => [] },
      }),
  });
  const post = (path, payload) =>
    app.inject({
      method: 'POST',
      url: `/api/callbacks/${path}`,
      headers: { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken },
      payload,
    });
  return { tasks, post };
}

test('remaining-work receipts are bounded and retain their full count', async (t) => {
  const { tasks, post } = await setup(t);
  const work = Array.from({ length: 8 }, (_, index) => tasks.create({ ...taskInput, title: `工作 ${index}` }));
  const response = await post('update-task', { taskId: work[0].id, status: 'done' });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().unheldOwnedTaskCount, 7);
  assert.equal(response.json().unheldOwnedTasks.length, 5);
  assert.ok(response.json().unheldOwnedTasks.every((task) => task.id !== work[0].id));
});

test('task tool receipts reconcile remaining owned work inside the authenticated thread and user', async (t) => {
  const { tasks, post } = await setup(t);
  const remaining = tasks.create(taskInput);
  tasks.create({ ...taskInput, ownerCatId: 'opus', title: '别猫的工作' });
  tasks.create({ ...taskInput, userId: 'someone-else', title: '别人的工作' });
  tasks.create({ ...taskInput, threadId: 'another-thread', title: '别处的工作' });
  tasks.create({ ...taskInput, kind: 'pr_tracking', title: '历史跟踪记录' });
  const response = await post('create-task', { title: '阶段 A', ownerCatId: 'codex' });
  assert.equal(response.statusCode, 201, response.body);
  const created = response.json();
  assert.ok(Array.isArray(created.unheldOwnedTasks), 'tool receipt must expose the remaining owned work');
  assert.deepEqual(created.unheldOwnedTasks.map((task) => task.id).sort(), [remaining.id, created.task.id].sort());
  const updated = await post('update-task', { taskId: created.task.id, status: 'done' });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.deepEqual(updated.json().unheldOwnedTasks, [{ id: remaining.id, title: remaining.title, status: 'todo' }]);
});

test('typed progress and closure receipts expose the same remaining-work facts', async (t) => {
  const { tasks, post } = await setup(t);
  const remaining = tasks.create(taskInput);
  const lifecycle = new EntrustedWorkLifecycleService(tasks);
  const closure = { condition: '实现与验证已交付', expectedSignal: 'artifact:result' };
  const admission = await lifecycle.admitOrResume({
    task: { ...taskInput, title: '阶段 A' },
    admission: {
      basis: 'explicit_entrustment',
      sourceRefs: ['message:source'],
      intendedOutcome: '完成交付',
      idempotencyKey: 'source',
    },
    closure,
  });
  const taskId = admission.ownerRef.replace('task:item:', '');
  const progress = await post('update-entrusted-work', { taskId, expectedRevision: 1, status: 'doing' });
  assert.equal(progress.statusCode, 200, progress.body);
  assert.ok(Array.isArray(progress.json().unheldOwnedTasks), 'typed progress must reconcile owned work');
  assert.ok(progress.json().unheldOwnedTasks.some((task) => task.id === taskId));
  const closed = await post('close-entrusted-work', {
    taskId,
    expectedRevision: 2,
    closure: { ...closure, state: 'satisfied', evidenceRefs: ['message:result'] },
  });
  assert.equal(closed.statusCode, 200, closed.body);
  assert.deepEqual(closed.json().unheldOwnedTasks, [{ id: remaining.id, title: remaining.title, status: 'todo' }]);
});

for (const [name, readWait] of [
  ['active wait', async () => true],
  ['unknown wait state', async () => undefined],
  [
    'unavailable wait store',
    async () => {
      throw new Error('read unavailable');
    },
  ],
]) {
  test(`${name} does not claim that a task is unheld or undo a successful mutation`, async (t) => {
    const { tasks, post } = await setup(t, readWait);
    const task = tasks.create(taskInput);
    const response = await post('update-task', { taskId: task.id, status: 'doing' });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().unheldOwnedTasks, undefined);
    assert.equal(tasks.get(task.id).status, 'doing');
  });
}
