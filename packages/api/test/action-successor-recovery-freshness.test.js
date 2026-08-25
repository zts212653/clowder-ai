import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const OLD_HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);

function reviewLease(overrides = {}) {
  return {
    leaseId: 'lease-review-recovery',
    key: 'user-1\u001fpr:owner/repo#42\u001freview\u001freviewer',
    tenantScope: 'user-1',
    subjectRef: 'pr:owner/repo#42',
    actionFamily: 'review',
    successorSlot: 'reviewer',
    mode: 'single',
    holderCatIds: ['codex-terra'],
    dispatchId: 'approval:proposal-review-recovery',
    claimOrigin: 'structured_transfer',
    holderThreadId: 'thread-review',
    predecessorCatId: 'codex-sol',
    predecessorThreadId: 'thread-author',
    issuerStandingEvidenceRef: 'approval:proposal-review-recovery',
    generation: 1,
    status: 'active',
    holderOutcomes: {},
    completionCandidates: {},
    evidenceRefs: ['approval:proposal-review-recovery'],
    terminalPredicateState: { kind: 'predicate_backed' },
    terminalPredicate: {
      kind: 'review_delivered',
      subjectRef: 'pr:owner/repo#42',
      identityKey: 'review_delivered\u001fpr:owner/repo#42',
      freshnessKey: `head:${OLD_HEAD}`,
      digest: 'predicate-review-recovery',
      headSha: OLD_HEAD,
    },
    returnTransitions: [],
    dispatchDeliveryState: 'pending',
    dispatchDeliveryAttemptCount: 0,
    revision: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function taskLease(overrides = {}) {
  return reviewLease({
    leaseId: 'lease-task-recovery',
    key: 'user-1\u001fsubject:task:task-1\u001fimplement\u001fimplementer',
    subjectRef: 'subject:task:task-1',
    actionFamily: 'implement',
    successorSlot: 'implementer',
    holderCatIds: ['codex-sol'],
    holderThreadId: 'thread-task',
    dispatchId: 'approval:proposal-task-recovery',
    terminalPredicate: {
      kind: 'task_done',
      subjectRef: 'subject:task:task-1',
      identityKey: 'task_done\u001fsubject:task:task-1',
      freshnessKey: 'task:task-1',
      digest: 'predicate-task-recovery',
    },
    ...overrides,
  });
}

function approvedProposal(lease) {
  return {
    proposalId: lease.dispatchId.slice('approval:'.length),
    sourceThreadId: lease.predecessorThreadId,
    targetThreadId: lease.holderThreadId,
    senderCatId: lease.predecessorCatId,
    ownerUserId: lease.tenantScope,
    effectClass: 'assign_work',
    content: 'Continue the exact frozen action.',
    targetCats: lease.holderCatIds,
    proposedAction: {
      subjectRef: lease.subjectRef,
      actionFamily: lease.actionFamily,
      successorSlot: lease.successorSlot,
      mode: lease.mode,
      terminalPredicate:
        lease.terminalPredicate.kind === 'review_delivered'
          ? { kind: 'review_delivered', headSha: lease.terminalPredicate.headSha }
          : { kind: 'task_done' },
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
}

function recoveryHarness({
  lease: initialLease,
  freshness,
  newerHeadWinsBeforeAttempt = false,
  newerHeadWinsAfterAttempt = false,
}) {
  let current = structuredClone(initialLease);
  const events = [];
  const sideEffects = { messages: 0, queueEntries: 0, invocations: 0 };
  const proposal = approvedProposal(current);
  const dispatchStore = {
    async listPendingDispatches() {
      return current.dispatchDeliveryState === 'pending' ? [current] : [];
    },
    async recordDispatchDeliveryAttempt(_leaseId, input) {
      events.push('attempt');
      assert.equal(input.expectedGeneration, current.generation);
      assert.equal(input.expectedRevision, current.revision);
      assert.equal(input.expectedPredicateDigest, current.terminalPredicate.digest);
      assert.equal(input.freshnessEvidenceRef, freshness.evidenceRef);
      if (newerHeadWinsBeforeAttempt) {
        const mismatchEvidenceRef = `community:${current.subjectRef}:head:${NEW_HEAD}`;
        events.push('newer-head-cas');
        current = {
          ...current,
          status: 'replaceable',
          holderOutcomes: Object.fromEntries(
            current.holderCatIds.map((catId) => [
              catId,
              { outcome: 'unavailable', evidenceRef: mismatchEvidenceRef, at: input.now },
            ]),
          ),
          dispatchDeliveryState: 'failed',
          dispatchFailureReason: 'terminal_predicate_mismatch',
          dispatchFailureEvidenceRef: mismatchEvidenceRef,
          evidenceRefs: [...new Set([...current.evidenceRefs, mismatchEvidenceRef])],
          revision: current.revision + 1,
          updatedAt: input.now,
        };
        return { outcome: 'stale_revision', lease: current };
      }
      current = {
        ...current,
        dispatchDeliveryAttemptCount: (current.dispatchDeliveryAttemptCount ?? 0) + 1,
        dispatchDeliveryLastAttemptAt: input.now,
        evidenceRefs: [...new Set([...current.evidenceRefs, input.freshnessEvidenceRef])],
        revision: current.revision + 1,
        updatedAt: input.now,
      };
      return { outcome: 'recorded', lease: current };
    },
    async retirePendingDispatchForFreshnessMismatch(_leaseId, input) {
      events.push('retire');
      assert.equal(input.expectedGeneration, current.generation);
      assert.equal(input.expectedPredicateDigest, current.terminalPredicate.digest);
      assert.equal(input.evidenceRef, freshness.evidenceRef);
      if (input.expectedRevision !== current.revision) return { outcome: 'stale_revision', lease: current };
      if (current.dispatchDeliveryState !== 'pending') return { outcome: 'dispatch_not_pending', lease: current };
      current = {
        ...current,
        dispatchDeliveryState: 'failed',
        dispatchFailureReason: 'terminal_predicate_mismatch',
        dispatchFailureEvidenceRef: input.evidenceRef,
        holderOutcomes: Object.fromEntries(
          current.holderCatIds.map((catId) => [
            catId,
            { outcome: 'unavailable', evidenceRef: input.evidenceRef, at: input.now },
          ]),
        ),
        status: 'replaceable',
        evidenceRefs: [...new Set([...current.evidenceRefs, input.evidenceRef])],
        revision: current.revision + 1,
        updatedAt: input.now,
      };
      return { outcome: 'retired', lease: current };
    },
    async reserveDispatchDelivery(_leaseId, input) {
      events.push('reserve');
      if (input.expectedGeneration !== current.generation) {
        return { outcome: 'stale_generation', lease: current };
      }
      if (input.expectedRevision !== current.revision) return { outcome: 'stale_revision', lease: current };
      if (current.terminalPredicate.digest !== input.expectedPredicateDigest) {
        return { outcome: 'predicate_mismatch', lease: current };
      }
      if (current.dispatchDeliveryState !== 'pending') {
        return { outcome: 'dispatch_not_pending', lease: current };
      }
      current = {
        ...current,
        dispatchDeliveryReservation: {
          predicateDigest: input.expectedPredicateDigest,
          freshnessEvidenceRef: input.freshnessEvidenceRef,
          reservedAt: input.now,
        },
        evidenceRefs: [...new Set([...current.evidenceRefs, input.freshnessEvidenceRef])],
        revision: current.revision + 1,
        updatedAt: input.now,
      };
      return { outcome: 'reserved', lease: current };
    },
    async markDispatchDelivered(_leaseId, input) {
      events.push('mark-delivered');
      assert.equal(input.expectedRevision, current.revision);
      assert.equal(input.expectedPredicateDigest, current.terminalPredicate.digest);
      assert.equal(input.freshnessEvidenceRef, current.dispatchDeliveryReservation.freshnessEvidenceRef);
      const { dispatchDeliveryReservation: _reservation, ...withoutReservation } = current;
      current = {
        ...withoutReservation,
        dispatchDeliveryState: 'delivered',
        dispatchDeliveredMessageId: input.deliveredMessageId,
        revision: current.revision + 1,
        updatedAt: input.now,
      };
      return { outcome: 'delivered', lease: current };
    },
    async markDispatchFailed() {
      throw new Error('unexpected transport failure');
    },
  };
  return {
    deps: {
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
        leaseStore: dispatchStore,
        truthResolver: {
          async resolveFreshness(predicate) {
            events.push('freshness');
            assert.equal(predicate.digest, current.terminalPredicate.digest);
            return freshness;
          },
        },
        async loadProposal() {
          events.push('proposal');
          return proposal;
        },
        async loadOwnerAuthProvenance() {
          events.push('provenance');
          if (newerHeadWinsAfterAttempt) {
            const mismatchEvidenceRef = `community:${current.subjectRef}:head:${NEW_HEAD}`;
            events.push('newer-head-cas');
            current = {
              ...current,
              status: 'replaceable',
              holderOutcomes: Object.fromEntries(
                current.holderCatIds.map((catId) => [
                  catId,
                  { outcome: 'unavailable', evidenceRef: mismatchEvidenceRef, at: 2_000 },
                ]),
              ),
              dispatchDeliveryState: 'failed',
              dispatchFailureReason: 'terminal_predicate_mismatch',
              dispatchFailureEvidenceRef: mismatchEvidenceRef,
              evidenceRefs: [...new Set([...current.evidenceRefs, mismatchEvidenceRef])],
              revision: current.revision + 1,
              updatedAt: 2_000,
            };
          }
          return 'strict';
        },
        async recordProposalDelivery() {},
        async deliver() {
          events.push('deliver');
          sideEffects.messages += 1;
          sideEffects.queueEntries += 1;
          sideEffects.invocations += 1;
          return { outcome: 'enqueued', deliveredMessageId: 'message-delivered' };
        },
      },
      now: () => 2_000,
    },
    events,
    sideEffects,
    current: () => current,
  };
}

async function loadSweep() {
  return import('../dist/domains/ball-custody/ActionSuccessorRecoverySweep.js');
}

describe('PR8 ActionSuccessor recovery freshness fence', () => {
  test('verified frozen review HEAD is CAS-bound before the existing carrier delivery runs', async () => {
    const { ActionSuccessorRecoverySweep } = await loadSweep();
    const h = recoveryHarness({
      lease: reviewLease(),
      freshness: {
        status: 'verified',
        evidenceRef: `community:pr:owner/repo#42:head:${OLD_HEAD}`,
        freshnessKey: `head:${OLD_HEAD}`,
      },
    });

    const result = await new ActionSuccessorRecoverySweep(h.deps).recoverDispatch(h.current());

    assert.deepEqual(result, { outcome: 'delivered', deliveredMessageId: 'message-delivered' });
    assert.deepEqual(h.events, [
      'freshness',
      'attempt',
      'proposal',
      'provenance',
      'reserve',
      'deliver',
      'mark-delivered',
    ]);
    assert.deepEqual(h.sideEffects, { messages: 1, queueEntries: 1, invocations: 1 });
  });

  test('mismatched frozen review HEAD retires the old generation before any provider-side effect', async () => {
    const { ActionSuccessorRecoverySweep } = await loadSweep();
    const h = recoveryHarness({
      lease: reviewLease(),
      freshness: {
        status: 'mismatch',
        reason: 'predicate HEAD is not the server-observed current HEAD',
        evidenceRef: `community:pr:owner/repo#42:head:${NEW_HEAD}`,
      },
    });
    const sweep = new ActionSuccessorRecoverySweep(h.deps);

    assert.deepEqual(await sweep.recoverDispatch(h.current()), {
      outcome: 'failed',
      reason: 'terminal_predicate_mismatch',
    });
    assert.deepEqual(await sweep.recoverDispatch(reviewLease()), {
      outcome: 'failed',
      reason: 'terminal_predicate_mismatch',
    });
    assert.deepEqual(h.events, ['freshness', 'retire', 'freshness', 'retire']);
    assert.deepEqual(h.sideEffects, { messages: 0, queueEntries: 0, invocations: 0 });
    assert.equal(h.current().status, 'replaceable');
    assert.equal(h.current().holderOutcomes['codex-terra'].outcome, 'unavailable');
  });

  test('insufficient review freshness remains pending without recording an attempt or guessing', async () => {
    const { ActionSuccessorRecoverySweep } = await loadSweep();
    const h = recoveryHarness({
      lease: reviewLease(),
      freshness: { status: 'insufficient', reason: 'current HEAD projection unavailable' },
    });

    assert.deepEqual(await new ActionSuccessorRecoverySweep(h.deps).recoverDispatch(h.current()), {
      outcome: 'pending',
    });
    assert.deepEqual(h.events, ['freshness']);
    assert.deepEqual(h.sideEffects, { messages: 0, queueEntries: 0, invocations: 0 });
    assert.equal(h.current().dispatchDeliveryAttemptCount, 0);
  });

  test('changed task owner/thread/tenant standing retires the frozen implement generation', async () => {
    const { ActionSuccessorRecoverySweep } = await loadSweep();
    const h = recoveryHarness({
      lease: taskLease(),
      freshness: {
        status: 'verified',
        evidenceRef: 'task:task-1:active:2000',
        freshnessKey: 'task:task-1',
        ownerCatId: 'codex-terra',
        holderThreadId: 'thread-reassigned',
        tenantScope: 'user-2',
      },
    });

    assert.deepEqual(await new ActionSuccessorRecoverySweep(h.deps).recoverDispatch(h.current()), {
      outcome: 'failed',
      reason: 'terminal_predicate_mismatch',
    });
    assert.deepEqual(h.events, ['freshness', 'retire']);
    assert.deepEqual(h.sideEffects, { messages: 0, queueEntries: 0, invocations: 0 });
    assert.equal(h.current().status, 'replaceable');
    assert.equal(h.current().holderOutcomes['codex-sol'].outcome, 'unavailable');
  });

  test('a newer-head retirement that wins the exact-revision race prevents provider entry', async () => {
    const { ActionSuccessorRecoverySweep } = await loadSweep();
    const h = recoveryHarness({
      lease: reviewLease(),
      freshness: {
        status: 'verified',
        evidenceRef: `community:pr:owner/repo#42:head:${OLD_HEAD}`,
        freshnessKey: `head:${OLD_HEAD}`,
      },
      newerHeadWinsBeforeAttempt: true,
    });

    assert.deepEqual(await new ActionSuccessorRecoverySweep(h.deps).recoverDispatch(h.current()), {
      outcome: 'failed',
      reason: 'terminal_predicate_mismatch',
    });
    assert.deepEqual(h.events, ['freshness', 'attempt', 'newer-head-cas']);
    assert.deepEqual(h.sideEffects, { messages: 0, queueEntries: 0, invocations: 0 });
  });

  test('a post-attempt newer-head retirement prevents carrier entry before the durable delivery reservation', async () => {
    const { ActionSuccessorRecoverySweep } = await loadSweep();
    const h = recoveryHarness({
      lease: reviewLease(),
      freshness: {
        status: 'verified',
        evidenceRef: `community:pr:owner/repo#42:head:${OLD_HEAD}`,
        freshnessKey: `head:${OLD_HEAD}`,
      },
      newerHeadWinsAfterAttempt: true,
    });

    assert.deepEqual(await new ActionSuccessorRecoverySweep(h.deps).recoverDispatch(h.current()), {
      outcome: 'failed',
      reason: 'terminal_predicate_mismatch',
    });
    assert.deepEqual(h.events, ['freshness', 'attempt', 'proposal', 'provenance', 'newer-head-cas', 'reserve']);
    assert.deepEqual(h.sideEffects, { messages: 0, queueEntries: 0, invocations: 0 });
  });
});
