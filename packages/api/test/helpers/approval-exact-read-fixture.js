import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import './setup-cat-registry.js';
import { ApprovalDecisionReceiptOutbox } from '../../dist/domains/approval-hub/ApprovalDecisionReceiptOutbox.js';
import { ApprovalDecisionReceiptService } from '../../dist/domains/approval-hub/ApprovalDecisionReceiptService.js';
import {
  ApprovalProducerRegistry,
  bindLegacyApprovalProducer,
  bindV1ApprovalProducer,
} from '../../dist/domains/approval-hub/ApprovalProducerRegistry.js';
import { InvocationQueue } from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { callbacksRoutes } from '../../dist/routes/callbacks.js';

export const OWNER = 'receipt-read-owner';

/** Actual publisher, stores and callback authentication; only the settled producer is controlled. */
export async function createReceiptReadFixture(t, { omitThreadStore = false } = {}) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const messages = new MessageStore();
  const threads = new ThreadStore();
  const thread = threads.create(OWNER, 'Neutral approval source');
  const callerThread = threads.create(OWNER, 'Neutral exact-read caller');
  const invocations = new InvocationRegistry();
  const queue = new InvocationQueue();
  const outbox = new ApprovalDecisionReceiptOutbox(db);
  const decisions = new Map();
  let decisionReads = 0;
  let adoptions = 0;
  const bindings = Object.fromEntries(
    ['F128', 'F139', 'F266'].map((id) => [
      id,
      (id === 'F266' ? bindV1ApprovalProducer : bindLegacyApprovalProducer)({
        featureId: id,
        listPending: () => [],
        listSettled: () => [],
        readDecision: async (user, proposal) => {
          decisionReads++;
          return decisions.get(`${user}:${proposal}`) ?? { state: 'closed' };
        },
      }),
    ]),
  );
  const warnings = [];
  const publisher = new ApprovalDecisionReceiptService({
    registry: new ApprovalProducerRegistry(bindings),
    messageStore: messages,
    outbox,
    logger: { warn: (...args) => warnings.push(args) },
  });
  const app = Fastify();
  t.after(() => app.close());
  await app.register(callbacksRoutes, {
    registry: invocations,
    messageStore: messages,
    ...(omitThreadStore ? {} : { threadStore: threads }),
    invocationQueue: queue,
    queueProcessor: {
      adoptExposedQueuedEntries: async () => {
        adoptions++;
        return { outcome: 'rejected', reason: 'fixture-not-executable' };
      },
    },
    socketManager: { broadcastAgentMessage() {}, getMessages: () => [] },
    evidenceStore: {
      search: async () => [],
      health: async () => true,
      initialize: async () => {},
      upsert: async () => {},
      deleteByAnchor: async () => {},
      getByAnchor: async () => null,
    },
    reflectionService: { reflect: async () => '' },
    markerQueue: { submit: async () => ({}), list: async () => [], transition: async () => {} },
  });
  const invocation = await invocations.create(OWNER, 'opus', callerThread.id);
  const headers = { 'x-invocation-id': invocation.invocationId, 'x-callback-token': invocation.callbackToken };

  async function publish(producerId = 'F128', resolution = 'accepted', targetThread = thread) {
    const proposal = `neutral-${producerId}-${resolution}-${decisions.size}`;
    decisions.set(`${OWNER}:${proposal}`, {
      state: 'decided',
      item: {
        ownerUserId: OWNER,
        sourceFeatureId: producerId,
        proposalId: proposal,
        status: resolution === 'accepted' ? 'approved' : 'rejected',
        requesterCatId: 'opus',
        decidedAt: 1234,
        decidedBy: OWNER,
        detail: { rejectionReason: 'Neutral rejection' },
        navigation: { state: 'anchored', approvalCardRef: { threadId: targetThread.id, messageId: 'neutral-card' } },
      },
    });
    const subject = { ownerUserId: OWNER, producerId, canonicalProposalId: proposal };
    publisher.prepare(subject);
    assert.equal(await publisher.deliver(subject), true);
    assert.deepEqual(warnings, []);
    const message = (await messages.getByThread(targetThread.id, 100, OWNER)).find(
      (m) => m.source?.meta?.approvalDecisionReceipt?.canonicalProposalId === proposal,
    );
    assert.ok(message, 'the real publisher committed its owner-scoped Host receipt');
    return message;
  }

  const read = (message, mode = 'full', options = {}) =>
    app.inject({
      method: 'GET',
      url: `/api/callbacks/get-message?messageId=${message.id}&mode=${mode}`,
      headers,
      ...options,
    });
  return {
    app,
    messages,
    threads,
    thread,
    invocations,
    outbox,
    headers,
    publish,
    read,
    decisionReads: () => decisionReads,
    adoptions: () => adoptions,
  };
}
