import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { ApprovalIngress } from '../../dist/domains/approval-hub/ApprovalIngress.js';
import { InvocationRegistry } from '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { InMemoryTasteProposalStore } from '../../dist/domains/taste/stores/InMemoryTasteProposalStore.js';
import { sessionAuthPlugin, sessionRoute } from '../../dist/infrastructure/session-auth.js';
import { callbackProposeTasteRoutes } from '../../dist/routes/callback-propose-taste-routes.js';
import { registerTasteProposalDecisionRoutes } from '../../dist/routes/taste-proposal-decision-routes.js';
import { canonicalTestMessageInput } from './message-from-fixtures.js';

export const tasteDraft = {
  scene: 'Owner explained the design in this conversation',
  quote: 'Keep the useful distinction',
  takeaway: 'A tentative reusable preference',
  tags: ['clarity'],
  dimension: 'authentic-expression',
  privacy: 'sensitive',
  clientRequestId: 'taste-request',
};

/** Real callback auth, original proposal store and ApprovalIngress; no network or Redis. */
export async function tasteAdmissionFixture(options = {}) {
  const app = Fastify();
  const registry = new InvocationRegistry();
  const store = new InMemoryTasteProposalStore();
  const messages = new MessageStore();
  const socketManager = { emitToUser() {}, broadcastToRoom() {} };
  const ingress = new ApprovalIngress({ messageStore: messages, socketManager });
  if (options.writeVignette) {
    await app.register(cookie);
    await app.register(sessionAuthPlugin);
    await app.register(sessionRoute, { ownerUserId: 'alice' });
    registerTasteProposalDecisionRoutes(app, {
      tasteProposalStore: store,
      socketManager,
      messageStore: messages,
      writeVignette: options.writeVignette,
    });
  }
  await app.register(callbackProposeTasteRoutes, {
    registry,
    tasteProposalStore: store,
    messageStore: messages,
    socketManager,
    approvalIngress: ingress,
  });
  await app.ready();
  const source = (overrides = {}) =>
    messages.append(
      canonicalTestMessageInput({
        userId: 'alice',
        catId: null,
        threadId: 'thread_1',
        content: 'Please capture this preference',
        mentions: [],
        timestamp: Date.now(),
        ...overrides,
      }),
    );
  const auth = (origin, overrides = {}) =>
    registry.create(
      overrides.userId ?? 'alice',
      overrides.catId ?? 'opus',
      overrides.threadId ?? 'thread_1',
      undefined,
      undefined,
      undefined,
      origin?.id,
    );
  const post = (credential, payload = tasteDraft) =>
    app.inject({
      method: 'POST',
      url: '/api/callbacks/propose-taste',
      headers: { 'x-invocation-id': credential.invocationId, 'x-callback-token': credential.callbackToken },
      payload,
    });
  const propose = async (origin, payload = tasteDraft, overrides = {}) => post(await auth(origin, overrides), payload);
  return { app, registry, store, messages, ingress, source, auth, post, propose };
}
