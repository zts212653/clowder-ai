import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { ActionSuccessorAdmissionService } = await import(
  '../dist/domains/ball-custody/ActionSuccessorAdmissionService.js'
);
const { canonicalizeActionTerminalPredicate } = await import(
  '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js'
);

// ── helpers ────────────────────────────────────────────────────────────────

const HEAD = '1111111111111111111111111111111111111111';

const reviewPredicate = canonicalizeActionTerminalPredicate({
  actionFamily: 'review',
  subjectRef: 'pr:owner/repo#63',
  predicate: { kind: 'review_delivered', headSha: HEAD },
});

function activeLease(overrides = {}) {
  return {
    leaseId: 'lease-review-1',
    key: 'test-key',
    tenantScope: 'user-1',
    subjectRef: 'pr:owner/repo#63',
    actionFamily: 'review',
    successorSlot: 'reviewer',
    generation: 1,
    status: 'active',
    mode: 'single',
    claimOrigin: 'structured_transfer',
    holderCatIds: ['kimi'],
    holderThreadId: 'thread-target',
    predecessorCatId: 'codex-sol',
    predecessorThreadId: 'thread-source',
    issuerStandingEvidenceRef: 'message:req-1',
    dispatchId: 'post:msg-1',
    holderOutcomes: {},
    completionCandidates: {},
    evidenceRefs: ['message:req-1'],
    returnTransitions: [],
    terminalPredicateState: { kind: 'predicate_backed' },
    terminalPredicate: reviewPredicate,
    revision: 1,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    tenantScope: 'user-1',
    actorCatId: 'codex-sol',
    sourceThreadId: 'thread-source',
    targetThreadId: 'thread-target',
    holderCatIds: ['kimi'],
    dispatchId: 'post:msg-1',
    evidenceRef: 'message:req-1',
    now: 100,
    action: {
      subjectRef: 'pr:owner/repo#63',
      actionFamily: 'review',
      successorSlot: 'reviewer',
      mode: 'single',
      terminalPredicate: { kind: 'review_delivered', headSha: HEAD },
    },
    ...overrides,
  };
}

function harness({ claimResult, freshnessResolution, getLease, replaceResult, commitOutcomeResult } = {}) {
  const calls = { claim: [], replace: [], commitOutcome: [] };
  const truthResolver = {
    async resolve() {
      return { terminal: false, source: 'community_projection', state: 'active' };
    },
    async resolveFreshness(predicate) {
      return (
        freshnessResolution ?? {
          status: 'verified',
          evidenceRef: `community:${predicate.subjectRef}:head:${predicate.headSha}`,
          freshnessKey: predicate.freshnessKey,
        }
      );
    },
  };
  const leaseStore = {
    async claim(input) {
      calls.claim.push(input);
      return claimResult ?? { outcome: 'claimed', lease: activeLease() };
    },
    async get(leaseId) {
      return getLease ? getLease(leaseId) : null;
    },
    async replace(leaseId, input) {
      calls.replace.push({ leaseId, ...input });
      return replaceResult ?? { outcome: 'replaced', lease: activeLease({ generation: 2 }) };
    },
    async commitOutcome(leaseId, input) {
      calls.commitOutcome.push({ leaseId, ...input });
      if (commitOutcomeResult) return commitOutcomeResult;
      return {
        outcome: 'recorded',
        lease: activeLease({
          status: 'replaceable',
          holderOutcomes: { [input.catId]: { outcome: input.outcome, evidenceRef: input.evidenceRef, at: input.now } },
          revision: 4,
        }),
      };
    },
    async returnToPredecessor() {
      return null;
    },
    async markReturnDelivered() {
      return { outcome: 'delivered' };
    },
    async continueFreshRevision() {
      return null;
    },
  };
  return { service: new ActionSuccessorAdmissionService(leaseStore, truthResolver), calls, leaseStore };
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('F167 terminal producer capability preflight', () => {
  describe('gap proof: current admission ignores carrier capability', () => {
    it('admits a Kimi carrier with unavailable terminal producer — the bug', async () => {
      // This test DOCUMENTS the existing gap: a carrier that CANNOT produce
      // review_delivered (native Kimi) is currently admitted, creating a
      // permanently stranded active lease.
      const { service, calls } = harness({
        claimResult: { outcome: 'claimed', lease: activeLease() },
      });
      const result = await service.admit(request());
      // BUG: admission succeeds even though holder cannot produce terminal
      assert.equal(result.admit, true, 'gap proof: incapable carrier is admitted');
      assert.equal(calls.claim.length, 1, 'claim was actually called');
    });
  });

  describe('defense layer: admission rejects incapable terminal producers', () => {
    it('rejects admission when holder has unavailable terminal producer', async () => {
      const { service, calls } = harness({
        claimResult: { outcome: 'claimed', lease: activeLease() },
      });
      const result = await service.admit(
        request({
          holderTerminalProducerCapabilities: {
            kimi: {
              status: 'unavailable',
              provider: 'kimi',
              carrier: 'kimi_stream_json',
              reason: 'native kimi-code does not support --mcp-config-file',
            },
          },
        }),
      );
      assert.equal(result.admit, false, 'should reject incapable terminal producer');
      assert.equal(result.outcome, 'terminal_producer_unavailable');
      assert.equal(calls.claim.length, 0, 'claim must NOT be called');
    });

    it('admits normally when holder has available terminal producer', async () => {
      const { service, calls } = harness({
        claimResult: { outcome: 'claimed', lease: activeLease({ holderCatIds: ['opus'] }) },
      });
      const result = await service.admit(
        request({
          holderCatIds: ['opus'],
          holderTerminalProducerCapabilities: {
            opus: {
              status: 'available',
              provider: 'anthropic',
              carrier: 'claude_print_sdk',
            },
          },
        }),
      );
      assert.equal(result.admit, true, 'capable carrier should be admitted');
      assert.equal(calls.claim.length, 1);
    });

    it('admits normally when no capability declaration AND no resolver (backwards compat)', async () => {
      const { service, calls } = harness({
        claimResult: { outcome: 'claimed', lease: activeLease() },
      });
      // No holderTerminalProducerCapabilities, no injected resolver — legacy callers
      const result = await service.admit(request());
      assert.equal(result.admit, true, 'backwards compat: no capability = admit');
      assert.equal(calls.claim.length, 1);
    });

    it('rejects when ANY parallel holder lacks terminal producer capability', async () => {
      const { service, calls } = harness({
        claimResult: {
          outcome: 'claimed',
          lease: activeLease({ holderCatIds: ['opus', 'kimi'], mode: 'parallel' }),
        },
      });
      const result = await service.admit(
        request({
          holderCatIds: ['opus', 'kimi'],
          action: {
            subjectRef: 'pr:owner/repo#63',
            actionFamily: 'review',
            successorSlot: 'reviewer',
            mode: 'parallel',
            parallelIntent: 'cross-model review',
            terminalPredicate: { kind: 'review_delivered', headSha: HEAD },
          },
          holderTerminalProducerCapabilities: {
            opus: { status: 'available', provider: 'anthropic', carrier: 'claude_print_sdk' },
            kimi: {
              status: 'unavailable',
              provider: 'kimi',
              carrier: 'kimi_stream_json',
              reason: 'native kimi-code does not support --mcp-config-file',
            },
          },
        }),
      );
      assert.equal(result.admit, false, 'parallel: any incapable holder rejects all');
      assert.equal(result.outcome, 'terminal_producer_unavailable');
      assert.equal(calls.claim.length, 0);
    });
  });

  describe('P1 regression: replacement bypasses preflight', () => {
    it('rejects replacement when new holder has unavailable terminal producer', async () => {
      const existingLease = activeLease({ generation: 1, claimOrigin: 'structured_transfer' });
      const { service, calls } = harness({
        getLease: () => existingLease,
        replaceResult: { outcome: 'replaced', lease: activeLease({ generation: 2 }) },
      });
      const result = await service.admit(
        request({
          holderTerminalProducerCapabilities: {
            kimi: {
              status: 'unavailable',
              provider: 'kimi',
              carrier: 'kimi_stream_json',
              reason: 'native kimi-code does not support --mcp-config-file',
            },
          },
          action: {
            subjectRef: 'pr:owner/repo#63',
            actionFamily: 'review',
            successorSlot: 'reviewer',
            mode: 'single',
            terminalPredicate: { kind: 'review_delivered', headSha: HEAD },
            replace: { leaseId: 'lease-review-1', expectedGeneration: 1 },
          },
        }),
      );
      assert.equal(result.admit, false, 'replacement must NOT bypass preflight');
      assert.equal(result.outcome, 'terminal_producer_unavailable');
      assert.equal(calls.replace.length, 0, 'leaseStore.replace must NOT be called');
    });
  });

  describe('P1 regression: injected resolver auto-resolves for callers that omit map', () => {
    it('rejects admission via resolver when caller omits holderTerminalProducerCapabilities', async () => {
      const { service, calls } = harness({
        claimResult: { outcome: 'claimed', lease: activeLease() },
      });
      // Inject resolver that reports kimi as unavailable
      service.setCapabilityResolver({
        resolve: (catId) =>
          catId === 'kimi'
            ? {
                status: 'unavailable',
                provider: 'kimi',
                carrier: 'kimi_stream_json',
                reason: 'native kimi-code does not support --mcp-config-file',
              }
            : { status: 'available', provider: 'anthropic', carrier: 'claude_print_sdk' },
      });
      // Caller does NOT pass holderTerminalProducerCapabilities (like DispatchActionApprovalService)
      const result = await service.admit(request());
      assert.equal(result.admit, false, 'injected resolver should catch unavailable carrier');
      assert.equal(result.outcome, 'terminal_producer_unavailable');
      assert.equal(calls.claim.length, 0, 'claim must NOT be called');
    });

    it('admits when injected resolver reports all holders as available', async () => {
      const { service, calls } = harness({
        claimResult: { outcome: 'claimed', lease: activeLease({ holderCatIds: ['opus'] }) },
      });
      service.setCapabilityResolver({
        resolve: () => ({ status: 'available', provider: 'anthropic', carrier: 'claude_print_sdk' }),
      });
      const result = await service.admit(request({ holderCatIds: ['opus'] }));
      assert.equal(result.admit, true, 'resolver reports available → admit');
      assert.equal(calls.claim.length, 1);
    });
  });

  describe('P1 regression: live recovery via recoverStranded', () => {
    it('recovers stranded lease via CAS-fenced commitOutcome', async () => {
      const strandedLease = activeLease({
        holderCatIds: ['kimi'],
        holderOutcomes: {},
        completionCandidates: {},
        returnTransitions: [],
      });
      const { service } = harness({
        getLease: () => strandedLease,
      });
      const result = await service.recoverStranded({
        leaseId: 'lease-review-1',
        recovery: {
          expectedGeneration: 1,
          holderCatId: 'kimi',
          capabilityWitness: {
            provider: 'kimi',
            carrier: 'kimi_stream_json',
            status: 'unavailable',
            reason: 'native kimi-code 0.34 does not support --mcp-config-file',
          },
          predicateKind: 'review_delivered',
          predicateDigest: reviewPredicate.digest,
          evidenceRef: 'stranded-producer:kimi:kimi_stream_json:review_delivered',
          now: 500,
        },
      });
      assert.equal(result.outcome, 'recovered');
      assert.equal(result.lease.status, 'replaceable');
      assert.equal(result.lease.holderOutcomes.kimi.outcome, 'unavailable');
    });

    it('returns output_present when commitOutcome reports holder_outcome_exists (verdict race)', async () => {
      const strandedLease = activeLease({
        holderCatIds: ['kimi'],
        holderOutcomes: {},
        completionCandidates: {},
        returnTransitions: [],
      });
      const { service } = harness({
        getLease: () => strandedLease,
        commitOutcomeResult: {
          outcome: 'holder_outcome_exists',
          lease: activeLease({
            holderOutcomes: {
              kimi: { outcome: 'succeeded', evidenceRef: 'local-review:kimi:approved', at: 400 },
            },
          }),
        },
      });
      const result = await service.recoverStranded({
        leaseId: 'lease-review-1',
        recovery: {
          expectedGeneration: 1,
          holderCatId: 'kimi',
          capabilityWitness: {
            provider: 'kimi',
            carrier: 'kimi_stream_json',
            status: 'unavailable',
            reason: 'native kimi-code 0.34',
          },
          predicateKind: 'review_delivered',
          predicateDigest: reviewPredicate.digest,
          evidenceRef: 'stranded-producer:kimi:kimi_stream_json:review_delivered',
          now: 500,
        },
      });
      assert.equal(result.outcome, 'output_present', 'late verdict won the CAS race');
    });

    it('rejects recovery when lease not found', async () => {
      const { service } = harness({ getLease: () => null });
      await assert.rejects(
        () =>
          service.recoverStranded({
            leaseId: 'missing-lease',
            recovery: {
              expectedGeneration: 1,
              holderCatId: 'kimi',
              capabilityWitness: {
                provider: 'kimi',
                carrier: 'kimi_stream_json',
                status: 'unavailable',
                reason: 'n/a',
              },
              predicateKind: 'review_delivered',
              predicateDigest: 'any',
              evidenceRef: 'test',
              now: 500,
            },
          }),
        /not found/,
      );
    });
  });
});
