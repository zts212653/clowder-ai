import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// ── R4 P1-2: Fanout channel isolation ─────────────────────────────────────
//
// R3 wrapped fanout in a single try/catch — broadcastToRoom throw blocked
// emitToUser from executing.  R4 isolates each channel independently.
//
// [宪宪/Claude Opus 4.6🐾]

describe('P1-2 R4: fanout channel isolation — one failure does not block the other', () => {
  it('broadcastToRoom throws → emitToUser still fires', async () => {
    const { ApprovalIngress } = await import('../../dist/domains/approval-hub/ApprovalIngress.js');
    const { InMemoryDispatchProposalStore } = await import(
      '../../dist/domains/approval-hub/stores/ports/IDispatchProposalStore.js'
    );
    const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const messageStore = new MessageStore();
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('user-1', 'Test');

    const userEvents = [];
    const ingress = new ApprovalIngress({
      messageStore,
      socketManager: {
        broadcastToRoom() {
          throw new Error('simulated broadcastToRoom failure');
        },
        emitToUser(...args) {
          userEvents.push(args);
        },
      },
    });

    const store = new InMemoryDispatchProposalStore();
    const { proposal } = await store.create({
      proposalId: 'dp-iso-1',
      sourceThreadId: thread.id,
      targetThreadId: 'target-1',
      senderCatId: 'opus',
      ownerUserId: 'user-1',
      content: 'Test',
      targetCats: ['sonnet'],
      createdAt: Date.now(),
    });

    await ingress.publish(
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

    assert.equal(userEvents.length, 1, 'emitToUser must fire even when broadcastToRoom throws');
    assert.equal(userEvents[0][1], 'proposal_created');
    assert.equal(userEvents[0][2].proposalId, proposal.proposalId);
  });

  it('emitToUser throws → broadcastToRoom still fires', async () => {
    const { ApprovalIngress } = await import('../../dist/domains/approval-hub/ApprovalIngress.js');
    const { InMemoryDispatchProposalStore } = await import(
      '../../dist/domains/approval-hub/stores/ports/IDispatchProposalStore.js'
    );
    const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const messageStore = new MessageStore();
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('user-1', 'Test');

    const broadcasts = [];
    const ingress = new ApprovalIngress({
      messageStore,
      socketManager: {
        broadcastToRoom(...args) {
          broadcasts.push(args);
        },
        emitToUser() {
          throw new Error('simulated emitToUser failure');
        },
      },
    });

    const store = new InMemoryDispatchProposalStore();
    const { proposal } = await store.create({
      proposalId: 'dp-iso-2',
      sourceThreadId: thread.id,
      targetThreadId: 'target-1',
      senderCatId: 'opus',
      ownerUserId: 'user-1',
      content: 'Test',
      targetCats: ['sonnet'],
      createdAt: Date.now(),
    });

    await ingress.publish(
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

    assert.equal(broadcasts.length, 1, 'broadcastToRoom must fire even when emitToUser throws');
  });
});
