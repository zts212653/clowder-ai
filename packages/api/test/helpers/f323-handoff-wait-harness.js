import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { InvocationQueue } from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { QueueProcessor } from '../../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { InvocationRecordStore } from '../../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { InMemorySessionHandoffProposalStore } from '../../dist/domains/cats/services/stores/ports/SessionHandoffProposalStore.js';
import { DeploymentWaitLifecycleService } from '../../dist/domains/runtime-deployment/DeploymentWaitLifecycleService.js';
import { sessionHandoffApproveRoutes } from '../../dist/routes/session-handoff-approve-routes.js';
import { anchorApproval } from '../approval-hub/helpers.js';
import { fixture, registerRequest } from './f323-deployment-wait-harness.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function handoffWaitFixture(t, { authorization = {}, privateInput = false } = {}) {
  const handoffProposalStore = new InMemorySessionHandoffProposalStore();
  const session = {
    id: 'handoff-session',
    userId: 'user-1',
    threadId: 'thread-1',
    catId: 'codex-sol',
    status: 'active',
  };
  const sessionChainStore = {
    get: (id) => (id === session.id ? structuredClone(session) : null),
    getActive: () => (session.status === 'active' ? structuredClone(session) : null),
    update: (id, patch) => {
      assert.equal(id, session.id);
      Object.assign(session, patch);
      return session;
    },
  };
  const h = await fixture({
    included: false,
    bindActiveInputs: false,
    authorization: { ...authorization, originTriggerMessageId: undefined },
    handoffProposalStore,
    sessionChainStore,
  });
  t.after(() => h.app.close());
  const queue = new InvocationQueue();
  const started = deferred();
  const release = deferred();
  const ended = deferred();
  let providerStarted = false;
  let routeCalls = 0;
  const errors = [];
  const log = { info() {}, warn() {}, error: (...args) => errors.push(args) };
  const processor = new QueueProcessor({
    queue,
    invocationTracker: h.invocationTracker,
    invocationRecordStore: new InvocationRecordStore(),
    messageStore: h.messageStore,
    turnExecutionStore: h.turnExecutionStore,
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
    router: {
      resolveExplicitTargets: async (cats) => cats,
      resolveConversationTargetsAtAdmission: async (cats) => cats,
      ackCollectedCursors: async () => {},
      // Model/provider work is controlled; approval, Queue, lifecycle admission and HTTP callbacks are real.
      async *routeExecution(userId, _content, threadId, _intent, cats, _context, options) {
        routeCalls++;
        providerStarted = true;
        try {
          await h.turnExecutionStore.createRunning({
            invocationId: h.auth.invocationId,
            parentInvocationId: options.parentInvocationId,
            userId,
            threadId,
            catId: cats[0],
            executionKind: 'ordinary',
            startedAt: Date.now(),
          });
          await options.onLifecycleInvocationStarted({
            userId,
            threadId,
            catId: cats[0],
            invocationId: h.auth.invocationId,
            parentInvocationId: options.parentInvocationId,
            startedAt: Date.now(),
          });
          started.resolve();
          await release.promise;
          await h.turnExecutionStore.transitionTerminal(h.auth.invocationId, {
            status: 'succeeded',
            endedAt: Date.now(),
          });
          yield { type: 'done', catId: cats[0], isFinal: true, timestamp: Date.now() };
        } finally {
          ended.resolve();
        }
      },
    },
    log,
  });
  const finish = async () => {
    release.resolve();
    if (providerStarted) await ended.promise;
  };
  t.after(finish);
  const proposal = handoffProposalStore.create({
    sourceThreadId: session.threadId,
    sourceSessionId: session.id,
    sourceCatId: session.catId,
    sourceMessageId: h.origin.id,
    userId: session.userId,
    note: { done: 'Read the design.', nextSteps: 'Verify after reboot.' },
  });
  anchorApproval(handoffProposalStore, {
    proposalId: proposal.proposalId,
    sourceFeatureId: 'F225',
    ownerUserId: session.userId,
    requesterCatId: session.catId,
    threadId: session.threadId,
    createdAt: proposal.createdAt,
  });
  const approvalApp = Fastify();
  await approvalApp.register(sessionHandoffApproveRoutes, {
    handoffProposalStore,
    sessionChainStore,
    invocationQueue: queue,
    queueProcessor: processor,
    sessionSealer: {
      requestSeal: async ({ reason }) => {
        session.status = 'sealing';
        session.sealReason = reason;
        return { accepted: true };
      },
      finalize: async () => {
        session.status = 'sealed';
      },
    },
    socketManager: { emitToUser() {} },
  });
  t.after(() => approvalApp.close());
  const approve = () =>
    approvalApp.inject({
      method: 'POST',
      url: `/api/session-handoff/${proposal.proposalId}/approve`,
      headers: { 'x-cat-cafe-user': session.userId },
    });
  if (privateInput) {
    await queue.enqueueDurable({
      from: { kind: 'agent', catId: session.catId },
      userId: session.userId,
      threadId: session.threadId,
      kind: 'private_input',
      sourceId: 'ordinary-private-input',
      content: 'Continue privately.',
      ownerAuthProvenance: 'strict',
      targetCats: [session.catId],
      intent: 'execute',
    });
    assert.equal((await processor.processNext(session.threadId, session.userId)).started, true);
  } else {
    const approved = await approve();
    assert.equal(approved.statusCode, 200, approved.body);
  }
  let timeout;
  try {
    await Promise.race([
      started.promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Queue did not start: ${JSON.stringify(errors)}`)), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  const active = () => h.invocationTracker.getActiveSlots(session.threadId)[0]?.activeRun;
  const register = () =>
    h.app.inject(registerRequest(h.auth, h.task, { when: { kind: 'new_ready_boot', services: ['api'] } }));
  const ready = () => {
    h.observation.bootId = 'boot-8';
    h.observation.bootSequence = 8;
    return new DeploymentWaitLifecycleService({
      taskStore: h.taskStore,
      messageStore: h.messageStore,
      turnExecutionStore: h.turnExecutionStore,
      deliveryDeps: h.connector.deliveryDeps,
      handoffProposalStore,
      sessionChainStore,
      currentObservation: async () => h.observation,
      log,
    }).observe({ taskId: h.task.id, observation: h.observation });
  };
  return {
    ...h,
    queue,
    proposal,
    handoffProposalStore,
    session,
    sessionChainStore,
    active,
    register,
    ready,
    finish,
    approve,
    routeCalls: () => routeCalls,
  };
}
