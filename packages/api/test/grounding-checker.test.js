/**
 * F167 Phase O PR-O2: Grounding Checker — shadow mode tests
 *
 * Tests follow the 8 dogfood fixtures from refs/dogfood-fixtures.md
 * and verify invariants INV-O1..O12 from refs/claim-schema.md.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';

/** @returns {import('../dist/infrastructure/grounding/grounding-checker.js').GroundingMetrics} */
function stubMetrics() {
  return {
    checkTotal: { add: mock.fn() },
    verdictTotal: { add: mock.fn() },
    resolverTotal: { add: mock.fn() },
    cacheHitTotal: { add: mock.fn() },
    budgetExhaustedTotal: { add: mock.fn() },
  };
}

/**
 * @param {string} id
 * @param {string[]} claimTypes
 * @param {string} outcome
 * @param {string} [tier]
 * @returns {import('../dist/infrastructure/grounding/grounding-checker.js').Resolver}
 */
function makeResolver(id, claimTypes, outcome, tier = 'T1') {
  return {
    id,
    applicableClaimTypes: new Set(claimTypes),
    resolve: mock.fn(async () => ({
      resolver: id,
      outcome,
      sourceTier: tier,
      cacheHit: false,
    })),
  };
}

/** @returns {import('../dist/infrastructure/grounding/types.js').GroundingCheckContext} */
function baseCtx(overrides = {}) {
  return {
    invocationId: 'inv-001',
    catId: 'opus',
    threadId: 'thread-001',
    tool: 'hold_ball',
    actionFamily: 'wait',
    actionRisk: 'hold_ball',
    claims: [],
    ...overrides,
  };
}

/** @returns {import('../dist/infrastructure/grounding/types.js').ClaimInput} */
function baseClaim(overrides = {}) {
  return {
    claimType: 'owner',
    sourceKind: 'cross_post',
    sourceRef: { kind: 'messageId', value: 'msg-123' },
    ...overrides,
  };
}

describe('F167 Phase O — GroundingChecker (shadow mode)', () => {
  /** @type {typeof import('../dist/infrastructure/grounding/grounding-checker.js')} */
  let mod;

  beforeEach(async () => {
    mod = await import('../dist/infrastructure/grounding/grounding-checker.js');
  });

  describe('INV-O10: read_intent bypass', () => {
    test('skips grounding for read_intent actions', async () => {
      const metrics = stubMetrics();
      const result = await mod.checkGrounding(baseCtx({ actionFamily: 'read_intent', claims: [baseClaim()] }), {
        metrics,
      });
      assert.equal(result.overallVerdict, 'verified');
      assert.equal(result.claimResults.length, 0);
      assert.equal(result.wouldBlock, false);
      assert.equal(metrics.checkTotal.add.mock.calls.length, 1);
    });
  });

  describe('no claims provided', () => {
    test('returns insufficient when no claims are given', async () => {
      const metrics = stubMetrics();
      const result = await mod.checkGrounding(baseCtx({ claims: [] }), { metrics });
      assert.equal(result.overallVerdict, 'insufficient');
      assert.equal(result.claimResults[0].verdictReason, 'no_claims_provided');
      // Cloud R5 P2: no-claims must use claimType 'none', not 'owner'
      assert.equal(result.claimResults[0].claim.claimType, 'none');
      const verdictCalls = metrics.verdictTotal.add.mock.calls;
      assert.equal(verdictCalls[0].arguments[1]['grounding.claim_type'], 'none');
    });
  });

  describe('Fixture F1: verified owner claim with T1 evidence', () => {
    test('returns verified when resolver confirms ownership', async () => {
      const resolver = makeResolver('git_log.author', ['owner'], 'verified', 'T1');
      const metrics = stubMetrics();
      const result = await mod.checkGrounding(baseCtx({ claims: [baseClaim({ claimType: 'owner' })] }), {
        resolvers: [resolver],
        metrics,
      });
      assert.equal(result.overallVerdict, 'verified');
      assert.equal(result.wouldBlock, false);
      assert.equal(result.claimResults[0].verdict, 'verified');
      assert.equal(resolver.resolve.mock.calls.length, 1);
      // Counter emitted with correct attributes
      const verdictCalls = metrics.verdictTotal.add.mock.calls;
      assert.equal(verdictCalls.length, 1);
      assert.equal(verdictCalls[0].arguments[1]['grounding.verdict'], 'verified');
    });
  });

  describe('Fixture F2: T2-only on high-risk action → insufficient (INV-O3)', () => {
    test('downgrades T2-only verified to insufficient for merge actions', async () => {
      const resolver = makeResolver('feat_index.lookup', ['owner'], 'verified', 'T2');
      const result = await mod.checkGrounding(
        baseCtx({
          actionFamily: 'merge',
          actionRisk: 'destructive',
          tool: 'gh_pr_merge',
          claims: [baseClaim({ claimType: 'owner' })],
        }),
        { resolvers: [resolver] },
      );
      assert.equal(result.overallVerdict, 'insufficient');
      assert.equal(result.claimResults[0].verdictReason, 'T2_only_on_high_risk');
      assert.equal(result.wouldBlock, true);
    });
  });

  describe('Cloud P2-1: T2 then T1 resolver on high-risk → verified (not early insufficient)', () => {
    test('continues past T2 to find T1 evidence on high-risk action', async () => {
      const t2Resolver = makeResolver('feat_index.lookup', ['owner'], 'verified', 'T2');
      const t1Resolver = makeResolver('git_log.author', ['owner'], 'verified', 'T1');
      const result = await mod.checkGrounding(
        baseCtx({
          actionFamily: 'merge',
          actionRisk: 'destructive',
          tool: 'gh_pr_merge',
          claims: [baseClaim({ claimType: 'owner' })],
        }),
        { resolvers: [t2Resolver, t1Resolver] },
      );
      // Should be verified (T1 found), NOT insufficient (T2_only_on_high_risk)
      assert.equal(result.overallVerdict, 'verified');
      assert.equal(result.wouldBlock, false);
      assert.equal(t2Resolver.resolve.mock.calls.length, 1);
      assert.equal(t1Resolver.resolve.mock.calls.length, 1);
    });
  });

  describe('Cloud P2-2: event attributes verdict resolver, not first resolver', () => {
    test('attributes event to the resolver that produced the verdict', async () => {
      const r1 = makeResolver('r1_na', ['owner'], 'not_applicable', 'T2');
      const r2 = makeResolver('r2_verified', ['owner'], 'verified', 'T1');
      const result = await mod.checkGrounding(baseCtx({ claims: [baseClaim()] }), {
        resolvers: [r1, r2],
        budgetTotal: 10,
      });
      assert.equal(result.overallVerdict, 'verified');
      assert.equal(result.events.length, 1);
      // Event should reference r2 (verdict producer), not r1 (not_applicable)
      assert.equal(result.events[0].resolver, 'r2_verified');
      assert.equal(result.events[0].resolverSourceTier, 'T1');
    });
  });

  describe('Fixture F3: mismatch → would block', () => {
    test('returns mismatch and would-block for any mismatched claim', async () => {
      const resolver = makeResolver('feat_index.lookup', ['owner'], 'mismatch', 'T1');
      const result = await mod.checkGrounding(baseCtx({ claims: [baseClaim({ claimType: 'owner' })] }), {
        resolvers: [resolver],
      });
      assert.equal(result.overallVerdict, 'mismatch');
      assert.equal(result.wouldBlock, true);
    });
  });

  describe('Fixture F4: issuerStanding=none → mismatch', () => {
    test('peer with no standing gets mismatch on peer_instruction', async () => {
      const resolver = makeResolver('issuer_standing.check', ['auth'], 'mismatch', 'T1');
      const result = await mod.checkGrounding(
        baseCtx({
          actionFamily: 'owner_reassignment',
          actionRisk: 'destructive',
          claims: [
            baseClaim({
              claimType: 'auth',
              authSubtype: 'peer_instruction',
              issuerStanding: 'none',
            }),
          ],
        }),
        { resolvers: [resolver] },
      );
      assert.equal(result.overallVerdict, 'mismatch');
      assert.equal(result.wouldBlock, true);
    });
  });

  describe('Fixture F7: keeper_owned + event-backed → verified', () => {
    test('returns verified for keeper-owned wait with event callback', async () => {
      const resolver = makeResolver('callback_coverage.check', ['wait'], 'verified', 'T1');
      const result = await mod.checkGrounding(
        baseCtx({
          actionFamily: 'wait',
          actionRisk: 'hold_ball',
          threadKind: 'gate-keeping',
          claims: [baseClaim({ claimType: 'wait' })],
        }),
        { resolvers: [resolver] },
      );
      assert.equal(result.overallVerdict, 'verified');
      assert.equal(result.wouldBlock, false);
    });
  });

  describe('Fixture F8: distributed ownership → mismatch', () => {
    test('blocks when ball has been distributed to downstream', async () => {
      const resolver = makeResolver('ownership_state.check', ['owner'], 'mismatch', 'T1');
      const result = await mod.checkGrounding(
        baseCtx({
          tool: 'hold_ball',
          actionFamily: 'wait',
          actionRisk: 'hold_ball',
          threadKind: 'gate-keeping',
          claims: [baseClaim({ claimType: 'owner' })],
        }),
        { resolvers: [resolver] },
      );
      assert.equal(result.overallVerdict, 'mismatch');
      assert.equal(result.wouldBlock, true);
    });
  });

  describe('resolver budget exhaustion', () => {
    test('returns insufficient when budget runs out (non-cached resolver)', async () => {
      const r1 = makeResolver('r1', ['owner'], 'not_applicable', 'T2');
      const r2 = makeResolver('r2', ['owner'], 'verified', 'T1');
      const metrics = stubMetrics();
      const result = await mod.checkGrounding(baseCtx({ claims: [baseClaim()] }), {
        resolvers: [r1, r2],
        metrics,
        budgetTotal: 1,
      });
      assert.equal(result.overallVerdict, 'insufficient');
      assert.equal(result.claimResults[0].verdictReason, 'resolver_budget_exhausted');
      assert.equal(metrics.budgetExhaustedTotal.add.mock.calls.length, 1);
      // r1 consumed budget; r2 called speculatively (INV-O7) but not cached → exhausted
      assert.equal(r1.resolve.mock.calls.length, 1);
      assert.equal(r2.resolve.mock.calls.length, 1);
    });
  });

  describe('INV-O7: cache hits do not consume budget', () => {
    test('refunds budget on cacheHit, allowing next resolver to run', async () => {
      // r1 returns cacheHit=true → budget refunded → r2 still gets to run
      const r1 = {
        id: 'cached',
        applicableClaimTypes: new Set(['owner']),
        resolve: mock.fn(async () => ({
          resolver: 'cached',
          outcome: 'not_applicable',
          sourceTier: 'T1',
          cacheHit: true,
        })),
      };
      const r2 = makeResolver('r2', ['owner'], 'verified', 'T1');
      const metrics = stubMetrics();
      // Budget of 1: without refund, r1 would exhaust it and r2 would never run
      const result = await mod.checkGrounding(baseCtx({ claims: [baseClaim()] }), {
        resolvers: [r1, r2],
        metrics,
        budgetTotal: 1,
      });
      assert.equal(result.overallVerdict, 'verified');
      assert.equal(r1.resolve.mock.calls.length, 1);
      assert.equal(r2.resolve.mock.calls.length, 1);
      assert.equal(metrics.cacheHitTotal.add.mock.calls.length, 1);
      // Budget was consumed then refunded, so resolverCallsConsumed = 1 (r2's non-cache call)
      assert.equal(result.resolverCallsConsumed, 1);
    });
  });

  describe('INV-O8: not_applicable → try next resolver', () => {
    test('skips not_applicable resolvers and uses next one', async () => {
      const r1 = makeResolver('r1', ['owner'], 'not_applicable', 'T2');
      const r2 = makeResolver('r2', ['owner'], 'verified', 'T1');
      const result = await mod.checkGrounding(baseCtx({ claims: [baseClaim()] }), {
        resolvers: [r1, r2],
        budgetTotal: 10,
      });
      assert.equal(result.overallVerdict, 'verified');
      assert.equal(r1.resolve.mock.calls.length, 1);
      assert.equal(r2.resolve.mock.calls.length, 1);
    });

    test('returns insufficient when ALL resolvers return not_applicable', async () => {
      const r1 = makeResolver('r1', ['owner'], 'not_applicable', 'T2');
      const r2 = makeResolver('r2', ['owner'], 'not_applicable', 'T2');
      const result = await mod.checkGrounding(baseCtx({ claims: [baseClaim()] }), {
        resolvers: [r1, r2],
        budgetTotal: 10,
      });
      assert.equal(result.overallVerdict, 'insufficient');
      assert.equal(result.claimResults[0].verdictReason, 'no_applicable_resolver');
    });
  });

  describe('resolver error handling', () => {
    test('treats resolver errors as not_applicable and tries next', async () => {
      const r1 = {
        id: 'broken',
        applicableClaimTypes: new Set(['owner']),
        resolve: mock.fn(async () => {
          throw new Error('resolver down');
        }),
      };
      const r2 = makeResolver('r2', ['owner'], 'verified', 'T1');
      const result = await mod.checkGrounding(baseCtx({ claims: [baseClaim()] }), {
        resolvers: [r1, r2],
        budgetTotal: 10,
      });
      assert.equal(result.overallVerdict, 'verified');
      assert.equal(r1.resolve.mock.calls.length, 1);
      assert.equal(r2.resolve.mock.calls.length, 1);
    });
  });

  describe('multiple claims — overall verdict aggregation', () => {
    test('any mismatch makes overall verdict mismatch', async () => {
      const ownerResolver = makeResolver('r_owner', ['owner'], 'verified', 'T1');
      const authResolver = makeResolver('r_auth', ['auth'], 'mismatch', 'T1');
      const result = await mod.checkGrounding(
        baseCtx({
          claims: [baseClaim({ claimType: 'owner' }), baseClaim({ claimType: 'auth' })],
        }),
        { resolvers: [ownerResolver, authResolver] },
      );
      assert.equal(result.overallVerdict, 'mismatch');
    });

    test('insufficient + verified → overall insufficient', async () => {
      const ownerResolver = makeResolver('r_owner', ['owner'], 'verified', 'T1');
      // No resolver for 'wait' → insufficient
      const result = await mod.checkGrounding(
        baseCtx({
          claims: [baseClaim({ claimType: 'owner' }), baseClaim({ claimType: 'wait' })],
        }),
        { resolvers: [ownerResolver] },
      );
      assert.equal(result.overallVerdict, 'insufficient');
    });
  });

  describe('event generation', () => {
    test('generates ClaimGroundingEvent per claim', async () => {
      const resolver = makeResolver('feat_index', ['owner'], 'verified', 'T2');
      const nowMs = 1700000000000;
      const result = await mod.checkGrounding(
        baseCtx({
          claims: [baseClaim()],
          threadKind: 'gate-keeping',
        }),
        { resolvers: [resolver], now: () => nowMs },
      );
      assert.equal(result.events.length, 1);
      const evt = result.events[0];
      assert.equal(evt.invocationId, 'inv-001');
      assert.equal(evt.catId, 'opus');
      assert.equal(evt.threadId, 'thread-001');
      assert.equal(evt.claimType, 'owner');
      assert.equal(evt.verdict, 'verified');
      assert.equal(evt.tool, 'hold_ball');
      assert.equal(evt.actionFamily, 'wait');
      assert.equal(evt.ts, nowMs);
      assert.equal(evt.threadKind, 'gate-keeping');
    });
  });

  describe('createResolverBudget', () => {
    test('tracks consumed vs remaining correctly', () => {
      const budget = mod.createResolverBudget(3);
      assert.equal(budget.remaining(), 3);
      assert.equal(budget.consume(), true);
      assert.equal(budget.consumed, 1);
      assert.equal(budget.remaining(), 2);
      assert.equal(budget.consume(), true);
      assert.equal(budget.consume(), true);
      assert.equal(budget.consume(), false); // exhausted
      assert.equal(budget.consumed, 3);
      assert.equal(budget.remaining(), 0);
    });

    test('refund() restores a consumed call (INV-O7)', () => {
      const budget = mod.createResolverBudget(2);
      assert.equal(budget.consume(), true); // 1/2
      assert.equal(budget.consume(), true); // 2/2
      assert.equal(budget.consume(), false); // exhausted
      budget.refund(); // back to 1/2
      assert.equal(budget.consumed, 1);
      assert.equal(budget.remaining(), 1);
      assert.equal(budget.consume(), true); // 2/2 again
      assert.equal(budget.consume(), false);
    });

    test('refund() at zero consumed is no-op', () => {
      const budget = mod.createResolverBudget(2);
      budget.refund(); // no-op
      assert.equal(budget.consumed, 0);
      assert.equal(budget.remaining(), 2);
    });
  });

  // ── Cloud R3 P2 regressions ────────────────────────────────────

  describe('Cloud P2-5: cached resolvers bypass budget exhaustion (INV-O7)', () => {
    test('cached resolver runs even when budget exhausted', async () => {
      const r1 = makeResolver('r1_uncached', ['owner'], 'not_applicable', 'T2');
      // r2 is cached — should run even after r1 exhausts budget
      const r2 = {
        id: 'r2_cached',
        applicableClaimTypes: new Set(['owner']),
        resolve: mock.fn(async () => ({
          resolver: 'r2_cached',
          outcome: 'verified',
          sourceTier: 'T1',
          cacheHit: true,
        })),
      };
      const metrics = stubMetrics();
      const result = await mod.checkGrounding(baseCtx({ claims: [baseClaim()] }), {
        resolvers: [r1, r2],
        metrics,
        budgetTotal: 1,
      });
      // r2 cached → budget not consumed → verified
      assert.equal(result.overallVerdict, 'verified');
      assert.equal(result.wouldBlock, false);
      assert.equal(r1.resolve.mock.calls.length, 1);
      assert.equal(r2.resolve.mock.calls.length, 1);
      // No budget exhaustion emitted (cache hit saved it)
      assert.equal(metrics.budgetExhaustedTotal.add.mock.calls.length, 0);
    });
  });

  describe('Cloud R6 P2-2: insufficient + non-destructive risks → wouldBlock', () => {
    test('insufficient + register_tracking → wouldBlock=true', async () => {
      // No resolvers → insufficient; register_tracking must soft-block
      const result = await mod.checkGrounding(
        baseCtx({
          tool: 'register_pr_tracking',
          actionFamily: 'register_tracking',
          actionRisk: 'register_tracking',
          claims: [baseClaim()],
        }),
        { resolvers: [] },
      );
      assert.equal(result.overallVerdict, 'insufficient');
      assert.equal(result.wouldBlock, true);
    });

    test('insufficient + hold_ball → wouldBlock=true', async () => {
      const result = await mod.checkGrounding(
        baseCtx({
          tool: 'hold_ball',
          actionFamily: 'wait',
          actionRisk: 'hold_ball',
          claims: [baseClaim({ claimType: 'wait' })],
        }),
        { resolvers: [] },
      );
      assert.equal(result.overallVerdict, 'insufficient');
      assert.equal(result.wouldBlock, true);
    });

    test('insufficient + read_only → wouldBlock=false', async () => {
      const result = await mod.checkGrounding(
        baseCtx({
          actionFamily: 'read_intent',
          actionRisk: 'read_only',
          claims: [baseClaim()],
        }),
        { resolvers: [] },
      );
      // read_intent bypasses grounding entirely → verified → wouldBlock=false
      assert.equal(result.wouldBlock, false);
    });

    test('insufficient + mutate_local → wouldBlock=false', async () => {
      const result = await mod.checkGrounding(
        baseCtx({
          actionFamily: 'mutate_local',
          actionRisk: 'mutate_local',
          claims: [baseClaim()],
        }),
        { resolvers: [] },
      );
      assert.equal(result.overallVerdict, 'insufficient');
      assert.equal(result.wouldBlock, false);
    });
  });

  describe('Cloud P2-6: resolver errors counted in resolverTotal', () => {
    test('failed resolver increments resolverTotal counter', async () => {
      const throwingResolver = {
        id: 'r_throws',
        applicableClaimTypes: new Set(['owner']),
        resolve: mock.fn(async () => {
          throw new Error('resolver crash');
        }),
      };
      const r2 = makeResolver('r2_verified', ['owner'], 'verified', 'T1');
      const metrics = stubMetrics();
      await mod.checkGrounding(baseCtx({ claims: [baseClaim()] }), {
        resolvers: [throwingResolver, r2],
        metrics,
      });
      // Both resolvers must be counted (throwing + successful)
      assert.equal(metrics.resolverTotal.add.mock.calls.length, 2);
      // First call is the throwing resolver with T2 fallback
      assert.equal(metrics.resolverTotal.add.mock.calls[0].arguments[1]['grounding.source_tier'], 'T2');
    });
  });
});
