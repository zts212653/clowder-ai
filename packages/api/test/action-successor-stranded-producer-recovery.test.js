import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { recoverStrandedProducer } = await import(
  '../dist/domains/ball-custody/action-successor-stranded-producer-recovery.js'
);
const { canonicalizeActionTerminalPredicate } = await import(
  '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js'
);

// ── helpers ────────────────────────────────────────────────────────────────

const HEAD = 'a23f29869bbd98aa1982c792b899a7098fe231a2';

const reviewPredicate = canonicalizeActionTerminalPredicate({
  actionFamily: 'review',
  subjectRef: 'pr:zts212653/fakexxx#63',
  predicate: { kind: 'review_delivered', headSha: HEAD },
});

function strandedLease(overrides = {}) {
  return {
    leaseId: '9d812552-c903-4e30-ad70-7cc3f26c5e3d',
    key: 'test-key',
    tenantScope: 'user-1',
    subjectRef: 'pr:zts212653/fakexxx#63',
    actionFamily: 'review',
    successorSlot: 'reviewer',
    generation: 2,
    status: 'active',
    mode: 'single',
    claimOrigin: 'structured_transfer',
    holderCatIds: ['kimi'],
    holderThreadId: 'thread-review',
    predecessorCatId: 'codex-sol',
    predecessorThreadId: 'thread-dispatch',
    issuerStandingEvidenceRef: 'message:dispatch-1',
    dispatchId: 'cross-post:dispatch-1',
    holderOutcomes: {},
    completionCandidates: {},
    evidenceRefs: ['message:dispatch-1'],
    returnTransitions: [],
    terminalPredicateState: { kind: 'predicate_backed' },
    terminalPredicate: reviewPredicate,
    revision: 3,
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

const recoveryInput = (overrides = {}) => ({
  expectedGeneration: 2,
  holderCatId: 'kimi',
  capabilityWitness: {
    provider: 'kimi',
    carrier: 'kimi_stream_json',
    status: 'unavailable',
    reason: 'native kimi-code 0.34 does not support --mcp-config-file; MCP tools unreachable',
  },
  predicateKind: 'review_delivered',
  predicateDigest: reviewPredicate.digest,
  evidenceRef: 'stranded-producer:kimi:kimi_stream_json:review_delivered',
  now: 500,
  ...overrides,
});

// ── tests ──────────────────────────────────────────────────────────────────

describe('F167 stranded producer recovery state machine', () => {
  describe('happy path: recovers stranded active lease', () => {
    it('marks holder outcome as unavailable when all guards pass', () => {
      const lease = strandedLease();
      const result = recoverStrandedProducer(lease, recoveryInput());
      assert.equal(result.outcome, 'recovered');
      assert.equal(result.lease.status, 'replaceable');
      assert.deepEqual(result.lease.holderOutcomes.kimi.outcome, 'unavailable');
      assert.equal(
        result.lease.holderOutcomes.kimi.evidenceRef,
        'stranded-producer:kimi:kimi_stream_json:review_delivered',
      );
      assert.equal(result.lease.revision, lease.revision + 1);
    });

    it('idempotent replay returns replayed when outcome already matches', () => {
      const lease = strandedLease({
        status: 'replaceable',
        holderOutcomes: {
          kimi: {
            outcome: 'unavailable',
            evidenceRef: 'stranded-producer:kimi:kimi_stream_json:review_delivered',
            at: 500,
          },
        },
      });
      const result = recoverStrandedProducer(lease, recoveryInput());
      assert.equal(result.outcome, 'replayed');
    });
  });

  describe('guard: stale generation', () => {
    it('rejects recovery with wrong generation', () => {
      const result = recoverStrandedProducer(strandedLease(), recoveryInput({ expectedGeneration: 1 }));
      assert.equal(result.outcome, 'stale_generation');
    });
  });

  describe('guard: lease not active', () => {
    it('rejects recovery when lease is already completed', () => {
      const lease = strandedLease({ status: 'completed' });
      const result = recoverStrandedProducer(lease, recoveryInput());
      assert.equal(result.outcome, 'lease_not_active');
    });

    it('rejects recovery when lease is replaceable', () => {
      const lease = strandedLease({ status: 'replaceable' });
      const result = recoverStrandedProducer(lease, recoveryInput());
      assert.equal(result.outcome, 'lease_not_active');
    });
  });

  describe('guard: holder mismatch', () => {
    it('rejects recovery for wrong holder cat', () => {
      const result = recoverStrandedProducer(strandedLease(), recoveryInput({ holderCatId: 'opus' }));
      assert.equal(result.outcome, 'holder_mismatch');
    });
  });

  describe('guard: predicate mismatch', () => {
    it('rejects recovery for wrong predicate digest', () => {
      const result = recoverStrandedProducer(strandedLease(), recoveryInput({ predicateDigest: 'wrong-digest' }));
      assert.equal(result.outcome, 'predicate_mismatch');
    });

    it('rejects recovery for wrong predicate kind', () => {
      const result = recoverStrandedProducer(strandedLease(), recoveryInput({ predicateKind: 'task_done' }));
      assert.equal(result.outcome, 'identity_mismatch');
    });
  });

  describe('guard: existing outcomes prevent recovery (verdict race)', () => {
    it('rejects when holderOutcomes already exist', () => {
      const lease = strandedLease({
        holderOutcomes: {
          kimi: { outcome: 'succeeded', evidenceRef: 'local-review:kimi:g2:approved', at: 400 },
        },
      });
      const result = recoverStrandedProducer(lease, recoveryInput());
      assert.equal(result.outcome, 'output_present');
    });
  });

  describe('guard: completion candidate present', () => {
    it('rejects when completion candidate exists (late verdict in progress)', () => {
      const lease = strandedLease({
        completionCandidates: {
          kimi: { evidenceRefs: ['local-review:kimi:g2:approved'], recordedAt: 400 },
        },
      });
      const result = recoverStrandedProducer(lease, recoveryInput());
      assert.equal(result.outcome, 'candidate_present');
    });
  });

  describe('guard: active return delivery blocks recovery', () => {
    it('rejects when returnDeliveryState is pending', () => {
      const lease = strandedLease({
        returnDeliveryState: 'pending',
        returnTransitions: [
          {
            predecessorCatId: 'codex-sol',
            predecessorThreadId: 'thread-dispatch',
            returnedAt: 300,
          },
        ],
      });
      const result = recoverStrandedProducer(lease, recoveryInput());
      assert.equal(result.outcome, 'return_present');
    });

    it('rejects when returnDeliveryState is overdue', () => {
      const lease = strandedLease({
        returnDeliveryState: 'overdue',
        returnTransitions: [
          {
            predecessorCatId: 'codex-sol',
            predecessorThreadId: 'thread-dispatch',
            returnedAt: 300,
          },
        ],
      });
      const result = recoverStrandedProducer(lease, recoveryInput());
      assert.equal(result.outcome, 'return_present');
    });

    it('allows recovery when returnTransitions exist but returnDeliveryState is cleared (reattached history)', () => {
      // After reattach, returnTransitions is audit trail but returnDeliveryState
      // is cleared. Recovery must NOT be permanently blocked by historical transitions.
      const lease = strandedLease({
        returnDeliveryState: undefined,
        returnTransitions: [
          {
            predecessorCatId: 'codex-sol',
            predecessorThreadId: 'thread-dispatch',
            returnedAt: 300,
          },
        ],
      });
      const result = recoverStrandedProducer(lease, recoveryInput());
      assert.equal(result.outcome, 'recovered', 'historical transitions must not block recovery');
    });
  });

  describe('guard: dispatch reservation blocks recovery', () => {
    it('rejects when dispatchDeliveryReservation exists (external delivery in flight)', () => {
      const lease = strandedLease({
        dispatchDeliveryReservation: {
          predicateDigest: 'test-digest',
          freshnessEvidenceRef: 'community:test:head:abc',
          reservedAt: 400,
        },
      });
      const result = recoverStrandedProducer(lease, recoveryInput());
      assert.equal(result.outcome, 'dispatch_reserved');
    });

    it('allows recovery when no dispatchDeliveryReservation exists', () => {
      const lease = strandedLease({ dispatchDeliveryReservation: undefined });
      const result = recoverStrandedProducer(lease, recoveryInput());
      assert.equal(result.outcome, 'recovered');
    });
  });

  describe('guard: normal capable carrier must NOT be retired', () => {
    it('does NOT recover when capability witness status is available', () => {
      const result = recoverStrandedProducer(
        strandedLease(),
        recoveryInput({
          capabilityWitness: {
            provider: 'anthropic',
            carrier: 'claude_print_sdk',
            status: 'available',
            reason: 'Claude carriers have full MCP access',
          },
        }),
      );
      assert.equal(result.outcome, 'capability_not_unavailable');
    });
  });

  describe('guard: restart sweep safety', () => {
    it('is restart-safe: same input against same lease yields same result', () => {
      const lease = strandedLease();
      const input = recoveryInput();
      const r1 = recoverStrandedProducer(lease, input);
      const r2 = recoverStrandedProducer(lease, input);
      assert.equal(r1.outcome, r2.outcome);
      assert.deepEqual(r1.lease.holderOutcomes, r2.lease.holderOutcomes);
    });
  });
});
