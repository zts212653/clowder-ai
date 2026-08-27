import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
  claimActionSuccessor,
  commitActionCompletionVerdict,
  continueActionSuccessorFreshRevision,
  markActionSuccessorReturnDelivered,
  preflightActionSuccessor,
  recordActionCompletionCandidate,
  recordActionSuccessorReturnDeliveryAttempt,
  recordActionSuccessorOutcome,
  replaceActionSuccessor,
  returnActionSuccessorToPredecessor,
} = await import('../dist/domains/ball-custody/action-successor-state-machine.js');
const { canonicalizeActionTerminalPredicate } = await import(
  '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js'
);
const { parseActionSuccessorLease } = await import('../dist/domains/ball-custody/action-successor-redis-codecs.js');

const reviewPredicate = (headSha) =>
  canonicalizeActionTerminalPredicate({
    actionFamily: 'review',
    subjectRef: 'pr:owner/repo#2868',
    predicate: { kind: 'review_delivered', headSha },
  });

const baseClaim = (overrides = {}) => ({
  leaseId: 'lease-1',
  tenantScope: 'user-1',
  subjectRef: 'pr:owner/repo#2868',
  actionFamily: 'merge',
  successorSlot: 'reviewer',
  mode: 'single',
  holderCatIds: ['codex-terra'],
  dispatchId: 'dispatch-1',
  claimOrigin: 'structured_transfer',
  holderThreadId: 'thread-target',
  predecessorCatId: 'codex-sol',
  predecessorThreadId: 'thread-source',
  issuerStandingEvidenceRef: 'message:request-1',
  evidenceRefs: ['message:request-1'],
  terminalPredicate: reviewPredicate('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  now: 100,
  ...overrides,
});

const verifiedCompletionVerdict = (lease, catId, evidenceRef, predicate = lease.terminalPredicate) => {
  const candidate = lease.completionCandidates[catId];
  return {
    status: 'verified',
    evidenceRef,
    predicateDigest: predicate.digest,
    freshnessKey: predicate.freshnessKey,
    candidateRevision: candidate.candidateRevision,
    evidenceDigest: candidate.evidenceDigest,
  };
};

describe('F167 Phase S action successor state machine', () => {
  it('rejects a new predicate-free lease instead of manufacturing a legacy generation', () => {
    assert.throws(
      () => claimActionSuccessor(null, baseClaim({ actionFamily: 'review', terminalPredicate: undefined })),
      /terminal predicate is required for a new action successor generation/,
    );
  });

  it('requires machine evidence before a verified completion verdict can end the action', () => {
    const lease = claimActionSuccessor(
      null,
      baseClaim({
        actionFamily: 'review',
        terminalPredicate: reviewPredicate('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      }),
    ).lease;

    assert.throws(
      () =>
        recordActionCompletionCandidate(lease, {
          generation: 1,
          catId: 'codex-terra',
          evidenceRefs: ['queue:dispatch-1:codex-terra:succeeded'],
          now: 110,
        }),
      /machine-checkable completion evidence/,
    );

    const candidate = recordActionCompletionCandidate(lease, {
      generation: 1,
      catId: 'codex-terra',
      evidenceRefs: ['community:pr:owner/repo#2868:review:g1'],
      now: 111,
    });
    assert.equal(candidate.status, 'active');
    assert.deepEqual(candidate.completionCandidates['codex-terra'].evidenceRefs, [
      'community:pr:owner/repo#2868:review:g1',
    ]);

    assert.throws(
      () =>
        commitActionCompletionVerdict(candidate, {
          generation: 1,
          catId: 'codex-terra',
          verdict: { status: 'mismatch', reason: 'HEAD moved' },
          now: 112,
        }),
      /verified completion verdict/,
    );

    const completed = commitActionCompletionVerdict(candidate, {
      generation: 1,
      catId: 'codex-terra',
      verdict: verifiedCompletionVerdict(candidate, 'codex-terra', 'community:pr:owner/repo#2868:review:g1'),
      now: 113,
    });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.holderOutcomes['codex-terra'].outcome, 'succeeded');
  });

  it('unions holder evidence canonically and fences verdicts to the exact candidate snapshot', () => {
    const predicate = reviewPredicate('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    const claimed = claimActionSuccessor(
      null,
      baseClaim({ actionFamily: 'review', terminalPredicate: predicate }),
    ).lease;
    const first = recordActionCompletionCandidate(claimed, {
      generation: 1,
      catId: 'codex-terra',
      evidenceRefs: [
        'github:https://github.com/owner/repo/pull/2868#discussion_r2',
        'community:pr:owner/repo#2868:review:g1',
      ],
      now: 110,
    });
    const firstSnapshot = first.completionCandidates['codex-terra'];

    assert.deepEqual(firstSnapshot.evidenceRefs, [
      'community:pr:owner/repo#2868:review:g1',
      'github:https://github.com/owner/repo/pull/2868#discussion_r2',
    ]);
    assert.equal(firstSnapshot.candidateRevision, 1);
    assert.match(firstSnapshot.evidenceDigest, /^[0-9a-f]{64}$/);

    const replay = recordActionCompletionCandidate(first, {
      generation: 1,
      catId: 'codex-terra',
      evidenceRefs: [...firstSnapshot.evidenceRefs].reverse(),
      now: 111,
    });
    assert.equal(replay, first);

    const expanded = recordActionCompletionCandidate(replay, {
      generation: 1,
      catId: 'codex-terra',
      evidenceRefs: ['community:pr:owner/repo#2868:review:g2'],
      now: 112,
    });
    const expandedSnapshot = expanded.completionCandidates['codex-terra'];
    assert.deepEqual(expandedSnapshot.evidenceRefs, [
      'community:pr:owner/repo#2868:review:g1',
      'community:pr:owner/repo#2868:review:g2',
      'github:https://github.com/owner/repo/pull/2868#discussion_r2',
    ]);
    assert.equal(expandedSnapshot.candidateRevision, 2);
    assert.notEqual(expandedSnapshot.evidenceDigest, firstSnapshot.evidenceDigest);

    assert.throws(
      () =>
        commitActionCompletionVerdict(expanded, {
          generation: 1,
          catId: 'codex-terra',
          verdict: {
            status: 'verified',
            evidenceRef: firstSnapshot.evidenceRefs[0],
            predicateDigest: predicate.digest,
            freshnessKey: predicate.freshnessKey,
            candidateRevision: firstSnapshot.candidateRevision,
            evidenceDigest: firstSnapshot.evidenceDigest,
          },
          now: 113,
        }),
      /candidate changed/,
    );

    const completed = commitActionCompletionVerdict(expanded, {
      generation: 1,
      catId: 'codex-terra',
      verdict: {
        status: 'verified',
        evidenceRef: expandedSnapshot.evidenceRefs[1],
        predicateDigest: predicate.digest,
        freshnessKey: predicate.freshnessKey,
        candidateRevision: expandedSnapshot.candidateRevision,
        evidenceDigest: expandedSnapshot.evidenceDigest,
      },
      now: 114,
    });
    assert.equal(completed.holderOutcomes['codex-terra'].evidenceRef, expandedSnapshot.evidenceRefs[1]);
  });

  it('isolates completion candidates and commits per holder in parallel mode', () => {
    const predicate = reviewPredicate('cccccccccccccccccccccccccccccccccccccccc');
    const claimed = claimActionSuccessor(
      null,
      baseClaim({
        actionFamily: 'review',
        mode: 'parallel',
        holderCatIds: ['codex-terra', 'opus'],
        parallelIntent: 'independent_review',
        terminalPredicate: predicate,
      }),
    ).lease;
    const terraCandidate = recordActionCompletionCandidate(claimed, {
      generation: 1,
      catId: 'codex-terra',
      evidenceRefs: ['community:pr:owner/repo#2868:review:terra'],
      now: 110,
    });
    const bothCandidates = recordActionCompletionCandidate(terraCandidate, {
      generation: 1,
      catId: 'opus',
      evidenceRefs: ['community:pr:owner/repo#2868:review:opus'],
      now: 111,
    });

    assert.deepEqual(Object.keys(bothCandidates.completionCandidates).sort(), ['codex-terra', 'opus']);

    const terraCommitted = commitActionCompletionVerdict(bothCandidates, {
      generation: 1,
      catId: 'codex-terra',
      verdict: verifiedCompletionVerdict(
        bothCandidates,
        'codex-terra',
        'community:pr:owner/repo#2868:review:terra',
        predicate,
      ),
      now: 112,
    });
    assert.equal(terraCommitted.status, 'active');
    assert.equal(terraCommitted.completionCandidates['codex-terra'], undefined);
    assert.deepEqual(terraCommitted.completionCandidates.opus.evidenceRefs, [
      'community:pr:owner/repo#2868:review:opus',
    ]);

    const completed = commitActionCompletionVerdict(terraCommitted, {
      generation: 1,
      catId: 'opus',
      verdict: verifiedCompletionVerdict(terraCommitted, 'opus', 'community:pr:owner/repo#2868:review:opus', predicate),
      now: 113,
    });
    assert.equal(completed.status, 'completed');
    assert.deepEqual(completed.completionCandidates, {});
    assert.equal(completed.holderOutcomes['codex-terra'].outcome, 'succeeded');
    assert.equal(completed.holderOutcomes.opus.outcome, 'succeeded');
  });

  it('retires only the failed holder candidate and rejects a late verified verdict', () => {
    const predicate = reviewPredicate('dddddddddddddddddddddddddddddddddddddddd');
    const claimed = claimActionSuccessor(
      null,
      baseClaim({
        actionFamily: 'review',
        mode: 'parallel',
        holderCatIds: ['codex-terra', 'opus'],
        parallelIntent: 'independent_review',
        terminalPredicate: predicate,
      }),
    ).lease;
    const terraCandidate = recordActionCompletionCandidate(claimed, {
      generation: 1,
      catId: 'codex-terra',
      evidenceRefs: ['community:pr:owner/repo#2868:review:terra'],
      now: 110,
    });
    const bothCandidates = recordActionCompletionCandidate(terraCandidate, {
      generation: 1,
      catId: 'opus',
      evidenceRefs: ['community:pr:owner/repo#2868:review:opus'],
      now: 111,
    });
    const terraFailed = recordActionSuccessorOutcome(bothCandidates, {
      generation: 1,
      catId: 'codex-terra',
      outcome: 'failed',
      evidenceRef: 'runtime:terra:failed',
      now: 112,
    });

    assert.equal(terraFailed.completionCandidates['codex-terra'], undefined);
    assert.ok(terraFailed.completionCandidates.opus);
    assert.throws(
      () =>
        commitActionCompletionVerdict(terraFailed, {
          generation: 1,
          catId: 'codex-terra',
          verdict: verifiedCompletionVerdict(
            bothCandidates,
            'codex-terra',
            'community:pr:owner/repo#2868:review:terra',
            predicate,
          ),
          now: 113,
        }),
      /holder already has a terminal outcome/,
    );
  });

  it('continues a completed lease on a server-verified fresh HEAD without changing its canonical key', () => {
    const oldPredicate = reviewPredicate('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const claimed = claimActionSuccessor(
      null,
      baseClaim({ actionFamily: 'review', terminalPredicate: oldPredicate }),
    ).lease;
    const candidate = recordActionCompletionCandidate(claimed, {
      generation: 1,
      catId: 'codex-terra',
      evidenceRefs: ['community:pr:owner/repo#2868:review:g1'],
      now: 110,
    });
    const completed = commitActionCompletionVerdict(candidate, {
      generation: 1,
      catId: 'codex-terra',
      verdict: verifiedCompletionVerdict(
        candidate,
        'codex-terra',
        'community:pr:owner/repo#2868:review:g1',
        oldPredicate,
      ),
      now: 111,
    });
    const newPredicate = reviewPredicate('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    const continued = continueActionSuccessorFreshRevision(completed, {
      successorLeaseId: 'lease-fresh-head-b',
      expectedGeneration: 1,
      terminalPredicate: newPredicate,
      holderCatIds: ['codex-terra'],
      holderThreadId: 'thread-target',
      claimOrigin: 'structured_transfer',
      predecessorCatId: 'codex-sol',
      predecessorThreadId: 'thread-source',
      dispatchId: 'dispatch-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      issuerStandingEvidenceRef: 'message:request-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      evidenceRef: 'community:pr:owner/repo#2868:head:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      reviewReentry: {
        reason: 'behavioral_delta',
        evidenceRef: 'git:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:authored-delta',
      },
      now: 120,
    });

    assert.equal(continued.outcome, 'continued');
    assert.equal(continued.lease.key, completed.key);
    assert.equal(continued.lease.leaseId, 'lease-fresh-head-b');
    assert.notEqual(continued.lease.leaseId, completed.leaseId);
    assert.equal(continued.lease.generation, 1);
    assert.equal(continued.lease.status, 'active');
    assert.deepEqual(continued.lease.holderOutcomes, {});
    assert.deepEqual(continued.lease.completionCandidates, {});
    assert.equal(continued.lease.terminalPredicate.freshnessKey, 'head:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    assert.ok(
      continued.lease.evidenceRefs.includes(
        'review-reentry:behavioral_delta:git:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:authored-delta',
      ),
    );
    assert.deepEqual(preflightActionSuccessor(completed, { generation: 1, subjectTerminal: false }), {
      ok: false,
      reason: 'lease_not_active',
    });
    assert.deepEqual(preflightActionSuccessor(continued.lease, { generation: 1, subjectTerminal: false }), {
      ok: true,
      reason: 'active',
    });
  });

  it('upgrades a completed legacy lease to a predicate-backed fresh generation', () => {
    const predicateBacked = claimActionSuccessor(null, baseClaim({ actionFamily: 'review' })).lease;
    const {
      terminalPredicate: _terminalPredicate,
      terminalPredicateState: _terminalPredicateState,
      ...persistedLegacy
    } = predicateBacked;
    const claimed = parseActionSuccessorLease(JSON.stringify(persistedLegacy));
    assert.ok(claimed);
    assert.deepEqual(claimed.terminalPredicateState, { kind: 'legacy_predicate_absent' });
    const completed = recordActionSuccessorOutcome(claimed, {
      generation: 1,
      catId: 'codex-terra',
      outcome: 'succeeded',
      evidenceRef: 'queue:legacy-dispatch:codex-terra:succeeded',
      now: 110,
    });
    const newPredicate = reviewPredicate('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

    const continued = continueActionSuccessorFreshRevision(completed, {
      successorLeaseId: 'lease-fresh-head-legacy',
      expectedGeneration: 1,
      terminalPredicate: newPredicate,
      holderCatIds: ['codex-terra'],
      holderThreadId: 'thread-target',
      claimOrigin: 'structured_transfer',
      predecessorCatId: 'codex-sol',
      predecessorThreadId: 'thread-source',
      dispatchId: 'dispatch-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      issuerStandingEvidenceRef: 'message:request-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      evidenceRef: 'community:pr:owner/repo#2868:head:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      now: 120,
    });

    assert.equal(continued.outcome, 'continued');
    assert.equal(continued.lease.leaseId, 'lease-fresh-head-legacy');
    assert.equal(continued.lease.generation, 1);
    assert.equal(continued.lease.status, 'active');
    assert.deepEqual(continued.lease.terminalPredicateState, { kind: 'predicate_backed' });
    assert.equal(continued.lease.terminalPredicate.digest, newPredicate.digest);
  });

  it('rebuilds claim provenance from the incoming fresh revision in both directions', () => {
    const complete = (claimOverrides, holderCatId) => {
      const predicate = reviewPredicate('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      const claimed = claimActionSuccessor(
        null,
        baseClaim({ actionFamily: 'review', terminalPredicate: predicate, ...claimOverrides }),
      ).lease;
      const candidate = recordActionCompletionCandidate(claimed, {
        generation: 1,
        catId: holderCatId,
        evidenceRefs: ['community:pr:owner/repo#2868:review:g1'],
        now: 110,
      });
      return commitActionCompletionVerdict(candidate, {
        generation: 1,
        catId: holderCatId,
        verdict: verifiedCompletionVerdict(candidate, holderCatId, 'community:pr:owner/repo#2868:review:g1', predicate),
        now: 111,
      });
    };

    const selfClaimed = complete(
      {
        holderCatIds: ['codex-sol'],
        holderThreadId: 'thread-source',
        claimOrigin: 'existing_standing',
        predecessorCatId: undefined,
        predecessorThreadId: undefined,
        issuerStandingEvidenceRef: 'grounding:verified-owner',
      },
      'codex-sol',
    );
    const transferred = continueActionSuccessorFreshRevision(selfClaimed, {
      successorLeaseId: 'lease-transferred-fresh-head',
      expectedGeneration: 1,
      terminalPredicate: reviewPredicate('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      holderCatIds: ['codex-terra'],
      holderThreadId: 'thread-target',
      claimOrigin: 'structured_transfer',
      predecessorCatId: 'codex-sol',
      predecessorThreadId: 'thread-source',
      dispatchId: 'dispatch-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      issuerStandingEvidenceRef: 'message:request-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      evidenceRef: 'community:pr:owner/repo#2868:head:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      now: 120,
    });

    assert.equal(transferred.outcome, 'continued');
    assert.equal(transferred.lease.claimOrigin, 'structured_transfer');
    assert.equal(transferred.lease.predecessorCatId, 'codex-sol');
    assert.equal(transferred.lease.predecessorThreadId, 'thread-source');

    const transferredClaim = complete({}, 'codex-terra');
    const selfContinued = continueActionSuccessorFreshRevision(transferredClaim, {
      successorLeaseId: 'lease-self-fresh-head',
      expectedGeneration: 1,
      terminalPredicate: reviewPredicate('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      holderCatIds: ['codex-sol'],
      holderThreadId: 'thread-source',
      claimOrigin: 'existing_standing',
      dispatchId: 'dispatch-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-self',
      issuerStandingEvidenceRef: 'grounding:verified-owner',
      evidenceRef: 'community:pr:owner/repo#2868:head:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      now: 121,
    });

    assert.equal(selfContinued.outcome, 'continued');
    assert.equal(selfContinued.lease.claimOrigin, 'existing_standing');
    assert.equal(selfContinued.lease.predecessorCatId, undefined);
    assert.equal(selfContinued.lease.predecessorThreadId, undefined);
  });
  it('claims once and replays the same dispatch idempotently', () => {
    const first = claimActionSuccessor(null, baseClaim());
    assert.equal(first.outcome, 'claimed');
    assert.equal(first.lease.generation, 1);

    const replay = claimActionSuccessor(first.lease, baseClaim({ leaseId: 'ignored-on-replay', now: 101 }));
    assert.equal(replay.outcome, 'replayed');
    assert.equal(replay.lease.leaseId, 'lease-1');
    assert.equal(replay.lease.generation, 1);
  });

  it('rejects a replay when the immutable holder payload changes', () => {
    const single = claimActionSuccessor(null, baseClaim()).lease;
    assert.equal(
      claimActionSuccessor(single, baseClaim({ leaseId: 'ignored', holderCatIds: ['codex'], now: 101 })).outcome,
      'replay_mismatch',
    );

    const parallelInput = baseClaim({
      mode: 'parallel',
      holderCatIds: ['opus', 'codex-terra'],
      parallelIntent: 'independent_review',
    });
    const parallel = claimActionSuccessor(null, parallelInput).lease;
    assert.equal(
      claimActionSuccessor(parallel, {
        ...parallelInput,
        leaseId: 'ignored',
        holderCatIds: ['codex-terra', 'opus'],
        now: 102,
      }).outcome,
      'replayed',
      'holder order is not part of the immutable set',
    );
    assert.equal(
      claimActionSuccessor(parallel, { ...parallelInput, leaseId: 'ignored', parallelIntent: 'debate', now: 103 })
        .outcome,
      'replay_mismatch',
    );
  });

  it('returns safe_wait when another dispatch tries to accumulate a successor', () => {
    const first = claimActionSuccessor(null, baseClaim()).lease;
    const conflict = claimActionSuccessor(
      first,
      baseClaim({ leaseId: 'lease-2', dispatchId: 'dispatch-2', holderCatIds: ['codex'], now: 110 }),
    );

    assert.equal(conflict.outcome, 'safe_wait');
    assert.deepEqual(conflict.lease.holderCatIds, ['codex-terra']);
    assert.equal(conflict.lease.generation, 1);
  });

  it('requires explicit parallel intent for more than one holder', () => {
    assert.throws(
      () => claimActionSuccessor(null, baseClaim({ holderCatIds: ['opus', 'codex-terra'] })),
      /single mode requires exactly one holder/,
    );
    assert.throws(
      () =>
        claimActionSuccessor(
          null,
          baseClaim({ mode: 'parallel', holderCatIds: ['opus', 'codex-terra'], parallelIntent: undefined }),
        ),
      /parallel mode requires explicit parallel intent/,
    );

    const parallel = claimActionSuccessor(
      null,
      baseClaim({
        mode: 'parallel',
        holderCatIds: ['opus', 'codex-terra'],
        parallelIntent: 'independent_review',
      }),
    );
    assert.equal(parallel.outcome, 'claimed');
    assert.deepEqual(parallel.lease.holderCatIds, ['opus', 'codex-terra']);
  });

  it('fails closed when a structured transfer omits its predecessor route', () => {
    assert.throws(
      () => claimActionSuccessor(null, baseClaim({ predecessorThreadId: undefined })),
      /structured transfer requires predecessor route and issuer standing evidence/,
    );
  });

  it('lets verified existing standing claim the same canonical identity without a predecessor', () => {
    const claimed = claimActionSuccessor(
      null,
      baseClaim({
        claimOrigin: 'existing_standing',
        predecessorCatId: undefined,
        predecessorThreadId: undefined,
      }),
    );
    assert.equal(claimed.outcome, 'claimed');
    assert.equal(claimed.lease.claimOrigin, 'existing_standing');

    const conflict = claimActionSuccessor(
      claimed.lease,
      baseClaim({
        leaseId: 'lease-2',
        dispatchId: 'dispatch-2',
        holderCatIds: ['gpt52'],
        now: 110,
      }),
    );
    assert.equal(conflict.outcome, 'safe_wait');
    assert.equal(conflict.lease.leaseId, claimed.lease.leaseId);
  });

  it('returns a rejected single lease to its persisted predecessor in one generation transition', () => {
    const first = claimActionSuccessor(null, baseClaim()).lease;
    const returned = returnActionSuccessorToPredecessor(first, {
      expectedGeneration: 1,
      rejectingCatId: 'codex-terra',
      rejectingThreadId: 'thread-target',
      dispatchId: 'return-1',
      groundingEvidenceRef: 'message:grounding-mismatch',
      now: 120,
    });

    assert.equal(returned.outcome, 'returned');
    assert.equal(returned.lease.generation, 2);
    assert.deepEqual(returned.lease.holderCatIds, ['codex-sol']);
    assert.equal(returned.lease.returnDeliveryState, 'pending');
    assert.equal(returned.lease.returnTransitions.length, 1);
    assert.deepEqual(returned.lease.returnTransitions[0], {
      outcome: 'rejected_ownership',
      fromGeneration: 1,
      toGeneration: 2,
      rejectingCatId: 'codex-terra',
      rejectingThreadId: 'thread-target',
      predecessorCatId: 'codex-sol',
      predecessorThreadId: 'thread-source',
      groundingEvidenceRef: 'message:grounding-mismatch',
      at: 120,
    });
    assert.equal(returned.lease.evidenceRefs.includes('message:grounding-mismatch'), true);

    const replay = returnActionSuccessorToPredecessor(returned.lease, {
      expectedGeneration: 1,
      rejectingCatId: 'codex-terra',
      rejectingThreadId: 'thread-target',
      dispatchId: 'return-1',
      groundingEvidenceRef: 'message:grounding-mismatch',
      now: 121,
    });
    assert.equal(replay.outcome, 'replayed');
    assert.equal(replay.lease, returned.lease);

    const stale = returnActionSuccessorToPredecessor(returned.lease, {
      expectedGeneration: 1,
      rejectingCatId: 'codex-terra',
      rejectingThreadId: 'thread-target',
      dispatchId: 'return-different',
      groundingEvidenceRef: 'message:duplicate',
      now: 121,
    });
    assert.equal(stale.outcome, 'stale_generation');
    assert.equal(stale.lease, returned.lease);
  });

  it('reattaches a returned holder to a fresh successor without opening ordinary active replacement', () => {
    const first = claimActionSuccessor(null, baseClaim()).lease;
    const returned = returnActionSuccessorToPredecessor(first, {
      expectedGeneration: 1,
      rejectingCatId: 'codex-terra',
      rejectingThreadId: 'thread-target',
      dispatchId: 'return-1',
      groundingEvidenceRef: 'message:grounding-mismatch',
      now: 120,
    }).lease;
    const freshPredicate = reviewPredicate('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

    const reattached = replaceActionSuccessor(returned, {
      expectedGeneration: 2,
      holderCatIds: ['gpt52'],
      holderThreadId: 'thread-review-next',
      predecessorCatId: 'codex-sol',
      predecessorThreadId: 'thread-source',
      dispatchId: 'dispatch-fresh-head',
      terminalPredicate: freshPredicate,
      evidenceRef: 'callback:returned-holder:dispatch-fresh-head',
      freshnessEvidenceRef: 'community:pr:owner/repo#2868:head:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      returnedHolderCatId: 'codex-sol',
      returnedHolderThreadId: 'thread-source',
      returnProof: { kind: 'returned_fence', leaseId: returned.leaseId, generation: 2 },
      now: 130,
    });

    assert.equal(reattached.outcome, 'reattached');
    assert.equal(reattached.lease.generation, 3);
    assert.deepEqual(reattached.lease.holderCatIds, ['gpt52']);
    assert.equal(reattached.lease.holderThreadId, 'thread-review-next');
    assert.equal(reattached.lease.predecessorCatId, 'codex-sol');
    assert.equal(reattached.lease.predecessorThreadId, 'thread-source');
    assert.equal(reattached.lease.terminalPredicate.digest, freshPredicate.digest);
    assert.deepEqual(reattached.lease.holderOutcomes, {});
    assert.deepEqual(reattached.lease.completionCandidates, {});
    assert.equal(reattached.lease.returnDeliveryState, undefined);
    assert.equal(reattached.lease.returnDeliveryEvidenceRef, undefined);
    assert.equal(reattached.lease.returnDeliveryAttemptCount, undefined);
    assert.equal(reattached.lease.returnDeliverySlaUntil, undefined);
    assert.equal(reattached.lease.returnDeliveryLastAttemptAt, undefined);
    assert.equal(reattached.lease.returnDeliveryOverdueObservedAt, undefined);
    assert.equal(reattached.lease.returnTransitions.length, 1);
    assert.ok(reattached.lease.evidenceRefs.includes('message:grounding-mismatch'));
    assert.ok(reattached.lease.evidenceRefs.includes('callback:returned-holder:dispatch-fresh-head'));
    assert.ok(
      reattached.lease.evidenceRefs.includes(
        'community:pr:owner/repo#2868:head:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      ),
    );

    const ordinaryActive = replaceActionSuccessor(first, {
      expectedGeneration: 1,
      holderCatIds: ['gpt52'],
      holderThreadId: 'thread-review-next',
      predecessorCatId: 'codex-sol',
      predecessorThreadId: 'thread-source',
      dispatchId: 'dispatch-not-returned',
      terminalPredicate: freshPredicate,
      evidenceRef: 'callback:not-returned',
      freshnessEvidenceRef: 'community:fresh',
      returnedHolderCatId: 'codex-sol',
      returnedHolderThreadId: 'thread-source',
      returnProof: { kind: 'returned_fence', leaseId: first.leaseId, generation: 1 },
      now: 131,
    });
    assert.equal(ordinaryActive.outcome, 'proof_required');
  });

  it('fails closed when returned-holder reattach proof, route, or generation state is stale', () => {
    const first = claimActionSuccessor(null, baseClaim()).lease;
    const returned = returnActionSuccessorToPredecessor(first, {
      expectedGeneration: 1,
      rejectingCatId: 'codex-terra',
      rejectingThreadId: 'thread-target',
      dispatchId: 'return-1',
      groundingEvidenceRef: 'message:grounding-mismatch',
      now: 120,
    }).lease;
    const freshPredicate = reviewPredicate('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    const replacement = (overrides = {}) => ({
      expectedGeneration: 2,
      holderCatIds: ['gpt52'],
      holderThreadId: 'thread-review-next',
      predecessorCatId: 'codex-sol',
      predecessorThreadId: 'thread-source',
      dispatchId: 'dispatch-fresh-head',
      terminalPredicate: freshPredicate,
      evidenceRef: 'callback:returned-holder:dispatch-fresh-head',
      freshnessEvidenceRef: 'community:fresh-head',
      returnedHolderCatId: 'codex-sol',
      returnedHolderThreadId: 'thread-source',
      returnProof: { kind: 'returned_fence', leaseId: returned.leaseId, generation: 2 },
      now: 130,
      ...overrides,
    });

    assert.equal(replaceActionSuccessor(returned, replacement({ expectedGeneration: 1 })).outcome, 'stale_generation');
    assert.equal(
      replaceActionSuccessor(returned, replacement({ returnedHolderThreadId: 'thread-wrong' })).outcome,
      'holder_mismatch',
    );
    assert.equal(
      replaceActionSuccessor(
        returned,
        replacement({ returnProof: { kind: 'returned_fence', leaseId: returned.leaseId, generation: 1 } }),
      ).outcome,
      'return_proof_required',
    );
    const wrongIdentityPredicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'implement',
      subjectRef: 'subject:task:task-1',
      predicate: { kind: 'task_done' },
    });
    assert.equal(
      replaceActionSuccessor(returned, replacement({ terminalPredicate: wrongIdentityPredicate })).outcome,
      'terminal_predicate_mismatch',
    );

    const withCandidate = recordActionCompletionCandidate(returned, {
      generation: 2,
      catId: 'codex-sol',
      evidenceRefs: ['local-review:message-1:g2:approved'],
      now: 125,
    });
    assert.equal(replaceActionSuccessor(withCandidate, replacement()).outcome, 'candidate_present');

    const withOutput = recordActionSuccessorOutcome(returned, {
      generation: 2,
      catId: 'codex-sol',
      outcome: 'failed',
      evidenceRef: 'runtime:returned-holder:failed',
      now: 126,
    });
    assert.equal(replaceActionSuccessor(withOutput, replacement()).outcome, 'completion_present');
  });

  it('rejects a return from another thread of the holder cat', () => {
    const first = claimActionSuccessor(null, baseClaim()).lease;
    const mismatch = returnActionSuccessorToPredecessor(first, {
      expectedGeneration: 1,
      rejectingCatId: 'codex-terra',
      rejectingThreadId: 'thread-other-session',
      dispatchId: 'return-1',
      groundingEvidenceRef: 'message:grounding-mismatch',
      now: 120,
    });

    assert.equal(mismatch.outcome, 'holder_mismatch');
    assert.equal(mismatch.lease, first);
  });

  it('marks return delivery without letting transport state alter custody', () => {
    const first = claimActionSuccessor(null, baseClaim()).lease;
    const returned = returnActionSuccessorToPredecessor(first, {
      expectedGeneration: 1,
      rejectingCatId: 'codex-terra',
      rejectingThreadId: 'thread-target',
      dispatchId: 'return-1',
      groundingEvidenceRef: 'message:grounding-mismatch',
      now: 120,
    }).lease;
    const delivered = markActionSuccessorReturnDelivered(returned, {
      expectedGeneration: 2,
      evidenceRef: 'message:return-delivered',
      now: 130,
    });
    assert.equal(delivered.outcome, 'delivered');
    assert.equal(delivered.lease.returnDeliveryState, 'delivered');
    assert.deepEqual(delivered.lease.holderCatIds, ['codex-sol']);
    assert.deepEqual(preflightActionSuccessor(delivered.lease, { generation: 2, subjectTerminal: false }), {
      ok: true,
      reason: 'active',
    });
  });

  it('records return attempts and crosses the delivery SLA exactly once', () => {
    const first = claimActionSuccessor(null, baseClaim()).lease;
    const returned = returnActionSuccessorToPredecessor(first, {
      expectedGeneration: 1,
      rejectingCatId: 'codex-terra',
      rejectingThreadId: 'thread-target',
      dispatchId: 'return-attempts',
      groundingEvidenceRef: 'grounding:return-attempts',
      now: 200,
    }).lease;

    const firstAttempt = recordActionSuccessorReturnDeliveryAttempt(returned, {
      expectedGeneration: 2,
      now: returned.returnDeliverySlaUntil + 1,
    });
    assert.equal(firstAttempt.outcome, 'recorded');
    assert.equal(firstAttempt.becameOverdue, true);
    assert.equal(firstAttempt.lease.returnDeliveryState, 'overdue');
    assert.equal(firstAttempt.lease.returnDeliveryAttemptCount, 1);

    const secondAttempt = recordActionSuccessorReturnDeliveryAttempt(firstAttempt.lease, {
      expectedGeneration: 2,
      now: returned.returnDeliverySlaUntil + 2,
    });
    assert.equal(secondAttempt.outcome, 'recorded');
    assert.equal(secondAttempt.becameOverdue, false);
    assert.equal(secondAttempt.lease.returnDeliveryAttemptCount, 2);
    assert.equal(
      secondAttempt.lease.returnDeliveryOverdueObservedAt,
      firstAttempt.lease.returnDeliveryOverdueObservedAt,
    );

    const delivered = markActionSuccessorReturnDelivered(secondAttempt.lease, {
      expectedGeneration: 2,
      evidenceRef: 'queue:return-attempts',
      now: returned.returnDeliverySlaUntil + 3,
    });
    assert.equal(delivered.outcome, 'delivered');
    assert.equal(delivered.lease.returnDeliveryState, 'delivered');
    assert.deepEqual(delivered.lease.holderCatIds, ['codex-sol']);
  });

  it('records parallel rejected ownership per holder and never returns the whole lease', () => {
    const parallel = claimActionSuccessor(
      null,
      baseClaim({
        mode: 'parallel',
        holderCatIds: ['codex-terra', 'opus'],
        parallelIntent: 'independent implementation',
      }),
    ).lease;
    const unsupported = returnActionSuccessorToPredecessor(parallel, {
      expectedGeneration: 1,
      rejectingCatId: 'codex-terra',
      rejectingThreadId: 'thread-target',
      dispatchId: 'return-1',
      groundingEvidenceRef: 'message:mismatch-1',
      now: 120,
    });
    assert.equal(unsupported.outcome, 'parallel_return_unsupported');
    const oneRejected = unsupported.lease;
    assert.equal(oneRejected.status, 'active');
    assert.equal(oneRejected.holderOutcomes['codex-terra'].outcome, 'rejected_ownership');

    const allRejected = recordActionSuccessorOutcome(oneRejected, {
      generation: 1,
      catId: 'opus',
      outcome: 'rejected_ownership',
      evidenceRef: 'message:mismatch-2',
      now: 121,
    });
    assert.equal(allRejected.status, 'replaceable');
  });

  it('replaces atomically only after a server-recorded replaceable outcome', () => {
    const first = claimActionSuccessor(null, baseClaim()).lease;
    const unavailable = recordActionSuccessorOutcome(first, {
      generation: 1,
      catId: 'codex-terra',
      outcome: 'unavailable',
      evidenceRef: 'runtime:quota-exhausted',
      now: 120,
    });
    assert.equal(unavailable.status, 'replaceable');

    const replaced = replaceActionSuccessor(unavailable, {
      expectedGeneration: 1,
      holderCatIds: ['gpt52'],
      holderThreadId: 'thread-target',
      predecessorCatId: 'codex-sol',
      predecessorThreadId: 'thread-source',
      dispatchId: 'dispatch-2',
      terminalPredicate: first.terminalPredicate,
      evidenceRef: 'lease:lease-1:unavailable',
      now: 130,
    });
    assert.equal(replaced.outcome, 'replaced');
    assert.equal(replaced.lease.generation, 2);
    assert.deepEqual(replaced.lease.holderCatIds, ['gpt52']);

    const stale = replaceActionSuccessor(replaced.lease, {
      expectedGeneration: 1,
      holderCatIds: ['codex'],
      holderThreadId: 'thread-target',
      predecessorCatId: 'codex-sol',
      predecessorThreadId: 'thread-source',
      dispatchId: 'dispatch-3',
      evidenceRef: 'stale-caller',
      now: 131,
    });
    assert.equal(stale.outcome, 'stale_generation');
    assert.deepEqual(stale.lease.holderCatIds, ['gpt52']);
  });

  it('refreshes the terminal predicate when replacing a replaceable generation', () => {
    const oldPredicate = reviewPredicate('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const newPredicate = reviewPredicate('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    const first = claimActionSuccessor(
      null,
      baseClaim({ actionFamily: 'review', terminalPredicate: oldPredicate }),
    ).lease;
    const replaceable = recordActionSuccessorOutcome(first, {
      generation: 1,
      catId: 'codex-terra',
      outcome: 'unavailable',
      evidenceRef: 'runtime:quota-exhausted',
      now: 120,
    });

    const replaced = replaceActionSuccessor(replaceable, {
      expectedGeneration: 1,
      holderCatIds: ['gpt52'],
      holderThreadId: 'thread-target',
      predecessorCatId: 'codex-sol',
      predecessorThreadId: 'thread-source',
      dispatchId: 'dispatch-2',
      terminalPredicate: newPredicate,
      evidenceRef: 'lease:lease-1:unavailable',
      now: 130,
    });

    assert.equal(replaced.outcome, 'replaced');
    assert.equal(replaced.lease.terminalPredicate.digest, newPredicate.digest);
    assert.equal(replaced.lease.terminalPredicate.freshnessKey, newPredicate.freshnessKey);
  });

  it('replaces a grounded existing-standing generation without manufacturing a predecessor route', () => {
    const taskPredicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'implement',
      subjectRef: 'subject:task:task-1',
      predicate: { kind: 'task_done' },
    });
    const first = claimActionSuccessor(
      null,
      baseClaim({
        subjectRef: 'subject:task:task-1',
        actionFamily: 'implement',
        successorSlot: 'implementer',
        holderCatIds: ['codex-sol'],
        claimOrigin: 'existing_standing',
        holderThreadId: 'thread-task',
        predecessorCatId: undefined,
        predecessorThreadId: undefined,
        issuerStandingEvidenceRef: 'message:original-task-assignment',
        terminalPredicate: taskPredicate,
      }),
    ).lease;
    const replaceable = recordActionSuccessorOutcome(first, {
      generation: 1,
      catId: 'codex-sol',
      outcome: 'unavailable',
      evidenceRef: 'queue:not_enqueued',
      now: 120,
    });

    assert.deepEqual(first.evidenceRefs, ['message:request-1', 'message:original-task-assignment']);

    const replaced = replaceActionSuccessor(replaceable, {
      expectedGeneration: 1,
      holderCatIds: ['codex-sol'],
      holderThreadId: 'thread-task',
      claimOrigin: 'existing_standing',
      issuerStandingEvidenceRef: 'message:replacement-grounding',
      dispatchId: 'existing-standing:task-1:g2',
      terminalPredicate: taskPredicate,
      evidenceRef: 'message:replacement-request',
      now: 130,
    });

    assert.equal(replaced.outcome, 'replaced');
    assert.equal(replaced.lease.generation, 2);
    assert.equal(replaced.lease.claimOrigin, 'existing_standing');
    assert.equal(replaced.lease.predecessorCatId, undefined);
    assert.equal(replaced.lease.predecessorThreadId, undefined);
    assert.equal(replaced.lease.issuerStandingEvidenceRef, 'message:replacement-grounding');
    assert.deepEqual(replaced.lease.evidenceRefs, [
      'message:request-1',
      'message:original-task-assignment',
      'queue:not_enqueued',
      'message:replacement-request',
      'message:replacement-grounding',
    ]);

    assert.throws(
      () =>
        replaceActionSuccessor(replaceable, {
          expectedGeneration: 1,
          holderCatIds: ['codex-sol'],
          holderThreadId: 'thread-task',
          claimOrigin: 'structured_transfer',
          predecessorCatId: 'codex-sol',
          predecessorThreadId: 'thread-task',
          dispatchId: 'structured-bypass:task-1:g2',
          terminalPredicate: taskPredicate,
          evidenceRef: 'message:structured-bypass',
          now: 130,
        }),
      /replacement claim origin must match the persisted lease/,
    );
  });

  it('keeps the first terminal holder outcome when cleanup reports again', () => {
    const first = claimActionSuccessor(
      null,
      baseClaim({
        mode: 'parallel',
        holderCatIds: ['codex-terra', 'opus'],
        parallelIntent: 'independent_review',
      }),
    ).lease;
    const failed = recordActionSuccessorOutcome(first, {
      generation: 1,
      catId: 'codex-terra',
      outcome: 'failed',
      evidenceRef: 'runtime:dispatch-1:failed',
      now: 120,
    });
    const duplicateCleanup = recordActionSuccessorOutcome(failed, {
      generation: 1,
      catId: 'codex-terra',
      outcome: 'unavailable',
      evidenceRef: 'timeout:dispatch-1',
      now: 130,
    });

    assert.equal(duplicateCleanup, failed);
    assert.equal(duplicateCleanup.holderOutcomes['codex-terra'].outcome, 'failed');
    assert.equal(duplicateCleanup.status, 'active');
  });

  it('rejects replace while the current successor is still active', () => {
    const first = claimActionSuccessor(null, baseClaim()).lease;
    const result = replaceActionSuccessor(first, {
      expectedGeneration: 1,
      holderCatIds: ['codex'],
      holderThreadId: 'thread-target',
      predecessorCatId: 'codex-sol',
      predecessorThreadId: 'thread-source',
      dispatchId: 'dispatch-2',
      evidenceRef: 'caller-says-so',
      now: 120,
    });
    assert.equal(result.outcome, 'proof_required');
  });

  it('fences stale generations and terminal subjects at preflight', () => {
    const first = claimActionSuccessor(null, baseClaim()).lease;
    assert.deepEqual(preflightActionSuccessor(first, { generation: 1, subjectTerminal: false }), {
      ok: true,
      reason: 'active',
    });
    assert.deepEqual(preflightActionSuccessor(first, { generation: 0, subjectTerminal: false }), {
      ok: false,
      reason: 'stale_generation',
    });
    assert.deepEqual(
      preflightActionSuccessor(first, {
        generation: 1,
        subjectTerminal: false,
        terminalPredicateDigest: 'wrong-digest',
      }),
      { ok: false, reason: 'predicate_mismatch' },
    );
    assert.deepEqual(preflightActionSuccessor(first, { generation: 1, subjectTerminal: true }), {
      ok: false,
      reason: 'subject_terminal',
    });
  });
});
