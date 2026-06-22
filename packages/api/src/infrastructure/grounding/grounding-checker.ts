/**
 * F167 Phase O PR-O2: Grounding Checker — Shadow Mode
 *
 * Orchestrates claim verification for stateful tool calls (hold_ball,
 * register_pr_tracking, register_issue_tracking, merge, etc.).
 *
 * In shadow mode (PR-O2): emits telemetry events + counters but NEVER blocks.
 * The `wouldBlock` field records what enforcement mode would have done.
 *
 * Spec: docs/features/F167-a2a-chain-quality.md §Phase O R3 Final Convergence
 * Schema: cat-cafe-skills/receive-handoff-grounding/refs/claim-schema.md
 */

import {
  CALLBACK_TOOL,
  GROUNDING_ACTION_FAMILY,
  GROUNDING_CLAIM_TYPE,
  GROUNDING_SOURCE_TIER,
  GROUNDING_VERDICT,
  STATUS,
} from '../telemetry/genai-semconv.js';
import {
  groundingBudgetExhaustedTotal,
  groundingCacheHitTotal,
  groundingCheckTotal,
  groundingResolverTotal,
  groundingVerdictTotal,
} from '../telemetry/instruments.js';
import {
  computeOverallVerdict,
  computeWouldBlock,
  createResolverBudget,
  DEFAULT_RESOLVER_BUDGET,
  HIGH_RISK_ACTION_FAMILIES,
} from './grounding-helpers.js';
import type {
  ClaimGroundingEvent,
  ClaimInput,
  ClaimResult,
  GroundingCheckContext,
  GroundingCheckResult,
  ResolverBudget,
  ResolverResult,
  Verdict,
} from './types.js';

// Re-export helpers for consumers that import from this module.
export { computeOverallVerdict, computeWouldBlock, createResolverBudget } from './grounding-helpers.js';

// ── Resolver interface ────────────────────────────────────────

export interface Resolver {
  id: string;
  /** Which claim types this resolver handles. */
  applicableClaimTypes: ReadonlySet<string>;
  /** Run the resolver. Returns outcome + metadata. */
  resolve(claim: ClaimInput, ctx: GroundingCheckContext): Promise<ResolverResult>;
}

// ── Metric counter interface (injectable for tests) ───────────

export interface GroundingMetrics {
  checkTotal: { add(v: number, attrs: Record<string, string>): void };
  verdictTotal: { add(v: number, attrs: Record<string, string>): void };
  resolverTotal: { add(v: number, attrs: Record<string, string>): void };
  cacheHitTotal: { add(v: number, attrs: Record<string, string>): void };
  budgetExhaustedTotal: { add(v: number, attrs: Record<string, string>): void };
}

const defaultMetrics: GroundingMetrics = {
  checkTotal: groundingCheckTotal,
  verdictTotal: groundingVerdictTotal,
  resolverTotal: groundingResolverTotal,
  cacheHitTotal: groundingCacheHitTotal,
  budgetExhaustedTotal: groundingBudgetExhaustedTotal,
};

// ── Core checker ──────────────────────────────────────────────

export interface GroundingCheckerOpts {
  resolvers?: Resolver[];
  metrics?: GroundingMetrics;
  budgetTotal?: number;
  /** Override for testing — inject Date.now(). */
  now?: () => number;
}

/**
 * Run grounding checks for all claims in a tool-call context.
 *
 * Shadow mode (PR-O2): always returns, never throws, never blocks.
 * Emits OTel counters + produces events for sample storage.
 */
export async function checkGrounding(
  ctx: GroundingCheckContext,
  opts: GroundingCheckerOpts = {},
): Promise<GroundingCheckResult> {
  const { resolvers = [], metrics = defaultMetrics, budgetTotal = DEFAULT_RESOLVER_BUDGET, now = Date.now } = opts;

  const budget = createResolverBudget(budgetTotal);

  // Counter: total grounding checks
  metrics.checkTotal.add(1, { [CALLBACK_TOOL]: ctx.tool });

  // INV-O10: read_intent actions skip grounding entirely.
  if (ctx.actionFamily === 'read_intent') {
    return {
      overallVerdict: 'verified',
      claimResults: [],
      wouldBlock: false,
      resolverCallsConsumed: 0,
      events: [],
    };
  }

  const claimResults: ClaimResult[] = [];
  const events: ClaimGroundingEvent[] = [];

  for (const claim of ctx.claims) {
    const result = await resolveClaim(claim, ctx, resolvers, budget, metrics, now);
    claimResults.push(result);

    // Build event per claim for sample storage.
    // Pick the resolver that produced the actual verdict (last non-not_applicable),
    // not [0] which may be a skipped resolver (INV-O8).
    const bestResolver =
      [...result.resolverResults].reverse().find((r: ResolverResult) => r.outcome !== 'not_applicable') ??
      result.resolverResults[0];
    const event: ClaimGroundingEvent = {
      invocationId: ctx.invocationId,
      catId: ctx.catId,
      threadId: ctx.threadId,
      sourceThreadId: ctx.sourceThreadId,
      claimType: claim.claimType,
      authSubtype: claim.authSubtype,
      sourceKind: claim.sourceKind,
      sourceRef: claim.sourceRef,
      claimSummary: claim.claimSummary,
      resolver: bestResolver?.resolver ?? 'none',
      resolverSourceTier: bestResolver?.sourceTier ?? 'T2',
      freshnessKey: bestResolver?.freshnessKey,
      cacheHit: bestResolver?.cacheHit ?? false,
      verdict: result.verdict,
      verdictReason: result.verdictReason,
      actionFamily: ctx.actionFamily,
      actionRisk: ctx.actionRisk,
      tool: ctx.tool,
      threadKind: ctx.threadKind,
      waitSourceRef: claim.waitSourceRef,
      issuerStanding: claim.issuerStanding,
      ts: now(),
      resolverCallsRemaining: budget.remaining(),
    };
    events.push(event);

    // Counter: verdict per claim
    metrics.verdictTotal.add(1, {
      [GROUNDING_CLAIM_TYPE]: claim.claimType,
      [GROUNDING_VERDICT]: result.verdict,
      [CALLBACK_TOOL]: ctx.tool,
    });
  }

  // If no claims provided, treat as insufficient (no grounding performed).
  // Use claimType 'none' — not 'owner' — so no-claim shadow checks don't
  // pollute real owner-claim telemetry (P2: all route hooks pass claims:[]
  // until PR-O2b wires claim extraction).
  if (claimResults.length === 0) {
    const verdict: Verdict = 'insufficient';
    metrics.verdictTotal.add(1, {
      [GROUNDING_CLAIM_TYPE]: 'none',
      [GROUNDING_VERDICT]: verdict,
      [CALLBACK_TOOL]: ctx.tool,
    });
    claimResults.push({
      claim: {
        claimType: 'none',
        sourceKind: 'self',
        sourceRef: { kind: 'messageId', value: '' },
      },
      resolverResults: [],
      verdict,
      verdictReason: 'no_claims_provided',
    });
  }

  const overallVerdict = computeOverallVerdict(claimResults);
  const wouldBlock = computeWouldBlock(overallVerdict, ctx.actionRisk);

  return {
    overallVerdict,
    claimResults,
    wouldBlock,
    resolverCallsConsumed: budget.consumed,
    events,
  };
}

// ── Claim resolution ──────────────────────────────────────────

async function resolveClaim(
  claim: ClaimInput,
  ctx: GroundingCheckContext,
  resolvers: Resolver[],
  budget: ResolverBudget,
  metrics: GroundingMetrics,
  _now: () => number,
): Promise<ClaimResult> {
  const applicableResolvers = resolvers.filter((r) => r.applicableClaimTypes.has(claim.claimType));

  if (applicableResolvers.length === 0) {
    return {
      claim,
      resolverResults: [],
      verdict: 'insufficient',
      verdictReason: 'no_applicable_resolver',
    };
  }

  const resolverResults: ResolverResult[] = [];

  for (const resolver of applicableResolvers) {
    // INV-O7: cache hits bypass budget — try resolver even when budget exhausted.
    // If the result is a cache hit, it's free; otherwise, budget is truly exhausted.
    const budgetConsumed = budget.consume();

    try {
      const result = await resolver.resolve(claim, ctx);
      resolverResults.push(result);

      // Counter: resolver invocation
      metrics.resolverTotal.add(1, {
        [GROUNDING_SOURCE_TIER]: result.sourceTier,
        [STATUS]: resolver.id,
      });

      if (result.cacheHit) {
        metrics.cacheHitTotal.add(1, { [STATUS]: resolver.id });
        // INV-O7: cache hits don't consume budget — refund the pre-debit (if consumed).
        if (budgetConsumed) budget.refund();
      } else if (!budgetConsumed) {
        // Not a cache hit and budget was already exhausted — truly exhausted.
        metrics.budgetExhaustedTotal.add(1, {
          [CALLBACK_TOOL]: ctx.tool,
          [GROUNDING_ACTION_FAMILY]: ctx.actionFamily,
        });
        return {
          claim,
          resolverResults,
          verdict: 'insufficient',
          verdictReason: 'resolver_budget_exhausted',
        };
      }

      // INV-O8: not_applicable → try next resolver
      if (result.outcome === 'not_applicable') {
        continue;
      }

      // We got a definitive outcome — evaluate
      if (result.outcome === 'verified' || result.outcome === 'mismatch') {
        // INV-O3: high-risk actions with T2-only verified → don't return yet,
        // continue trying for T0/T1 evidence from later resolvers.
        if (
          result.outcome === 'verified' &&
          HIGH_RISK_ACTION_FAMILIES.has(ctx.actionFamily) &&
          result.sourceTier === 'T2'
        ) {
          const hasHighTierEvidence = resolverResults.some(
            (r) => r.outcome === 'verified' && (r.sourceTier === 'T0' || r.sourceTier === 'T1'),
          );
          if (!hasHighTierEvidence) {
            // Don't return — keep trying subsequent resolvers for T0/T1
            continue;
          }
        }

        return {
          claim,
          resolverResults,
          verdict: result.outcome,
          verdictReason: result.reason,
        };
      }

      // 'insufficient' from a single resolver — continue trying others
      // (only if budget allows, checked at loop top)
    } catch {
      // Resolver threw — treat as not_applicable, try next
      resolverResults.push({
        resolver: resolver.id,
        outcome: 'not_applicable',
        sourceTier: 'T2',
        cacheHit: false,
        reason: 'resolver_error',
      });
      // Counter: failed resolver attempts must still be observable (P2-6).
      metrics.resolverTotal.add(1, {
        [GROUNDING_SOURCE_TIER]: 'T2',
        [STATUS]: resolver.id,
      });
      if (!budgetConsumed) {
        // Budget was exhausted, speculative call failed — truly exhausted.
        metrics.budgetExhaustedTotal.add(1, {
          [CALLBACK_TOOL]: ctx.tool,
          [GROUNDING_ACTION_FAMILY]: ctx.actionFamily,
        });
        return {
          claim,
          resolverResults,
          verdict: 'insufficient',
          verdictReason: 'resolver_budget_exhausted',
        };
      }
    }
  }

  // All resolvers exhausted without definitive answer.
  // INV-O3: if we saw T2-verified on a high-risk action but no T0/T1 confirmed it,
  // that's 'T2_only_on_high_risk' (we continued the loop instead of early-returning).
  const hasT2VerifiedHighRisk =
    HIGH_RISK_ACTION_FAMILIES.has(ctx.actionFamily) &&
    resolverResults.some((r) => r.outcome === 'verified' && r.sourceTier === 'T2');

  return {
    claim,
    resolverResults,
    verdict: 'insufficient',
    verdictReason: hasT2VerifiedHighRisk
      ? 'T2_only_on_high_risk'
      : resolverResults.every((r) => r.outcome === 'not_applicable')
        ? 'no_applicable_resolver'
        : 'all_resolvers_inconclusive',
  };
}
