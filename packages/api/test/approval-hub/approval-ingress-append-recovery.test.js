import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApprovalCardCommittedError, ApprovalIngress } from '../../dist/domains/approval-hub/ApprovalIngress.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';

const ownerUserId = 'user-1';
const requesterCatId = 'codex-sol';
const originRef = { kind: 'message', threadId: 'source-thread', messageId: 'origin-message' };

class FakePublicationStore {
  publication = { state: 'staged', stagedAt: 1_721_111_111_000 };
  commitCalls = 0;
  abortCalls = [];
  failCommit = false;

  async getPublication() {
    return this.publication;
  }

  async commitEnvelope(_proposalId, envelope) {
    this.commitCalls += 1;
    if (this.failCommit) throw new Error('commit unavailable');
    this.publication = { state: 'anchored', envelope };
  }

  async abortStaged(_proposalId, reason) {
    this.abortCalls.push(reason);
    this.publication = { state: 'tombstoned', failedAt: Date.now(), reason };
  }
}

function makeHarness() {
  const messageStore = new MessageStore();
  const origin = messageStore.append({
    userId: ownerUserId,
    catId: null,
    content: 'origin',
    mentions: [],
    timestamp: 1_721_111_110_000,
    threadId: originRef.threadId,
  });
  origin.id = originRef.messageId;
  const broadcasts = [];
  const userEvents = [];
  const socketManager = {
    broadcastToRoom: (...args) => broadcasts.push(args),
    emitToUser: (...args) => userEvents.push(args),
  };
  return {
    messageStore,
    broadcasts,
    userEvents,
    ingress: new ApprovalIngress({ messageStore, socketManager }),
  };
}

function makeDraft() {
  return {
    producerId: 'F260',
    canonicalProposalId: 'entity-proposal-1',
    ownerUserId,
    requesterCatId,
    originRef,
    cardThreadId: 'source-thread',
    cardContent: 'approval requested',
    cardBlock: {
      id: 'approval-card-entity-proposal-1',
      kind: 'card',
      v: 1,
      title: 'Approve?',
      actions: [{ label: 'Approve', action: 'propose:approve', payload: { proposalId: 'entity-proposal-1' } }],
    },
    createdAt: 1_721_111_111_000,
  };
}

describe('ApprovalIngress append acknowledgement recovery', () => {
  it('commits a card that was persisted before messageStore.append lost its acknowledgement', async () => {
    const harness = makeHarness();
    const store = new FakePublicationStore();
    const originalAppend = harness.messageStore.append.bind(harness.messageStore);
    let failedCardId = null;

    harness.messageStore.append = (input) => {
      if (input.idempotencyKey) {
        const stored = originalAppend(input);
        failedCardId = stored.id;
        throw new Error('append acknowledgement lost');
      }
      return originalAppend(input);
    };

    const envelope = await harness.ingress.publish(makeDraft(), store);

    assert.equal(envelope.approvalCardRef.messageId, failedCardId);
    assert.equal(store.publication.state, 'anchored');
    assert.equal(store.abortCalls.length, 0, 'persisted cards must not be classified as pre-card failures');
    assert.equal(harness.messageStore.getByThread('source-thread', 100, ownerUserId).length, 2);
    assert.equal(harness.broadcasts.length, 1);
    assert.equal(harness.userEvents.length, 1);
  });

  it('surfaces a committed-card error if envelope commit fails after append acknowledgement loss', async () => {
    const harness = makeHarness();
    const store = new FakePublicationStore();
    store.failCommit = true;
    const originalAppend = harness.messageStore.append.bind(harness.messageStore);

    harness.messageStore.append = (input) => {
      if (input.idempotencyKey) {
        originalAppend(input);
        throw new Error('append acknowledgement lost');
      }
      return originalAppend(input);
    };

    await assert.rejects(() => harness.ingress.publish(makeDraft(), store), ApprovalCardCommittedError);
    assert.equal(store.publication.state, 'staged');
    assert.equal(store.abortCalls.length, 0);
    assert.equal(harness.messageStore.getByThread('source-thread', 100, ownerUserId).length, 2);
  });
});
