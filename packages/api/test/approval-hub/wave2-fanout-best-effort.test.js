import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { proposedReviewAction } from './helpers.js';

// ── R3 P1-2: Fanout best-effort — broadcastToRoom/emitToUser errors swallowed ──
// Envelope is committed → fanout is fire-and-forget.  If broadcastToRoom or
// emitToUser throws, it must NOT escape to caller catch blocks that would
// misclassify it as pre-card failure and run compensation on an anchored proposal.
//
// RED snapshot: tests FAIL because current code has no try/catch around
// fanOutAnchoredPublication — synchronous throws propagate through publishOnce.
//
// [宪宪/Claude Opus 4.6🐾]

describe('P1-2 R3: fanout best-effort — post-commit errors do not trigger compensation', () => {
  it('broadcastToRoom throws → publish still succeeds (ingress level)', async () => {
    const { ApprovalIngress } = await import('../../dist/domains/approval-hub/ApprovalIngress.js');
    const { InMemoryDispatchProposalStore } = await import(
      '../../dist/domains/approval-hub/stores/ports/IDispatchProposalStore.js'
    );
    const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const messageStore = new MessageStore();
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('user-1', 'Test');

    const ingress = new ApprovalIngress({
      messageStore,
      socketManager: {
        broadcastToRoom() {
          throw new Error('simulated broadcastToRoom failure');
        },
        emitToUser() {},
      },
    });

    const store = new InMemoryDispatchProposalStore();
    const { proposal } = await store.create({
      proposalId: 'dp-fanout-1',
      sourceThreadId: thread.id,
      targetThreadId: 'target-1',
      senderCatId: 'opus',
      ownerUserId: 'user-1',
      content: 'Test',
      targetCats: ['sonnet'],
      createdAt: Date.now(),
    });

    // publish must succeed — broadcastToRoom throw is swallowed
    const envelope = await ingress.publish(
      {
        producerId: 'F193',
        canonicalProposalId: proposal.proposalId,
        ownerUserId: proposal.ownerUserId,
        requesterCatId: 'opus',
        originRef: { kind: 'event', anchor: 'test', summary: 'test', threadId: thread.id },
        cardThreadId: thread.id,
        cardContent: 'Test card',
        cardBlock: {
          id: `approval:F193:${proposal.proposalId}`,
          kind: 'card',
          v: 1,
          title: 'Test',
          bodyMarkdown: '',
          tone: 'info',
          fields: [],
        },
        createdAt: proposal.createdAt,
      },
      store,
    );
    assert.ok(envelope, 'publish must return envelope despite broadcastToRoom failure');
    assert.equal(envelope.canonicalProposalId, proposal.proposalId);

    const pub = await store.getPublication(proposal.proposalId);
    assert.equal(pub?.state, 'anchored', 'publication must be anchored despite fanout failure');
  });

  it('emitToUser throws → publish still succeeds (ingress level)', async () => {
    const { ApprovalIngress } = await import('../../dist/domains/approval-hub/ApprovalIngress.js');
    const { InMemoryDispatchProposalStore } = await import(
      '../../dist/domains/approval-hub/stores/ports/IDispatchProposalStore.js'
    );
    const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const messageStore = new MessageStore();
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('user-1', 'Test');

    const ingress = new ApprovalIngress({
      messageStore,
      socketManager: {
        broadcastToRoom() {},
        emitToUser() {
          throw new Error('simulated emitToUser failure');
        },
      },
    });

    const store = new InMemoryDispatchProposalStore();
    const { proposal } = await store.create({
      proposalId: 'dp-fanout-2',
      sourceThreadId: thread.id,
      targetThreadId: 'target-1',
      senderCatId: 'opus',
      ownerUserId: 'user-1',
      content: 'Test',
      targetCats: ['sonnet'],
      createdAt: Date.now(),
    });

    const envelope = await ingress.publish(
      {
        producerId: 'F193',
        canonicalProposalId: proposal.proposalId,
        ownerUserId: proposal.ownerUserId,
        requesterCatId: 'opus',
        originRef: { kind: 'event', anchor: 'test', summary: 'test', threadId: thread.id },
        cardThreadId: thread.id,
        cardContent: 'Test card',
        cardBlock: {
          id: `approval:F193:${proposal.proposalId}`,
          kind: 'card',
          v: 1,
          title: 'Test',
          bodyMarkdown: '',
          tone: 'info',
          fields: [],
        },
        createdAt: proposal.createdAt,
      },
      store,
    );
    assert.ok(envelope, 'publish must return envelope despite emitToUser failure');

    const pub = await store.getPublication(proposal.proposalId);
    assert.equal(pub?.state, 'anchored', 'publication must be anchored despite fanout failure');
  });

  it('F193: fanout failure does NOT restore superseded (caller compensation blocked)', async () => {
    // A succeeds. B supersedes A, commitEnvelope succeeds, but emitToUser throws.
    // Without best-effort wrapping, caller catch would misclassify as pre-card
    // failure and restore A → double pending.
    const { ApprovalIngress } = await import('../../dist/domains/approval-hub/ApprovalIngress.js');
    const { InvocationRegistry } = await import(
      '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { InMemoryDispatchProposalStore: Store } = await import(
      '../../dist/domains/approval-hub/stores/ports/IDispatchProposalStore.js'
    );
    const { callbacksRoutes } = await import('../../dist/routes/callbacks.js');

    const registry = new InvocationRegistry();
    const messageStore = new MessageStore();
    const threadStore = new ThreadStore();

    const source = await threadStore.create('user-1', 'Source');
    const target = await threadStore.create('user-1', 'Target');
    await threadStore.addParticipants(source.id, ['opus']);
    await threadStore.addParticipants(target.id, ['sonnet']);

    const store = new Store();
    let publishCount = 0;

    // emitToUser throws on second publish (B's fanout)
    const ingress = new ApprovalIngress({
      messageStore,
      socketManager: {
        broadcastToRoom() {},
        emitToUser() {
          publishCount++;
          if (publishCount > 1) throw new Error('simulated emitToUser failure on B');
        },
      },
    });

    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      threadStore,
      socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
      router: {
        async *routeExecution() {
          yield* [];
        },
        getExecutions: () => [],
      },
      invocationRecordStore: {
        create: () => ({ outcome: 'created', invocationId: 'inv-0' }),
        update() {},
        get: () => null,
      },
      dispatchProposalStore: store,
      approvalIngress: ingress,
    });
    await app.ready();
    const auth = await registry.create('user-1', 'opus', source.id);

    try {
      // A succeeds
      const r1 = await app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
        payload: {
          threadId: target.id,
          content: '@sonnet\nOriginal dispatch',
          targetCats: ['sonnet'],
          effectClass: 'assign_work',
          proposedAction: proposedReviewAction(),
          clientMessageId: 'dispatch-fanout-a',
        },
      });
      assert.equal(r1.statusCode, 200, 'A must succeed');
      const proposalAId = r1.json().proposalId;

      // B: same lineage, supersedes A. emitToUser throws on fanout.
      const r2 = await app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
        payload: {
          threadId: target.id,
          content: '@sonnet\nUpdated dispatch',
          targetCats: ['sonnet'],
          effectClass: 'assign_work',
          proposedAction: proposedReviewAction(),
          clientMessageId: 'dispatch-fanout-b',
        },
      });
      // B must succeed (fanout error swallowed)
      assert.equal(r2.statusCode, 200, 'B must succeed — fanout error is best-effort');

      // A must remain superseded (NOT restored)
      const aAfter = await store.get(proposalAId);
      assert.equal(
        aAfter?.status,
        'superseded',
        'A must remain superseded — fanout failure must NOT trigger compensation that restores A. ' +
          'Without best-effort wrapping, caller catch misclassifies post-commit throw as pre-card failure.',
      );

      // B must be anchored
      const bId = r2.json().proposalId;
      const bPub = await store.getPublication(bId);
      assert.equal(bPub?.state, 'anchored', 'B must be anchored despite fanout failure');
    } finally {
      await app.close();
    }
  });
});
