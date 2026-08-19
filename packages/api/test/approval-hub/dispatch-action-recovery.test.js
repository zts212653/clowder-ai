import assert from 'node:assert/strict';
import { test } from 'node:test';

const lease = {
  leaseId: 'lease-action-1',
  key: 'user-1\u001fpr:owner/repo#42\u001freview\u001freviewer',
  tenantScope: 'user-1',
  subjectRef: 'pr:owner/repo#42',
  actionFamily: 'review',
  successorSlot: 'reviewer',
  mode: 'single',
  holderCatIds: ['codex-terra'],
  dispatchId: 'approval:dp-action-1',
  claimOrigin: 'structured_transfer',
  holderThreadId: 'thread-target',
  predecessorCatId: 'codex-sol',
  predecessorThreadId: 'thread-source',
  issuerStandingEvidenceRef: 'approval:dp-action-1',
  generation: 1,
  status: 'active',
  holderOutcomes: {},
  completionCandidates: {},
  evidenceRefs: ['approval:dp-action-1'],
  terminalPredicateState: { kind: 'predicate_backed' },
  terminalPredicate: { digest: 'predicate-digest' },
  returnTransitions: [],
  dispatchDeliveryState: 'pending',
  dispatchDeliveryAttemptCount: 0,
  revision: 1,
  createdAt: 1_000,
  updatedAt: 1_000,
};

const proposal = {
  proposalId: 'dp-action-1',
  sourceThreadId: 'thread-source',
  targetThreadId: 'thread-target',
  senderCatId: 'codex-sol',
  ownerUserId: 'user-1',
  effectClass: 'assign_work',
  content: 'Review exact HEAD.',
  targetCats: ['codex-terra'],
  proposedAction: {
    subjectRef: 'pr:owner/repo#42',
    actionFamily: 'review',
    successorSlot: 'reviewer',
    mode: 'single',
    terminalPredicate: { kind: 'review_delivered', headSha: 'a'.repeat(40) },
  },
  envelopeDigest: 'sha256:proposal',
  status: 'approved',
  actionLeaseRef: {
    leaseId: lease.leaseId,
    generation: lease.generation,
    dispatchId: lease.dispatchId,
    terminalPredicateDigest: lease.terminalPredicate.digest,
  },
  createdAt: 900,
};

test('message append and enqueue faults retry one exact fenced carrier without forging started', async () => {
  const { ActionSuccessorRecoverySweep } = await import(
    '../../dist/domains/ball-custody/ActionSuccessorRecoverySweep.js'
  );
  let current = structuredClone(lease);
  const deliveries = [];
  const recordedMessages = [];
  const outcomes = [new Error('fault: message append'), { outcome: 'unavailable' }, { outcome: 'enqueued' }];
  const sweep = new ActionSuccessorRecoverySweep({
    leaseStore: {
      async listPendingReturns() {
        return [];
      },
      async recordReturnDeliveryAttempt() {
        throw new Error('not used');
      },
      async markReturnDelivered() {
        throw new Error('not used');
      },
    },
    async deliverReturnCarrier() {
      return { outcome: 'unavailable' };
    },
    dispatch: {
      leaseStore: {
        async listPendingDispatches() {
          return current.dispatchDeliveryState === 'pending' ? [current] : [];
        },
        async recordDispatchDeliveryAttempt(id, input) {
          assert.equal(id, current.leaseId);
          assert.equal(input.expectedGeneration, current.generation);
          if (current.dispatchDeliveryState !== 'pending') {
            return { outcome: 'dispatch_not_pending', lease: current };
          }
          current = {
            ...current,
            dispatchDeliveryAttemptCount: current.dispatchDeliveryAttemptCount + 1,
            dispatchDeliveryLastAttemptAt: input.now,
            revision: current.revision + 1,
            updatedAt: input.now,
          };
          return { outcome: 'recorded', lease: current };
        },
        async markDispatchDelivered(id, input) {
          assert.equal(id, current.leaseId);
          current = {
            ...current,
            dispatchDeliveryState: 'delivered',
            dispatchDeliveredMessageId: input.deliveredMessageId,
            revision: current.revision + 1,
            updatedAt: input.now,
          };
          return { outcome: 'delivered', lease: current };
        },
      },
      async loadProposal() {
        return proposal;
      },
      async loadOwnerAuthProvenance() {
        return 'strict';
      },
      async recordProposalDelivery(proposalId, deliveredMessageId) {
        recordedMessages.push({ proposalId, deliveredMessageId });
      },
      async deliver(_proposal, fence, ownerAuthProvenance) {
        deliveries.push({ fence, ownerAuthProvenance });
        const outcome = outcomes.shift();
        if (outcome instanceof Error) throw outcome;
        if (outcome.outcome === 'unavailable') return outcome;
        return { outcome: 'enqueued', deliveredMessageId: 'msg-action-1' };
      },
    },
    now: () => 2_000,
  });

  assert.deepEqual(await sweep.runDispatchesOnce(), { scanned: 1, delivered: 0, pending: 1 });
  assert.equal(current.dispatchDeliveryState, 'pending');
  assert.equal(recordedMessages.length, 0);

  assert.deepEqual(await sweep.runDispatchesOnce(), { scanned: 1, delivered: 0, pending: 1 });
  assert.equal(current.dispatchDeliveryState, 'pending');
  assert.equal(recordedMessages.length, 0);

  assert.deepEqual(await sweep.runDispatchesOnce(), { scanned: 1, delivered: 1, pending: 0 });
  assert.equal(current.dispatchDeliveryState, 'delivered');
  assert.equal(current.dispatchDeliveryAttemptCount, 3);
  assert.equal(recordedMessages.length, 1);
  assert.equal(deliveries.length, 3);
  assert.deepEqual(deliveries[0], deliveries[1]);
  assert.deepEqual(deliveries[1], deliveries[2]);
  assert.deepEqual(deliveries[2], {
    ownerAuthProvenance: 'strict',
    fence: {
      leaseId: lease.leaseId,
      generation: 1,
      dispatchId: lease.dispatchId,
      terminalPredicateDigest: lease.terminalPredicate.digest,
      invocationLineageRef: `dispatch:${lease.dispatchId}`,
    },
  });
});

test('persisted proposal receipt is reused after lease delivery mark fails', async () => {
  const { ActionSuccessorRecoverySweep } = await import(
    '../../dist/domains/ball-custody/ActionSuccessorRecoverySweep.js'
  );
  let current = structuredClone(lease);
  let currentProposal = structuredClone(proposal);
  let deliveries = 0;
  let markAttempts = 0;
  const sweep = new ActionSuccessorRecoverySweep({
    leaseStore: {
      async listPendingReturns() {
        return [];
      },
      async recordReturnDeliveryAttempt() {
        throw new Error('not used');
      },
      async markReturnDelivered() {
        throw new Error('not used');
      },
    },
    async deliverReturnCarrier() {
      return { outcome: 'unavailable' };
    },
    dispatch: {
      leaseStore: {
        async listPendingDispatches() {
          return current.dispatchDeliveryState === 'pending' ? [current] : [];
        },
        async recordDispatchDeliveryAttempt(_id, input) {
          current = {
            ...current,
            dispatchDeliveryAttemptCount: current.dispatchDeliveryAttemptCount + 1,
            dispatchDeliveryLastAttemptAt: input.now,
            revision: current.revision + 1,
            updatedAt: input.now,
          };
          return { outcome: 'recorded', lease: current };
        },
        async markDispatchDelivered(_id, input) {
          markAttempts += 1;
          if (markAttempts === 1) throw new Error('fault: lease delivery mark');
          current = {
            ...current,
            dispatchDeliveryState: 'delivered',
            dispatchDeliveredMessageId: input.deliveredMessageId,
            revision: current.revision + 1,
            updatedAt: input.now,
          };
          return { outcome: 'delivered', lease: current };
        },
      },
      async loadProposal() {
        return currentProposal;
      },
      async loadOwnerAuthProvenance() {
        return 'strict';
      },
      async recordProposalDelivery(_proposalId, deliveredMessageId) {
        currentProposal = { ...currentProposal, deliveredMessageId };
      },
      async deliver() {
        deliveries += 1;
        return { outcome: 'enqueued', deliveredMessageId: `msg-${deliveries}` };
      },
    },
    now: () => 2_000,
  });

  await assert.rejects(() => sweep.recoverDispatch(current), /fault: lease delivery mark/);
  assert.equal(currentProposal.deliveredMessageId, 'msg-1');
  assert.equal(current.dispatchDeliveryState, 'pending');

  assert.deepEqual(await sweep.recoverDispatch(current), {
    outcome: 'delivered',
    deliveredMessageId: 'msg-1',
  });
  assert.equal(deliveries, 1);
  assert.equal(markAttempts, 2);
  assert.equal(current.dispatchDeliveredMessageId, 'msg-1');
});

test('stable approved-carrier retry produces one fenced queue dispatch', async () => {
  const [{ InvocationQueue }, { enqueueA2ATargets }] = await Promise.all([
    import('../../dist/domains/cats/services/agents/invocation/InvocationQueue.js'),
    import('../../dist/routes/callback-a2a-trigger.js'),
  ]);
  const invocationQueue = new InvocationQueue();
  const triggerMessage = {
    id: 'msg-action-1',
    threadId: 'thread-target',
    userId: 'user-1',
    catId: 'codex-sol',
    content: 'Review exact HEAD.',
    mentions: ['codex-terra'],
    origin: 'callback',
    timestamp: 2_000,
  };
  const fence = {
    leaseId: lease.leaseId,
    generation: lease.generation,
    dispatchId: lease.dispatchId,
    terminalPredicateDigest: lease.terminalPredicate.digest,
    invocationLineageRef: `dispatch:${lease.dispatchId}`,
  };
  const deps = {
    router: {},
    invocationRecordStore: {},
    socketManager: {
      broadcastAgentMessage() {},
      broadcastToRoom() {},
      emitToUser() {},
    },
    queueProcessor: { async tryAutoExecute() {} },
    invocationQueue,
    messageStore: {},
    log: { info() {}, warn() {}, error() {} },
  };
  const input = {
    targetCats: ['codex-terra'],
    content: triggerMessage.content,
    userId: triggerMessage.userId,
    ownerAuthProvenance: 'unknown',
    threadId: triggerMessage.threadId,
    triggerMessage,
    callerCatId: 'codex-sol',
    actionSuccessorFence: fence,
  };

  const first = await enqueueA2ATargets(deps, input);
  const retry = await enqueueA2ATargets(deps, input);

  assert.deepEqual(first.enqueued, ['codex-terra']);
  assert.deepEqual(retry.enqueued, ['codex-terra']);
  const queued = invocationQueue.list('thread-target', 'user-1');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].idempotencyKey, `action:${lease.leaseId}:${lease.generation}:codex-terra`);
  assert.equal(queued[0].ownerAuthProvenance, 'unknown');
  assert.deepEqual(queued[0].actionSuccessorFence, fence);
});

test('recovery refuses a proposal whose persisted fence identity does not match the lease', async () => {
  const { ActionSuccessorRecoverySweep } = await import(
    '../../dist/domains/ball-custody/ActionSuccessorRecoverySweep.js'
  );
  let current = structuredClone(lease);
  let deliveries = 0;
  const sweep = new ActionSuccessorRecoverySweep({
    leaseStore: {
      async listPendingReturns() {
        return [];
      },
      async recordReturnDeliveryAttempt() {
        throw new Error('not used');
      },
      async markReturnDelivered() {
        throw new Error('not used');
      },
    },
    async deliverReturnCarrier() {
      return { outcome: 'unavailable' };
    },
    dispatch: {
      leaseStore: {
        async listPendingDispatches() {
          return [current];
        },
        async recordDispatchDeliveryAttempt(_id, input) {
          current = {
            ...current,
            dispatchDeliveryAttemptCount: current.dispatchDeliveryAttemptCount + 1,
            dispatchDeliveryLastAttemptAt: input.now,
            revision: current.revision + 1,
            updatedAt: input.now,
          };
          return { outcome: 'recorded', lease: current };
        },
        async markDispatchDelivered() {
          throw new Error('must not mark a mismatched carrier delivered');
        },
      },
      async loadProposal() {
        return {
          ...proposal,
          actionLeaseRef: {
            ...proposal.actionLeaseRef,
            terminalPredicateDigest: 'wrong-predicate-digest',
          },
        };
      },
      async loadOwnerAuthProvenance() {
        throw new Error('must not load provenance for a mismatched carrier');
      },
      async recordProposalDelivery() {
        throw new Error('must not record a mismatched carrier');
      },
      async deliver() {
        deliveries += 1;
        return { outcome: 'enqueued', deliveredMessageId: 'unexpected' };
      },
    },
    now: () => 2_000,
  });

  assert.deepEqual(await sweep.recoverDispatch(current), { outcome: 'ignored' });
  assert.equal(deliveries, 0);
  assert.equal(current.dispatchDeliveryState, 'pending');
});
