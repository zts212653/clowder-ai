import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { proposedReviewAction } from './helpers.js';

// ── R2 P1-1: Commit-point-aware recovery ─────────────────────────────
// Uses REAL ApprovalIngress with a store where commitEnvelope fails AFTER
// card is persisted.  The catch blocks must distinguish card-append failure
// (abort OK) from commitEnvelope failure (keep staged + card for retry).
//
// RED snapshot: all tests FAIL because current catch blocks blanket-abort
// regardless of failure phase, deleting staged proposals that should be
// kept for recovery.
//
// [宪宪/Claude Opus 4.6🐾]

describe('P1-1 R2: commit-point recovery — card committed, commitEnvelope fails', () => {
  /** Build a Fastify app with REAL ApprovalIngress + a store where commitEnvelope throws. */
  async function buildAppWithCommitFailure() {
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

    // Patch commitEnvelope to fail — card is already appended at this point
    let commitCallCount = 0;
    const origCommit = store.commitEnvelope.bind(store);
    store.commitEnvelope = (...args) => {
      commitCallCount++;
      if (commitCallCount === 1) throw new Error('simulated commitEnvelope failure');
      return origCommit(...args);
    };

    const ingress = new ApprovalIngress({
      messageStore,
      socketManager: { broadcastToRoom() {}, emitToUser() {} },
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
    return { app, auth, sourceId: source.id, targetId: target.id, store, messageStore };
  }

  const createPayload = (targetId, clientMessageId = 'dispatch-commit-recovery') => ({
    threadId: targetId,
    content: '@sonnet\nPlease fix the bug',
    targetCats: ['sonnet'],
    effectClass: 'assign_work',
    proposedAction: proposedReviewAction(),
    clientMessageId,
  });

  it('F193: proposal stays staged (not deleted) after commitEnvelope failure', async () => {
    const { app, auth, targetId, store } = await buildAppWithCommitFailure();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
        payload: createPayload(targetId),
      });
      // Error must propagate (R1 fix — still works)
      assert.ok(res.statusCode >= 500, `Expected 5xx but got ${res.statusCode}`);

      // Key R2 assertion: proposal must NOT be deleted — it should stay in store
      // with staged publication, recoverable by idempotent retry.
      const all = await store.listPendingByUser('user-1');
      assert.ok(
        all.length > 0,
        'Proposal must survive commitEnvelope failure (staged + card for recovery). ' +
          'Current code deletes it via blanket abortStaged.',
      );
      const proposal = all[0];
      const pub = await store.getPublication(proposal.proposalId);
      assert.equal(pub?.state, 'staged', 'publication must remain staged for retry');
    } finally {
      await app.close();
    }
  });

  it('F193: superseded proposals NOT restored when card is committed', async () => {
    // A succeeds, then B fails at commitEnvelope.
    // B's card is persisted → B should NOT restore A (B is still viable for retry).
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

    // First commitEnvelope succeeds (A's publish), second fails (B's publish)
    let commitCount = 0;
    const origCommit = store.commitEnvelope.bind(store);
    store.commitEnvelope = (...args) => {
      commitCount++;
      if (commitCount === 2) throw new Error('simulated commitEnvelope failure for B');
      return origCommit(...args);
    };

    const ingress = new ApprovalIngress({
      messageStore,
      socketManager: { broadcastToRoom() {}, emitToUser() {} },
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
        payload: createPayload(target.id, 'dispatch-commit-a'),
      });
      assert.equal(r1.statusCode, 200, 'A must succeed');
      const proposalAId = r1.json().proposalId;

      // B fails at commitEnvelope (same lineage → supersedes A)
      const r2 = await app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
        payload: {
          ...createPayload(target.id, 'dispatch-commit-b'),
          content: '@sonnet\nUpdated dispatch',
        },
      });
      assert.ok(r2.statusCode >= 500, 'B must fail (commitEnvelope error)');

      // Key R2 assertion: A must remain superseded because B's card was committed.
      // B is still viable for retry — restoring A would create confusion.
      const aAfter = await store.get(proposalAId);
      assert.equal(
        aAfter?.status,
        'superseded',
        'A must stay superseded when B fails at commitEnvelope (card committed). ' +
          'Current code incorrectly restores A despite B being recoverable.',
      );
    } finally {
      await app.close();
    }
  });
});
