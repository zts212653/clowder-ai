import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { proposedReviewAction } from './helpers.js';

// ── R3 P1-1: Retry recovery — staged proposal retries commitEnvelope ──────
// First request: card persisted, commitEnvelope fails → proposal staged.
// Second request (same dedup key): detects staged state, retries publish() →
// ingress finds existing card, commitEnvelope succeeds → proposal anchored.
// No new card, no new proposal, same canonicalProposalId.
//
// RED snapshot: tests FAIL because current dedup checks return proposal_exists
// without checking publication state — retry never reaches publish().
//
// [宪宪/Claude Opus 4.6🐾]

describe('P1-1 R3: retry recovery — commitEnvelope failure, then successful retry', () => {
  it('F193: retry anchors same proposal, no duplicate card', async () => {
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
    let commitCount = 0;
    const origCommit = store.commitEnvelope.bind(store);
    store.commitEnvelope = (...args) => {
      commitCount++;
      if (commitCount === 1) throw new Error('simulated commitEnvelope failure');
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

    const payload = {
      threadId: target.id,
      content: '@sonnet\nPlease fix the bug',
      targetCats: ['sonnet'],
      effectClass: 'assign_work',
      proposedAction: proposedReviewAction(),
      clientMessageId: 'retry-test-f193',
    };

    try {
      // First call: commitEnvelope fails after card persisted
      const r1 = await app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
        payload,
      });
      assert.ok(r1.statusCode >= 500, 'first call must fail');
      const proposals = await store.listPendingByUser('user-1');
      const stagedProposal = proposals[0];
      assert.ok(stagedProposal, 'proposal must exist after first call');
      const pubBefore = await store.getPublication(stagedProposal.proposalId);
      assert.equal(pubBefore?.state, 'staged', 'proposal must be staged after first call');

      // Count cards before retry
      const cardsBefore = await messageStore.getByThread(source.id, 100, 'user-1');
      const cardCountBefore = cardsBefore.length;

      // Second call: same clientMessageId → detects staged, retries publish
      const r2 = await app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
        payload,
      });
      assert.equal(r2.statusCode, 200, 'retry must succeed');
      const body = r2.json();
      assert.equal(body.proposalId, stagedProposal.proposalId, 'must use same proposalId');
      assert.equal(body.status, 'proposal_recovered', 'must indicate recovery');

      // Publication must be anchored
      const pubAfter = await store.getPublication(stagedProposal.proposalId);
      assert.equal(pubAfter?.state, 'anchored', 'proposal must be anchored after retry');

      // No duplicate card
      const cardsAfter = await messageStore.getByThread(source.id, 100, 'user-1');
      assert.equal(cardsAfter.length, cardCountBefore, 'retry must not create duplicate card');

      // commitEnvelope called exactly twice (first fail + second succeed)
      assert.equal(commitCount, 2, 'commitEnvelope must be called exactly twice');
    } finally {
      await app.close();
    }
  });

  it('F221: retry anchors same taste proposal, no duplicate card', async () => {
    const { ApprovalIngress } = await import('../../dist/domains/approval-hub/ApprovalIngress.js');
    const { InMemoryTasteProposalStore } = await import(
      '../../dist/domains/taste/stores/InMemoryTasteProposalStore.js'
    );
    const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { callbackProposeTasteRoutes } = await import('../../dist/routes/callback-propose-taste-routes.js');
    const { InvocationRegistry } = await import(
      '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    const messageStore = new MessageStore();
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('user-1', 'Taste');
    const tasteStore = new InMemoryTasteProposalStore();

    let commitCount = 0;
    const origCommit = tasteStore.commitEnvelope.bind(tasteStore);
    tasteStore.commitEnvelope = (...args) => {
      commitCount++;
      if (commitCount === 1) throw new Error('simulated commitEnvelope failure');
      return origCommit(...args);
    };

    const ingress = new ApprovalIngress({
      messageStore,
      socketManager: { broadcastToRoom() {}, emitToUser() {} },
    });

    const app = Fastify();
    app.addHook('preHandler', (request, _reply, done) => {
      request.callbackAuth = {
        invocationId: 'inv-taste-retry',
        callbackToken: 'tok',
        catId: 'opus',
        threadId: thread.id,
        userId: 'user-1',
        clientMessageIds: new Set(),
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
      };
      done();
    });
    await app.register(callbackProposeTasteRoutes, {
      registry: { ...registry, isLatest: async () => true },
      tasteProposalStore: tasteStore,
      socketManager: { emitToUser() {} },
      approvalIngress: ingress,
    });
    await app.ready();

    const payload = {
      scene: 'operator said "太客服了"',
      quote: '太客服了，我要的是活人感',
      tags: ['authentic-expression'],
      dimension: 'authentic-expression',
      privacy: 'public',
      clientRequestId: 'taste-retry-test',
    };

    try {
      // First call: commitEnvelope fails
      const r1 = await app.inject({ method: 'POST', url: '/api/callbacks/propose-taste', payload });
      assert.ok(r1.statusCode >= 500, 'first call must fail');

      // Find the staged proposal
      const all = await tasteStore.listPending('user-1');
      assert.equal(all.length, 1, 'one proposal must exist');
      const proposalId = all[0].id;
      const pubBefore = await tasteStore.getPublication(proposalId);
      assert.equal(pubBefore?.state, 'staged', 'proposal must be staged');

      // Count cards before retry
      const cardsBefore = await messageStore.getByThread(thread.id, 100, 'user-1');
      const cardCountBefore = cardsBefore.length;

      // Second call: same clientRequestId → recovery
      const r2 = await app.inject({ method: 'POST', url: '/api/callbacks/propose-taste', payload });
      assert.equal(r2.statusCode, 200, 'retry must succeed');
      const body = r2.json();
      assert.equal(body.proposalId, proposalId, 'must use same proposalId');
      assert.equal(body.recovered, true, 'must indicate recovery');

      // Publication must be anchored
      const pubAfter = await tasteStore.getPublication(proposalId);
      assert.equal(pubAfter?.state, 'anchored', 'proposal must be anchored after retry');

      // No duplicate card
      const cardsAfter = await messageStore.getByThread(thread.id, 100, 'user-1');
      assert.equal(cardsAfter.length, cardCountBefore, 'retry must not create duplicate card');
    } finally {
      await app.close();
    }
  });

  it('F260: retry anchors same entity proposal, no duplicate card', async () => {
    const { ApprovalIngress } = await import('../../dist/domains/approval-hub/ApprovalIngress.js');
    const { InMemoryEntityProposalStore } = await import(
      '../../dist/domains/approval-hub/stores/ports/IEntityProposalStore.js'
    );
    const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { callbackProposeEntityRoutes } = await import('../../dist/routes/callback-propose-entity-routes.js');

    const messageStore = new MessageStore();
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('user-1', 'Entity');
    const entityStore = new InMemoryEntityProposalStore();

    let commitCount = 0;
    const origCommit = entityStore.commitEnvelope.bind(entityStore);
    entityStore.commitEnvelope = (...args) => {
      commitCount++;
      if (commitCount === 1) throw new Error('simulated commitEnvelope failure');
      return origCommit(...args);
    };

    const ingress = new ApprovalIngress({
      messageStore,
      socketManager: { broadcastToRoom() {}, emitToUser() {} },
    });

    const app = Fastify();
    app.addHook('preHandler', (request, _reply, done) => {
      request.callbackAuth = {
        invocationId: 'inv-entity-retry',
        callbackToken: 'tok',
        catId: 'opus',
        threadId: thread.id,
        userId: 'user-1',
        clientMessageIds: new Set(),
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
      };
      done();
    });
    await app.register(callbackProposeEntityRoutes, {
      registry: { isLatest: async () => true },
      entityProposalStore: entityStore,
      socketManager: { emitToUser() {} },
      approvalIngress: ingress,
    });
    await app.ready();

    const payload = {
      entityId: 'concept:retry-test',
      entityType: 'concept',
      canonicalName: 'Retry Test',
      aliases: ['retry-test'],
      stance: 'endorsed',
      visibilityScope: 'workspace',
      provenance: [{ source: 'test' }],
      rationale: 'Testing retry recovery',
      clientRequestId: 'cr-entity-retry-1', // R4: explicit dedup key required
    };

    try {
      // First call: commitEnvelope fails (ApprovalCardCommittedError keeps dedup + staged)
      const r1 = await app.inject({ method: 'POST', url: '/api/callbacks/propose-entity', payload });
      assert.ok(r1.statusCode >= 500, 'first call must fail');

      // Find the staged proposal via dedup key
      const proposalId = entityStore.getDedupProposalId('user-1', 'cr-entity-retry-1');
      assert.ok(proposalId, 'dedup key must be preserved after card-committed failure');
      const pubBefore = await entityStore.getPublication(proposalId);
      assert.equal(pubBefore?.state, 'staged', 'proposal must be staged');

      // Count cards before retry
      const cardsBefore = await messageStore.getByThread(thread.id, 100, 'user-1');
      const cardCountBefore = cardsBefore.length;

      // Second call: same clientRequestId → detects staged, retries publish
      const r2 = await app.inject({ method: 'POST', url: '/api/callbacks/propose-entity', payload });
      assert.equal(r2.statusCode, 200, 'retry must succeed');
      const body = r2.json();
      assert.equal(body.proposalId, proposalId, 'must use same proposalId');
      assert.equal(body.recovered, true, 'must indicate recovery');

      // Publication must be anchored
      const pubAfter = await entityStore.getPublication(proposalId);
      assert.equal(pubAfter?.state, 'anchored', 'proposal must be anchored after retry');

      // No duplicate card
      const cardsAfter = await messageStore.getByThread(thread.id, 100, 'user-1');
      assert.equal(cardsAfter.length, cardCountBefore, 'retry must not create duplicate card');
    } finally {
      await app.close();
    }
  });
});
