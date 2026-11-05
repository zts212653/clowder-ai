import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { canonicalizeActionTerminalPredicate } from '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js';
import {
  currentDelegateLineageGenerationHasExactEntry,
  currentDelegateLineageSegmentStartGeneration,
  delegateLineageGenerationWasSuperseded,
  delegateLineageHistoryMatchesCanonicalOwner,
} from '../dist/domains/ball-custody/action-successor-delegate-lineage.js';
import { carrierRefreshEvidenceRef } from '../dist/domains/ball-custody/action-successor-refresh-state-machine.js';
import {
  preflightActionSuccessor,
  recoverOrphanActionSuccessorCarrier,
} from '../dist/domains/ball-custody/action-successor-state-machine.js';

const taskId = '0001792286456335-000721-5b82ba3c';

function lease(overrides = {}) {
  const subjectRef = `subject:task:${taskId}`;
  return {
    leaseId: 'lease-orphan-task-721',
    key: `user-1|${subjectRef}|implement|implementer`,
    tenantScope: 'user-1',
    subjectRef,
    actionFamily: 'implement',
    successorSlot: 'implementer',
    mode: 'single',
    holderCatIds: ['codex-sol'],
    dispatchId: 'cross-post:old-task-721-carrier',
    claimOrigin: 'structured_transfer',
    holderThreadId: 'thread-approved-child',
    predecessorCatId: 'codex-astra',
    predecessorThreadId: 'thread-owner',
    issuerStandingEvidenceRef: 'callback:old:old-task-721-carrier',
    generation: 3,
    status: 'active',
    holderOutcomes: {},
    completionCandidates: {},
    terminalPredicateState: { kind: 'predicate_backed' },
    terminalPredicate: canonicalizeActionTerminalPredicate({
      actionFamily: 'implement',
      subjectRef,
      predicate: { kind: 'task_done' },
    }),
    evidenceRefs: ['callback:old:old-task-721-carrier'],
    returnTransitions: [
      {
        outcome: 'rejected_ownership',
        fromGeneration: 1,
        toGeneration: 2,
        rejectingCatId: 'codex-sol',
        rejectingThreadId: 'thread-approved-child',
        predecessorCatId: 'codex-astra',
        predecessorThreadId: 'thread-owner',
        groundingEvidenceRef: 'message:owner-return',
        at: 90,
      },
    ],
    replacementTransitions: [
      {
        fromGeneration: 2,
        toGeneration: 3,
        reason: 'holder_terminal',
        fromHolderCatIds: ['codex-astra'],
        fromHolderThreadId: 'thread-owner',
        toHolderCatIds: ['codex-sol'],
        toHolderThreadId: 'thread-approved-child',
        issuerCatId: 'codex-astra',
        issuerThreadId: 'thread-owner',
        holderOutcomes: { 'codex-astra': { outcome: 'rejected_ownership', evidenceRef: 'message:return', at: 91 } },
        evidenceRefs: ['message:owner-return'],
        at: 91,
      },
    ],
    orphanCarrierRecoveryTransitions: [],
    revision: 7,
    createdAt: 10,
    updatedAt: 100,
    ...overrides,
  };
}

function recovery(overrides = {}) {
  return {
    expectedGeneration: 3,
    expectedRevision: 7,
    taskId,
    taskRevision: 366,
    sourceMessageId: '0001791900666739-000044-aee64d04',
    predecessorCatId: 'codex-astra',
    predecessorThreadId: 'thread-owner',
    holderCatId: 'codex-sol',
    holderThreadId: 'thread-approved-child',
    dispatchId: 'cross-post:recover-task-721-carrier',
    evidenceRef: 'callback:new:recover-task-721-carrier',
    now: 200,
    ...overrides,
  };
}

describe('orphan task action carrier transition', () => {
  test('atomically advances the exact outcome-free task generation and records typed provenance', () => {
    const result = recoverOrphanActionSuccessorCarrier(lease(), recovery());

    assert.equal(result.outcome, 'recovered');
    assert.equal(result.lease.generation, 4);
    assert.equal(result.lease.revision, 8);
    assert.equal(result.lease.dispatchId, recovery().dispatchId);
    assert.deepEqual(result.lease.holderCatIds, ['codex-sol']);
    assert.equal(result.lease.returnTransitions.length, 1, 'historical return lineage remains auditable');
    assert.deepEqual(result.lease.orphanCarrierRecoveryTransitions, [
      {
        kind: 'orphan_carrier_recovery',
        fromGeneration: 3,
        toGeneration: 4,
        taskId,
        taskRevision: 366,
        sourceMessageId: recovery().sourceMessageId,
        predecessorCatId: 'codex-astra',
        predecessorThreadId: 'thread-owner',
        holderCatId: 'codex-sol',
        holderThreadId: 'thread-approved-child',
        fromDispatchId: lease().dispatchId,
        toDispatchId: recovery().dispatchId,
        evidenceRef: recovery().evidenceRef,
        at: 200,
      },
    ]);
    assert.deepEqual(preflightActionSuccessor(result.lease, { generation: 3, subjectTerminal: false }), {
      ok: false,
      reason: 'stale_generation',
    });
    const initial = lease({
      generation: 1,
      revision: 1,
      returnTransitions: [],
      replacementTransitions: [],
    });
    const cleanRecovery = recoverOrphanActionSuccessorCarrier(
      initial,
      recovery({ expectedGeneration: 1, expectedRevision: 1 }),
    );
    assert.equal(cleanRecovery.outcome, 'recovered');
    assert.equal(
      currentDelegateLineageGenerationHasExactEntry(cleanRecovery.lease, {
        ownerCatId: 'codex-astra',
        ownerThreadId: 'thread-owner',
        childThreadId: 'thread-approved-child',
      }),
      true,
      'the recovered generation remains inside the same approved delegate lineage',
    );
    const route = {
      ownerCatId: 'codex-astra',
      ownerThreadId: 'thread-owner',
      childThreadId: 'thread-approved-child',
    };
    const refreshedLineage = lease({
      returnTransitions: [],
      replacementTransitions: [],
      evidenceRefs: [
        'callback:old:old-task-721-carrier',
        carrierRefreshEvidenceRef('lease-orphan-task-721', 2),
        carrierRefreshEvidenceRef('lease-orphan-task-721', 3),
      ],
    });
    const lineageRecovery = recoverOrphanActionSuccessorCarrier(refreshedLineage, recovery());
    assert.equal(lineageRecovery.outcome, 'recovered');
    assert.equal(delegateLineageHistoryMatchesCanonicalOwner(lineageRecovery.lease, route), true);
    assert.equal(
      delegateLineageGenerationWasSuperseded({
        lease: lineageRecovery.lease,
        route,
        generation: 3,
        expectedReporterCatIds: ['codex-sol'],
      }),
      true,
      'a late old-generation development return is explicitly superseded by the recovery edge',
    );
    const [edge] = lineageRecovery.lease.orphanCarrierRecoveryTransitions;
    assert.equal(
      delegateLineageHistoryMatchesCanonicalOwner(
        {
          ...lineageRecovery.lease,
          orphanCarrierRecoveryTransitions: [
            edge,
            { ...edge, sourceMessageId: 'other-source', toDispatchId: 'cross-post:other-recovery' },
          ],
        },
        route,
      ),
      false,
      'two edges may not claim the same old generation',
    );
  });

  test('refuses outcomes, candidates, current returns, dispatch state, and stale CAS coordinates', () => {
    assert.equal(
      recoverOrphanActionSuccessorCarrier(
        lease({ holderOutcomes: { 'codex-sol': { outcome: 'failed', evidenceRef: 'invocation:x', at: 150 } } }),
        recovery(),
      ).outcome,
      'holder_outcome_present',
    );
    assert.equal(
      recoverOrphanActionSuccessorCarrier(
        lease({
          completionCandidates: {
            'codex-sol': { evidenceRefs: ['message:x'], candidateRevision: 1, evidenceDigest: 'x', recordedAt: 150 },
          },
        }),
        recovery(),
      ).outcome,
      'completion_candidate_present',
    );
    assert.equal(
      recoverOrphanActionSuccessorCarrier(lease({ returnDeliveryState: 'pending' }), recovery()).outcome,
      'current_return_present',
    );
    assert.equal(
      recoverOrphanActionSuccessorCarrier(lease({ dispatchDeliveryState: 'pending' }), recovery()).outcome,
      'dispatch_state_present',
    );
    assert.equal(
      recoverOrphanActionSuccessorCarrier(lease(), recovery({ expectedGeneration: 2 })).outcome,
      'stale_generation',
    );
    assert.equal(
      recoverOrphanActionSuccessorCarrier(lease(), recovery({ expectedRevision: 6 })).outcome,
      'stale_revision',
    );
  });

  test('rejects a current segment whose orphan edge belongs to another child before a refresh', () => {
    const route = {
      ownerCatId: 'codex-astra',
      ownerThreadId: 'thread-owner',
      childThreadId: 'thread-approved-child',
    };
    const corrupted = lease({
      generation: 3,
      holderThreadId: route.childThreadId,
      returnTransitions: [],
      replacementTransitions: [],
      evidenceRefs: ['callback:old:old-task-721-carrier', carrierRefreshEvidenceRef('lease-orphan-task-721', 3)],
      orphanCarrierRecoveryTransitions: [
        {
          kind: 'orphan_carrier_recovery',
          fromGeneration: 1,
          toGeneration: 2,
          taskId,
          taskRevision: 366,
          sourceMessageId: recovery().sourceMessageId,
          predecessorCatId: route.ownerCatId,
          predecessorThreadId: route.ownerThreadId,
          holderCatId: 'codex-sol',
          holderThreadId: 'thread-other-child',
          fromDispatchId: 'cross-post:old-task-721-carrier',
          toDispatchId: 'cross-post:wrong-child-recovery',
          evidenceRef: 'callback:new:wrong-child-recovery',
          at: 150,
        },
      ],
    });

    assert.equal(currentDelegateLineageSegmentStartGeneration(corrupted, route), null);
  });
});
