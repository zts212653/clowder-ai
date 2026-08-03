import assert from 'node:assert/strict';
import test from 'node:test';

import Fastify from 'fastify';

import { InMemoryDispatchProposalStore } from '../../dist/domains/approval-hub/stores/ports/IDispatchProposalStore.js';
import { dispatchProposalRoutes } from '../../dist/routes/dispatch-proposal-routes.js';
import { anchorApproval } from './helpers.js';

const OWNER_ID = 'owner-1';
const TARGET_THREAD_ID = 'thread-target';

function createApp(store, deliveries, overrides = {}) {
  const app = Fastify();
  const actionLease = {
    leaseId: 'lease-action-001',
    generation: 1,
    dispatchId: 'approval:dp-action-001',
    terminalPredicate: { digest: 'predicate-digest' },
  };
  const actionFence = {
    leaseId: actionLease.leaseId,
    generation: actionLease.generation,
    dispatchId: actionLease.dispatchId,
    terminalPredicateDigest: actionLease.terminalPredicate.digest,
    invocationLineageRef: `dispatch:${actionLease.dispatchId}`,
  };

  app.register(dispatchProposalRoutes, {
    store,
    approveAction: async (proposal, userId, ownerAuthProvenance) => {
      const approved = await store.approve(proposal.proposalId, userId, ownerAuthProvenance);
      const actionLeaseRef = {
        ...actionFence,
        terminalPredicateDigest: actionFence.terminalPredicateDigest,
      };
      return {
        approved: true,
        value: {
          proposal: { ...approved, actionLeaseRef },
          actionLease,
          actionFence,
          outcome: 'claimed',
        },
      };
    },
    recoverApprovedAction: async () => {
      const ownerAuthProvenance = await store.getApprovalOwnerAuthProvenance('dp-action-001');
      deliveries.push({ actionFence, ownerAuthProvenance });
      await store.recordDelivery('dp-action-001', 'msg:dp-action-001');
      return { outcome: 'delivered', deliveredMessageId: 'msg:dp-action-001' };
    },
    deliverMessage: async (proposal) => {
      return `msg:${proposal.proposalId}`;
    },
    notifyUpdate: () => {},
    ...overrides,
  });

  return app;
}

async function createActionProposal(store, overrides = {}) {
  const { proposal } = await store.create({
    proposalId: 'dp-action-001',
    sourceThreadId: 'thread-source',
    content: 'Please review PR #42.',
    targetCats: ['reviewer'],
    targetThreadId: TARGET_THREAD_ID,
    senderCatId: 'author',
    ownerUserId: OWNER_ID,
    createdAt: Date.now(),
    proposedAction: {
      subjectRef: 'pr:cat-cafe/cat-cafe#42',
      actionFamily: 'review',
      successorSlot: 'reviewer',
      mode: 'single',
      terminalPredicate: {
        kind: 'review_delivered',
        headSha: 'a'.repeat(40),
      },
    },
    ...overrides,
  });
  await anchorApproval(store, {
    proposalId: proposal.proposalId,
    sourceFeatureId: 'F193',
    ownerUserId: proposal.ownerUserId,
    requesterCatId: proposal.senderCatId,
    threadId: proposal.sourceThreadId,
    createdAt: proposal.createdAt,
  });
  return proposal;
}

test('approve returns the promoted action lease and uses the same fence for delivery', async (t) => {
  const store = new InMemoryDispatchProposalStore();
  const deliveries = [];
  const app = createApp(store, deliveries);
  t.after(() => app.close());
  const proposal = await createActionProposal(store);

  const response = await app.inject({
    method: 'POST',
    url: `/api/dispatch-proposals/${proposal.proposalId}/approve`,
    headers: { 'x-cat-cafe-user': OWNER_ID },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.proposal.status, 'approved');
  assert.ok(body.actionLease, 'approved proposal must have an active action lease');
  assert.ok(body.actionFence, 'approved proposal must expose the dispatch fence');
  assert.equal(body.proposal.actionLeaseRef.leaseId, body.actionLease.leaseId);
  assert.equal(body.proposal.actionLeaseRef.generation, body.actionLease.generation);
  assert.equal(deliveries.length, 1);
  assert.deepEqual(deliveries[0].actionFence, body.actionFence);
  assert.equal(deliveries[0].ownerAuthProvenance, 'strict');
});

test('trusted-browser action approval persists compatibility provenance for recovery', async (t) => {
  const store = new InMemoryDispatchProposalStore();
  const deliveries = [];
  const app = createApp(store, deliveries);
  t.after(() => app.close());
  const proposal = await createActionProposal(store, { ownerUserId: 'default-user' });

  const response = await app.inject({
    method: 'POST',
    url: `/api/dispatch-proposals/${proposal.proposalId}/approve`,
    headers: { origin: 'http://localhost:3003' },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].ownerAuthProvenance, 'compatibility_fallback');
});

test('lease-claim failure keeps proposal pending and produces no target delivery', async (t) => {
  const store = new InMemoryDispatchProposalStore();
  const deliveries = [];
  const app = createApp(store, deliveries, {
    approveAction: async () => {
      throw new Error('fault: lease claim');
    },
    recoverApprovedAction: async () => {
      deliveries.push('unexpected');
      return { outcome: 'pending' };
    },
  });
  t.after(() => app.close());
  const proposal = await createActionProposal(store);

  const response = await app.inject({
    method: 'POST',
    url: `/api/dispatch-proposals/${proposal.proposalId}/approve`,
    headers: { 'x-cat-cafe-user': OWNER_ID },
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().code, 'ACTION_LEASE_CLAIM_FAILED');
  assert.equal((await store.get(proposal.proposalId)).status, 'pending');
  assert.deepEqual(deliveries, []);
});

test('reject creates no lease and no target delivery', async (t) => {
  const store = new InMemoryDispatchProposalStore();
  const deliveries = [];
  let approvalCalls = 0;
  const app = createApp(store, deliveries, {
    approveAction: async () => {
      approvalCalls += 1;
      throw new Error('must not run');
    },
  });
  t.after(() => app.close());
  const proposal = await createActionProposal(store);

  const response = await app.inject({
    method: 'POST',
    url: `/api/dispatch-proposals/${proposal.proposalId}/reject`,
    headers: { 'x-cat-cafe-user': OWNER_ID },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().proposal.status, 'rejected');
  assert.equal(approvalCalls, 0);
  assert.deepEqual(deliveries, []);
});
