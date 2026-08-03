import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApprovalIngress } from '../../dist/domains/approval-hub/ApprovalIngress.js';
import {
  ApprovalPublicationNotAnchoredError,
  requireAnchoredPublication,
} from '../../dist/domains/approval-hub/requireAnchoredPublication.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';

const ownerUserId = 'user-1';
const requesterCatId = 'codex-sol';
const originRef = { kind: 'message', threadId: 'source-thread', messageId: 'origin-message' };

class FakePublicationStore {
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

function appendOrigin(messageStore) {
  messageStore.append({
    userId: ownerUserId,
    catId: null,
    content: 'please propose this',
    mentions: [],
    timestamp: 1_721_111_110_000,
    threadId: originRef.threadId,
  });
  const stored = messageStore.getByThread(originRef.threadId, 1)[0];
  stored.id = originRef.messageId;
  return stored;
}

function makeDraft(overrides = {}) {
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

function makeHarness() {
  const messageStore = new MessageStore();
  appendOrigin(messageStore);
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

function findApprovalCard(messageStore) {
  const messages = messageStore.getByThread('source-thread', 100);
  return messages.find((message) => message.extra?.rich?.blocks.some((block) => block.id === 'proposal-proposal-1'));
}

describe('ApprovalIngress', () => {
  it('persists one card, commits its exact envelope, then broadcasts', async () => {
    const harness = makeHarness();
    const store = new FakePublicationStore();

    const envelope = await harness.ingress.publish(makeDraft(), store);

    assert.equal(envelope.approvalCardRef.threadId, 'source-thread');
    assert.equal(store.publication.state, 'anchored');
    assert.deepEqual(store.publication.envelope, envelope);
    assert.equal(harness.messageStore.getByThread('source-thread', 100).length, 2);
    assert.equal(harness.broadcasts.length, 1);
    assert.equal(harness.userEvents.length, 1);
  });

  it('aborts staged publication and emits nothing when card append fails', async () => {
    const harness = makeHarness();
    const store = new FakePublicationStore();
    const originalAppend = harness.messageStore.append.bind(harness.messageStore);
    harness.messageStore.append = (input) => {
      if (input.idempotencyKey) throw new Error('append unavailable');
      return originalAppend(input);
    };

    await assert.rejects(() => harness.ingress.publish(makeDraft(), store), /append unavailable/);
    assert.equal(store.publication.state, 'tombstoned');
    assert.equal(store.abortCalls.length, 1);
    assert.equal(harness.broadcasts.length, 0);
    assert.equal(harness.userEvents.length, 0);
  });

  it('recovers a persisted card after envelope commit failure without duplicating or broadcasting it twice', async () => {
    const harness = makeHarness();
    const store = new FakePublicationStore();
    store.failCommitOnce = true;
    await assert.rejects(() => harness.ingress.publish(makeDraft(), store), /commit unavailable/);
    assert.equal(harness.messageStore.getByThread('source-thread', 100).length, 2);
    assert.equal(store.publication.state, 'staged');
    assert.equal(harness.broadcasts.length, 0);

    const recovered = await harness.ingress.publish(makeDraft(), store);
    assert.equal(recovered.approvalCardRef.messageId, store.publication.envelope.approvalCardRef.messageId);
    assert.equal(harness.messageStore.getByThread('source-thread', 100).length, 2);
    assert.equal(harness.broadcasts.length, 1);
  });

  it('refuses to anchor a soft-deleted idempotent card recovered after commit failure', async () => {
    const harness = makeHarness();
    const store = new FakePublicationStore();
    store.failCommitOnce = true;

    await assert.rejects(() => harness.ingress.publish(makeDraft(), store), /commit unavailable/);
    const card = findApprovalCard(harness.messageStore);
    assert.ok(card);
    harness.messageStore.softDelete(card.id, ownerUserId);
    await assert.rejects(() => harness.ingress.publish(makeDraft(), store), /approval card is deleted/i);
    assert.equal(store.commitCalls, 1);
    assert.equal(store.publication.state, 'tombstoned');
    assert.equal(harness.broadcasts.length, 0);
    assert.equal(harness.userEvents.length, 0);
  });

  it('refuses to anchor a hard-deleted idempotent card recovered after commit failure', async () => {
    const harness = makeHarness();
    const store = new FakePublicationStore();
    store.failCommitOnce = true;
    await assert.rejects(() => harness.ingress.publish(makeDraft(), store), /commit unavailable/);
    const card = findApprovalCard(harness.messageStore);
    assert.ok(card);
    const tombstone = harness.messageStore.hardDelete(card.id, ownerUserId);
    assert.ok(tombstone?._tombstone);
    // Redis retains its idempotency index for hard-deleted message hashes; model that
    // store contract here so shared ingress must reject the returned tombstone.
    harness.messageStore.getByIdempotencyKey = () => tombstone;
    await assert.rejects(() => harness.ingress.publish(makeDraft(), store), /approval card is deleted/i);
    assert.equal(store.commitCalls, 1);
    assert.equal(store.publication.state, 'tombstoned');
    assert.equal(harness.broadcasts.length, 0);
    assert.equal(harness.userEvents.length, 0);
  });

  it('broadcasts after a successful commit without depending on a second publication read', async () => {
    const harness = makeHarness();
    const store = new FakePublicationStore();
    let reads = 0;
    store.getPublication = async () => {
      reads += 1;
      if (reads > 1) throw new Error('read-back unavailable');
      return store.publication;
    };

    const envelope = await harness.ingress.publish(makeDraft(), store);

    assert.equal(store.publication.state, 'anchored');
    assert.deepEqual(store.publication.envelope, envelope);
    assert.equal(reads, 1);
    assert.equal(harness.broadcasts.length, 1);
    assert.equal(harness.userEvents.length, 1);
  });

  it('repairs card and Hub fan-out when a retry finds an anchored publication', async () => {
    const harness = makeHarness();
    const store = new FakePublicationStore();
    const broadcastToRoom = harness.socketManager.broadcastToRoom;
    harness.socketManager.broadcastToRoom = () => {
      throw new Error('socket fan-out interrupted');
    };

    // R4 P1-2: Each fanout channel is independently isolated.
    // broadcastToRoom throws but emitToUser still succeeds.
    const firstResult = await harness.ingress.publish(makeDraft(), store);
    assert.ok(firstResult, 'publish must succeed despite fanout failure');
    assert.equal(store.publication.state, 'anchored');
    assert.equal(harness.messageStore.getByThread('source-thread', 100).length, 2);
    // broadcast failed, but emitToUser succeeded (independent channels)
    assert.equal(harness.broadcasts.length, 0, 'broadcast failed — 0 broadcasts');
    assert.equal(harness.userEvents.length, 1, 'emitToUser must succeed despite broadcast failure');

    // Fix broadcastToRoom and retry — replay path re-broadcasts
    harness.socketManager.broadcastToRoom = broadcastToRoom;
    const recovered = await harness.ingress.publish(makeDraft(), store);

    assert.deepEqual(recovered, store.publication.envelope);
    assert.equal(harness.messageStore.getByThread('source-thread', 100).length, 2);
    // Replay adds one more broadcast (total 1) and one more userEvent (total 2)
    assert.equal(harness.broadcasts.length, 1);
    assert.equal(harness.userEvents.length, 2);
    assert.deepEqual(harness.userEvents[0], [
      ownerUserId,
      'proposal_created',
      {
        proposalId: 'proposal-1',
        status: 'pending',
        sourceFeatureId: 'F128',
      },
    ]);
  });

  it('coalesces concurrent publishes to one card and envelope', async () => {
    const harness = makeHarness();
    const store = new FakePublicationStore();

    const [left, right] = await Promise.all([
      harness.ingress.publish(makeDraft(), store),
      harness.ingress.publish(makeDraft(), store),
    ]);

    assert.deepEqual(left, right);
    assert.equal(store.commitCalls, 1);
    assert.equal(harness.messageStore.getByThread('source-thread', 100).length, 2);
    assert.equal(harness.broadcasts.length, 1);
  });

  it('rejects an anchored retry whose canonical creation time changed', async () => {
    const harness = makeHarness();
    const store = new FakePublicationStore();
    await harness.ingress.publish(makeDraft(), store);

    await assert.rejects(
      () => harness.ingress.publish(makeDraft({ createdAt: 1_721_111_111_001 }), store),
      /conflicts with publish draft/,
    );
    assert.equal(harness.messageStore.getByThread('source-thread', 100).length, 2);
  });

  it('rejects message-policy, missing, cross-thread, and cross-owner origins before append', async () => {
    const harness = makeHarness();

    await assert.rejects(
      () =>
        harness.ingress.publish(
          makeDraft({ originRef: { kind: 'event', anchor: 'cron:1', summary: 'cron event' } }),
          new FakePublicationStore(),
        ),
      /requires a message origin/,
    );
    await assert.rejects(
      () =>
        harness.ingress.publish(
          makeDraft({ canonicalProposalId: 'proposal-2', originRef: { ...originRef, messageId: 'missing' } }),
          new FakePublicationStore(),
        ),
      /origin message not found/,
    );
    await assert.rejects(
      () =>
        harness.ingress.publish(
          makeDraft({ canonicalProposalId: 'proposal-3', originRef: { ...originRef, threadId: 'wrong-thread' } }),
          new FakePublicationStore(),
        ),
      /origin message thread mismatch/,
    );

    const otherOwnerOrigin = harness.messageStore.append({
      userId: 'user-2',
      catId: null,
      content: 'private',
      mentions: [],
      timestamp: 1_721_111_110_001,
      threadId: 'source-thread',
    });
    await assert.rejects(
      () =>
        harness.ingress.publish(
          makeDraft({
            canonicalProposalId: 'proposal-4',
            originRef: { kind: 'message', threadId: 'source-thread', messageId: otherOwnerOrigin.id },
          }),
          new FakePublicationStore(),
        ),
      /origin message owner mismatch/,
    );
    assert.equal(harness.messageStore.getByThread('source-thread', 100).length, 2);
  });

  it('allows a valid event origin only for a message-or-event producer', async () => {
    const harness = makeHarness();
    const store = new FakePublicationStore();
    const envelope = await harness.ingress.publish(
      makeDraft({
        producerId: 'F193',
        originRef: { kind: 'event', anchor: 'dispatch:request-1', summary: 'assign_work request' },
      }),
      store,
    );
    assert.equal(envelope.originRef.kind, 'event');
  });
});

describe('requireAnchoredPublication', () => {
  it('rejects staged and tombstoned records with a typed 409 before callers mutate business state', async () => {
    for (const publication of [
      { state: 'staged', stagedAt: 1 },
      { state: 'tombstoned', failedAt: 2, reason: 'append failed' },
    ]) {
      const store = { getPublication: async () => publication };
      await assert.rejects(
        () => requireAnchoredPublication(store, 'proposal-1'),
        (error) => error instanceof ApprovalPublicationNotAnchoredError && error.statusCode === 409,
      );
    }
  });

  it('accepts anchored and pre-Phase-I legacy records', async () => {
    const harness = makeHarness();
    const store = new FakePublicationStore();
    const envelope = await harness.ingress.publish(makeDraft(), store);
    assert.deepEqual(await requireAnchoredPublication(store, 'proposal-1'), envelope);
    assert.equal(await requireAnchoredPublication({ getPublication: async () => null }, 'legacy-1'), null);
  });
});
