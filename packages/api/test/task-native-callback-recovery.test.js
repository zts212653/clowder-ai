import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskNativeCallbackFixture } from './helpers/task-native-callback-fixture.js';

async function actor(f, catId = 'codex', threadId = f.home.id, userId = 'native-user') {
  const auth = await f.registry.create(userId, catId, threadId);
  await f.turns.createRunning({
    invocationId: auth.invocationId,
    parentInvocationId: auth.invocationId,
    threadId,
    userId,
    catId,
    executionKind: 'ordinary',
    providerLifecycleTracked: true,
    startedAt: Date.now(),
  });
  return { ...auth, headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken } };
}

const update = (f, auth, taskId, status = 'doing') =>
  f.app.inject({
    method: 'POST',
    url: '/api/callbacks/update-task',
    headers: auth.headers,
    payload: { taskId, status },
  });

test('unassigned home Task is atomically picked up by one authenticated actor and binds its execution', async (t) => {
  const f = await taskNativeCallbackFixture(t);
  const creator = await actor(f);
  const created = await f.app.inject({
    method: 'POST',
    url: '/api/callbacks/create-task',
    headers: creator.headers,
    payload: { title: 'Work for whoever picks it up' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const taskId = created.json().task.id;
  const wrongThread = await actor(f, 'sonnet', f.child.id);
  assert.equal((await update(f, wrongThread, taskId)).statusCode, 409);
  const foreign = await actor(f, 'sonnet', f.home.id, 'foreign-user');
  assert.equal((await update(f, foreign, taskId)).statusCode, 403);
  assert.equal(f.tasks.get(taskId).ownerCatId, null);
  const next = await actor(f, 'sonnet');
  const claimed = await update(f, next, taskId);
  assert.equal(claimed.statusCode, 200, claimed.body);
  const task = claimed.json().task;
  assert.equal(task.ownerCatId, 'sonnet');
  assert.equal(task.ownerRevision, 1);
  assert.equal(task.executionRef.invocationId, next.invocationId);
  assert.equal((await update(f, creator, taskId)).statusCode, 409);
  assert.equal((await update(f, next, taskId, 'done')).statusCode, 200);
});

test('legacy board Task backfills only the authenticated home tenant and still enforces the cat owner', async (t) => {
  const f = await taskNativeCallbackFixture(t);
  const legacy = f.tasks.create({
    threadId: f.home.id,
    title: 'Old board task',
    createdBy: 'user',
    ownerCatId: 'codex',
  });
  const stranger = await actor(f, 'sonnet');
  assert.equal((await update(f, stranger, legacy.id)).statusCode, 403);
  const foreign = await actor(f, 'codex', f.home.id, 'other-user');
  assert.equal((await update(f, foreign, legacy.id)).statusCode, 403);
  assert.equal(f.tasks.get(legacy.id).userId, undefined);
  const owner = await actor(f);
  const result = await update(f, owner, legacy.id);
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().task.userId, 'native-user');
  assert.equal(result.json().task.executionRef.invocationId, owner.invocationId);
});

test('owner callback recovers a crashed creator only after exact positive stop proof and binds the successor', async (t) => {
  const f = await taskNativeCallbackFixture(t);
  const old = await actor(f);
  const created = await f.app.inject({
    method: 'POST',
    url: '/api/callbacks/create-task',
    headers: old.headers,
    payload: { title: 'Survive creator restart', ownerCatId: 'codex' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const taskId = created.json().task.id;
  await f.turns.markProviderStarted(old.invocationId, Date.now());
  assert.equal((await f.turns.get(old.invocationId)).status, 'running', 'a crash cannot prove native teardown');
  const next = await actor(f);
  const unknown = await update(f, next, taskId);
  assert.equal(unknown.statusCode, 409, unknown.body);
  assert.equal(unknown.json().reason, 'task_execution_stop_unproven');
  assert.equal(f.tasks.get(taskId).executionRef.invocationId, old.invocationId);
  f.handoffs.deps.providerIsStopped = async (ref, userId) =>
    ref.invocationId === old.invocationId && userId === 'native-user';
  const recovered = await update(f, next, taskId);
  assert.equal(recovered.statusCode, 200, recovered.body);
  assert.equal(recovered.json().task.executionRef.invocationId, next.invocationId);
  assert.equal((await f.turns.get(old.invocationId)).status, 'interrupted');
  assert.ok((await f.turns.get(old.invocationId)).providerTeardownAt);
  assert.equal(f.tasks.get(taskId).id, taskId);
  assert.ok(
    [401, 409].includes((await update(f, old, taskId, 'done')).statusCode),
    'retired callback cannot finish the successor',
  );
  assert.equal((await update(f, next, taskId, 'done')).statusCode, 200);
});

test('owner later invocation lazily releases an exact ended provider when finally never released the Task', async (t) => {
  const f = await taskNativeCallbackFixture(t);
  const old = await actor(f);
  const created = await f.app.inject({
    method: 'POST',
    url: '/api/callbacks/create-task',
    headers: old.headers,
    payload: { title: 'Ended without Task finally', ownerCatId: 'codex' },
  });
  const taskId = created.json().task.id;
  await f.turns.transitionTerminal(old.invocationId, {
    status: 'succeeded',
    endedAt: Date.now(),
    providerTeardownAt: Date.now(),
  });
  const next = await actor(f);
  const result = await update(f, next, taskId, 'done');
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().task.executionRef, null);
  assert.equal(result.json().task.status, 'done');
});

test('an old callback cannot clear a newer assignment execution even when that newer provider has ended', async (t) => {
  const f = await taskNativeCallbackFixture(t);
  const old = await actor(f);
  let entered,
    resume,
    blocked = true;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  const released = new Promise((resolve) => {
    resume = resolve;
  });
  t.after(() => resume());
  const get = f.tasks.get.bind(f.tasks);
  f.tasks.get = async (id) => {
    if (id === f.task.id && blocked) {
      blocked = false;
      entered();
      await released;
    }
    return get(id);
  };
  const pending = update(f, old, f.task.id, 'done').then((r) => r);
  await waiting; // Old callback passed authentication, but has not yet read the current Task.
  const sent = await f.app.inject({
    method: 'POST',
    url: '/api/callbacks/post-message',
    headers: old.headers,
    payload: {
      content: 'Next exact assignment',
      targetCats: ['codex'],
      clientMessageId: 'new-assignment',
      action: f.action,
    },
  });
  assert.equal(sent.statusCode, 200, sent.body);
  const sourceId = sent.json().messageId;
  const next = await f.registry.create('native-user', 'codex', f.home.id, 'next-parent', sourceId);
  await f.turns.createRunning({
    invocationId: next.invocationId,
    parentInvocationId: 'next-parent',
    threadId: f.home.id,
    userId: 'native-user',
    catId: 'codex',
    executionKind: 'ordinary',
    startedAt: Date.now(),
    providerLifecycleTracked: true,
  });
  await f.handoffs.start(
    sourceId,
    { userId: 'native-user', catId: 'codex', threadId: f.home.id, invocationId: next.invocationId },
    'next-parent',
  );
  await f.turns.transitionTerminal(next.invocationId, {
    status: 'succeeded',
    endedAt: Date.now(),
    providerTeardownAt: Date.now(),
  });
  resume();
  const result = await pending;
  assert.equal(result.statusCode, 409, result.body);
  assert.equal(
    (await f.tasks.get(f.task.id)).executionRef?.invocationId,
    next.invocationId,
    'a stale callback must leave the newer binding untouched',
  );
  assert.equal((await f.tasks.get(f.task.id)).status, 'todo');
});
