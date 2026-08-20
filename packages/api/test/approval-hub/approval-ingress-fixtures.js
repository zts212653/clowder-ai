import assert from 'node:assert/strict';
import { ApprovalIngress } from '../../dist/domains/approval-hub/ApprovalIngress.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';

export const ownerUserId = 'user-1';
const requesterCatId = 'codex-sol';
export const originRef = { kind: 'message', threadId: 'source-thread', messageId: 'origin-message' };

export class FakePublicationStore {
  publication = { state: 'staged', stagedAt: 1_721_111_111_000 };
  commitCalls = 0;
  abortCalls = [];
  failCommitOnce = false;

  async getPublication() {
    return this.publication;
  }

  async commitEnvelope(_proposalId, envelope) {
    this.commitCalls += 1;
    if (this.failCommitOnce) {
      this.failCommitOnce = false;
      throw new Error('commit unavailable');
    }
    if (this.publication?.state === 'anchored') {
      assert.deepEqual(this.publication.envelope, envelope);
      return;
    }
    assert.equal(this.publication?.state, 'staged');
    this.publication = { state: 'anchored', envelope };
  }

  async abortStaged(_proposalId, reason) {
    this.abortCalls.push(reason);
    this.publication = { state: 'tombstoned', failedAt: Date.now(), reason };
  }
}

function appendOrigin(messageStore, authorOverrides = {}) {
  messageStore.append({
    userId: ownerUserId,
    catId: null,
    content: 'please propose this',
    mentions: [],
    timestamp: 1_721_111_110_000,
    threadId: originRef.threadId,
    ...authorOverrides,
  });
  const stored = messageStore.getByThread(originRef.threadId, 1)[0];
  stored.id = originRef.messageId;
  return stored;
}

export function makeDraft(overrides = {}) {
  return {
    producerId: 'F128',
    canonicalProposalId: 'proposal-1',
    ownerUserId,
    requesterCatId,
    originRef,
    cardThreadId: 'source-thread',
    cardContent: 'approval requested',
    cardBlock: {
      id: 'proposal-proposal-1',
      kind: 'card',
      v: 1,
      title: 'Approve?',
      actions: [{ label: 'Approve', action: 'propose:approve', payload: { proposalId: 'proposal-1' } }],
    },
    createdAt: 1_721_111_111_000,
    ...overrides,
  };
}

export function makeHarness(originAuthorOverrides = {}) {
  const messageStore = new MessageStore();
  appendOrigin(messageStore, originAuthorOverrides);
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
    socketManager,
    ingress: new ApprovalIngress({ messageStore, socketManager }),
  };
}

export function findApprovalCard(messageStore) {
  const messages = messageStore.getByThread('source-thread', 100);
  return messages.find((message) => message.extra?.rich?.blocks.some((block) => block.id === 'proposal-proposal-1'));
}
