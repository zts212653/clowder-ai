import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { createWorkAuthorizer } from '../dist/domains/collaborative-content/works/access.js';
import { DeploymentWaitStartGuard } from '../dist/domains/runtime-deployment/DeploymentWaitStartGuard.js';
import { fixture, registerRequest } from './helpers/f323-deployment-wait-harness.js';

const restrictedPolicy = {
  mode: 'callback_allowlist',
  allowedCallbackRoutes: ['POST /api/callbacks/register-deployment-wait'],
};

async function waiting(t, authorization) {
  const h = await fixture({ authorization });
  t.after(() => h.app.close());
  const response = await h.app.inject(
    registerRequest(h.auth, h.task, { when: { kind: 'new_ready_boot', services: ['api', 'web'] } }),
  );
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().disposition, 'registered');
  return h;
}

async function ready(h) {
  Object.assign(h.observation, { bootId: 'boot-8', bootSequence: 8, observedAt: Date.now() });
  return h.lifecycle.observe({ taskId: h.task.id, observation: h.observation });
}

async function historicalReceipt(h) {
  const { task, receipt } = await h.taskStore.getWaitRegistration(h.task.id);
  const { authorization: _unavailableOnOldVersions, ...legacy } = receipt;
  assert.ok(
    await h.taskStore.replaceDeploymentWaitIfGeneration(task.id, {
      expectedGeneration: 1,
      expectedDeploymentWait: task.deploymentWait,
      expectedUpdatedAt: task.updatedAt,
      deploymentWait: task.deploymentWait,
      waitRegistration: legacy,
    }),
  );
}

async function workDecision(h, row, permission) {
  const registry = new InvocationRegistry();
  const { invocationId } = await registry.create(
    h.auth.userId,
    h.auth.catId,
    h.auth.threadId,
    undefined,
    undefined,
    row.execution.readOnlyToolPolicy,
    row.payload.messageId,
    row.execution.ownerAuthProvenance,
  );
  const authorize = createWorkAuthorizer({
    ownerUserId: h.auth.userId,
    access: {
      async authorizeThread(threadId, principal) {
        assert.equal(threadId, h.auth.threadId);
        assert.equal(principal.userId, h.auth.userId);
      },
    },
    invocation: (id) => registry.peekRecord(id),
  });
  return authorize({
    principal: {
      userId: h.auth.userId,
      threadId: h.auth.threadId,
      actor: { kind: 'cat', actorId: h.auth.catId },
      invocationId,
    },
    permission,
  });
}

test('authenticated deployment registration retains its owner authority through Queue into Works', async (t) => {
  const h = await waiting(t, { ownerAuthProvenance: 'strict' });
  assert.equal((await ready(h)).kind, 'notified');
  const [row] = h.connector.admitted(h.auth.threadId, h.auth.userId);
  assert.equal(row.execution.ownerAuthProvenance, 'strict');
  await workDecision(h, row, 'read');
  await workDecision(h, row, 'write');
  const { receipt } = await h.taskStore.getWaitRegistration(h.task.id);
  assert.deepEqual(receipt.authorization, { ownerAuthProvenance: 'strict' });
  await ready(h);
  assert.equal(h.connector.admitted(h.auth.threadId, h.auth.userId).length, 1);
});

test('a permitted wait cannot drop the registering invocation tool restrictions', async (t) => {
  const h = await waiting(t, { ownerAuthProvenance: 'strict', toolExecutionPolicy: restrictedPolicy });
  // The callback principal may be collected after its terminal retention window; the wait persists.
  h.registry.peekRecord = async () => null;
  assert.equal((await ready(h)).kind, 'notified');
  const [row] = h.connector.admitted(h.auth.threadId, h.auth.userId);
  assert.equal(row.execution.ownerAuthProvenance, 'strict');
  assert.deepEqual(row.execution.readOnlyToolPolicy, restrictedPolicy);
  await assert.rejects(workDecision(h, row, 'write'), { code: 'access_denied' });
  assert.deepEqual((await h.taskStore.getWaitRegistration(h.task.id)).receipt.authorization, {
    ownerAuthProvenance: 'strict',
    toolExecutionPolicy: restrictedPolicy,
  });
});

for (const grade of ['unknown', 'compatibility_fallback']) {
  test(`${grade} registration never becomes strict through deployment readiness`, async (t) => {
    const h = await waiting(t, { ownerAuthProvenance: grade });
    assert.equal((await ready(h)).kind, 'notified');
    const [row] = h.connector.admitted(h.auth.threadId, h.auth.userId);
    assert.equal(row.execution.ownerAuthProvenance, grade);
    await assert.rejects(workDecision(h, row, 'read'), { code: 'access_denied' });
  });
}

test('callback clients cannot provide an authentication grade in the registration payload', async (t) => {
  const h = await fixture({ authorization: { ownerAuthProvenance: 'unknown' } });
  t.after(() => h.app.close());
  const response = await h.app.inject(
    registerRequest(h.auth, h.task, { authorization: { ownerAuthProvenance: 'strict' } }),
  );
  assert.equal(response.statusCode, 400);
  assert.equal((await h.taskStore.getWaitRegistration(h.task.id)).receipt, null);
});

test('a historical receipt recovers only its exact original authenticated principal and restrictions', async (t) => {
  const h = await waiting(t, { ownerAuthProvenance: 'strict', toolExecutionPolicy: restrictedPolicy });
  await historicalReceipt(h);
  Object.assign(h.auth, { state: 'completed', endedAt: Date.now() + 1 });
  assert.equal((await ready(h)).kind, 'notified');
  assert.deepEqual((await h.taskStore.getWaitRegistration(h.task.id)).receipt.authorization, {
    ownerAuthProvenance: 'strict',
    toolExecutionPolicy: restrictedPolicy,
  });
  const [row] = h.connector.admitted(h.auth.threadId, h.auth.userId);
  assert.equal(row.execution.ownerAuthProvenance, 'strict');
  assert.deepEqual(row.execution.readOnlyToolPolicy, restrictedPolicy);
  await assert.rejects(workDecision(h, row, 'write'), { code: 'access_denied' });
});

test('a missing historical auth record does not infer strict from a Human message or Task ownership', async (t) => {
  const h = await waiting(t, { ownerAuthProvenance: 'strict' });
  await historicalReceipt(h);
  h.registry.peekRecord = async () => null;
  assert.equal((await ready(h)).kind, 'notified');
  const [row] = h.connector.admitted(h.auth.threadId, h.auth.userId);
  assert.equal(row.execution.ownerAuthProvenance, 'unknown');
  await assert.rejects(workDecision(h, row, 'write'), { code: 'access_denied' });
});

for (const [name, changes] of [
  ['foreign owner', { userId: 'another-user' }],
  ['foreign cat', { catId: 'opus' }],
  ['foreign thread', { threadId: 'another-thread' }],
  ['different source', { originTriggerMessageId: 'another-source' }],
  ['revoked credentials', { state: 'revoked' }],
  ['retired authority', { retiredAuthorization: { bindingFields: ['executionGrant'] } }],
]) {
  test(`historical proof with ${name} cannot authorize publication`, async (t) => {
    const h = await waiting(t, { ownerAuthProvenance: 'strict' });
    await historicalReceipt(h);
    const original = { ...h.auth };
    h.registry.peekRecord = async () => ({ ...original, ...changes });
    assert.equal((await ready(h)).kind, 'state_only');
    assert.equal(h.connector.admitted(h.auth.threadId, h.auth.userId).length, 0);
  });
}

test('deleting the sealed registration source prevents an authenticated wake', async (t) => {
  const h = await waiting(t, { ownerAuthProvenance: 'strict' });
  const get = h.messageStore.getById.bind(h.messageStore);
  h.messageStore.getById = (id) => {
    const message = get(id);
    return id === h.origin.id ? { ...message, deletedAt: Date.now() } : message;
  };
  assert.equal((await ready(h)).kind, 'state_only');
  assert.equal(h.connector.admitted(h.auth.threadId, h.auth.userId).length, 0);
});

test('a sealed strict snapshot cannot keep a completed Task eligible', async (t) => {
  const h = await waiting(t, { ownerAuthProvenance: 'strict' });
  await h.taskStore.update(h.task.id, { status: 'done' });
  await ready(h);
  assert.equal(h.connector.admitted(h.auth.threadId, h.auth.userId).length, 0);
});

test('the real start boundary rejects a sealed source deleted after publication', async (t) => {
  const h = await waiting(t, { ownerAuthProvenance: 'strict' });
  const published = await ready(h);
  assert.equal(published.kind, 'notified');
  const get = h.messageStore.getById.bind(h.messageStore);
  h.messageStore.getById = (id) => {
    const message = get(id);
    return id === h.origin.id ? { ...message, deletedAt: Date.now() } : message;
  };
  const guard = new DeploymentWaitStartGuard({
    taskStore: h.taskStore,
    messageStore: h.messageStore,
    observationProvider: { observe: async () => h.observation },
  });
  assert.deepEqual(
    await guard.check({
      userId: h.auth.userId,
      threadId: h.auth.threadId,
      catId: h.auth.catId,
      messageId: published.messageId,
      expectedDeploymentWait: true,
    }),
    { ok: false, reason: 'authority_stale' },
  );
});
