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
