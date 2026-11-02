import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { tasksRoutes } from '../dist/routes/tasks.js';

async function fixture(t, stores) {
  const tasks = stores?.tasks ?? new TaskStore(),
    messages = stores?.messages ?? new MessageStore();
  const task =
    stores?.task ??
    tasks.create({
      threadId: 'home',
      userId: 'user-a',
      title: 'Original Task',
      why: 'Preserve WIP',
      ownerCatId: 'codex',
      createdBy: 'codex',
      ...(stores?.initialExecutionRef ? { initialExecutionRef: stores.initialExecutionRef } : {}),
    });
  const app = Fastify();
  t.after(() => app.close());
  await app.register(tasksRoutes, {
    taskStore: tasks,
    messageStore: messages,
    socketManager: { broadcastToRoom() {} },
  });
  const patch = (payload, userId = 'user-a') =>
    app.inject({ method: 'PATCH', url: `/api/tasks/${task.id}`, headers: { 'x-cat-cafe-user': userId }, payload });
  return { tasks, messages, task, app, patch };
}

test('human assignment response loss and restart replay one source and one owner revision', async (t) => {
  const f = await fixture(t);
  const body = { ownerCatId: 'sonnet', expectedOwnerRevision: 0, why: 'Continue original WIP' };
  const first = await f.patch(body);
  assert.equal(first.statusCode, 200, first.body);
  const restarted = await fixture(t, f);
  const retry = await restarted.patch(body);
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json().ownerRevision, 1);
  assert.equal(retry.json().lastAppliedHandoffMessageRef, first.json().lastAppliedHandoffMessageRef);
  assert.equal(f.messages.getByThread('home').length, 1);
  assert.equal((await f.patch({ ...body, why: 'Different request' })).statusCode, 409);
});

test('human assignment after source append crash resumes the same request without a second message', async (t) => {
  const f = await fixture(t),
    mutate = f.tasks.mutateOrdinaryTask.bind(f.tasks);
  let crash = true;
  f.tasks.mutateOrdinaryTask = (...args) => {
    if (crash) {
      crash = false;
      throw new Error('fixture process crash before Task write');
    }
    return mutate(...args);
  };
  const body = { ownerCatId: 'sonnet', expectedOwnerRevision: 0 };
  assert.equal((await f.patch(body)).statusCode, 500);
  assert.equal(f.tasks.get(f.task.id).ownerCatId, 'codex');
  const restarted = await fixture(t, f);
  assert.equal((await restarted.patch(body)).statusCode, 200);
  assert.equal(f.messages.getByThread('home').length, 1);
});

test('human assignment cannot borrow a foreign tenant or detach/delete an occupied writer', async (t) => {
  const execution = {
    invocationId: 'exact-child',
    parentInvocationId: 'exact-parent',
    catId: 'codex',
    threadId: 'home',
    sourceMessageId: null,
  };
  const f = await fixture(t, { initialExecutionRef: execution });
  assert.equal((await f.patch({ ownerCatId: 'sonnet', expectedOwnerRevision: 0 }, 'foreign')).statusCode, 403);
  assert.equal((await f.patch({ ownerCatId: 'sonnet', expectedOwnerRevision: 0 })).statusCode, 409);
  const deleted = await f.app.inject({
    method: 'DELETE',
    url: `/api/tasks/${f.task.id}`,
    headers: { 'x-cat-cafe-user': 'user-a' },
  });
  assert.equal(deleted.statusCode, 409, deleted.body);
  assert.deepEqual(f.tasks.get(f.task.id).executionRef, execution);
});

test('anonymous HTTP cannot create an unowned tenant or delete a legacy tenantless Task', async (t) => {
  const f = await fixture(t);
  const created = await f.app.inject({
    method: 'POST',
    url: '/api/tasks',
    payload: { threadId: 'home', title: 'Anonymous work', createdBy: 'user' },
  });
  assert.equal(created.statusCode, 401, created.body);
  const legacy = f.tasks.create({ threadId: 'home', title: 'Unknown legacy tenant', createdBy: 'user' });
  const removed = await f.app.inject({ method: 'DELETE', url: `/api/tasks/${legacy.id}` });
  assert.equal(removed.statusCode, 403, removed.body);
  assert.ok(f.tasks.get(legacy.id));
});

test('authenticated home owner can resume and delete a legacy tenantless board Task', async (t) => {
  const tasks = new TaskStore(),
    threads = new ThreadStore();
  const home = threads.create('board-user', 'Original board');
  const legacy = tasks.create({
    threadId: home.id,
    title: 'Pre-migration board Task',
    ownerCatId: 'codex',
    createdBy: 'user',
  });
  const app = Fastify();
  t.after(() => app.close());
  await app.register(tasksRoutes, { taskStore: tasks, threadStore: threads, socketManager: { broadcastToRoom() {} } });
  const patch = (status, user = 'board-user') =>
    app.inject({
      method: 'PATCH',
      url: `/api/tasks/${legacy.id}`,
      headers: { 'x-cat-cafe-user': user },
      payload: { status },
    });
  assert.equal((await patch('doing', 'foreign')).statusCode, 403);
  assert.equal(tasks.get(legacy.id).userId, undefined);
  const resumed = await patch('doing');
  assert.equal(resumed.statusCode, 200, resumed.body);
  assert.equal(resumed.json().userId, 'board-user');
  assert.equal((await patch('done')).statusCode, 200);
  assert.equal(tasks.get(legacy.id).id, legacy.id);
  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/tasks/${legacy.id}`,
    headers: { 'x-cat-cafe-user': 'board-user' },
  });
  assert.equal(removed.statusCode, 204, removed.body);
  const old = tasks.create({ threadId: home.id, title: 'Delete before any PATCH', createdBy: 'user' });
  const direct = await app.inject({
    method: 'DELETE',
    url: `/api/tasks/${old.id}`,
    headers: { 'x-cat-cafe-user': 'board-user' },
  });
  assert.equal(direct.statusCode, 204, direct.body);
});
