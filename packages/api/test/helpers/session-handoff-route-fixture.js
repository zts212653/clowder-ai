import Fastify from 'fastify';
import { InMemorySessionHandoffProposalStore } from '../../dist/domains/cats/services/stores/ports/SessionHandoffProposalStore.js';
import { sessionHandoffApproveRoutes } from '../../dist/routes/session-handoff-approve-routes.js';
import { anchorApproval } from '../approval-hub/helpers.js';

export function buildSessionHandoffDeps({ sealAccepted = true, sessionActive = true } = {}) {
  const store = new InMemorySessionHandoffProposalStore();
  const session = {
    id: 'sess_1',
    status: 'active',
    catId: 'opus',
    threadId: 'thread_1',
    userId: 'user_1',
  };
  const sessionChainStore = {
    get: async (id) => (id === session.id ? session : null),
    getActive: async (catId, threadId) =>
      sessionActive && catId === session.catId && threadId === session.threadId ? session : null,
    update: async (id, patch) => {
      if (id === session.id) Object.assign(session, patch);
      return session;
    },
  };
  const sealCalls = [];
  const finalizeCalls = [];
  const sessionSealer = {
    requestSeal: async ({ sessionId, reason }) => {
      sealCalls.push({ sessionId, reason });
      return { accepted: sealAccepted, status: sealAccepted ? 'sealing' : 'sealed' };
    },
    finalize: async ({ sessionId }) => {
      finalizeCalls.push({ sessionId });
    },
  };
  const enqueueCalls = [];
  const invocationQueue = {
    enqueue: (input) => {
      enqueueCalls.push(input);
      return { outcome: 'enqueued', entry: { id: `entry_${enqueueCalls.length}` } };
    },
  };
  const processNextCalls = [];
  const queueProcessor = {
    processNext: async (threadId, userId) => {
      processNextCalls.push({ threadId, userId });
      return { started: true };
    },
  };
  return {
    store,
    session,
    sessionChainStore,
    sessionSealer,
    invocationQueue,
    queueProcessor,
    sealCalls,
    finalizeCalls,
    enqueueCalls,
    processNextCalls,
  };
}

export async function buildSessionHandoffApp(deps, routeOptions = {}) {
  const app = Fastify();
  await app.register(sessionHandoffApproveRoutes, {
    handoffProposalStore: deps.store,
    sessionChainStore: deps.sessionChainStore,
    sessionSealer: deps.sessionSealer,
    invocationQueue: deps.invocationQueue,
    queueProcessor: deps.queueProcessor,
    socketManager: { emitToUser() {}, broadcastToRoom() {} },
    ...routeOptions,
  });
  return app;
}

export function seedSessionHandoffProposal(deps, { anchored = true, userId = 'user_1' } = {}) {
  const proposal = deps.store.create({
    sourceThreadId: 'thread_1',
    sourceSessionId: 'sess_1',
    sourceCatId: 'opus',
    sourceMessageId: 'message_1',
    userId,
    note: { done: 'wired ②a', nextSteps: 'wire ②b' },
  });
  if (anchored) {
    anchorApproval(deps.store, {
      proposalId: proposal.proposalId,
      sourceFeatureId: 'F225',
      ownerUserId: userId,
      requesterCatId: 'opus',
      threadId: 'thread_1',
      createdAt: proposal.createdAt,
    });
  }
  return proposal;
}

export const approveSessionHandoff = (app, proposalId, userId = 'user_1') =>
  app.inject({
    method: 'POST',
    url: `/api/session-handoff/${proposalId}/approve`,
    headers: { 'x-cat-cafe-user': userId },
  });

export const rejectSessionHandoff = (app, proposalId, userId = 'user_1', body) =>
  app.inject({
    method: 'POST',
    url: `/api/session-handoff/${proposalId}/reject`,
    headers: { 'x-cat-cafe-user': userId },
    ...(body === undefined ? {} : { payload: body }),
  });
