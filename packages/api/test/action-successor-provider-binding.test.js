import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalizeActionTerminalPredicate } from '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js';
import { parseActionSuccessorLease } from '../dist/domains/ball-custody/action-successor-redis-codecs.js';
import {
  claimActionSuccessor,
  commitActionCompletionVerdict,
  continueActionSuccessorFreshRevision,
  recordActionCompletionCandidate,
  recordActionSuccessorOutcome,
  replaceActionSuccessor,
  returnActionSuccessorToPredecessor,
} from '../dist/domains/ball-custody/action-successor-state-machine.js';

const predicate = (head = 'a') =>
  canonicalizeActionTerminalPredicate({
    actionFamily: 'review',
    subjectRef: 'pr:owner/repo#42',
    predicate: { kind: 'review_delivered', headSha: head.repeat(40) },
  });
const binding = (instance = 'installation-1') => ({
  pluginInstanceId: instance,
  packageDigest: 'b'.repeat(64),
  featureId: 'review',
  contributionId: 'review-truth',
  freshnessMethod: 'review.freshness',
  completionMethod: 'review.completion',
  grantRevision: 3,
  lifecycleRevision: 4,
  tenantScope: 'owner',
  installationProjectRoot: '/isolated/project',
});
const claim = (overrides = {}) => ({
  leaseId: 'lease-1',
  tenantScope: 'owner',
  subjectRef: 'pr:owner/repo#42',
  actionFamily: 'review',
  successorSlot: 'reviewer',
  mode: 'single',
  holderCatIds: ['reviewer'],
  holderThreadId: 'review-thread',
  dispatchId: 'dispatch-1',
  claimOrigin: 'structured_transfer',
  predecessorCatId: 'author',
  predecessorThreadId: 'author-thread',
  issuerStandingEvidenceRef: 'message:request',
  evidenceRefs: ['message:request'],
  terminalPredicate: predicate(),
  now: 100,
  ...overrides,
});
const replacement = (overrides = {}) => ({
  expectedGeneration: 1,
  holderCatIds: ['replacement'],
  holderThreadId: 'replacement-thread',
  dispatchId: 'dispatch-2',
  terminalPredicate: predicate(),
  predecessorCatId: 'author',
  predecessorThreadId: 'author-thread',
  evidenceRef: 'message:replacement',
  now: 110,
  ...overrides,
});
function boundLease() {
  // A persisted fixture ensures later tests reach their own transition even while claim is RED.
  return { ...claimActionSuccessor(null, claim()).lease, terminalPredicateProviderBinding: binding() };
}
function replaceable() {
  return recordActionSuccessorOutcome(boundLease(), {
    generation: 1,
    catId: 'reviewer',
    outcome: 'unavailable',
    evidenceRef: 'delivery:unavailable',
    now: 105,
  });
}
function completed() {
  const evidenceRef = 'github:https://github.com/owner/repo/pull/42#pullrequestreview-123';
  const lease = recordActionCompletionCandidate(boundLease(), {
    generation: 1,
    catId: 'reviewer',
    evidenceRefs: [evidenceRef],
    now: 105,
  });
  const candidate = lease.completionCandidates.reviewer;
  return commitActionCompletionVerdict(lease, {
    generation: 1,
    catId: 'reviewer',
    now: 106,
    verdict: {
      status: 'verified',
      evidenceRef,
      predicateDigest: lease.terminalPredicate.digest,
      freshnessKey: lease.terminalPredicate.freshnessKey,
      candidateRevision: candidate.candidateRevision,
      evidenceDigest: candidate.evidenceDigest,
    },
  });
}

test('claim persists a detached provider binding with its generation', () => {
  const inputBinding = binding();
  const lease = claimActionSuccessor(null, claim({ terminalPredicateProviderBinding: inputBinding })).lease;
  assert.deepEqual(lease.terminalPredicateProviderBinding, binding());
  inputBinding.grantRevision = 99;
  assert.equal(lease.terminalPredicateProviderBinding.grantRevision, 3);
});

test('same-dispatch replay rejects a different provider installation', () => {
  const result = claimActionSuccessor(
    boundLease(),
    claim({
      terminalPredicateProviderBinding: binding('installation-2'),
    }),
  );
  assert.equal(result.outcome, 'replay_mismatch');
});

test('replacement persists the newly admitted provider, not the preceding generation binding', () => {
  const next = binding('installation-2');
  const result = replaceActionSuccessor(replaceable(), replacement({ terminalPredicateProviderBinding: next }));
  assert.equal(result.outcome, 'replaced');
  assert.equal(result.lease.generation, 2);
  assert.deepEqual(result.lease.terminalPredicateProviderBinding, next);
  next.grantRevision = 99;
  assert.equal(result.lease.terminalPredicateProviderBinding.grantRevision, 3);
});

test('a bound generation cannot be replaced without freshly admitted binding', () => {
  assert.throws(() => replaceActionSuccessor(replaceable(), replacement()), /provider binding/i);
});

test('fresh revision persists the selected provider with the new lease', () => {
  const result = continueActionSuccessorFreshRevision(completed(), {
    successorLeaseId: 'lease-2',
    expectedGeneration: 1,
    terminalPredicate: predicate('c'),
    terminalPredicateProviderBinding: binding('installation-2'),
    holderCatIds: ['reviewer'],
    holderThreadId: 'review-thread',
    claimOrigin: 'structured_transfer',
    predecessorCatId: 'author',
    predecessorThreadId: 'author-thread',
    dispatchId: 'dispatch-2',
    issuerStandingEvidenceRef: 'message:request-2',
    evidenceRef: 'github:head-c',
    now: 120,
  });
  assert.equal(result.outcome, 'continued');
  assert.equal(result.lease.leaseId, 'lease-2');
  assert.deepEqual(result.lease.terminalPredicateProviderBinding, binding('installation-2'));
});

test('binding survives persisted JSON round trip, but malformed or cross-tenant bindings reject', () => {
  assert.deepEqual(parseActionSuccessorLease(JSON.stringify(boundLease())).terminalPredicateProviderBinding, binding());
  for (const bad of [
    { ...binding(), grantRevision: 0 },
    { ...binding(), lifecycleRevision: 1.5 },
    { ...binding(), pluginInstanceId: '' },
    { ...binding(), tenantScope: 'someone-else' },
    { ...binding(), installationProjectRoot: '' },
    { ...binding(), injectedCallback: 'other' },
    null,
  ]) {
    assert.throws(
      () =>
        parseActionSuccessorLease(
          JSON.stringify({
            ...boundLease(),
            terminalPredicateProviderBinding: bad,
          }),
        ),
      /provider binding/i,
    );
  }
});

test('legacy unbound records stay unbound instead of guessing the current installation', () => {
  const lease = claimActionSuccessor(null, claim()).lease;
  assert.equal(parseActionSuccessorLease(JSON.stringify(lease)).terminalPredicateProviderBinding, undefined);
});

test('returned-holder reattachment requires and stores a new binding', () => {
  const returned = returnActionSuccessorToPredecessor(boundLease(), {
    expectedGeneration: 1,
    rejectingCatId: 'reviewer',
    rejectingThreadId: 'review-thread',
    dispatchId: 'return-1',
    groundingEvidenceRef: 'message:wrong-owner',
    now: 110,
  });
  assert.equal(returned.outcome, 'returned');
  assert.deepEqual(returned.lease.terminalPredicateProviderBinding, binding());
  const input = replacement({
    expectedGeneration: 2,
    terminalPredicate: predicate('c'),
    returnedHolderCatId: 'author',
    returnedHolderThreadId: 'author-thread',
    freshnessEvidenceRef: 'github:head-c',
    returnProof: { kind: 'returned_fence', leaseId: returned.lease.leaseId, generation: 2 },
  });
  assert.throws(() => replaceActionSuccessor(returned.lease, input), /provider binding/i);
  const next = replaceActionSuccessor(returned.lease, {
    ...input,
    terminalPredicateProviderBinding: binding('installation-2'),
  });
  assert.equal(next.outcome, 'reattached');
  assert.equal(next.lease.generation, 3);
  assert.deepEqual(next.lease.terminalPredicateProviderBinding, binding('installation-2'));
});

test('claim refuses cross-tenant or malformed bindings before creating custody', () => {
  for (const bad of [{ ...binding(), tenantScope: 'other' }, { ...binding(), grantRevision: 0 }, null]) {
    assert.throws(
      () => claimActionSuccessor(null, claim({ terminalPredicateProviderBinding: bad })),
      /provider binding/i,
    );
  }
});

test('a fresh revision cannot downgrade a bound lease to an unbound lease', () => {
  assert.throws(
    () =>
      continueActionSuccessorFreshRevision(completed(), {
        successorLeaseId: 'lease-2',
        expectedGeneration: 1,
        terminalPredicate: predicate('c'),
        holderCatIds: ['reviewer'],
        holderThreadId: 'review-thread',
        claimOrigin: 'structured_transfer',
        predecessorCatId: 'author',
        predecessorThreadId: 'author-thread',
        dispatchId: 'dispatch-2',
        issuerStandingEvidenceRef: 'message:request-2',
        evidenceRef: 'github:head-c',
        now: 120,
      }),
    /provider binding/i,
  );
});
