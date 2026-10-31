/**
 * F167 × F322 — P1-2: Delegate authority evidence must propagate through
 * ALL three admission paths (claim, replacement, continuation).
 *
 * Claim-path evidence was already tested in f167-delegate-admission.test.js.
 * This file covers the replacement and continuation state machines, verifying
 * that `delegateEvidenceRef` ends up in the output lease's `evidenceRefs`.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  APPROVED_DELEGATE,
  CHILD_CAT,
  CHILD_THREAD,
  OWNER_CAT,
  OWNER_THREAD,
  SUBJECT_REF,
  TASK_ID,
  TENANT,
} from './f167-delegate-test-helpers.js';

const { replaceActionSuccessor } = await import(
  '../dist/domains/ball-custody/action-successor-replacement-state-machine.js'
);
const { continueActionSuccessorFreshRevision } = await import(
  '../dist/domains/ball-custody/action-successor-completion-state-machine.js'
);
const { reattachReturnedActionSuccessor } = await import(
  '../dist/domains/ball-custody/action-successor-return-state-machine.js'
);

// ── Shared test fixtures ──

const IDENTITY_KEY = [TENANT, SUBJECT_REF, 'implement', 'implementer'].join('\u001f');
const DELEGATE_EVIDENCE_REF = APPROVED_DELEGATE.evidenceRef;

const TERMINAL_PREDICATE = {
  kind: 'task_done',
  subjectRef: SUBJECT_REF,
  identityKey: `task_done\u001f${SUBJECT_REF}`,
  freshnessKey: `task:${TASK_ID}`,
  digest: 'test-digest',
};

/** Base active lease for replacement tests. */
function makeActiveLease(overrides = {}) {
  return {
    leaseId: 'lease-original',
    key: IDENTITY_KEY,
    tenantScope: TENANT,
    subjectRef: SUBJECT_REF,
    actionFamily: 'implement',
    successorSlot: 'implementer',
    mode: 'single',
    holderCatIds: [CHILD_CAT],
    holderThreadId: CHILD_THREAD,
    claimOrigin: 'existing_standing',
    issuerStandingEvidenceRef: 'standing:original',
    dispatchId: 'dispatch:original',
    generation: 1,
    status: 'replaceable',
    holderOutcomes: {},
    terminalPredicateState: { kind: 'predicate_backed' },
    terminalPredicate: TERMINAL_PREDICATE,
    completionCandidates: {},
    evidenceRefs: ['evidence:original'],
    returnTransitions: [],
    revision: 1,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

/** Base completed lease for continuation tests. */
function makeCompletedLease(overrides = {}) {
  return {
    ...makeActiveLease(),
    status: 'completed',
    terminalPredicate: {
      ...TERMINAL_PREDICATE,
      freshnessKey: 'task:old-revision', // stale — triggers continuation
    },
    ...overrides,
  };
}

describe('F167 P1-2 — delegate evidence propagation in replacement state machine', () => {
  test('delegateEvidenceRef is included in replaced lease evidenceRefs', () => {
    const current = makeActiveLease();
    const result = replaceActionSuccessor(current, {
      expectedGeneration: 1,
      holderCatIds: [CHILD_CAT],
      holderThreadId: CHILD_THREAD,
      dispatchId: 'dispatch:replacement',
      terminalPredicate: TERMINAL_PREDICATE,
      evidenceRef: 'evidence:replacement',
      claimOrigin: 'existing_standing',
      issuerStandingEvidenceRef: 'standing:replacement',
      delegateEvidenceRef: DELEGATE_EVIDENCE_REF,
      now: 300,
    });

    assert.equal(result.outcome, 'replaced');
    assert.ok(
      result.lease.evidenceRefs.includes(DELEGATE_EVIDENCE_REF),
      `replaced lease must include delegateEvidenceRef '${DELEGATE_EVIDENCE_REF}', got: ${JSON.stringify(result.lease.evidenceRefs)}`,
    );
  });

  test('replacement without delegateEvidenceRef does not include it (canonical owner)', () => {
    const current = makeActiveLease();
    const result = replaceActionSuccessor(current, {
      expectedGeneration: 1,
      holderCatIds: [CHILD_CAT],
      holderThreadId: CHILD_THREAD,
      dispatchId: 'dispatch:replacement',
      terminalPredicate: TERMINAL_PREDICATE,
      evidenceRef: 'evidence:replacement',
      claimOrigin: 'existing_standing',
      issuerStandingEvidenceRef: 'standing:replacement',
      // no delegateEvidenceRef — canonical owner path
      now: 300,
    });

    assert.equal(result.outcome, 'replaced');
    assert.ok(
      !result.lease.evidenceRefs.some((ref) => ref.startsWith('proposal:')),
      'canonical owner replacement should not contain proposal evidence',
    );
  });

  test('delegate evidence is deduplicated in replaced lease', () => {
    const current = makeActiveLease({ evidenceRefs: [DELEGATE_EVIDENCE_REF, 'evidence:original'] });
    const result = replaceActionSuccessor(current, {
      expectedGeneration: 1,
      holderCatIds: [CHILD_CAT],
      holderThreadId: CHILD_THREAD,
      dispatchId: 'dispatch:replacement',
      terminalPredicate: TERMINAL_PREDICATE,
      evidenceRef: 'evidence:replacement',
      claimOrigin: 'existing_standing',
      issuerStandingEvidenceRef: 'standing:replacement',
      delegateEvidenceRef: DELEGATE_EVIDENCE_REF,
      now: 300,
    });

    assert.equal(result.outcome, 'replaced');
    const delegateCount = result.lease.evidenceRefs.filter((ref) => ref === DELEGATE_EVIDENCE_REF).length;
    assert.equal(delegateCount, 1, 'delegate evidence must appear exactly once (deduplicated)');
  });
});

describe('F167 P1-2 — delegate evidence propagation in continuation state machine', () => {
  test('delegateEvidenceRef is included in continued lease evidenceRefs', () => {
    const current = makeCompletedLease();
    const result = continueActionSuccessorFreshRevision(current, {
      successorLeaseId: 'lease-continued',
      expectedGeneration: 1,
      terminalPredicate: TERMINAL_PREDICATE,
      holderCatIds: [CHILD_CAT],
      holderThreadId: CHILD_THREAD,
      claimOrigin: 'existing_standing',
      dispatchId: 'dispatch:continuation',
      issuerStandingEvidenceRef: 'standing:continuation',
      evidenceRef: 'evidence:continuation',
      delegateEvidenceRef: DELEGATE_EVIDENCE_REF,
      now: 400,
    });

    assert.equal(result.outcome, 'continued');
    assert.ok(
      result.lease.evidenceRefs.includes(DELEGATE_EVIDENCE_REF),
      `continued lease must include delegateEvidenceRef '${DELEGATE_EVIDENCE_REF}', got: ${JSON.stringify(result.lease.evidenceRefs)}`,
    );
  });

  test('continuation without delegateEvidenceRef does not include it (canonical owner)', () => {
    const current = makeCompletedLease();
    const result = continueActionSuccessorFreshRevision(current, {
      successorLeaseId: 'lease-continued',
      expectedGeneration: 1,
      terminalPredicate: TERMINAL_PREDICATE,
      holderCatIds: [CHILD_CAT],
      holderThreadId: CHILD_THREAD,
      claimOrigin: 'existing_standing',
      dispatchId: 'dispatch:continuation',
      issuerStandingEvidenceRef: 'standing:continuation',
      evidenceRef: 'evidence:continuation',
      // no delegateEvidenceRef
      now: 400,
    });

    assert.equal(result.outcome, 'continued');
    assert.ok(
      !result.lease.evidenceRefs.some((ref) => ref.startsWith('proposal:')),
      'canonical owner continuation should not contain proposal evidence',
    );
  });

  test('delegate evidence is deduplicated in continued lease', () => {
    const current = makeCompletedLease();
    const result = continueActionSuccessorFreshRevision(current, {
      successorLeaseId: 'lease-continued',
      expectedGeneration: 1,
      terminalPredicate: TERMINAL_PREDICATE,
      holderCatIds: [CHILD_CAT],
      holderThreadId: CHILD_THREAD,
      claimOrigin: 'existing_standing',
      dispatchId: 'dispatch:continuation',
      issuerStandingEvidenceRef: DELEGATE_EVIDENCE_REF, // same as delegate ref
      evidenceRef: 'evidence:continuation',
      delegateEvidenceRef: DELEGATE_EVIDENCE_REF,
      now: 400,
    });

    assert.equal(result.outcome, 'continued');
    const delegateCount = result.lease.evidenceRefs.filter((ref) => ref === DELEGATE_EVIDENCE_REF).length;
    assert.equal(delegateCount, 1, 'delegate evidence must appear exactly once (deduplicated)');
  });
});

// ── Reattach path ──

/**
 * Returned-holder lease: CHILD_CAT held the ball, returned it to OWNER_CAT.
 * OWNER_CAT now reattaches (re-dispatches). The lease is in the returned state
 * where isReturnedActionSuccessorHolderGeneration returns true.
 */
function makeReturnedLease(overrides = {}) {
  const RETURN_TRANSITION = {
    outcome: 'rejected_ownership',
    fromGeneration: 1,
    toGeneration: 2,
    rejectingCatId: CHILD_CAT,
    rejectingThreadId: CHILD_THREAD,
    predecessorCatId: OWNER_CAT,
    predecessorThreadId: OWNER_THREAD,
    groundingEvidenceRef: 'evidence:return-grounding',
    at: 200,
  };
  return {
    leaseId: 'lease-original',
    key: IDENTITY_KEY,
    tenantScope: TENANT,
    subjectRef: SUBJECT_REF,
    actionFamily: 'implement',
    successorSlot: 'implementer',
    mode: 'single',
    holderCatIds: [OWNER_CAT],
    holderThreadId: OWNER_THREAD,
    predecessorCatId: CHILD_CAT,
    predecessorThreadId: CHILD_THREAD,
    claimOrigin: 'structured_transfer',
    issuerStandingEvidenceRef: 'evidence:return-grounding',
    dispatchId: 'dispatch:returned',
    generation: 2,
    status: 'active',
    holderOutcomes: {},
    terminalPredicateState: { kind: 'predicate_backed' },
    terminalPredicate: TERMINAL_PREDICATE,
    completionCandidates: {},
    evidenceRefs: ['evidence:original', 'evidence:return-grounding'],
    returnTransitions: [RETURN_TRANSITION],
    returnDeliveryState: 'delivered',
    returnDeliveryEvidenceRef: 'evidence:return-grounding',
    revision: 2,
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

const RETURN_PROOF = { kind: 'returned_fence', leaseId: 'lease-original', generation: 2 };

describe('F167 P1-2 — delegate evidence propagation in reattach state machine', () => {
  test('delegateEvidenceRef is included in reattached lease evidenceRefs', () => {
    const current = makeReturnedLease();
    const result = reattachReturnedActionSuccessor(current, {
      expectedGeneration: 2,
      holderCatIds: [CHILD_CAT],
      holderThreadId: CHILD_THREAD,
      dispatchId: 'dispatch:reattach',
      terminalPredicate: TERMINAL_PREDICATE,
      evidenceRef: 'evidence:reattach',
      freshnessEvidenceRef: 'freshness:reattach',
      delegateEvidenceRef: DELEGATE_EVIDENCE_REF,
      returnedHolderCatId: OWNER_CAT,
      returnedHolderThreadId: OWNER_THREAD,
      returnProof: RETURN_PROOF,
      now: 500,
    });

    assert.equal(result.outcome, 'reattached');
    assert.ok(
      result.lease.evidenceRefs.includes(DELEGATE_EVIDENCE_REF),
      `reattached lease must include delegateEvidenceRef '${DELEGATE_EVIDENCE_REF}', got: ${JSON.stringify(result.lease.evidenceRefs)}`,
    );
  });

  test('reattach without delegateEvidenceRef does not include it (canonical owner)', () => {
    const current = makeReturnedLease();
    const result = reattachReturnedActionSuccessor(current, {
      expectedGeneration: 2,
      holderCatIds: [CHILD_CAT],
      holderThreadId: CHILD_THREAD,
      dispatchId: 'dispatch:reattach',
      terminalPredicate: TERMINAL_PREDICATE,
      evidenceRef: 'evidence:reattach',
      freshnessEvidenceRef: 'freshness:reattach',
      // no delegateEvidenceRef — canonical owner path
      returnedHolderCatId: OWNER_CAT,
      returnedHolderThreadId: OWNER_THREAD,
      returnProof: RETURN_PROOF,
      now: 500,
    });

    assert.equal(result.outcome, 'reattached');
    assert.ok(
      !result.lease.evidenceRefs.some((ref) => ref.startsWith('proposal:')),
      'canonical owner reattach should not contain proposal evidence',
    );
  });

  test('delegate evidence is deduplicated in reattached lease', () => {
    const current = makeReturnedLease({ evidenceRefs: [DELEGATE_EVIDENCE_REF, 'evidence:original'] });
    const result = reattachReturnedActionSuccessor(current, {
      expectedGeneration: 2,
      holderCatIds: [CHILD_CAT],
      holderThreadId: CHILD_THREAD,
      dispatchId: 'dispatch:reattach',
      terminalPredicate: TERMINAL_PREDICATE,
      evidenceRef: 'evidence:reattach',
      freshnessEvidenceRef: 'freshness:reattach',
      delegateEvidenceRef: DELEGATE_EVIDENCE_REF,
      returnedHolderCatId: OWNER_CAT,
      returnedHolderThreadId: OWNER_THREAD,
      returnProof: RETURN_PROOF,
      now: 500,
    });

    assert.equal(result.outcome, 'reattached');
    const delegateCount = result.lease.evidenceRefs.filter((ref) => ref === DELEGATE_EVIDENCE_REF).length;
    assert.equal(delegateCount, 1, 'delegate evidence must appear exactly once (deduplicated)');
  });
});
