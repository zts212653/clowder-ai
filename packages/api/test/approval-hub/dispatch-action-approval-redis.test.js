import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';

import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from '../helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const HEAD_SHA = 'a'.repeat(40);

describe('F246 approval atomically acquires F167 custody', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let proposalStore;
  let leaseStore;
  let truthResolver;
  let admissionService;
  let approvalService;
  let DispatchActionApprovalService;
  let approveWithClaim;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F246 atomic action approval');
    const [
      { createRedisClient },
      { RedisDispatchProposalStore },
      { RedisActionSuccessorLeaseStore },
      { ActionSuccessorAdmissionService },
      dispatchApprovalModule,
      { approveRedisDispatchProposalWithActionClaim },
    ] = await Promise.all([
      import('@cat-cafe/shared/utils'),
      import('../../dist/domains/approval-hub/stores/redis/RedisDispatchProposalStore.js'),
      import('../../dist/domains/ball-custody/RedisActionSuccessorLeaseStore.js'),
      import('../../dist/domains/ball-custody/ActionSuccessorAdmissionService.js'),
      import('../../dist/domains/approval-hub/DispatchActionApprovalService.js'),
      import('../../dist/domains/approval-hub/stores/redis/RedisDispatchActionApproval.js'),
    ]);
    ({ DispatchActionApprovalService } = dispatchApprovalModule);
    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
      return;
    }
    proposalStore = new RedisDispatchProposalStore(redis);
    leaseStore = new RedisActionSuccessorLeaseStore(redis);
    truthResolver = {
      async resolve() {
        return { terminal: false, source: 'community_projection', state: 'active' };
      },
      async resolveFreshness(predicate) {
        return {
          status: 'verified',
          evidenceRef: `community:${predicate.subjectRef}:head:${HEAD_SHA}`,
          freshnessKey: predicate.freshnessKey,
        };
      },
    };
    admissionService = new ActionSuccessorAdmissionService(leaseStore, truthResolver);
    approveWithClaim = (proposal, userId, ownerAuthProvenance, input) =>
      approveRedisDispatchProposalWithActionClaim(redis, proposal, userId, ownerAuthProvenance, input);
    approvalService = new DispatchActionApprovalService({
      store: proposalStore,
      leaseStore,
      admissionService,
      claimAndApprove: approveWithClaim,
      now: () => 10_000,
    });
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, [
      'dispatch-proposal:*',
      'dispatch-proposal-user-pending:*',
      'dispatch-proposal-user-settled:*',
      'dispatch-proposal-clientmsg:*',
      'dispatch-proposal-lineage:*',
      'dispatch-proposal-canonical-admission:*',
      'dispatch-proposal-canonical-admission-rebuild-completed-at',
      'action:successor:*',
    ]);
  });

  after(async () => {
    if (!connected) return;
    await cleanupPrefixedRedisKeys(redis, ['dispatch-proposal*', 'action:successor:*']);
    await redis.quit();
  });

  async function createProposal(overrides = {}) {
    const proposedAction = {
      subjectRef: 'pr:owner/repo#42',
      actionFamily: 'review',
      successorSlot: 'reviewer',
      mode: 'single',
      terminalPredicate: { kind: 'review_delivered', headSha: HEAD_SHA },
    };
    const { validateDispatchProposedAction } = await import(
      '../../dist/domains/approval-hub/DispatchProposedAction.js'
    );
    const validated = validateDispatchProposedAction(proposedAction, ['codex-terra']);
    const { proposal } = await proposalStore.create({
      proposalId: 'dp-atomic-001',
      sourceThreadId: 'thread-source',
      targetThreadId: 'thread-target',
      senderCatId: 'codex-sol',
      ownerUserId: 'user-1',
      content: 'Review exact HEAD.',
      targetCats: ['codex-terra'],
      clientMessageId: 'retry-atomic-001',
      proposedAction: validated.action,
      envelopeDigest: validated.envelopeDigest,
      createdAt: 9_000,
      ...overrides,
    });
    return proposal;
  }

  test('concurrent stable retry produces one approved proposal and one fenced lease', async () => {
    const proposal = await createProposal();
    const [first, retry] = await Promise.all([
      approvalService.approve(proposal, 'user-1', 'strict'),
      approvalService.approve(proposal, 'user-1', 'strict'),
    ]);

    assert.equal(first.approved, true);
    assert.equal(retry.approved, true);
    assert.equal(first.value.actionLease.leaseId, retry.value.actionLease.leaseId);
    assert.deepEqual(first.value.actionFence, retry.value.actionFence);
    const persisted = await proposalStore.get(proposal.proposalId);
    assert.equal(persisted.status, 'approved');
    assert.equal(persisted.actionLeaseRef.leaseId, first.value.actionLease.leaseId);
    assert.equal(persisted.actionLeaseRef.generation, 1);
    assert.equal(await proposalStore.getApprovalOwnerAuthProvenance(proposal.proposalId), 'strict');
    assert.equal(first.value.actionLease.dispatchDeliveryState, 'pending');
    assert.equal(await redis.scard('action:successor:all'), 1);
    const { computeDispatchCanonicalActionKey } = await import(
      '../../dist/domains/approval-hub/stores/ports/IDispatchProposalStore.js'
    );
    assert.deepEqual(
      await proposalStore.findCanonicalAdmissionBlocks({
        ownerUserId: proposal.ownerUserId,
        canonicalActionKey: computeDispatchCanonicalActionKey(proposal.ownerUserId, proposal.proposedAction),
      }),
      [],
      'the atomic approval removes its proposal from canonical admission before subsequent carriers inspect it',
    );
  });

  test('matching task standing approves exactly one executable implement lease', async () => {
    const taskAction = {
      subjectRef: 'subject:task:task-standing-redis',
      actionFamily: 'implement',
      successorSlot: 'implementer',
      mode: 'single',
      terminalPredicate: { kind: 'task_done' },
    };
    const { validateDispatchProposedAction } = await import(
      '../../dist/domains/approval-hub/DispatchProposedAction.js'
    );
    const validated = validateDispatchProposedAction(taskAction, ['codex-terra']);
    const { proposal } = await proposalStore.create({
      proposalId: 'dp-task-standing-redis',
      sourceThreadId: 'thread-source',
      targetThreadId: 'thread-target',
      senderCatId: 'codex-sol',
      ownerUserId: 'user-1',
      content: 'Implement the durable task.',
      targetCats: ['codex-terra'],
      clientMessageId: 'task-standing-redis',
      proposedAction: validated.action,
      envelopeDigest: validated.envelopeDigest,
      createdAt: 9_000,
    });
    const { ActionSuccessorAdmissionService } = await import(
      '../../dist/domains/ball-custody/ActionSuccessorAdmissionService.js'
    );
    const taskAdmission = new ActionSuccessorAdmissionService(leaseStore, {
      async resolve() {
        return { terminal: false, source: 'task_store', state: 'active' };
      },
      async resolveFreshness(predicate) {
        return {
          status: 'verified',
          evidenceRef: 'task:task-standing-redis:active:9000',
          freshnessKey: predicate.freshnessKey,
          ownerCatId: 'codex-terra',
          holderThreadId: 'thread-target',
          tenantScope: 'user-1',
        };
      },
    });
    const taskApproval = new DispatchActionApprovalService({
      store: proposalStore,
      leaseStore,
      admissionService: taskAdmission,
      claimAndApprove: approveWithClaim,
      now: () => 10_000,
    });

    const result = await taskApproval.approve(proposal, 'user-1', 'strict');

    assert.equal(result.approved, true);
    assert.equal(result.value.actionLease.actionFamily, 'implement');
    assert.deepEqual(result.value.actionLease.holderCatIds, ['codex-terra']);
    assert.equal(result.value.actionLease.holderThreadId, 'thread-target');
    assert.equal(await redis.scard('action:successor:all'), 1);
  });

  test('lease conflict leaves proposal pending with no second lease', async () => {
    const proposal = await createProposal();
    const action = proposal.proposedAction;
    const { canonicalizeActionTerminalPredicate } = await import(
      '../../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js'
    );
    await leaseStore.claim({
      leaseId: 'lease-existing',
      tenantScope: proposal.ownerUserId,
      subjectRef: action.subjectRef,
      actionFamily: action.actionFamily,
      successorSlot: action.successorSlot,
      mode: 'single',
      holderCatIds: ['codex-terra'],
      dispatchId: 'direct:existing',
      claimOrigin: 'structured_transfer',
      holderThreadId: proposal.targetThreadId,
      predecessorCatId: proposal.senderCatId,
      predecessorThreadId: proposal.sourceThreadId,
      issuerStandingEvidenceRef: 'message:existing',
      evidenceRefs: ['message:existing'],
      terminalPredicate: canonicalizeActionTerminalPredicate({
        actionFamily: action.actionFamily,
        subjectRef: action.subjectRef,
        predicate: action.terminalPredicate,
      }),
      now: 8_000,
    });

    const result = await approvalService.approve(proposal, 'user-1', 'strict');
    assert.deepEqual(result, { approved: false, outcome: 'safe_wait' });
    assert.equal((await proposalStore.get(proposal.proposalId)).status, 'pending');
    assert.equal(await redis.scard('action:successor:all'), 1);
  });

  test('claim exception leaves proposal pending and creates no lease', async () => {
    const proposal = await createProposal();
    const failing = new DispatchActionApprovalService({
      store: proposalStore,
      leaseStore,
      admissionService,
      claimAndApprove: async () => {
        throw new Error('fault: lease claim');
      },
      now: () => 10_000,
    });

    await assert.rejects(() => failing.approve(proposal, 'user-1', 'strict'), /fault: lease claim/);
    assert.equal((await proposalStore.get(proposal.proposalId)).status, 'pending');
    assert.equal(await redis.scard('action:successor:all'), 0);
  });

  test('reject creates no lease and no approval reference', async () => {
    const proposal = await createProposal();
    const rejected = await proposalStore.reject(proposal.proposalId, 'user-1');
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.actionLeaseRef, undefined);
    assert.equal(await redis.scard('action:successor:all'), 0);
  });

  test('durable terminal truth blocks deferred carrier recovery before delivery', async () => {
    const proposal = await createProposal();
    const approved = await approvalService.approve(proposal, 'user-1', 'strict');
    assert.equal(approved.approved, true);
    const { actionLease } = approved.value;
    await leaseStore.markSubjectTerminal({
      subjectRef: actionLease.subjectRef,
      state: 'merged',
      evidenceRef: 'community:pr:owner/repo#42:merged',
      now: 10_001,
    });

    const { ActionSuccessorRecoverySweep } = await import(
      '../../dist/domains/ball-custody/ActionSuccessorRecoverySweep.js'
    );
    let deliveries = 0;
    const sweep = new ActionSuccessorRecoverySweep({
      leaseStore,
      async deliverReturnCarrier() {
        return { outcome: 'unavailable' };
      },
      dispatch: {
        leaseStore,
        truthResolver,
        loadProposal: (proposalId) => proposalStore.get(proposalId),
        loadOwnerAuthProvenance: (proposalId) => proposalStore.getApprovalOwnerAuthProvenance(proposalId),
        recordProposalDelivery: (proposalId, deliveredMessageId) =>
          proposalStore.recordDelivery(proposalId, deliveredMessageId),
        async deliver() {
          deliveries += 1;
          return { outcome: 'enqueued', deliveredMessageId: 'must-not-exist' };
        },
      },
      now: () => 10_002,
    });

    assert.deepEqual(await sweep.recoverDispatch(actionLease), { outcome: 'ignored' });
    assert.equal(deliveries, 0);
    assert.equal((await proposalStore.get(proposal.proposalId)).deliveredMessageId, undefined);
    const persistedLease = await leaseStore.get(actionLease.leaseId);
    assert.equal(persistedLease.dispatchDeliveryState, 'pending');
    assert.equal(persistedLease.dispatchDeliveryAttemptCount, 0);
  });

  test('the approved receiver holds and completes the same fenced generation', async () => {
    const proposal = await createProposal();
    const approved = await approvalService.approve(proposal, 'user-1', 'strict');
    assert.equal(approved.approved, true);
    const { actionLease, actionFence } = approved.value;
    const attempt = await leaseStore.recordDispatchDeliveryAttempt(actionLease.leaseId, {
      expectedGeneration: actionFence.generation,
      expectedRevision: actionLease.revision,
      expectedPredicateDigest: actionLease.terminalPredicate.digest,
      freshnessEvidenceRef: `community:${actionLease.subjectRef}:head:${HEAD_SHA}`,
      now: 10_001,
    });
    assert.equal(attempt.outcome, 'recorded');
    const reservation = await leaseStore.reserveDispatchDelivery(actionLease.leaseId, {
      expectedGeneration: actionFence.generation,
      expectedRevision: attempt.lease.revision,
      expectedPredicateDigest: actionLease.terminalPredicate.digest,
      freshnessEvidenceRef: `community:${actionLease.subjectRef}:head:${HEAD_SHA}`,
      now: 10_002,
    });
    assert.equal(reservation.outcome, 'reserved');
    await leaseStore.markDispatchDelivered(actionLease.leaseId, {
      expectedGeneration: actionFence.generation,
      expectedRevision: reservation.lease.revision,
      expectedPredicateDigest: actionLease.terminalPredicate.digest,
      freshnessEvidenceRef: `community:${actionLease.subjectRef}:head:${HEAD_SHA}`,
      deliveredMessageId: 'msg-action-carrier',
      evidenceRef: 'message:msg-action-carrier',
      now: 10_003,
    });

    const { ActionSuccessorCompletionService } = await import(
      '../../dist/domains/ball-custody/ActionSuccessorCompletionService.js'
    );
    const completion = new ActionSuccessorCompletionService(leaseStore, {
      async resolveCompletion(predicate, candidate) {
        return {
          status: 'verified',
          evidenceRef: candidate.evidenceRefs[0],
          predicateDigest: predicate.digest,
          freshnessKey: predicate.freshnessKey,
          candidateRevision: candidate.candidateRevision,
          evidenceDigest: candidate.evidenceDigest,
        };
      },
    });
    const result = await completion.complete({
      leaseId: actionFence.leaseId,
      generation: actionFence.generation,
      catId: 'codex-terra',
      evidenceRefs: ['community:pr:owner/repo#42:review:terra'],
      now: 10_004,
    });

    assert.deepEqual(result, {
      outcome: 'committed',
      leaseId: actionFence.leaseId,
      generation: actionFence.generation,
    });
    const completed = await leaseStore.get(actionFence.leaseId);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.holderOutcomes['codex-terra'].outcome, 'succeeded');
    assert.equal(completed.dispatchDeliveredMessageId, 'msg-action-carrier');
  });
});
