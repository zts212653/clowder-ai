import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';

import { createTypedWaitRegistration } from '../dist/domains/ball-custody/TypedWaitRegistration.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { DeploymentWaitLifecycleService } from '../dist/domains/runtime-deployment/DeploymentWaitLifecycleService.js';
import { tasksRoutes } from '../dist/routes/tasks.js';

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

async function fixture() {
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
  const lifecycle = new DeploymentWaitLifecycleService({
    taskStore,
    deliveryDeps: { messageStore },
    currentObservation: async () => observation(['api']),
    log: { info() {}, warn() {}, error() {} },
  });
  const socketManager = { broadcastToRoom() {} };
  const app = Fastify();
  await app.register(tasksRoutes, {
    taskStore,
    socketManager,
    deploymentWaitLifecycleHolder: { current: lifecycle },
  });
  return { app, lifecycle, taskStore, task: installed };
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
    url: `/api/tasks/${h.task.id}`,
    payload: { status: 'done' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, 'done');
  assert.equal(response.json().deploymentWait.waitOutcome.reason, 'subject_terminal');
  const lateCancel = await h.app.inject({
    method: 'POST',
    url: `/api/tasks/${h.task.id}/cancel-wait`,
    headers: { 'x-cat-cafe-user': 'user-1' },
    payload: {},
  });
  assert.equal(lateCancel.statusCode, 409);
  await h.app.close();
});
