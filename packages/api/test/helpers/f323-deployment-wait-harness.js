import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { InvocationTracker } from '../../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { InMemoryTurnExecutionStore } from '../../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../../dist/domains/cats/services/stores/ports/TaskStore.js';
import { DeploymentWaitLifecycleService } from '../../dist/domains/runtime-deployment/DeploymentWaitLifecycleService.js';
import { registerCallbackAuthHook } from '../../dist/routes/callback-auth-prehandler.js';
import { registerCallbackDeploymentWaitRoutes } from '../../dist/routes/callback-deployment-wait-routes.js';
import { connectorDeliveryHarness } from './connector-delivery-harness.js';
import { adaptMessageStore, appendTestLifecycleResponseSource } from './message-from-fixtures.js';

export const TARGET = 'a'.repeat(40);
export const RUNNING = 'b'.repeat(40);

export function bindInputs(messages, principals) {
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

export async function fixture({
  included = true,
  observe,
  staleCurrentObservation = false,
  authorization = {},
  bindActiveInputs = true,
  handoffProposalStore,
  sessionChainStore,
} = {}) {
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
    ...authorization,
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
    async peekRecord(invocationId) {
      return invocationId === auth.invocationId ? auth : null;
    },
  };
  const invocationTracker = bindActiveInputs ? bindInputs(messageStore, [{ auth, origin }]) : new InvocationTracker();
  const turnExecutionStore = new InMemoryTurnExecutionStore();
  if (bindActiveInputs)
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
    authorizationRegistry: registry,
    handoffProposalStore,
    sessionChainStore,
  });
  registerCallbackDeploymentWaitRoutes(app, {
    taskStore,
    messageStore,
    registry,
    invocationTracker,
    handoffProposalStore,
    sessionChainStore,
    observationProvider: {
      observe: observeDeployment,
    },
    lifecycleHolder: { current: lifecycle },
  });
  await app.ready();
  return {
    app,
    taskStore,
    messageStore,
    task,
    auth,
    origin,
    invocationTracker,
    turnExecutionStore,
    getWakes: () => connector.wakes.length,
    connector,
    observation,
    lifecycle,
    registry,
  };
}

export function registerRequest(auth, task, overrides = {}) {
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
