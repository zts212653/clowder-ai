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

/**
 * Known guard → ledger registry coordinates.
 * Null-prototype + frozen (sol review P1-3): a plain object literal inherits
 * `toString`/`constructor`/`__proto__`, so `guardId in map` and `map[guardId]`
 * would accept prototype keys and return FUNCTIONS as ledgerIds. Lookups must
 * additionally go through Object.hasOwn (see isRegisteredGuardId).
 */
export const GUARD_LEDGER_IDS: Record<string, string> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, string>, {
    hold_ball_rate_limit: 'mcp/hold-ball-rate-limit',
    a2a_block_pingpong: 'mcp/a2a-pingpong-block',
    hold_ball_wait_source_ref: 'mcp/hold-ball-wait-source-ref',
    cross_post_routing_credentials: 'mcp/cross-post-routing-credentials',
    publish_verdict_authority: 'eval/publish-verdict-authority',
    a2a_route_decision_skip: 'mcp/a2a-route-decision-skip',
    gate_keeping_thread_default: 'mcp/gate-keeping-thread-default',
  }),
);

/** Prototype-safe whitelist membership (sol P1-3: `in` walks the prototype chain). */
export function isRegisteredGuardId(guardId: string): boolean {
  return Object.hasOwn(GUARD_LEDGER_IDS, guardId);
}

/**
 * Reverse whitelist: checks whether a given ledgerId is among the registered
 * values (not a guardId key). Prototype-safe (sol P2-2).
 * Validates incoming ledgerIds at API query boundaries — rejects spoofed
 * pot coordinates that don't map to any known guard.
 */
export function isRegisteredLedgerId(ledgerId: string): boolean {
  return Object.values(GUARD_LEDGER_IDS).includes(ledgerId);
}

/** Resolve a guard's ledger coordinate; unregistered guards are fail-visible. */
export function ledgerIdForGuard(guardId: string): string {
  return Object.hasOwn(GUARD_LEDGER_IDS, guardId) ? GUARD_LEDGER_IDS[guardId] : `unregistered/${guardId}`;
}

/** Characters that can appear inside a pot coordinate slug. */
const SLUG_CHAR = /[a-z0-9/-]/;

/**
 * Extract registered pot coordinates referenced in free text.
 * Token-boundary matching (sol P2-2): a bare substring test would attribute
 * `mcp/hold-ball-rate-limit-evil` (or `xmcp/...`) to the legitimate pot.
 * An occurrence counts only when both neighbors are non-slug characters
 * (or string edges).
 */
export function extractLedgerRefs(text: string): string[] {
  const refs: string[] = [];
  for (const ledgerId of Object.values(GUARD_LEDGER_IDS)) {
    let from = 0;
    while (true) {
      const idx = text.indexOf(ledgerId, from);
      if (idx < 0) break;
      const before = idx > 0 ? (text[idx - 1] as string) : '';
      const after = idx + ledgerId.length < text.length ? (text[idx + ledgerId.length] as string) : '';
      if (!(before && SLUG_CHAR.test(before)) && !(after && SLUG_CHAR.test(after))) {
        refs.push(ledgerId);
        break; // one ref per pot per note is enough for attribution
      }
      from = idx + 1;
    }
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
 * distinct referencing deviation eventIds'. Write fail-open (observation
 * loss acceptable), read fail-closed (fake zero misleads operators — sol P2-3).
 */
export class GuardLedgerStats {
  constructor(private readonly redis: StatsRedis) {}

  /** Owner-scoped (sol R2 P1: stats must not leak across owners). */
  async recordAnomalyReference(ownerUserId: string, ledgerId: string, deviationEventId: string): Promise<void> {
    try {
      await this.redis.sadd(`${STATS_KEY_PREFIX}${ownerUserId}:${ledgerId}:anomaly-refs`, deviationEventId);
    } catch {
      /* fail-open */
    }
  }

  /**
   * Read-side: propagates Redis errors (sol P2-3 — fake zero hides infra
   * failures from operators). Caller must catch and surface `{ available: false }`.
   */
  async anomalyReferenceCount(ownerUserId: string, ledgerId: string): Promise<number> {
    return await this.redis.scard(`${STATS_KEY_PREFIX}${ownerUserId}:${ledgerId}:anomaly-refs`);
  }
}
