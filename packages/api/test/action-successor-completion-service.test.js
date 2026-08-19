import assert from 'node:assert/strict';
import { it, mock } from 'node:test';

const { ActionSuccessorCompletionService } = await import(
  '../dist/domains/ball-custody/ActionSuccessorCompletionService.js'
);
const { claimActionSuccessor, commitActionCompletionVerdict, recordActionCompletionCandidate } = await import(
  '../dist/domains/ball-custody/action-successor-state-machine.js'
);
const { canonicalizeActionTerminalPredicate } = await import(
  '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js'
);

function createCompletionStates(mode = 'parallel') {
  const predicate = canonicalizeActionTerminalPredicate({
    actionFamily: 'review',
    subjectRef: 'pr:owner/repo#2868',
    predicate: { kind: 'review_delivered', headSha: 'cccccccccccccccccccccccccccccccccccccccc' },
  });
  const holderCatIds = mode === 'single' ? ['codex-terra'] : ['codex-terra', 'opus'];
  const claimed = claimActionSuccessor(null, {
    leaseId: 'lease-parallel',
    tenantScope: 'user-1',
    subjectRef: 'pr:owner/repo#2868',
    actionFamily: 'review',
    successorSlot: 'reviewer',
    mode,
    holderCatIds,
    ...(mode === 'parallel' ? { parallelIntent: 'independent_review' } : {}),
    dispatchId: 'dispatch-1',
    claimOrigin: 'structured_transfer',
    holderThreadId: 'thread-target',
    predecessorCatId: 'codex-sol',
    predecessorThreadId: 'thread-source',
    issuerStandingEvidenceRef: 'message:request-1',
    evidenceRefs: ['message:request-1'],
    terminalPredicate: predicate,
    now: 100,
  }).lease;
  const candidate = recordActionCompletionCandidate(claimed, {
    generation: 1,
    catId: 'codex-terra',
    evidenceRefs: ['community:pr:owner/repo#2868:review:terra'],
    now: 110,
  });
  const snapshot = candidate.completionCandidates['codex-terra'];
  const oneSucceeded = commitActionCompletionVerdict(candidate, {
    generation: 1,
    catId: 'codex-terra',
    verdict: {
      status: 'verified',
      evidenceRef: 'community:pr:owner/repo#2868:review:terra',
      predicateDigest: predicate.digest,
      freshnessKey: predicate.freshnessKey,
      candidateRevision: snapshot.candidateRevision,
      evidenceDigest: snapshot.evidenceDigest,
    },
    now: 111,
  });
  return { candidate, claimed, oneSucceeded, predicate };
}

it('treats a successful parallel holder completion replay as committed while peers remain active', async () => {
  const { oneSucceeded } = createCompletionStates();
  assert.equal(oneSucceeded.status, 'active');

  const leaseStore = {
    get: mock.fn(async () => oneSucceeded),
    recordCompletionCandidate: mock.fn(async () => ({ outcome: 'holder_outcome_exists', lease: oneSucceeded })),
    commitCompletionVerdict: mock.fn(),
  };
  const truthResolver = { resolveCompletion: mock.fn() };
  const service = new ActionSuccessorCompletionService(leaseStore, truthResolver);

  assert.deepEqual(
    await service.complete({
      leaseId: 'lease-parallel',
      generation: 1,
      catId: 'codex-terra',
      evidenceRefs: ['community:pr:owner/repo#2868:review:terra'],
      now: 120,
    }),
    { outcome: 'committed', leaseId: 'lease-parallel', generation: 1 },
  );
  assert.equal(leaseStore.recordCompletionCandidate.mock.calls.length, 0);
  assert.equal(truthResolver.resolveCompletion.mock.calls.length, 0);
});

it('treats a candidate CAS loss to exact same-generation success as committed', async () => {
  const { claimed, oneSucceeded } = createCompletionStates('single');
  assert.equal(oneSucceeded.status, 'completed');

  const leaseStore = {
    get: mock.fn(async () => claimed),
    recordCompletionCandidate: mock.fn(async () => ({ outcome: 'lease_not_active', lease: oneSucceeded })),
    commitCompletionVerdict: mock.fn(),
  };
  const truthResolver = { resolveCompletion: mock.fn() };
  const service = new ActionSuccessorCompletionService(leaseStore, truthResolver);

  assert.deepEqual(
    await service.complete({
      leaseId: 'lease-parallel',
      generation: 1,
      catId: 'codex-terra',
      evidenceRefs: ['community:pr:owner/repo#2868:review:terra'],
      now: 120,
    }),
    { outcome: 'committed', leaseId: 'lease-parallel', generation: 1 },
  );
  assert.equal(truthResolver.resolveCompletion.mock.calls.length, 0);
  assert.equal(leaseStore.commitCompletionVerdict.mock.calls.length, 0);
});

it('treats a verdict CAS loss to exact same-generation success as committed', async () => {
  const { candidate, claimed, oneSucceeded, predicate } = createCompletionStates();
  const snapshot = candidate.completionCandidates['codex-terra'];
  const leaseStore = {
    get: mock.fn(async () => claimed),
    recordCompletionCandidate: mock.fn(async () => ({ outcome: 'recorded', lease: candidate })),
    commitCompletionVerdict: mock.fn(async () => ({ outcome: 'holder_outcome_exists', lease: oneSucceeded })),
  };
  const truthResolver = {
    resolveCompletion: mock.fn(async () => ({
      status: 'verified',
      evidenceRef: 'community:pr:owner/repo#2868:review:terra',
      predicateDigest: predicate.digest,
      freshnessKey: predicate.freshnessKey,
      candidateRevision: snapshot.candidateRevision,
      evidenceDigest: snapshot.evidenceDigest,
    })),
  };
  const service = new ActionSuccessorCompletionService(leaseStore, truthResolver);

  assert.deepEqual(
    await service.complete({
      leaseId: 'lease-parallel',
      generation: 1,
      catId: 'codex-terra',
      evidenceRefs: ['community:pr:owner/repo#2868:review:terra'],
      now: 120,
    }),
    { outcome: 'committed', leaseId: 'lease-parallel', generation: 1 },
  );
});

it('resolves and commits the exact holder candidate snapshot', async () => {
  const { candidate, claimed, oneSucceeded, predicate } = createCompletionStates('single');
  const snapshot = candidate.completionCandidates['codex-terra'];
  const leaseStore = {
    get: mock.fn(async () => claimed),
    recordCompletionCandidate: mock.fn(async () => ({ outcome: 'recorded', lease: candidate })),
    commitCompletionVerdict: mock.fn(async (_leaseId, input) => {
      assert.equal(input.verdict.candidateRevision, snapshot.candidateRevision);
      assert.equal(input.verdict.evidenceDigest, snapshot.evidenceDigest);
      return { outcome: 'committed', lease: oneSucceeded };
    }),
  };
  const truthResolver = {
    resolveCompletion: mock.fn(async (_predicate, candidateSnapshot, context) => {
      assert.deepEqual(candidateSnapshot, snapshot);
      assert.deepEqual(context, {
        leaseId: 'lease-parallel',
        generation: 1,
        catId: 'codex-terra',
        holderThreadId: 'thread-target',
        predecessorCatId: 'codex-sol',
        predecessorThreadId: 'thread-source',
        tenantScope: 'user-1',
      });
      return {
        status: 'verified',
        evidenceRef: snapshot.evidenceRefs[0],
        predicateDigest: predicate.digest,
        freshnessKey: predicate.freshnessKey,
        candidateRevision: snapshot.candidateRevision,
        evidenceDigest: snapshot.evidenceDigest,
      };
    }),
  };
  const service = new ActionSuccessorCompletionService(leaseStore, truthResolver);

  assert.deepEqual(
    await service.complete({
      leaseId: 'lease-parallel',
      generation: 1,
      catId: 'codex-terra',
      evidenceRefs: snapshot.evidenceRefs,
      now: 120,
    }),
    { outcome: 'committed', leaseId: 'lease-parallel', generation: 1 },
  );
  assert.equal(truthResolver.resolveCompletion.mock.calls.length, 1);
});
