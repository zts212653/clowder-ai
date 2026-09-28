import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import '../helpers/setup-cat-registry.js';

const { TaskStore } = await import('../../dist/domains/cats/services/stores/ports/TaskStore.js');
const { withBallCustodyTaskEvents } = await import('../../dist/domains/ball-custody/BallCustodyTaskStore.js');
const { EntrustedWorkLifecycleService } = await import('../../dist/domains/growing/EntrustedWorkLifecycleService.js');
const { InvocationRegistry } = await import('../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
const { callbacksRoutes } = await import('../../dist/routes/callbacks.js');

const closure = {
  condition: 'The prepared presentation is approved',
  expectedSignal: 'artifact:final-presentation',
};

async function setup() {
  const custodyEvents = [];
  const store = withBallCustodyTaskEvents(new TaskStore(), {
    async record(event) {
      custodyEvents.push(event);
    },
  });
  const lifecycle = new EntrustedWorkLifecycleService(store);
  const admission = await lifecycle.admitOrResume({
    task: {
      threadId: 'thread-progress',
      title: 'Prepare presentation',
      why: 'Explicit source request',
      createdBy: 'codex-sol',
      ownerCatId: 'codex-sol',
      userId: 'owner-progress',
    },
    admission: {
      basis: 'explicit_entrustment',
      sourceRefs: ['message:source-progress'],
      intendedOutcome: 'A reviewable presentation',
      idempotencyKey: 'source-progress',
    },
    closure,
  });
  return { store, lifecycle, custodyEvents, taskId: admission.ownerRef.replace('task:item:', '') };
}

test('owner typed progress advances todo → doing → blocked → doing on the same Task and revision', async () => {
  const { store, lifecycle, taskId, custodyEvents } = await setup();
  const initial = structuredClone(store.get(taskId));
  assert.equal(initial.status, 'todo');
  for (const [index, status] of ['doing', 'blocked', 'doing', 'todo'].entries()) {
    const task = await lifecycle.update({ taskId, expectedRevision: index + 1, status });
    assert.equal(task.status, status);
    assert.equal(task.entrustedWork.revision, index + 2);
    assert.equal(task.id, initial.id);
    assert.equal(task.subjectKey, initial.subjectKey);
    assert.equal(task.ownerCatId, initial.ownerCatId);
    assert.equal(task.threadId, initial.threadId);
    assert.deepEqual(task.entrustedWork.admission, initial.entrustedWork.admission);
    assert.deepEqual(task.entrustedWork.closure, initial.entrustedWork.closure);
    assert.deepEqual(store.get(taskId), task);
    if (status === 'blocked') {
      assert.equal(
        custodyEvents.at(-1)?.sourceEventId,
        `task:${taskId}:blocked:entrusted:${task.entrustedWork.revision}`,
      );
      assert.equal(custodyEvents.at(-1)?.subjectKey, `ball:task:${taskId}`);
      assert.deepEqual(custodyEvents.at(-1)?.payload, {
        taskId,
        threadId: initial.threadId,
        ownerCatId: initial.ownerCatId,
      });
    }
  }
  assert.deepEqual(
    custodyEvents.map((event) => event.kind),
    ['task.blocked', 'task.unblocked'],
  );
});

test('the decorated in-memory typed store preserves synchronous results', async () => {
  const { store, taskId, custodyEvents } = await setup();
  const result = store.updateEntrustedWork(taskId, { expectedRevision: 1, status: 'blocked' });
  assert.equal(result.kind, 'updated');
  assert.equal(result.task.status, 'blocked');
  assert.deepEqual(
    custodyEvents.map((event) => event.kind),
    ['task.blocked'],
  );
});

test('same progress is a no-op unless an Artifact/time fact changes in the same atomic update', async () => {
  const { store, lifecycle, taskId, custodyEvents } = await setup();
  const before = structuredClone(store.get(taskId));
  await assert.rejects(
    lifecycle.update({ taskId, expectedRevision: 1, status: 'todo' }),
    (error) => error.code === 'ENTRUSTED_WORK_NO_OP',
  );
  assert.deepEqual(store.get(taskId), before);
  const updated = await lifecycle.update({
    taskId,
    expectedRevision: 1,
    status: 'doing',
    artifactRefs: ['artifact:presentation:v1'],
    time: { reviewBy: { value: 1_789_000_000_000, sourceRef: 'message:source-progress' } },
  });
  assert.equal(updated.status, 'doing');
  assert.equal(updated.entrustedWork.revision, 2);
  assert.deepEqual(updated.entrustedWork.artifactRefs, ['artifact:presentation:v1']);
  const changed = await lifecycle.update({ taskId, expectedRevision: 2, status: 'doing', artifactRefs: [] });
  assert.equal(changed.entrustedWork.revision, 3);
  assert.deepEqual(changed.entrustedWork.artifactRefs, []);
  await lifecycle.update({ taskId, expectedRevision: 3, time: { reviewBy: null } });
  assert.deepEqual(custodyEvents, [], 'no-op, time and artifact changes must not emit status events');
});

test('stale, terminal and generic progress updates have no effects', async () => {
  const { store, lifecycle, taskId, custodyEvents } = await setup();
  await lifecycle.update({ taskId, expectedRevision: 1, status: 'doing' });
  await assert.rejects(
    lifecycle.update({ taskId, expectedRevision: 1, status: 'blocked' }),
    (error) => error.code === 'ENTRUSTED_WORK_REVISION_CONFLICT',
  );
  assert.throws(() => store.update(taskId, { status: 'blocked' }), /typed lifecycle/);
  assert.deepEqual(custodyEvents, [], 'rejected progress must not emit a blocked event');
  const closed = await lifecycle.close({
    taskId,
    expectedRevision: 2,
    closure: { ...closure, state: 'satisfied', evidenceRefs: ['artifact:presentation:approved'] },
  });
  await assert.rejects(
    lifecycle.update({ taskId, expectedRevision: 3, status: 'doing' }),
    (error) => error.code === 'ENTRUSTED_WORK_ALREADY_CLOSED',
  );
  assert.deepEqual(store.get(taskId), closed);
  assert.deepEqual(
    custodyEvents.map((event) => event.kind),
    ['task.done'],
  );
});

test('concurrent progress versus close has one winner and never splits status from closure', async () => {
  const { store, lifecycle, taskId } = await setup();
  const results = await Promise.allSettled([
    lifecycle.update({ taskId, expectedRevision: 1, status: 'doing' }),
    lifecycle.close({
      taskId,
      expectedRevision: 1,
      closure: { ...closure, state: 'satisfied', evidenceRefs: ['artifact:presentation:approved'] },
    }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const task = store.get(taskId);
  assert.equal(task.entrustedWork.revision, 2);
  assert.equal(task.status === 'done', task.entrustedWork.closure.state === 'satisfied');
});

test('callback progress requires the exact owner invocation and thread and rejects terminal/identity input', async (t) => {
  const { store, taskId, custodyEvents } = await setup();
  const registry = new InvocationRegistry();
  const app = Fastify();
  t.after(() => app.close());
  const events = [];
  const ownerEvents = [];
  await app.register(callbacksRoutes, {
    registry,
    messageStore: new MessageStore(),
    taskStore: store,
    socketManager: {
      broadcastAgentMessage() {},
      emitToUser(...args) {
        ownerEvents.push(args);
      },
      broadcastToRoom(...args) {
        events.push(args);
      },
    },
  });
  async function request(cat, thread, patch) {
    const credentials = await registry.create('owner-progress', cat, thread);
    return app.inject({
      method: 'POST',
      url: '/api/callbacks/update-entrusted-work',
      headers: { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken },
      payload: { taskId, expectedRevision: 1, ...patch },
    });
  }
  assert.equal((await request('opus', 'thread-progress', { status: 'doing' })).statusCode, 403);
  assert.equal((await request('codex-sol', 'thread-other', { status: 'doing' })).statusCode, 403);
  for (const patch of [
    { status: 'done' },
    { status: 'doing', ownerCatId: 'opus' },
    { status: 'doing', threadId: 'thread-other' },
  ]) {
    assert.equal((await request('codex-sol', 'thread-progress', patch)).statusCode, 400);
  }
  assert.equal(events.length, 0);
  assert.deepEqual(ownerEvents, []);
  assert.deepEqual(custodyEvents, []);
  const response = await request('codex-sol', 'thread-progress', { status: 'blocked' });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().task.status, 'blocked');
  assert.equal(response.json().task.entrustedWork.revision, 2);
  assert.equal(events.length, 1);
  assert.deepEqual(ownerEvents, [
    ['owner-progress', 'entrusted_work_projection_invalidated', { ownerUserId: 'owner-progress' }],
  ]);
  assert.deepEqual(
    custodyEvents.map((event) => event.kind),
    ['task.blocked'],
  );
});
