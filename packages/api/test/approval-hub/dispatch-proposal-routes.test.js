import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { anchorApproval } from './helpers.js';

describe('Dispatch Proposal Routes', () => {
  let InMemoryDispatchProposalStore;
  let dispatchProposalRoutes;
  let app;
  let store;
  /** @type {Array<{proposal: import('@cat-cafe/shared').DispatchProposal, ownerAuthProvenance: string}>} */
  let deliveredMessages;
  /** @type {Array<{proposalId: string, status: string, userId: string}>} */
  let emittedEvents;

  beforeEach(async () => {
    ({ InMemoryDispatchProposalStore } = await import(
      '../../dist/domains/approval-hub/stores/ports/IDispatchProposalStore.js'
    ));
    ({ dispatchProposalRoutes } = await import('../../dist/routes/dispatch-proposal-routes.js'));

    store = new InMemoryDispatchProposalStore();
    app = Fastify();
    deliveredMessages = [];
    emittedEvents = [];

    // Mock delivery callback: records what was delivered, returns a fake messageId
    const deliverMessage = async (proposal, ownerAuthProvenance) => {
      const messageId = `msg-${proposal.proposalId}-${Date.now()}`;
      deliveredMessages.push({ proposal, ownerAuthProvenance, messageId });
      return messageId;
    };

    // Mock notify callback: records emitted events
    const notifyUpdate = (proposal) => {
      emittedEvents.push({
        proposalId: proposal.proposalId,
        status: proposal.status,
        userId: proposal.ownerUserId,
      });
    };

    await app.register(dispatchProposalRoutes, { store, deliverMessage, notifyUpdate });
    await app.ready();
  });

  const createProposal = async (overrides = {}) => {
    const result = await store.create({
      proposalId: 'dp-001',
      sourceThreadId: 'thread-sender',
      targetThreadId: 'thread-target',
      senderCatId: 'opus',
      ownerUserId: 'user-1',
      content: 'Fix the bug in package X',
      targetCats: ['sonnet'],
      createdAt: Date.now(),
      ...overrides,
    });
    // F246 Phase I: anchor publication so decision guards pass.
    await anchorApproval(store, {
      proposalId: result.proposal.proposalId,
      sourceFeatureId: 'F193',
      ownerUserId: result.proposal.ownerUserId,
      requesterCatId: result.proposal.senderCatId,
      threadId: result.proposal.sourceThreadId,
      createdAt: result.proposal.createdAt,
    });
    return result.proposal;
  };

  // --- Approve ---

  it('POST /approve: pending → approved', async () => {
    await createProposal();
    const res = await app.inject({
      method: 'POST',
      url: '/api/dispatch-proposals/dp-001/approve',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.proposal.status, 'approved');
    assert.equal(body.proposal.decidedBy, 'user-1');
    assert.ok(body.proposal.decidedAt > 0);
  });

  it('POST /approve: delivers held message to target thread (P1-1 fix)', async () => {
    await createProposal();
    const res = await app.inject({
      method: 'POST',
      url: '/api/dispatch-proposals/dp-001/approve',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    // deliverMessage callback must have been called exactly once
    assert.equal(deliveredMessages.length, 1, 'deliverMessage must be called on approve');
    const delivered = deliveredMessages[0];
    assert.equal(delivered.proposal.targetThreadId, 'thread-target');
    assert.equal(delivered.proposal.content, 'Fix the bug in package X');
    assert.deepEqual(delivered.proposal.targetCats, ['sonnet']);
    assert.equal(delivered.ownerAuthProvenance, 'strict');

    // deliveredMessageId must be the real one from delivery, not a placeholder
    const body = res.json();
    assert.equal(body.proposal.deliveredMessageId, delivered.messageId);
    assert.ok(
      !body.proposal.deliveredMessageId.startsWith('delivered-'),
      'deliveredMessageId must not be a placeholder string',
    );
  });

  it('POST /approve: trusted-browser compatibility identity remains non-strict during delivery', async () => {
    await createProposal({ proposalId: 'dp-compat', ownerUserId: 'default-user' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/dispatch-proposals/dp-compat/approve',
      headers: { origin: 'http://localhost:3003' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(deliveredMessages.length, 1);
    assert.equal(deliveredMessages[0].ownerAuthProvenance, 'compatibility_fallback');
  });

  it('POST /approve: emits proposal_updated socket event (P1-1 audit fix)', async () => {
    await createProposal();
    await app.inject({
      method: 'POST',
      url: '/api/dispatch-proposals/dp-001/approve',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(emittedEvents.length, 1, 'must emit proposal_updated on approve');
    assert.equal(emittedEvents[0].proposalId, 'dp-001');
    assert.equal(emittedEvents[0].status, 'approved');
    assert.equal(emittedEvents[0].userId, 'user-1');
  });

  it('POST /approve: wrong userId → 403', async () => {
    await createProposal();
    const res = await app.inject({
      method: 'POST',
      url: '/api/dispatch-proposals/dp-001/approve',
      headers: { 'x-cat-cafe-user': 'wrong-user' },
    });

    assert.equal(res.statusCode, 403);
    // Must NOT deliver message on auth failure
    assert.equal(deliveredMessages.length, 0);
  });

  it('POST /approve: no userId → 401', async () => {
    await createProposal();
    const res = await app.inject({
      method: 'POST',
      url: '/api/dispatch-proposals/dp-001/approve',
    });

    assert.equal(res.statusCode, 401);
  });

  it('POST /approve: nonexistent proposal → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/dispatch-proposals/nonexistent/approve',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 404);
  });

  it('POST /approve: already approved → 409', async () => {
    await createProposal();
    // First approve
    await app.inject({
      method: 'POST',
      url: '/api/dispatch-proposals/dp-001/approve',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    // Second approve
    const res = await app.inject({
      method: 'POST',
      url: '/api/dispatch-proposals/dp-001/approve',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 409);
  });

  it('POST /approve: CAS-first — no delivery when proposal already decided (R2 P1-2 fix)', async () => {
    await createProposal();
    // Reject first — CAS transition to terminal state
    await app.inject({
      method: 'POST',
      url: '/api/dispatch-proposals/dp-001/reject',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    deliveredMessages.length = 0; // reset

    // Now try approve — CAS should fail BEFORE delivery
    const res = await app.inject({
      method: 'POST',
      url: '/api/dispatch-proposals/dp-001/approve',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 409);
    // Critical assertion: deliverMessage must NOT have been called
    assert.equal(deliveredMessages.length, 0, 'rejected proposal must not trigger delivery (CAS-first ordering)');
  });

  it('POST /approve: recordDelivery persists messageId after CAS (R2 P1-2 fix)', async () => {
    await createProposal();
    const res = await app.inject({
      method: 'POST',
      url: '/api/dispatch-proposals/dp-001/approve',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    // deliveredMessageId must be present in response (recorded via recordDelivery)
    assert.ok(body.proposal.deliveredMessageId, 'deliveredMessageId must be set after approve + delivery');
    // Verify it matches what deliverMessage returned
    assert.equal(body.proposal.deliveredMessageId, deliveredMessages[0].messageId);
  });

  it('POST /approve: delivery failure reverts to pending (Cloud P1-2 fix)', async () => {
    // Set up a FAILING deliverMessage
    const failApp = Fastify();
    const failStore = new InMemoryDispatchProposalStore();
    const failDeliverMessage = async () => {
      throw new Error('Transient delivery failure');
    };
    const failNotifyUpdate = () => {};
    await failApp.register(dispatchProposalRoutes, {
      store: failStore,
      deliverMessage: failDeliverMessage,
      notifyUpdate: failNotifyUpdate,
    });
    await failApp.ready();

    const { proposal: failProposal } = await failStore.create({
      proposalId: 'dp-fail',
      sourceThreadId: 'thread-sender',
      targetThreadId: 'thread-target',
      senderCatId: 'opus',
      ownerUserId: 'user-1',
      content: 'Test delivery failure',
      targetCats: ['sonnet'],
      createdAt: Date.now(),
    });
    await anchorApproval(failStore, {
      proposalId: failProposal.proposalId,
      sourceFeatureId: 'F193',
      ownerUserId: failProposal.ownerUserId,
      requesterCatId: failProposal.senderCatId,
      threadId: failProposal.sourceThreadId,
      createdAt: failProposal.createdAt,
    });

    const res = await failApp.inject({
      method: 'POST',
      url: '/api/dispatch-proposals/dp-fail/approve',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    // Should get 502 (delivery failed)
    assert.equal(res.statusCode, 502);
    const body = res.json();
    assert.ok(body.error.includes('reverted'), 'error must mention revert');

    // Proposal must be back to pending — user can retry
    const proposal = await failStore.get('dp-fail');
    assert.equal(proposal.status, 'pending', 'proposal must revert to pending after delivery failure');
    assert.equal(proposal.decidedAt, undefined, 'decidedAt must be cleared');
    assert.equal(proposal.decidedBy, undefined, 'decidedBy must be cleared');
    assert.equal(
      await failStore.getApprovalOwnerAuthProvenance('dp-fail'),
      undefined,
      'private approval provenance must be cleared with rollback',
    );

    // Must still appear in pending list
    const pending = await failStore.listPendingByUser('user-1');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].proposalId, 'dp-fail');

    await failApp.close();
  });

  // --- Reject ---

  it('POST /reject: pending → rejected', async () => {
    await createProposal();
    const res = await app.inject({
      method: 'POST',
      url: '/api/dispatch-proposals/dp-001/reject',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.proposal.status, 'rejected');
    assert.equal(body.proposal.decidedBy, 'user-1');
    // Must NOT deliver message on reject
    assert.equal(deliveredMessages.length, 0);
  });

  it('POST /reject: emits proposal_updated socket event (P1-1 audit fix)', async () => {
    await createProposal();
    await app.inject({
      method: 'POST',
      url: '/api/dispatch-proposals/dp-001/reject',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(emittedEvents.length, 1, 'must emit proposal_updated on reject');
    assert.equal(emittedEvents[0].proposalId, 'dp-001');
    assert.equal(emittedEvents[0].status, 'rejected');
  });

  it('POST /reject: wrong userId → 403', async () => {
    await createProposal();
    const res = await app.inject({
      method: 'POST',
      url: '/api/dispatch-proposals/dp-001/reject',
      headers: { 'x-cat-cafe-user': 'wrong-user' },
    });

    assert.equal(res.statusCode, 403);
  });

  it('POST /reject: already rejected → 409', async () => {
    await createProposal();
    await app.inject({
      method: 'POST',
      url: '/api/dispatch-proposals/dp-001/reject',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/dispatch-proposals/dp-001/reject',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 409);
  });

  // === F246 Phase J: Superseded proposals (AC-J4, INV-J6) ===

  it('POST /approve: superseded proposal → 409 with supersededBy (INV-J6)', async () => {
    // Create first, then create same-K to supersede it
    await createProposal({ proposalId: 'dp-old' });
    await createProposal({ proposalId: 'dp-new' });

    // Old proposal is now superseded — approve must fail with specific error
    const res = await app.inject({
      method: 'POST',
      url: '/api/dispatch-proposals/dp-old/approve',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 409);
    const body = res.json();
    assert.equal(body.code, 'PROPOSAL_SUPERSEDED');
    assert.equal(body.supersededBy, 'dp-new');
    assert.ok(body.error.includes('superseded'));
    // Must NOT deliver message for superseded proposal
    assert.equal(deliveredMessages.length, 0);
  });

  it('POST /reject: superseded proposal → 409 with supersededBy (INV-J6)', async () => {
    await createProposal({ proposalId: 'dp-old' });
    await createProposal({ proposalId: 'dp-new' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/dispatch-proposals/dp-old/reject',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 409);
    const body = res.json();
    assert.equal(body.code, 'PROPOSAL_SUPERSEDED');
    assert.equal(body.supersededBy, 'dp-new');
  });

  // === F246 Phase J: Legacy 409 guard (AC-J8) ===

  it('POST /approve: legacy proposal in required rollout → 409 (AC-J8)', async () => {
    // Set up app with rollout=required
    const requiredApp = Fastify();
    const requiredStore = new InMemoryDispatchProposalStore();
    await requiredApp.register(dispatchProposalRoutes, {
      store: requiredStore,
      deliverMessage: async (p) => `msg-${p.proposalId}`,
      notifyUpdate: () => {},
      rolloutState: 'required',
    });
    await requiredApp.ready();

    await requiredStore.create({
      proposalId: 'dp-legacy',
      sourceThreadId: 'thread-sender',
      targetThreadId: 'thread-target',
      senderCatId: 'opus',
      ownerUserId: 'user-1',
      content: 'Legacy proposal without envelope',
      targetCats: ['sonnet'],
      createdAt: Date.now(),
    });

    const res = await requiredApp.inject({
      method: 'POST',
      url: '/api/dispatch-proposals/dp-legacy/approve',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 409);
    const body = res.json();
    assert.equal(body.code, 'LEGACY_PROPOSAL_NOT_APPROVABLE');
    assert.ok(body.error.includes('reject'));
    assert.ok(body.error.includes('re-attest') || body.error.includes('resubmit'));
    // Must NOT deliver
    await requiredApp.close();
  });

  it('POST /approve: legacy proposal in shadow rollout → 200 (backward compat)', async () => {
    // Default rollout is shadow — legacy proposals can still be approved
    await createProposal({ proposalId: 'dp-legacy-shadow' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/dispatch-proposals/dp-legacy-shadow/approve',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().proposal.status, 'approved');
  });

  it('POST /reject: legacy proposal in required rollout → 200 (reject always allowed, KD-17)', async () => {
    // Even in required mode, legacy proposals CAN be rejected (re-attest path)
    const requiredApp = Fastify();
    const requiredStore = new InMemoryDispatchProposalStore();
    await requiredApp.register(dispatchProposalRoutes, {
      store: requiredStore,
      deliverMessage: async (p) => `msg-${p.proposalId}`,
      notifyUpdate: () => {},
      rolloutState: 'required',
    });
    await requiredApp.ready();

    const { proposal: legacyRejectProposal } = await requiredStore.create({
      proposalId: 'dp-legacy-reject',
      sourceThreadId: 'thread-sender',
      targetThreadId: 'thread-target',
      senderCatId: 'opus',
      ownerUserId: 'user-1',
      content: 'Legacy proposal',
      targetCats: ['sonnet'],
      createdAt: Date.now(),
    });
    await anchorApproval(requiredStore, {
      proposalId: legacyRejectProposal.proposalId,
      sourceFeatureId: 'F193',
      ownerUserId: legacyRejectProposal.ownerUserId,
      requesterCatId: legacyRejectProposal.senderCatId,
      threadId: legacyRejectProposal.sourceThreadId,
      createdAt: legacyRejectProposal.createdAt,
    });

    const res = await requiredApp.inject({
      method: 'POST',
      url: '/api/dispatch-proposals/dp-legacy-reject/reject',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().proposal.status, 'rejected');
    await requiredApp.close();
  });

  // === Phase J: superseded-on-revert during delivery failure (Sol R3 #2) ===

  it('POST /approve: delivery fails + successor created mid-flight → 409 PROPOSAL_SUPERSEDED', async () => {
    // Scenario: A is pending, user approves A, CAS succeeds, but during delivery
    // a successor B is created (same K, lineage moves). Delivery then throws.
    // revertToPending(A) detects lineage points to B → A becomes superseded → 409.
    const failApp = Fastify();
    const failStore = new InMemoryDispatchProposalStore();

    const deliverMessage = async (_proposal) => {
      // Mid-delivery: a successor proposal arrives via another concurrent request
      await failStore.create({
        proposalId: 'dp-successor-b',
        sourceThreadId: 'thread-sender',
        targetThreadId: 'thread-target',
        senderCatId: 'opus',
        ownerUserId: 'user-1',
        content: 'Successor proposal',
        targetCats: ['sonnet'],
        createdAt: Date.now() + 1000,
      });
      throw new Error('Delivery failed (simulated)');
    };

    await failApp.register(dispatchProposalRoutes, {
      store: failStore,
      deliverMessage,
      notifyUpdate: () => {},
    });
    await failApp.ready();

    // Create the original proposal A
    const { proposal: originalA } = await failStore.create({
      proposalId: 'dp-original-a',
      sourceThreadId: 'thread-sender',
      targetThreadId: 'thread-target',
      senderCatId: 'opus',
      ownerUserId: 'user-1',
      content: 'Original proposal',
      targetCats: ['sonnet'],
      createdAt: Date.now(),
    });
    await anchorApproval(failStore, {
      proposalId: originalA.proposalId,
      sourceFeatureId: 'F193',
      ownerUserId: originalA.ownerUserId,
      requesterCatId: originalA.senderCatId,
      threadId: originalA.sourceThreadId,
      createdAt: originalA.createdAt,
    });

    // Approve A — CAS succeeds, delivery creates successor then throws
    const res = await failApp.inject({
      method: 'POST',
      url: '/api/dispatch-proposals/dp-original-a/approve',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    // A should be 409 PROPOSAL_SUPERSEDED (not 502 retryable)
    assert.equal(res.statusCode, 409);
    const body = res.json();
    assert.equal(body.code, 'PROPOSAL_SUPERSEDED');
    assert.ok(body.error.includes('superseded'));

    // Verify: A is superseded in store
    const a = await failStore.get('dp-original-a');
    assert.equal(a.status, 'superseded');

    // Verify: B is still pending
    const pending = await failStore.listPendingByUser('user-1');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].proposalId, 'dp-successor-b');

    await failApp.close();
  });
});
