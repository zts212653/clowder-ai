import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

describe('Dispatch Proposal Routes', () => {
  let InMemoryDispatchProposalStore;
  let dispatchProposalRoutes;
  let app;
  let store;
  /** @type {Array<{proposal: import('@cat-cafe/shared').DispatchProposal}>} */
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
    const deliverMessage = async (proposal) => {
      const messageId = `msg-${proposal.proposalId}-${Date.now()}`;
      deliveredMessages.push({ proposal, messageId });
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
    return store.create({
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

    // deliveredMessageId must be the real one from delivery, not a placeholder
    const body = res.json();
    assert.equal(body.proposal.deliveredMessageId, delivered.messageId);
    assert.ok(
      !body.proposal.deliveredMessageId.startsWith('delivered-'),
      'deliveredMessageId must not be a placeholder string',
    );
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

    await failStore.create({
      proposalId: 'dp-fail',
      sourceThreadId: 'thread-sender',
      targetThreadId: 'thread-target',
      senderCatId: 'opus',
      ownerUserId: 'user-1',
      content: 'Test delivery failure',
      targetCats: ['sonnet'],
      createdAt: Date.now(),
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
});
