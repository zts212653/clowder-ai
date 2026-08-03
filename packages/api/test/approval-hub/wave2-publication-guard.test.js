/**
 * F246 Phase I Wave 2: Publication guard integration tests.
 *
 * Proves that decision routes for F193/F260/F221 reject staged/tombstoned
 * proposals with 409 APPROVAL_PUBLICATION_NOT_ANCHORED, and accept anchored
 * proposals normally.
 *
 * RED snapshot: staged proposals created without ingress cannot be approved/rejected.
 * GREEN: after anchorApproval(), the normal CAS flow proceeds.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { anchorApproval } from './helpers.js';

// ── F193: Dispatch Proposal ──

describe('F193 dispatch proposal publication guard', () => {
  let InMemoryDispatchProposalStore;
  let dispatchProposalRoutes;
  let app;
  let store;

  beforeEach(async () => {
    ({ InMemoryDispatchProposalStore } = await import(
      '../../dist/domains/approval-hub/stores/ports/IDispatchProposalStore.js'
    ));
    ({ dispatchProposalRoutes } = await import('../../dist/routes/dispatch-proposal-routes.js'));

    store = new InMemoryDispatchProposalStore();
    app = Fastify();
    await app.register(dispatchProposalRoutes, {
      store,
      deliverMessage: async () => 'msg-delivered',
      notifyUpdate: () => {},
    });
    await app.ready();
  });

  afterEach(() => app?.close());

  const createProposal = async (id = 'dp-guard-1') => {
    const { proposal } = await store.create({
      proposalId: id,
      sourceThreadId: 'thread-1',
      targetThreadId: 'thread-2',
      senderCatId: 'opus',
      ownerUserId: 'user-1',
      content: 'Fix the bug',
      targetCats: ['sonnet'],
      createdAt: Date.now(),
    });
    return proposal;
  };

  it('approve rejects staged proposal with 409 APPROVAL_PUBLICATION_NOT_ANCHORED', async () => {
    await createProposal();
    const res = await app.inject({
      method: 'POST',
      url: '/api/dispatch-proposals/dp-guard-1/approve',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'APPROVAL_PUBLICATION_NOT_ANCHORED');
  });

  it('reject rejects staged proposal with 409 APPROVAL_PUBLICATION_NOT_ANCHORED', async () => {
    await createProposal();
    const res = await app.inject({
      method: 'POST',
      url: '/api/dispatch-proposals/dp-guard-1/reject',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'APPROVAL_PUBLICATION_NOT_ANCHORED');
  });

  it('approve succeeds after anchorApproval()', async () => {
    const proposal = await createProposal();
    await anchorApproval(store, {
      proposalId: proposal.proposalId,
      sourceFeatureId: 'F193',
      ownerUserId: proposal.ownerUserId,
      requesterCatId: proposal.senderCatId,
      threadId: proposal.sourceThreadId,
      createdAt: proposal.createdAt,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/dispatch-proposals/dp-guard-1/approve',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().proposal.status, 'approved');
  });

  it('reject succeeds after anchorApproval()', async () => {
    const proposal = await createProposal();
    await anchorApproval(store, {
      proposalId: proposal.proposalId,
      sourceFeatureId: 'F193',
      ownerUserId: proposal.ownerUserId,
      requesterCatId: proposal.senderCatId,
      threadId: proposal.sourceThreadId,
      createdAt: proposal.createdAt,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/dispatch-proposals/dp-guard-1/reject',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().proposal.status, 'rejected');
  });
});

// ── F260: Entity Proposal ──

describe('F260 entity proposal publication guard', () => {
  let InMemoryEntityProposalStore;
  let registerEntityProposalDecisionRoutes;
  let app;
  let store;

  beforeEach(async () => {
    ({ InMemoryEntityProposalStore } = await import(
      '../../dist/domains/approval-hub/stores/ports/IEntityProposalStore.js'
    ));
    ({ registerEntityProposalDecisionRoutes } = await import('../../dist/routes/entity-proposal-decision-routes.js'));
    store = new InMemoryEntityProposalStore();
    app = Fastify();
    registerEntityProposalDecisionRoutes(app, {
      store,
      upsertEntities: () => {},
      inspectEntityConflict: async () => null,
      resolveEntityConflict: async () => undefined,
      socketManager: { emitToUser: () => {} },
    });
    await app.ready();
  });

  afterEach(() => app?.close());

  const createProposal = (id = 'ep-guard-1') =>
    store.create({
      proposalId: id,
      entityId: 'concept:test',
      entityType: 'concept',
      canonicalName: 'Test',
      aliases: ['test-alias'],
      stance: 'endorsed',
      visibilityScope: 'workspace',
      provenance: [{ source: 'cat-proposed' }],
      rationale: 'Test',
      sourceThreadId: 'thread-1',
      sourceCatId: 'opus',
      ownerUserId: 'user-1',
    });

  it('approve rejects staged proposal with 409', async () => {
    createProposal();
    const res = await app.inject({
      method: 'POST',
      url: '/api/entity-proposals/ep-guard-1/approve',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'APPROVAL_PUBLICATION_NOT_ANCHORED');
  });

  it('reject rejects staged proposal with 409', async () => {
    createProposal();
    const res = await app.inject({
      method: 'POST',
      url: '/api/entity-proposals/ep-guard-1/reject',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'APPROVAL_PUBLICATION_NOT_ANCHORED');
  });

  it('approve succeeds after anchorApproval()', async () => {
    const proposal = createProposal();
    await anchorApproval(store, {
      proposalId: proposal.proposalId,
      sourceFeatureId: 'F260',
      ownerUserId: proposal.ownerUserId,
      requesterCatId: proposal.sourceCatId,
      threadId: proposal.sourceThreadId,
      createdAt: proposal.createdAt,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/entity-proposals/ep-guard-1/approve',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'approved');
  });

  it('reject succeeds after anchorApproval()', async () => {
    const proposal = createProposal();
    await anchorApproval(store, {
      proposalId: proposal.proposalId,
      sourceFeatureId: 'F260',
      ownerUserId: proposal.ownerUserId,
      requesterCatId: proposal.sourceCatId,
      threadId: proposal.sourceThreadId,
      createdAt: proposal.createdAt,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/entity-proposals/ep-guard-1/reject',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'rejected');
  });
});

// ── F221: Taste Proposal ──

describe('F221 taste proposal publication guard', () => {
  let InMemoryTasteProposalStore;
  let registerTasteProposalDecisionRoutes;
  let app;
  let store;

  beforeEach(async () => {
    ({ InMemoryTasteProposalStore } = await import('../../dist/domains/taste/stores/InMemoryTasteProposalStore.js'));
    ({ registerTasteProposalDecisionRoutes } = await import('../../dist/routes/taste-proposal-decision-routes.js'));
    store = new InMemoryTasteProposalStore();
    app = Fastify();
    registerTasteProposalDecisionRoutes(app, {
      tasteProposalStore: store,
      socketManager: { emitToUser: () => {} },
      writeVignette: async () => ({ slug: 'test-slug', path: 'test/path.md' }),
    });
    await app.ready();
  });

  afterEach(() => app?.close());

  const createProposal = () =>
    store.create({
      proposalId: 'tp-guard-1',
      userId: 'user-1',
      catId: 'opus',
      threadId: 'thread-1',
      scene: 'Test taste',
      quote: 'Quote text',
      tags: ['real'],
      dimension: 'authentic-expression',
      privacy: 'public',
    });

  it('approve rejects staged proposal with 409', async () => {
    createProposal();
    const res = await app.inject({
      method: 'POST',
      url: '/api/taste-proposals/tp-guard-1/approve',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'APPROVAL_PUBLICATION_NOT_ANCHORED');
  });

  it('reject rejects staged proposal with 409', async () => {
    createProposal();
    const res = await app.inject({
      method: 'POST',
      url: '/api/taste-proposals/tp-guard-1/reject',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { rejectionReason: 'test' },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'APPROVAL_PUBLICATION_NOT_ANCHORED');
  });

  it('approve succeeds after anchorApproval()', async () => {
    const proposal = createProposal();
    await anchorApproval(store, {
      proposalId: proposal.id,
      sourceFeatureId: 'F221',
      ownerUserId: proposal.userId,
      requesterCatId: proposal.catId,
      threadId: proposal.threadId,
      createdAt: proposal.createdAt,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/taste-proposals/${proposal.id}/approve`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'approved');
  });

  it('reject succeeds after anchorApproval()', async () => {
    const proposal = createProposal();
    await anchorApproval(store, {
      proposalId: proposal.id,
      sourceFeatureId: 'F221',
      ownerUserId: proposal.userId,
      requesterCatId: proposal.catId,
      threadId: proposal.threadId,
      createdAt: proposal.createdAt,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/taste-proposals/${proposal.id}/reject`,
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { rejectionReason: 'Not relevant' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'rejected');
  });
});
