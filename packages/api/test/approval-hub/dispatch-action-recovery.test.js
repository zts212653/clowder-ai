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
        async markDispatchFailed() {
          throw new Error('must not fail a retryable transport fault');
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

  assert.deepEqual(await sweep.runDispatchesOnce(), { scanned: 1, delivered: 0, pending: 1, failed: 0 });
  assert.equal(current.dispatchDeliveryState, 'pending');
  assert.equal(recordedMessages.length, 0);

  assert.deepEqual(await sweep.runDispatchesOnce(), { scanned: 1, delivered: 0, pending: 1, failed: 0 });
  assert.equal(current.dispatchDeliveryState, 'pending');
  assert.equal(recordedMessages.length, 0);

  assert.deepEqual(await sweep.runDispatchesOnce(), { scanned: 1, delivered: 1, pending: 0, failed: 0 });
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

test('persisted proposal receipt is revalidated idempotently after lease delivery mark fails', async () => {
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
        async markDispatchFailed() {
          throw new Error('must not fail an exact persisted proposal receipt');
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
        return {
          outcome: 'enqueued',
          deliveredMessageId: currentProposal.deliveredMessageId ?? `msg-${deliveries}`,
        };
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
  assert.equal(deliveries, 2, 'recovery must revalidate custody behind the persisted receipt');
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

test('recovery adopts the exact legacy-visible carrier as one queued custody source without user-message rescue', async () => {
  const [{ InvocationQueue }, { MessageStore }, { enqueueA2ATargets }] = await Promise.all([
    import('../../dist/domains/cats/services/agents/invocation/InvocationQueue.js'),
    import('../../dist/domains/cats/services/stores/ports/MessageStore.js'),
    import('../../dist/routes/callback-a2a-trigger.js'),
  ]);
  const invocationQueue = new InvocationQueue();
  const messageStore = new MessageStore();
  const triggerMessage = messageStore.append({
    idempotencyKey: `dispatch-action:${proposal.proposalId}:message`,
    threadId: proposal.targetThreadId,
    userId: proposal.ownerUserId,
    catId: proposal.senderCatId,
    content: proposal.content,
    mentions: proposal.targetCats,
    origin: 'callback',
    timestamp: 2_000,
    extra: {
      isExplicitPost: true,
      crossPost: {
        sourceThreadId: proposal.sourceThreadId,
        effectClass: 'assign_work',
      },
      targetCats: proposal.targetCats,
    },
  });
  assert.equal(triggerMessage.deliveryStatus, undefined, 'reproduce the persisted visible half-carrier');

  let autoExecuteCalls = 0;
  const result = await enqueueA2ATargets(
    {
      router: {},
      invocationRecordStore: {},
      socketManager: {
        broadcastAgentMessage() {},
        broadcastToRoom() {},
        emitToUser() {},
      },
      queueProcessor: {
        async tryAutoExecute() {
          autoExecuteCalls += 1;
        },
      },
      invocationQueue,
      messageStore,
      log: { info() {}, warn() {}, error() {} },
    },
    {
      targetCats: proposal.targetCats,
      content: proposal.content,
      userId: proposal.ownerUserId,
      ownerAuthProvenance: 'strict',
      threadId: proposal.targetThreadId,
      triggerMessage,
      callerCatId: proposal.senderCatId,
      actionSuccessorFence: {
        leaseId: lease.leaseId,
        generation: lease.generation,
        dispatchId: lease.dispatchId,
        terminalPredicateDigest: lease.terminalPredicate.digest,
        invocationLineageRef: `dispatch:${lease.dispatchId}`,
      },
    },
  );

  assert.deepEqual(result.enqueued, ['codex-terra']);
  const queued = invocationQueue.list(proposal.targetThreadId, proposal.ownerUserId);
  assert.equal(queued.length, 1);
  const recovered = messageStore.getById(triggerMessage.id);
  assert.equal(recovered.deliveryStatus, 'queued');
  assert.equal(recovered.queueCustody.status, 'queued');
  assert.equal(recovered.queueCustody.receiptScope, 'cross_thread_delivery');
  assert.equal(recovered.queueCustody.carrierByTargetCatId['codex-terra'].entryId, queued[0].id);
  assert.equal(autoExecuteCalls, 1);
});

test('identical recovery races and a process restart converge on the same durable Queue carrier', async () => {
  const [{ InvocationQueue }, { MessageStore }, { enqueueA2ATargets }] = await Promise.all([
    import('../../dist/domains/cats/services/agents/invocation/InvocationQueue.js'),
    import('../../dist/domains/cats/services/stores/ports/MessageStore.js'),
    import('../../dist/routes/callback-a2a-trigger.js'),
  ]);
  const messageStore = new MessageStore();
  const triggerMessage = messageStore.append({
    idempotencyKey: `dispatch-action:${proposal.proposalId}:message`,
    threadId: proposal.targetThreadId,
    userId: proposal.ownerUserId,
    catId: proposal.senderCatId,
    content: proposal.content,
    mentions: proposal.targetCats,
    origin: 'callback',
    timestamp: 2_000,
    extra: {
      isExplicitPost: true,
      crossPost: {
        sourceThreadId: proposal.sourceThreadId,
        effectClass: 'assign_work',
      },
      targetCats: proposal.targetCats,
    },
  });
  const fence = {
    leaseId: lease.leaseId,
    generation: lease.generation,
    dispatchId: lease.dispatchId,
    terminalPredicateDigest: lease.terminalPredicate.digest,
    invocationLineageRef: `dispatch:${lease.dispatchId}`,
  };
  const input = {
    targetCats: proposal.targetCats,
    content: proposal.content,
    userId: proposal.ownerUserId,
    ownerAuthProvenance: 'strict',
    threadId: proposal.targetThreadId,
    triggerMessage,
    callerCatId: proposal.senderCatId,
    actionSuccessorFence: fence,
  };
  const depsFor = (invocationQueue) => ({
    router: {},
    invocationRecordStore: {},
    socketManager: {
      broadcastAgentMessage() {},
      broadcastToRoom() {},
      emitToUser() {},
    },
    queueProcessor: { async tryAutoExecute() {} },
    invocationQueue,
    messageStore,
    log: { info() {}, warn() {}, error() {} },
  });

  const firstProcessQueue = new InvocationQueue();
  const raced = await Promise.all([
    enqueueA2ATargets(depsFor(firstProcessQueue), input),
    enqueueA2ATargets(depsFor(firstProcessQueue), input),
  ]);
  assert.deepEqual(
    raced.map((result) => result.enqueued),
    [['codex-terra'], ['codex-terra']],
  );
  const firstEntries = firstProcessQueue.list(proposal.targetThreadId, proposal.ownerUserId);
  assert.equal(firstEntries.length, 1, 'recovery race must not create a second Queue entry');

  const admitted = messageStore.getById(triggerMessage.id);
  const durableEntryId = admitted.queueCustody.carrierByTargetCatId['codex-terra'].entryId;
  assert.equal(durableEntryId, firstEntries[0].id);

  const restartedQueue = new InvocationQueue();
  const restarted = await enqueueA2ATargets(depsFor(restartedQueue), input);
  assert.deepEqual(restarted.enqueued, ['codex-terra']);
  const restoredEntries = restartedQueue.list(proposal.targetThreadId, proposal.ownerUserId);
  assert.equal(restoredEntries.length, 1, 'restart must restore, not mint, the durable Queue carrier');
  assert.equal(restoredEntries[0].id, durableEntryId);
  assert.equal(restoredEntries[0].idempotencyKey, `action:${lease.leaseId}:${lease.generation}:codex-terra`);

  await enqueueA2ATargets(depsFor(restartedQueue), input);
  assert.equal(
    restartedQueue.list(proposal.targetThreadId, proposal.ownerUserId).length,
    1,
    'post-restart replay must remain idempotent',
  );
});

test('approved carrier classification fails closed on conflicting source or custody identity', async () => {
  const { classifyApprovedActionCarrier } = await import(
    '../../dist/domains/ball-custody/ActionSuccessorRecoverySweep.js'
  );
  const carrier = {
    id: 'msg-action-classification',
    threadId: proposal.targetThreadId,
    userId: proposal.ownerUserId,
    catId: proposal.senderCatId,
    content: proposal.content,
    mentions: proposal.targetCats,
    origin: 'callback',
    timestamp: 2_000,
    extra: {
      isExplicitPost: true,
      crossPost: {
        sourceThreadId: proposal.sourceThreadId,
        effectClass: 'assign_work',
      },
      targetCats: proposal.targetCats,
    },
  };

  assert.deepEqual(classifyApprovedActionCarrier(proposal, carrier), { outcome: 'repairable' });
  assert.deepEqual(classifyApprovedActionCarrier(proposal, { ...carrier, content: 'conflicting replay' }), {
    outcome: 'conflict',
    reason: 'carrier_source_conflict',
  });

  const admitted = {
    ...carrier,
    deliveryStatus: 'queued',
    queueCustody: {
      entryId: `cross-thread:${carrier.id}`,
      intent: 'execute',
      ownerUserId: proposal.ownerUserId,
      receiptScope: 'cross_thread_delivery',
      allTargetCats: proposal.targetCats,
      carrierByTargetCatId: {
        'codex-terra': {
          entryId: 'queue-entry-terra',
          source: 'agent',
          sourceCategory: 'a2a',
          callerCatId: proposal.senderCatId,
          a2aTriggerMessageId: carrier.id,
          autoExecute: true,
        },
      },
    },
  };
  assert.deepEqual(classifyApprovedActionCarrier(proposal, admitted), { outcome: 'admitted' });
  assert.deepEqual(
    classifyApprovedActionCarrier(proposal, {
      ...admitted,
      queueCustody: {
        ...admitted.queueCustody,
        carrierByTargetCatId: {
          'codex-terra': {
            ...admitted.queueCustody.carrierByTargetCatId['codex-terra'],
            a2aTriggerMessageId: 'another-source',
          },
        },
      },
    }),
    { outcome: 'conflict', reason: 'carrier_receipt_conflict' },
  );
});

test('recovery terminalizes a proposal whose persisted fence identity does not match the lease exactly once', async () => {
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
        async markDispatchDelivered() {
          throw new Error('must not mark a mismatched carrier delivered');
        },
        async markDispatchFailed(_id, input) {
          current = {
            ...current,
            dispatchDeliveryState: 'failed',
            dispatchFailureReason: input.reason,
            dispatchFailureEvidenceRef: input.evidenceRef,
          };
          return { outcome: 'failed', lease: current };
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

  assert.deepEqual(await sweep.runDispatchesOnce(), { scanned: 1, delivered: 0, pending: 0, failed: 1 });
  assert.deepEqual(await sweep.runDispatchesOnce(), { scanned: 0, delivered: 0, pending: 0, failed: 0 });
  assert.equal(deliveries, 0);
  assert.equal(current.dispatchDeliveryState, 'failed');
  assert.equal(current.dispatchFailureReason, 'proposal_fence_mismatch');
});
