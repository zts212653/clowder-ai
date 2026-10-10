import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { handleRegisterDeploymentWait } from '../../mcp-server/dist/tools/callback-tools.js';
import { withInvocationCredentials } from '../../mcp-server/dist/tools/invocation-auth.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { DeploymentWaitLifecycleService } from '../dist/domains/runtime-deployment/DeploymentWaitLifecycleService.js';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import { registerCallbackDeploymentWaitRoutes } from '../dist/routes/callback-deployment-wait-routes.js';
import { connectorDeliveryHarness } from './helpers/connector-delivery-harness.js';
import { adaptMessageStore, appendTestLifecycleResponseSource } from './helpers/message-from-fixtures.js';

const TARGET = 'a'.repeat(40);
const RUNNING = 'b'.repeat(40);

function bindInputs(messages, principals) {
  const tracker = new InvocationTracker();
  for (const { auth, origin } of principals) {
    tracker.start(auth.threadId, auth.catId, auth.userId, [auth.catId], auth.invocationId);
    const response = appendTestLifecycleResponseSource(messages, {
      userId: auth.userId,
      threadId: auth.threadId,
      catId: auth.catId,
      invocationId: auth.invocationId,
      timestamp: 101,
    });
    assert.equal(
      tracker.bindLifecycleActiveRun(
        {
          threadId: auth.threadId,
          targetId: auth.catId,
          invocationId: auth.invocationId,
          responseMessageId: response.id,
          inputEntryIds: [],
          inputMessageIds: [origin.id],
          privateInputEntryIds: [],
          startedAt: 101,
        },
        auth.invocationId,
      ),
      true,
    );
  }
  return tracker;
}

async function fixture({ included = true, observe, staleCurrentObservation = false } = {}) {
  const app = Fastify({ logger: false });
  const taskStore = new TaskStore();
  const messageStore = adaptMessageStore(new MessageStore());
  const origin = messageStore.append({
    threadId: 'thread-1',
    userId: 'user-1',
    catId: null,
    content: 'Please verify this after deployment.',
    timestamp: 100,
  });
  const auth = {
    invocationId: 'invocation-1',
    callbackToken: 'token-1',
    userId: 'user-1',
    catId: 'codex-sol',
    threadId: 'thread-1',
    originTriggerMessageId: origin.id,
    clientMessageIds: new Set(),
    createdAt: 100,
    expiresAt: null,
    state: 'active',
  };
  const registry = {
    async verify(invocationId, token) {
      return invocationId === auth.invocationId && token === auth.callbackToken
        ? { ok: true, record: auth }
        : { ok: false, reason: 'invalid_token' };
    },
    async isLatest(invocationId) {
      return invocationId === auth.invocationId;
    },
  };
  const invocationTracker = bindInputs(messageStore, [{ auth, origin }]);
  const turnExecutionStore = new InMemoryTurnExecutionStore();
  turnExecutionStore.createRunning({
    invocationId: auth.invocationId,
    parentInvocationId: 'parent-registration',
    userId: auth.userId,
    threadId: auth.threadId,
    catId: auth.catId,
    executionKind: 'ordinary',
    startedAt: 101,
  });
  const connector = connectorDeliveryHarness({ messageStore });
  registerCallbackAuthHook(app, registry);
  const task = taskStore.create({
    kind: 'work',
    threadId: 'thread-1',
    title: 'Verify activation',
    ownerCatId: 'codex-sol',
    why: 'Runtime is still dormant.',
    createdBy: 'codex-sol',
    userId: 'user-1',
  });
  const observation = {
    subjectRef: 'deployment:abc123def456:runtime',
    bootId: 'boot-7',
    bootSequence: 7,
    runningRevision: RUNNING,
    readyServices: ['api', 'web'],
    observedAt: 200,
    inclusionProof: {
      kind: 'git_ancestry',
      targetRevision: TARGET,
      runningRevision: RUNNING,
      included,
    },
  };
  const observeDeployment = observe ?? (async () => observation);
  const currentObservation = staleCurrentObservation
    ? async () => ({
        ...observation,
        inclusionProof: { ...observation.inclusionProof, included: false },
      })
    : observeDeployment;
  const lifecycle = new DeploymentWaitLifecycleService({
    taskStore,
    messageStore,
    turnExecutionStore,
    deliveryDeps: connector.deliveryDeps,
    log: { info() {}, warn() {}, error() {} },
    currentObservation,
  });
  registerCallbackDeploymentWaitRoutes(app, {
    taskStore,
    messageStore,
    registry,
    invocationTracker,
    observationProvider: {
      observe: observeDeployment,
    },
    lifecycleHolder: { current: lifecycle },
  });
  await app.ready();
  return { app, taskStore, messageStore, task, auth, getWakes: () => connector.wakes.length, connector, observation };
}

test('authenticated Task owner registers idempotently and an immediate match stays in the current turn', async () => {
  const h = await fixture();
  const request = {
    method: 'POST',
    url: '/api/callbacks/register-deployment-wait',
    headers: { 'x-invocation-id': h.auth.invocationId, 'x-callback-token': h.auth.callbackToken },
    payload: {
      taskId: h.task.id,
      deploymentId: 'runtime',
      when: { kind: 'revision_included', revision: TARGET, services: ['api', 'web'] },
      nextStep: 'Run the original acceptance check.',
    },
  };
  const first = await h.app.inject(request);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().disposition, 'matched_current_execution');
  assert.match(first.json().notification.content, /Run the original acceptance check/);
  assert.equal(first.json().notification.outcome.reason, 'matched');
  assert.equal(h.connector.admitted('thread-1', 'user-1').length, 0);
  assert.equal(h.getWakes(), 0, 'the current owner invocation must not be started a second time');
  assert.equal(h.messageStore.getByThread('thread-1').length, 3, 'origin, active response and one durable outcome');

  const second = await h.app.inject(request);
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().disposition, 'already_satisfied', 'a replay does not silently re-arm the wait');
  assert.equal(h.messageStore.getByThread('thread-1').length, 3);

  const reordered = await h.app.inject({
    ...request,
    payload: {
      ...request.payload,
      when: { ...request.payload.when, services: ['web', 'api'] },
    },
  });
  assert.equal(reordered.statusCode, 200);
  assert.equal(reordered.json().disposition, 'already_satisfied', 'service-set order does not mint a generation');
  assert.equal(h.messageStore.getByThread('thread-1').length, 3);
  await h.app.close();
});

test('compiled MCP registration hands the full immediate outcome back to the exact callback child', async (t) => {
  const h = await fixture();
  const originalFetch = globalThis.fetch;
  const originalApi = process.env.CAT_CAFE_API_URL;
  process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
  globalThis.fetch = async (url, options) => {
    const target = new URL(url);
    assert.equal(target.origin, 'http://127.0.0.1:1');
    assert.equal(target.pathname, '/api/callbacks/register-deployment-wait');
    const response = await h.app.inject({
      method: 'POST',
      url: target.pathname,
      headers: options.headers,
      payload: options.body,
    });
    return new Response(response.body, {
      status: response.statusCode,
      headers: { 'content-type': 'application/json' },
    });
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (originalApi === undefined) delete process.env.CAT_CAFE_API_URL;
    else process.env.CAT_CAFE_API_URL = originalApi;
    await h.app.close();
  });
  const result = await withInvocationCredentials(h.auth, () =>
    handleRegisterDeploymentWait({
      taskId: h.task.id,
      deploymentId: 'runtime',
      when: { kind: 'revision_included', revision: TARGET, services: ['api', 'web'] },
      nextStep: 'Verify exact deployment in this current child.',
    }),
  );
  assert.equal(result.isError, undefined, result.content[0].text);
  const returned = JSON.parse(result.content[0].text);
  assert.equal(returned.disposition, 'matched_current_execution');
  assert.match(returned.notification.content, /Verify exact deployment in this current child/);
  assert.equal(returned.notification.outcome.reason, 'matched');
  assert.equal(returned.task.deploymentWait.currentExecutionReceipt.invocationId, h.auth.invocationId);
  assert.equal(h.connector.admitted('thread-1', 'user-1').length, 0);
  assert.equal(h.messageStore.getById(returned.notification.messageId).lifecycle?.dispatchRefs?.length ?? 0, 0);
});

test('another owner cannot attach a deployment wait to the Task', async () => {
  const h = await fixture();
  const task = await h.taskStore.get(h.task.id);
  h.taskStore.update(task.id, { ownerCatId: 'opus' });
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/callbacks/register-deployment-wait',
    headers: { 'x-invocation-id': h.auth.invocationId, 'x-callback-token': h.auth.callbackToken },
    payload: {
      taskId: h.task.id,
      deploymentId: 'runtime',
      when: { kind: 'new_ready_boot', services: ['api'] },
      nextStep: 'Verify after the next ready boot.',
    },
  });
  assert.equal(response.statusCode, 403);
  assert.equal((await h.taskStore.get(h.task.id)).deploymentWait, undefined);
  await h.app.close();
});

test('same-source replay returns the original active generation without replacing it', async () => {
  const h = await fixture({ included: false });
  const request = {
    method: 'POST',
    url: '/api/callbacks/register-deployment-wait',
    headers: { 'x-invocation-id': h.auth.invocationId, 'x-callback-token': h.auth.callbackToken },
    payload: {
      taskId: h.task.id,
      deploymentId: 'runtime',
      when: { kind: 'revision_included', revision: TARGET, services: ['api', 'web'] },
      nextStep: 'Run the original acceptance check.',
    },
  };
  const first = await h.app.inject(request);
  const second = await h.app.inject(request);
  assert.equal(first.json().disposition, 'registered');
  assert.equal(second.json().disposition, 'already_registered');
  assert.equal(second.json().await.generation, 1);
  assert.equal(h.messageStore.getByThread('thread-1').length, 2, 'original input and active response, no outcome');
  await h.app.close();
});

function registerRequest(auth, task, overrides = {}) {
  return {
    method: 'POST',
    url: '/api/callbacks/register-deployment-wait',
    headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
    payload: {
      taskId: task.id,
      deploymentId: 'runtime',
      when: { kind: 'revision_included', revision: TARGET, services: ['api', 'web'] },
      nextStep: 'Run the acceptance check.',
      ...overrides,
    },
  };
}

async function multiFixture() {
  const app = Fastify({ logger: false });
  const taskStore = new TaskStore();
  const messageStore = adaptMessageStore(new MessageStore());
  const principal = ({ threadId, catId, invocationId, callbackToken }) => {
    const origin = messageStore.append({
      threadId,
      userId: 'user-1',
      catId: null,
      content: `Please verify this after deployment on ${threadId}.`,
      timestamp: 100,
    });
    const auth = {
      invocationId,
      callbackToken,
      userId: 'user-1',
      catId,
      threadId,
      originTriggerMessageId: origin.id,
      clientMessageIds: new Set(),
      createdAt: 100,
      expiresAt: null,
      state: 'active',
    };
    const task = taskStore.create({
      kind: 'work',
      threadId,
      title: `Verify activation on ${threadId}`,
      ownerCatId: catId,
      why: 'Runtime is still dormant.',
      createdBy: catId,
      userId: 'user-1',
    });
    return { origin, auth, task };
  };
  const a = principal({
    threadId: 'thread-a',
    catId: 'codex-sol',
    invocationId: 'invocation-a',
    callbackToken: 'token-a',
  });
  const b = principal({ threadId: 'thread-b', catId: 'opus', invocationId: 'invocation-b', callbackToken: 'token-b' });
  const auths = new Map([
    [a.auth.invocationId, a.auth],
    [b.auth.invocationId, b.auth],
  ]);
  const invocationTracker = bindInputs(messageStore, [a, b]);
  const registry = {
    async verify(invocationId, token) {
      const record = auths.get(invocationId);
      return record && record.callbackToken === token ? { ok: true, record } : { ok: false, reason: 'invalid_token' };
    },
    async isLatest(invocationId) {
      return auths.has(invocationId);
    },
  };
  registerCallbackAuthHook(app, registry);
  const observeDeployment = async () => ({
    subjectRef: 'deployment:abc123def456:runtime',
    bootId: 'boot-7',
    bootSequence: 7,
    runningRevision: RUNNING,
    readyServices: ['api', 'web'],
    observedAt: 200,
    inclusionProof: {
      kind: 'git_ancestry',
      targetRevision: TARGET,
      runningRevision: RUNNING,
      included: false,
    },
  });
  const lifecycle = new DeploymentWaitLifecycleService({
    taskStore,
    messageStore,
    deliveryDeps: connectorDeliveryHarness({ messageStore }).deliveryDeps,
    log: { info() {}, warn() {}, error() {} },
    currentObservation: observeDeployment,
  });
  registerCallbackDeploymentWaitRoutes(app, {
    taskStore,
    messageStore,
    registry,
    invocationTracker,
    observationProvider: { observe: observeDeployment },
    lifecycleHolder: { current: lifecycle },
  });
  await app.ready();
  return { app, taskStore, messageStore, a, b };
}

test('two owners on separate threads register concurrently without crossing receipts', async () => {
  const h = await multiFixture();
  const requestA = registerRequest(h.a.auth, h.a.task, { nextStep: 'Accept on thread A.' });
  const requestB = registerRequest(h.b.auth, h.b.task, { nextStep: 'Accept on thread B.' });
  const [firstA, firstB] = await Promise.all([h.app.inject(requestA), h.app.inject(requestB)]);
  assert.equal(firstA.statusCode, 200);
  assert.equal(firstB.statusCode, 200);
  assert.equal(firstA.json().disposition, 'registered');
  assert.equal(firstB.json().disposition, 'registered');

  const taskA = await h.taskStore.get(h.a.task.id);
  const taskB = await h.taskStore.get(h.b.task.id);
  assert.equal(taskA.status, 'blocked');
  assert.equal(taskB.status, 'blocked');
  assert.equal(taskA.deploymentWait?.await?.generation, 1);
  assert.equal(taskB.deploymentWait?.await?.generation, 1);
  assert.equal(taskA.deploymentWait?.await?.continuation.then, 'Accept on thread A.');
  assert.equal(taskB.deploymentWait?.await?.continuation.then, 'Accept on thread B.');

  const receiptA = h.taskStore.getWaitRegistration(h.a.task.id)?.receipt;
  const receiptB = h.taskStore.getWaitRegistration(h.b.task.id)?.receipt;
  assert.equal(receiptA?.taskId, h.a.task.id);
  assert.equal(receiptA?.invocationId, 'invocation-a');
  assert.equal(receiptA?.catId, 'codex-sol');
  assert.equal(receiptA?.threadId, 'thread-a');
  assert.equal(receiptA?.source.sourceMessageId, h.a.origin.id);
  assert.equal(receiptB?.taskId, h.b.task.id);
  assert.equal(receiptB?.invocationId, 'invocation-b');
  assert.equal(receiptB?.catId, 'opus');
  assert.equal(receiptB?.threadId, 'thread-b');
  assert.equal(receiptB?.source.sourceMessageId, h.b.origin.id);

  const replayA = await h.app.inject(requestA);
  const replayB = await h.app.inject(requestB);
  assert.equal(replayA.json().disposition, 'already_registered');
  assert.equal(replayB.json().disposition, 'already_registered');
  assert.equal(replayA.json().await.generation, 1);
  assert.equal(replayB.json().await.generation, 1);
  assert.equal(h.messageStore.getByThread('thread-a').length, 2, 'input and response, no delivery on thread A');
  assert.equal(h.messageStore.getByThread('thread-b').length, 2, 'input and response, no delivery on thread B');
  await h.app.close();
});

test('a non-work Task cannot register a deployment wait', async () => {
  const h = await fixture({ included: false });
  const tracking = h.taskStore.create({
    kind: 'pr_tracking',
    threadId: 'thread-1',
    title: 'Track a PR',
    ownerCatId: 'codex-sol',
    why: 'PR tracking task.',
    createdBy: 'codex-sol',
    userId: 'user-1',
  });
  const response = await h.app.inject(registerRequest(h.auth, tracking));
  assert.equal(response.statusCode, 403);
  assert.match(response.json().error, /original Task owner/);
  const stored = await h.taskStore.get(tracking.id);
  assert.equal(stored.deploymentWait, undefined);
  assert.equal(stored.status, 'todo');
  assert.equal(h.taskStore.getWaitRegistration(tracking.id)?.receipt ?? null, null);
  await h.app.close();
});

test('a terminal Task cannot register a deployment wait', async () => {
  const h = await fixture({ included: false });
  h.taskStore.update(h.task.id, { status: 'done' });
  const response = await h.app.inject(registerRequest(h.auth, h.task));
  assert.equal(response.statusCode, 409);
  assert.match(response.json().error, /Terminal Task/);
  const stored = await h.taskStore.get(h.task.id);
  assert.equal(stored.deploymentWait, undefined);
  assert.equal(stored.status, 'done');
  assert.equal(h.taskStore.getWaitRegistration(h.task.id)?.receipt ?? null, null);
  await h.app.close();
});

test('an unavailable observation baseline registers nothing', async () => {
  const h = await fixture({ observe: async () => null });
  const response = await h.app.inject(registerRequest(h.auth, h.task));
  assert.equal(response.statusCode, 503);
  assert.match(response.json().error, /baseline is unavailable/);
  const stored = await h.taskStore.get(h.task.id);
  assert.equal(stored.deploymentWait, undefined);
  assert.equal(stored.status, 'todo');
  assert.equal(h.taskStore.getWaitRegistration(h.task.id)?.receipt ?? null, null);
  assert.equal(h.messageStore.getByThread('thread-1').length, 2, 'input and response, no outcome message was appended');
  await h.app.close();
});

test('a same-source replay while delivery is still pending is rejected with 409', async () => {
  const h = await fixture({ included: true, staleCurrentObservation: true });
  const request = registerRequest(h.auth, h.task, { nextStep: 'Run the original acceptance check.' });
  const first = await h.app.inject(request);
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().disposition, 'registered');
  assert.equal(first.json().observationState, 'state_only');

  const pending = await h.taskStore.get(h.task.id);
  assert.equal(pending.deploymentWait?.await, undefined, 'the matched await was consumed by the outcome');
  assert.equal(pending.deploymentWait?.waitOutcome?.reason, 'matched');
  assert.equal(pending.deploymentWait?.waitOutcome?.delivery, 'pending');
  assert.equal(pending.deploymentWait?.waitOutcome?.generation, 1);
  assert.equal(pending.status, 'blocked');
  assert.equal(h.getWakes(), 0, 'a stale-evidence match must not wake the owner');
  assert.equal(h.messageStore.getByThread('thread-1').length, 2, 'input and response, no owner delivery happened');

  h.observation.subjectRef = 'deployment:fedcba654321:runtime';
  const replay = await h.app.inject(request);
  assert.equal(replay.statusCode, 409);
  assert.match(replay.json().error, /pending delivery/);

  const after = await h.taskStore.get(h.task.id);
  assert.equal(after.deploymentWait?.waitOutcome?.outcomeId, pending.deploymentWait?.waitOutcome?.outcomeId);
  assert.equal(after.deploymentWait?.waitOutcome?.delivery, 'pending');
  assert.equal(after.deploymentWait?.waitOutcome?.generation, 1);
  assert.equal(after.updatedAt, pending.updatedAt, 'the rejected replay must not touch the Task');
  const receipt = h.taskStore.getWaitRegistration(h.task.id)?.receipt;
  assert.equal(receipt?.taskId, h.task.id);
  assert.equal(receipt?.generation, 1);
  await h.app.close();
});
