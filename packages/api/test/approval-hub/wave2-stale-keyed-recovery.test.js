import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { proposedReviewAction } from './helpers.js';

describe('Wave 2 stale keyed recovery', () => {
  it('F193 rejects the replaced attempt while a newer attempt can recover its staged dispatch proposal', async () => {
    const { ApprovalIngress } = await import('../../dist/domains/approval-hub/ApprovalIngress.js');
    const { InvocationRegistry } = await import(
      '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { InMemoryDispatchProposalStore } = await import(
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

    const store = new InMemoryDispatchProposalStore();
    let commitCount = 0;
    const originalCommit = store.commitEnvelope.bind(store);
    store.commitEnvelope = (...args) => {
      commitCount++;
      if (commitCount === 1) throw new Error('simulated commitEnvelope failure');
      return originalCommit(...args);
    };

    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      threadStore,
      socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
      router: { async *routeExecution() {}, getExecutions: () => [] },
      invocationRecordStore: { create: () => ({ outcome: 'created' }), update() {}, get: () => null },
      dispatchProposalStore: store,
      approvalIngress: new ApprovalIngress({
        messageStore,
        socketManager: { broadcastToRoom() {}, emitToUser() {} },
      }),
    });
    await app.ready();

    const staleAuth = await registry.create('user-1', 'opus', source.id);
    const payload = {
      threadId: target.id,
      content: '@sonnet\nPlease recover this staged dispatch proposal',
      targetCats: ['sonnet'],
      effectClass: 'assign_work',
      proposedAction: proposedReviewAction(),
      clientMessageId: 'dispatch-stale-keyed-recovery',
    };

    try {
      const first = await app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers: { 'x-invocation-id': staleAuth.invocationId, 'x-callback-token': staleAuth.callbackToken },
        payload,
      });
      assert.ok(first.statusCode >= 500, 'first attempt must retain a staged proposal after commit failure');

      const [stagedProposal] = await store.listPendingByUser('user-1');
      assert.ok(stagedProposal, 'first attempt must leave a recoverable staged proposal');
      assert.equal((await store.getPublication(stagedProposal.proposalId))?.state, 'staged');

      const replacementAuth = await registry.create('user-1', 'opus', source.id);

      const replacedRetry = await app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers: { 'x-invocation-id': staleAuth.invocationId, 'x-callback-token': staleAuth.callbackToken },
        payload,
      });

      assert.equal(replacedRetry.statusCode, 401);
      assert.equal(replacedRetry.json().reason, 'replaced');
      assert.equal((await store.getPublication(stagedProposal.proposalId))?.state, 'staged');

      const retry = await app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers: {
          'x-invocation-id': replacementAuth.invocationId,
          'x-callback-token': replacementAuth.callbackToken,
        },
        payload,
      });

      assert.equal(retry.statusCode, 200);
      assert.equal(retry.json().status, 'proposal_recovered');
      assert.equal(retry.json().proposalId, stagedProposal.proposalId);
      assert.equal((await store.getPublication(stagedProposal.proposalId))?.state, 'anchored');
    } finally {
      await app.close();
    }
  });

  it('F221 rejects the replaced attempt while a newer attempt can recover its staged taste proposal', async () => {
    const { ApprovalIngress } = await import('../../dist/domains/approval-hub/ApprovalIngress.js');
    const { InvocationRegistry } = await import(
      '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { InMemoryTasteProposalStore } = await import(
      '../../dist/domains/taste/stores/InMemoryTasteProposalStore.js'
    );
    const { callbackProposeTasteRoutes } = await import('../../dist/routes/callback-propose-taste-routes.js');

    const registry = new InvocationRegistry();
    const messageStore = new MessageStore();
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('user-1', 'Taste');
    const store = new InMemoryTasteProposalStore();
    let commitCount = 0;
    const originalCommit = store.commitEnvelope.bind(store);
    store.commitEnvelope = (...args) => {
      commitCount++;
      if (commitCount === 1) throw new Error('simulated commitEnvelope failure');
      return originalCommit(...args);
    };

    const app = Fastify();
    await app.register(callbackProposeTasteRoutes, {
      registry,
      tasteProposalStore: store,
      socketManager: { emitToUser() {}, broadcastToRoom() {} },
      approvalIngress: new ApprovalIngress({
        messageStore,
        socketManager: { broadcastToRoom() {}, emitToUser() {} },
      }),
    });
    await app.ready();

    const staleAuth = await registry.create('user-1', 'opus', thread.id);
    const payload = {
      scene: 'Stale keyed retry',
      quote: 'Outbox replay must recover the retained staged proposal',
      tags: ['cognitive-honesty'],
      dimension: 'cognitive-honesty',
      privacy: 'public',
      clientRequestId: 'taste-stale-keyed-recovery',
    };

    try {
      const first = await app.inject({
        method: 'POST',
        url: '/api/callbacks/propose-taste',
        headers: { 'x-invocation-id': staleAuth.invocationId, 'x-callback-token': staleAuth.callbackToken },
        payload,
      });
      assert.ok(first.statusCode >= 500, 'first attempt must retain a staged proposal after commit failure');

      const [stagedProposal] = await store.listPending('user-1');
      assert.ok(stagedProposal, 'first attempt must leave a recoverable staged proposal');
      assert.equal((await store.getPublication(stagedProposal.id))?.state, 'staged');

      const replacementAuth = await registry.create('user-1', 'opus', thread.id);

      const replacedRetry = await app.inject({
        method: 'POST',
        url: '/api/callbacks/propose-taste',
        headers: { 'x-invocation-id': staleAuth.invocationId, 'x-callback-token': staleAuth.callbackToken },
        payload,
      });

      assert.equal(replacedRetry.statusCode, 401);
      assert.equal(replacedRetry.json().reason, 'replaced');
      assert.equal((await store.getPublication(stagedProposal.id))?.state, 'staged');

      const retry = await app.inject({
        method: 'POST',
        url: '/api/callbacks/propose-taste',
        headers: {
          'x-invocation-id': replacementAuth.invocationId,
          'x-callback-token': replacementAuth.callbackToken,
        },
        payload,
      });

      assert.equal(retry.statusCode, 200);
      assert.equal(retry.json().recovered, true);
      assert.equal(retry.json().proposalId, stagedProposal.id);
      assert.equal((await store.getPublication(stagedProposal.id))?.state, 'anchored');
    } finally {
      await app.close();
    }
  });
});
