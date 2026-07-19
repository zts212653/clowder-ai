/**
 * F257 V2/Phase B — guard → ledger registry coordinate mapping.
 *
 * `ledgerId` is the "which pot" coordinate (`{layer}/{slug}`, spec OQ-2):
 * per-GUARD, carried in every guard-rejection event AND in the rejection
 * response body, so the rejected cat can quote it in an anomaly report
 * (F245 fifth friction source adapter → pot stats attribution).
 *
 * Dual-coordinate contract (V2 ruling): `ledgerId` (pot) and `eventId`
 * (per-raw-rejection) are DIFFERENT coordinates and never interchangeable.
 * `episodeId` is a third, derived coordinate (see guard-episode-coalescing).
 *
 * YAML registry files (docs/harness-feedback/ledger/{layer}/{slug}.yaml)
 * are a progressive backfill task per spec AC-A1 — this constant map is the
 * code-side source of truth until the YAML registry lands. Unregistered
 * guards get a fail-visible `unregistered/` prefix instead of a silent
 * fallback, so a missing registration shows up in eval verdicts.
 */

/** Known guard → ledger registry coordinates. */
export const GUARD_LEDGER_IDS: Record<string, string> = {
  hold_ball_rate_limit: 'mcp/hold-ball-rate-limit',
  a2a_block_pingpong: 'mcp/a2a-pingpong-block',
  hold_ball_wait_source_ref: 'mcp/hold-ball-wait-source-ref',
  cross_post_routing_credentials: 'mcp/cross-post-routing-credentials',
  publish_verdict_authority: 'eval/publish-verdict-authority',
  a2a_route_decision_skip: 'mcp/a2a-route-decision-skip',
  gate_keeping_thread_default: 'mcp/gate-keeping-thread-default',
};

/** Resolve a guard's ledger coordinate; unregistered guards are fail-visible. */
export function ledgerIdForGuard(guardId: string): string {
  return GUARD_LEDGER_IDS[guardId] ?? `unregistered/${guardId}`;
}

/** Extract registered pot coordinates referenced in free text (whitelist-exact, zero false positives). */
export function extractLedgerRefs(text: string): string[] {
  const refs: string[] = [];
  for (const ledgerId of Object.values(GUARD_LEDGER_IDS)) {
    if (text.includes(ledgerId)) refs.push(ledgerId);
  }
  return refs;
}

/** Minimal Redis surface the stats store needs. */
interface StatsRedis {
  sadd(key: string, member: string): Promise<number>;
  scard(key: string): Promise<number>;
}

const STATS_KEY_PREFIX = 'guard-ledger:stats:';

/**
 * F257 V2 AC-B2 — idempotent per-pot anomaly-reference stats.
 *
 * Writeback happens on the WRITE side (report-harness-signal, when an
 * anomaly report referencing a pot is recorded) — F245 KD-4 keeps the
 * friction pull path strictly read-only. SADD of the referencing deviation
 * eventId is idempotent, so dedup/replay never double-counts.
 *
 * how_counted: 'scard guard-ledger:stats:{ledgerId}:anomaly-refs —
 * distinct referencing deviation eventIds'. Fail-open both ways.
 */
export class GuardLedgerStats {
  constructor(private readonly redis: StatsRedis) {}

  async recordAnomalyReference(ledgerId: string, deviationEventId: string): Promise<void> {
    try {
      await this.redis.sadd(`${STATS_KEY_PREFIX}${ledgerId}:anomaly-refs`, deviationEventId);
    } catch {
      /* fail-open */
    }
  }

  async anomalyReferenceCount(ledgerId: string): Promise<number> {
    try {
      return await this.redis.scard(`${STATS_KEY_PREFIX}${ledgerId}:anomaly-refs`);
    } catch {
      return 0;
    }
  }
}
