import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';

import { createTypedWaitRegistration } from '../dist/domains/ball-custody/TypedWaitRegistration.js';
import { MemoryWaitLifecycleEventLog } from '../dist/domains/ball-custody/WaitLifecycleEventLog.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { DeploymentWaitLifecycleService } from '../dist/domains/runtime-deployment/DeploymentWaitLifecycleService.js';
import { DeploymentWaitRecoverySweep } from '../dist/domains/runtime-deployment/DeploymentWaitRecoverySweep.js';
import { tasksRoutes } from '../dist/routes/tasks.js';
import { connectorDeliveryHarness } from './helpers/connector-delivery-harness.js';

const TARGET = 'a'.repeat(40);

function observation(readyServices = ['api', 'web']) {
  return {
    subjectRef: 'deployment:abc123def456:runtime',
    bootId: 'boot-2',
    bootSequence: 2,
    runningRevision: 'b'.repeat(40),
    readyServices,
    observedAt: 200,
    inclusionProof: {
      kind: 'git_ancestry',
      targetRevision: TARGET,
      runningRevision: 'b'.repeat(40),
      included: true,
    },
  };
}

async function fixture({ governed = false } = {}) {
  const taskStore = new TaskStore();
  const messageStore = new MessageStore();
  const task = taskStore.create({
    kind: 'work',
    threadId: 'thread-f323-task-route',
    title: 'Verify runtime activation',
    ownerCatId: 'codex-sol',
    why: 'wait for exact deployment',
    createdBy: 'codex-sol',
    userId: 'user-1',
    ...(governed ? { subjectKey: 'eval-case:deployment-wait' } : {}),
  });
  const active = {
    v: 1,
    generation: 1,
    subjectRef: 'deployment:abc123def456:runtime',
    ownerFence: { kind: 'containing_task', generation: 1 },
    baseline: { bootSequence: 1, bootId: 'boot-1', capturedAt: 100 },
    continuation: {
      when: [{ kind: 'revision_included', revision: TARGET, services: ['api', 'web'] }],
      // biome-ignore lint/suspicious/noThenProperty: F280 continuation contract field.
      then: 'verify in the original thread',
    },
    autoRenew: false,
    createdAt: 100,
  };
  const receipt = createTypedWaitRegistration({
    task,
    active,
    invocationId: 'invocation-1',
    source: { kind: 'primary', sourceMessageId: 'message-1' },
  });
  assert.ok(receipt);
  const installed = await taskStore.replaceDeploymentWaitIfGeneration(task.id, {
    expectedGeneration: null,
    expectedDeploymentWait: task.deploymentWait,
    expectedUpdatedAt: task.updatedAt,
    deploymentWait: { await: active },
    waitRegistration: receipt,
    status: 'blocked',
  });
  assert.ok(installed);
  const eventLog = new MemoryWaitLifecycleEventLog();
  const lifecycle = new DeploymentWaitLifecycleService({
    taskStore,
    messageStore,
    deliveryDeps: connectorDeliveryHarness({ messageStore }).deliveryDeps,
    currentObservation: async () => observation(['api']),
    eventLog,
    log: { info() {}, warn() {}, error() {} },
  });
  const socketManager = { broadcastToRoom() {} };
  const app = Fastify();
  await app.register(tasksRoutes, {
    taskStore,
    messageStore,
    socketManager,
    deploymentWaitLifecycleHolder: { current: lifecycle },
  });
  return { app, lifecycle, taskStore, task: installed, eventLog };
}

test('deployment wait cancel route owns pending matched outcomes and keeps them terminal', async () => {
  const h = await fixture();
  const stale = await h.lifecycle.observe({ taskId: h.task.id, observation: observation() });
  assert.equal(stale.reason, 'deployment_evidence_stale');

  const denied = await h.app.inject({
    method: 'POST',
    url: `/api/tasks/${h.task.id}/cancel-wait`,
    headers: { 'x-cat-cafe-user': 'user-2' },
    payload: {},
  });
  assert.equal(denied.statusCode, 403);

  const cancelled = await h.app.inject({
    method: 'POST',
    url: `/api/tasks/${h.task.id}/cancel-wait`,
    headers: { 'x-cat-cafe-user': 'user-1' },
    payload: {},
  });
  assert.equal(cancelled.statusCode, 200);
  const stored = await h.taskStore.get(h.task.id);
  assert.equal(stored.deploymentWait.waitOutcome.reason, 'user_cancel');
  assert.equal(stored.deploymentWait.waitOutcome.delivery, 'not_applicable');
  await h.app.close();
});

test('business Task completion terminalizes its active deployment wait without a wake', async () => {
  const h = await fixture();
  const response = await h.app.inject({
    method: 'PATCH',
    headers: { 'x-cat-cafe-user': 'user-1' },
    url: `/api/tasks/${h.task.id}`,
    payload: { status: 'done' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, 'done');
  assert.equal(response.json().deploymentWait.waitOutcome.reason, 'subject_terminal');
  const events = await h.eventLog.read(h.task.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'subject_terminal');
  const lateCancel = await h.app.inject({
    method: 'POST',
    url: `/api/tasks/${h.task.id}/cancel-wait`,
    headers: { 'x-cat-cafe-user': 'user-1' },
    payload: {},
  });
  assert.equal(lateCancel.statusCode, 409);
  await h.app.close();
});

test('rejected ordinary owner change cannot terminalize its deployment wait before the Task CAS', async () => {
  const h = await fixture();
  const current = h.taskStore.get(h.task.id);
  current.executionRef = {
    invocationId: 'occupied-child',
    parentInvocationId: 'occupied-parent',
    catId: current.ownerCatId,
    threadId: current.threadId,
    sourceMessageId: null,
  };
  const wait = structuredClone(current.deploymentWait);
  const response = await h.app.inject({
    method: 'PATCH',
    url: `/api/tasks/${h.task.id}`,
    headers: { 'x-cat-cafe-user': 'user-1' },
    payload: { ownerCatId: 'sonnet', expectedOwnerRevision: 0 },
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.deepEqual(h.taskStore.get(h.task.id).deploymentWait, wait);
  assert.equal(h.taskStore.get(h.task.id).ownerCatId, 'codex-sol');
  assert.deepEqual(await h.eventLog.read(h.task.id), []);
  await h.app.close();
});

test('successful wait owner PATCH resumes ordinary and governed work and records the original wait owner once', async (t) => {
  for (const governed of [false, true]) {
    const h = await fixture({ governed });
    t.after(() => h.app.close());
    const patch = () =>
      h.app.inject({
        method: 'PATCH',
        url: `/api/tasks/${h.task.id}`,
        headers: { 'x-cat-cafe-user': 'user-1' },
        payload: { ownerCatId: 'sonnet', expectedOwnerRevision: 0 },
      });
    const first = await patch();
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().status, 'doing');
    assert.equal(first.json().ownerCatId, 'sonnet');
    assert.equal(first.json().deploymentWait.waitOutcome.reason, 'owner_changed');
    assert.equal(first.json().deploymentWait.await, undefined);
    const events = await h.eventLog.read(h.task.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, 'owner_changed');
    assert.equal(events[0].ownerCatId, 'codex-sol');
    assert.equal((await patch()).statusCode, 200);
    assert.deepEqual(await h.eventLog.read(h.task.id), events);
  }
});

test('an explicit replacement blocked status remains blocked when consuming the old deployment wait', async (t) => {
  const h = await fixture();
  t.after(() => h.app.close());
  const result = await h.app.inject({
    method: 'PATCH',
    url: `/api/tasks/${h.task.id}`,
    headers: { 'x-cat-cafe-user': 'user-1' },
    payload: { ownerCatId: 'sonnet', status: 'blocked', why: 'New manual blocker', expectedOwnerRevision: 0 },
  });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().status, 'blocked');
  assert.equal(result.json().why, 'New manual blocker');
  assert.equal((await h.eventLog.read(h.task.id)).length, 1);
});

test('a failed post-commit wait event append recovers after restart without undoing Task done or waking work', async (t) => {
  const h = await fixture();
  t.after(() => h.app.close());
  const append = h.eventLog.append.bind(h.eventLog);
  h.eventLog.append = async () => {
    throw new Error('fixture event append unavailable');
  };
  const result = await h.app.inject({
    method: 'PATCH',
    url: `/api/tasks/${h.task.id}`,
    headers: { 'x-cat-cafe-user': 'user-1' },
    payload: { status: 'done' },
  });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(h.taskStore.get(h.task.id).status, 'done');
  assert.deepEqual(await h.eventLog.read(h.task.id), []);
  h.eventLog.append = append;
  const restarted = new DeploymentWaitLifecycleService({
    taskStore: h.taskStore,
    eventLog: h.eventLog,
    deliveryDeps: {
      publish() {
        throw new Error('audit recovery must not wake work');
      },
    },
    currentObservation: async () => {
      throw new Error('terminal audit needs no new deployment observation');
    },
    log: { info() {}, warn() {}, error() {} },
  });
  const sweep = new DeploymentWaitRecoverySweep(
    h.taskStore,
    {
      observe: async () => {
        throw new Error('terminal audit must not observe or wake');
      },
    },
    restarted,
  );
  await sweep.run();
  const events = await h.eventLog.read(h.task.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'subject_terminal');
  await sweep.run();
  assert.deepEqual(await h.eventLog.read(h.task.id), events);
});

test('unassigning a waiting work Task still records its original wait owner after the successful write', async (t) => {
  const h = await fixture();
  t.after(() => h.app.close());
  const result = await h.app.inject({
    method: 'PATCH',
    url: `/api/tasks/${h.task.id}`,
    headers: { 'x-cat-cafe-user': 'user-1' },
    payload: { ownerCatId: null, expectedOwnerRevision: 0 },
  });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().ownerCatId, null);
  assert.equal(result.json().status, 'doing');
  assert.equal((await h.eventLog.read(h.task.id))[0]?.ownerCatId, 'codex-sol');
});

test('inactive plugin projection does not shadow an active deployment wait', async () => {
  const h = await fixture();
  const task = h.taskStore.get(h.task.id);
  assert.ok(
    h.taskStore.replacePluginWait(task.id, {
      expectedStatus: task.status,
      expectedState: undefined,
      expectedGeneration: null,
      state: {
        pluginInstanceId: 'instance',
        generation: 1,
        userId: 'user-1',
        catId: 'codex-sol',
        threadId: task.threadId,
      },
    }),
  );
  const response = await h.app.inject({
    method: 'POST',
    url: `/api/tasks/${task.id}/cancel-wait`,
    headers: { 'x-cat-cafe-user': 'user-1' },
    payload: {},
  });
  assert.equal(response.statusCode, 200);
  assert.equal(h.taskStore.get(task.id).deploymentWait.waitOutcome.reason, 'user_cancel');
  await h.app.close();
});
