import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

const { claimActionSuccessor, recordActionSuccessorOutcome } = await import(
  '../dist/domains/ball-custody/action-successor-state-machine.js'
);
const { recoverActiveExternalReviewVerdict } = await import(
  '../dist/domains/ball-custody/action-successor-external-review-recovery-state-machine.js'
);
const { ExternalReviewRecoveryService } = await import('../dist/domains/ball-custody/ExternalReviewRecoveryService.js');
const {
  canonicalizeActionTerminalPredicate,
  isMachineCheckableCompletionEvidenceRef,
  isDurableReviewReentryEvidenceRef,
} = await import('../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js');

const HEAD = 'a'.repeat(40);
const ADVANCED_HEAD = 'b'.repeat(40);
const GITHUB_REVIEW_URL = 'https://github.com/zts212653/clowder-ai/pull/1365#pullrequestreview-5006426559';
const EVIDENCE_REF = `github:${GITHUB_REVIEW_URL}`;

function createLease(overrides = {}) {
  return claimActionSuccessor(null, {
    leaseId: 'lease-ext-review-1',
    tenantScope: 'user-1',
    subjectRef: 'pr:zts212653/clowder-ai#1365',
    actionFamily: 'review',
    successorSlot: 'reviewer',
    mode: 'single',
    holderCatIds: ['codex-terra'],
    dispatchId: 'dispatch-review-1',
    claimOrigin: 'structured_transfer',
    holderThreadId: 'thread-review',
    predecessorCatId: 'codex-sol',
    predecessorThreadId: 'thread-author',
    issuerStandingEvidenceRef: 'message:request-1',
    evidenceRefs: ['message:request-1'],
    terminalPredicate: canonicalizeActionTerminalPredicate({
      actionFamily: 'review',
      subjectRef: 'pr:zts212653/clowder-ai#1365',
      predicate: { kind: 'review_delivered', headSha: HEAD },
    }),
    now: 100,
    ...overrides,
  }).lease;
}

// --- Pure state machine tests ---

describe('F167 external review recovery state machine', () => {
  const baseInput = {
    expectedGeneration: 1,
    reviewerCatId: 'codex-terra',
    predecessorCatId: 'codex-sol',
    predecessorThreadId: 'thread-author',
    tenantScope: 'user-1',
    headSha: HEAD,
    evidenceRef: EVIDENCE_REF,
    now: 200,
  };

  it('recovers an untouched active lease matching all guards', () => {
    const lease = createLease();
    const result = recoverActiveExternalReviewVerdict(lease, baseInput);
    assert.equal(result.outcome, 'recovered');
    assert.equal(result.lease.status, 'completed');
    assert.equal(result.lease.holderOutcomes['codex-terra'].outcome, 'succeeded');
    assert.equal(result.lease.holderOutcomes['codex-terra'].evidenceRef, EVIDENCE_REF);
  });

  it('rejects stale generation', () => {
    const lease = createLease();
    const result = recoverActiveExternalReviewVerdict(lease, { ...baseInput, expectedGeneration: 2 });
    assert.equal(result.outcome, 'stale_generation');
  });

  it('rejects wrong action family', () => {
    const lease = createLease();
    // Mutate after creation to test the guard (can't create with invalid family)
    const tampered = { ...lease, actionFamily: 'dispatch', successorSlot: 'dispatcher' };
    const result = recoverActiveExternalReviewVerdict(tampered, baseInput);
    assert.equal(result.outcome, 'identity_mismatch');
  });

  it('rejects wrong holder', () => {
    const lease = createLease();
    const result = recoverActiveExternalReviewVerdict(lease, {
      ...baseInput,
      reviewerCatId: 'opus',
    });
    assert.equal(result.outcome, 'holder_mismatch');
  });

  it('rejects wrong predecessor', () => {
    const lease = createLease();
    const result = recoverActiveExternalReviewVerdict(lease, {
      ...baseInput,
      predecessorCatId: 'opus',
    });
    assert.equal(result.outcome, 'predecessor_mismatch');
  });

  it('rejects wrong tenant', () => {
    const lease = createLease();
    const result = recoverActiveExternalReviewVerdict(lease, {
      ...baseInput,
      tenantScope: 'user-2',
    });
    assert.equal(result.outcome, 'predecessor_mismatch');
  });

  it('rejects lease with existing holder outcomes', () => {
    const lease = createLease();
    const withOutcome = recordActionSuccessorOutcome(lease, {
      generation: 1,
      catId: 'codex-terra',
      outcome: 'succeeded',
      evidenceRef: 'other-evidence',
      now: 150,
    });
    const result = recoverActiveExternalReviewVerdict(withOutcome, baseInput);
    // completed lease with different evidenceRef → lease_not_active
    assert.equal(result.outcome, 'lease_not_active');
  });

  it('replays a completed lease with matching evidence', () => {
    const lease = createLease();
    const completed = recordActionSuccessorOutcome(lease, {
      generation: 1,
      catId: 'codex-terra',
      outcome: 'succeeded',
      evidenceRef: EVIDENCE_REF,
      now: 150,
    });
    const result = recoverActiveExternalReviewVerdict(completed, baseInput);
    assert.equal(result.outcome, 'replayed');
  });

  it('rejects wrong head SHA in terminal predicate', () => {
    const lease = createLease();
    const result = recoverActiveExternalReviewVerdict(lease, {
      ...baseInput,
      headSha: ADVANCED_HEAD,
    });
    assert.equal(result.outcome, 'identity_mismatch');
  });

  it('rejects non-structured_transfer claim origin', () => {
    const lease = createLease({ claimOrigin: 'self' });
    const result = recoverActiveExternalReviewVerdict(lease, baseInput);
    assert.equal(result.outcome, 'identity_mismatch');
  });
});

// --- Service integration tests ---

function serviceHarness({
  lease = createLease(),
  freshnessStatus = 'mismatch',
  freshnessReason,
  casOutcome = 'recovered',
} = {}) {
  const leaseStore = {
    get: mock.fn(async (leaseId) => (leaseId === lease.leaseId ? lease : null)),
    recoverExternalReviewVerdict: mock.fn(async (_leaseId, _input) => {
      if (casOutcome === 'recovered') {
        const completed = recordActionSuccessorOutcome(lease, {
          generation: lease.generation,
          catId: lease.holderCatIds[0],
          outcome: 'succeeded',
          evidenceRef: EVIDENCE_REF,
          now: 200,
        });
        return { outcome: 'recovered', lease: completed };
      }
      if (casOutcome === 'replayed') {
        return { outcome: 'replayed', lease };
      }
      return { outcome: casOutcome, lease };
    }),
  };
  const truthResolver = {
    resolveFreshness: mock.fn(async (_predicate) => {
      if (freshnessStatus === 'mismatch') {
        return {
          status: 'mismatch',
          reason: freshnessReason ?? 'predicate HEAD is not the server-observed current HEAD',
          currentHead: ADVANCED_HEAD,
        };
      }
      if (freshnessStatus === 'verified') return { status: 'verified' };
      return { status: 'insufficient', reason: freshnessReason ?? 'cannot resolve' };
    }),
  };
  return {
    leaseStore,
    truthResolver,
    service: new ExternalReviewRecoveryService({ leaseStore, truthResolver }),
  };
}

function serviceInput(overrides = {}) {
  return {
    leaseId: 'lease-ext-review-1',
    generation: 1,
    githubReviewUrl: GITHUB_REVIEW_URL,
    now: 200,
    principal: { catId: 'codex-sol', threadId: 'thread-author', tenantScope: 'user-1' },
    ...overrides,
  };
}

describe('F167 ExternalReviewRecoveryService', () => {
  it('commits when all guards pass and HEAD has advanced', async () => {
    const { service, leaseStore, truthResolver } = serviceHarness();
    const result = await service.recover(serviceInput());
    assert.equal(result.outcome, 'committed');
    assert.equal(result.leaseId, 'lease-ext-review-1');
    assert.equal(result.evidenceRef, EVIDENCE_REF);
    assert.equal(leaseStore.recoverExternalReviewVerdict.mock.calls.length, 1);
    assert.equal(truthResolver.resolveFreshness.mock.calls.length, 1);
  });

  it('P1: evidenceRef uses github: prefix eligible for machine-check and review reentry', async () => {
    const { service } = serviceHarness();
    const result = await service.recover(serviceInput());
    assert.equal(result.outcome, 'committed');
    // The evidence ref must be recognized by the catalog validators
    // so recovered leases can enter the next review cycle via reviewReentry
    assert.ok(
      isMachineCheckableCompletionEvidenceRef(result.evidenceRef),
      `evidenceRef ${result.evidenceRef} must be machine-checkable`,
    );
    assert.ok(
      isDurableReviewReentryEvidenceRef(result.evidenceRef),
      `evidenceRef ${result.evidenceRef} must be durable-review-reentry eligible`,
    );
  });

  it('rejects missing lease', async () => {
    const { service } = serviceHarness();
    const result = await service.recover(serviceInput({ leaseId: 'nonexistent' }));
    assert.equal(result.outcome, 'stale');
    assert.equal(result.reason, 'lease_missing');
  });

  it('rejects wrong principal (not predecessor)', async () => {
    const { service } = serviceHarness();
    const result = await service.recover(
      serviceInput({ principal: { catId: 'opus', threadId: 'thread-author', tenantScope: 'user-1' } }),
    );
    assert.equal(result.outcome, 'mismatch');
    assert.match(result.reason, /not the lease predecessor/);
  });

  it('rejects wrong tenant', async () => {
    const { service } = serviceHarness();
    const result = await service.recover(
      serviceInput({ principal: { catId: 'codex-sol', threadId: 'thread-author', tenantScope: 'user-2' } }),
    );
    assert.equal(result.outcome, 'mismatch');
    assert.match(result.reason, /outside the predecessor tenant/);
  });

  it('rejects invalid GitHub review URL', async () => {
    const { service } = serviceHarness();
    const result = await service.recover(serviceInput({ githubReviewUrl: 'https://github.com/foo/bar/issues/1' }));
    assert.equal(result.outcome, 'mismatch');
    assert.match(result.reason, /does not match lease subject/);
  });

  it('P1: rejects GitHub review URL from a different repo/PR than lease subject', async () => {
    const { service } = serviceHarness();
    // Lease subject is pr:zts212653/clowder-ai#1365 but URL points to other/repo#999
    const wrongRepoUrl = 'https://github.com/other/repo/pull/999#pullrequestreview-1';
    const result = await service.recover(serviceInput({ githubReviewUrl: wrongRepoUrl }));
    assert.equal(result.outcome, 'mismatch');
    assert.match(result.reason, /does not match lease subject/);
  });

  it('P1: rejects recovery when PR is terminal (not just HEAD advanced)', async () => {
    const { service } = serviceHarness({
      freshnessStatus: 'mismatch',
      freshnessReason: 'PR is already terminal',
    });
    const result = await service.recover(serviceInput());
    assert.equal(result.outcome, 'mismatch');
    assert.match(result.reason, /terminal/);
  });

  it('P1: rejects recovery when PR is terminal via bootstrap observation path', async () => {
    const { service } = serviceHarness({
      freshnessStatus: 'mismatch',
      freshnessReason: 'bootstrap observation reports a terminal PR',
    });
    const result = await service.recover(serviceInput());
    assert.equal(result.outcome, 'mismatch');
    assert.match(result.reason, /terminal/);
  });

  it('P2: accepts /files#pullrequestreview- permalink variant', async () => {
    const filesUrl = 'https://github.com/zts212653/clowder-ai/pull/1365/files#pullrequestreview-5006426559';
    const { service } = serviceHarness();
    const result = await service.recover(serviceInput({ githubReviewUrl: filesUrl }));
    assert.equal(result.outcome, 'committed');
  });

  it('rejects when HEAD is still current (use normal record path instead)', async () => {
    const { service } = serviceHarness({ freshnessStatus: 'verified' });
    const result = await service.recover(serviceInput());
    assert.equal(result.outcome, 'mismatch');
    assert.match(result.reason, /still current/);
  });

  it('rejects when freshness cannot be resolved', async () => {
    const { service } = serviceHarness({ freshnessStatus: 'insufficient', freshnessReason: 'repo not found' });
    const result = await service.recover(serviceInput());
    assert.equal(result.outcome, 'insufficient');
    assert.match(result.reason, /repo not found/);
  });

  it('replays idempotent recovery for already-completed lease with same evidence', async () => {
    const lease = createLease();
    const completed = recordActionSuccessorOutcome(lease, {
      generation: 1,
      catId: 'codex-terra',
      outcome: 'succeeded',
      evidenceRef: EVIDENCE_REF,
      now: 150,
    });
    const { service, truthResolver } = serviceHarness({ lease: completed });
    const result = await service.recover(serviceInput());
    assert.equal(result.outcome, 'committed');
    assert.equal(result.evidenceRef, EVIDENCE_REF);
    // Should short-circuit before checking freshness
    assert.equal(truthResolver.resolveFreshness.mock.calls.length, 0);
  });

  it('rejects completed lease with different evidence', async () => {
    const lease = createLease();
    const completed = recordActionSuccessorOutcome(lease, {
      generation: 1,
      catId: 'codex-terra',
      outcome: 'succeeded',
      evidenceRef: 'github-review:https://github.com/other/repo/pull/1#pullrequestreview-999',
      now: 150,
    });
    const { service } = serviceHarness({ lease: completed });
    const result = await service.recover(serviceInput());
    assert.equal(result.outcome, 'stale');
  });

  it('rejects stale generation', async () => {
    const { service } = serviceHarness();
    const result = await service.recover(serviceInput({ generation: 99 }));
    assert.equal(result.outcome, 'stale');
    assert.equal(result.reason, 'stale_generation');
  });

  it('validates GitHub review URL format and subject anchor strictly', async () => {
    const { service } = serviceHarness();
    for (const badUrl of [
      // Missing hash fragment
      'https://github.com/zts212653/clowder-ai/pull/1365',
      // No hash fragment at all
      'https://github.com/zts212653/clowder-ai/pull/1365#',
      // Wrong hostname
      'https://gitlab.com/zts212653/clowder-ai/pull/1365#pullrequestreview-123',
      // Not a URL
      'not-a-url',
      // Wrong repo (subject anchor validation)
      'https://github.com/other/repo/pull/1#pullrequestreview-123',
      // Wrong PR number (subject anchor validation)
      'https://github.com/zts212653/clowder-ai/pull/999#pullrequestreview-123',
      // Commit URL
      'https://github.com/zts212653/clowder-ai/commit/abc',
    ]) {
      const result = await service.recover(serviceInput({ githubReviewUrl: badUrl }));
      assert.equal(result.outcome, 'mismatch', `Expected mismatch for ${badUrl}`);
    }
  });
});
