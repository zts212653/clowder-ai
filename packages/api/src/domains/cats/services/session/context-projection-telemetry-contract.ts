import {
  CONTEXT_PROJECTION_DELTA_SIZE,
  CONTEXT_PROJECTION_DISPOSITION,
  CONTEXT_PROJECTION_LEDGER_OUTCOME,
  CONTEXT_PROJECTION_MODE,
  CONTEXT_PROJECTION_REASON,
  CONTEXT_PROJECTION_TIER,
  CONTEXT_PROJECTION_TRANSITION,
} from '../../../../infrastructure/telemetry/genai-semconv.js';
import type { ContextContinuityHandshake, ContinuityDisposition } from '../types.js';

export const CONTINUITY_DISPOSITION_REASON_SET = Object.freeze({
  no_prior_session: true,
  resume_rejected: true,
  resume_failed: true,
  carrier_forces_fresh: true,
  resume_confirmed: true,
  runtime_replaced: true,
  carrier_unsupported: true,
  signal_unavailable: true,
  binding_mismatch: true,
} satisfies Readonly<Record<ContinuityDisposition['reason'], true>>);

export const CONTEXT_PROJECTION_TELEMETRY_CONTRACT = Object.freeze({
  schemaVersion: 1,
  metricNames: Object.freeze({
    transitionTotal: 'cat_cafe.context_projection.transition_total',
    tierCount: 'cat_cafe.context_projection.tier_count',
    tierBytes: 'cat_cafe.context_projection.tier_bytes',
    deliveryLatency: 'cat_cafe.context_projection.delivery_latency',
    ledgerOutcomeTotal: 'cat_cafe.context_projection.ledger_outcome_total',
  }),
  metricAttributes: Object.freeze({
    disposition: CONTEXT_PROJECTION_DISPOSITION,
    reason: CONTEXT_PROJECTION_REASON,
    transition: CONTEXT_PROJECTION_TRANSITION,
    mode: CONTEXT_PROJECTION_MODE,
    deltaSize: CONTEXT_PROJECTION_DELTA_SIZE,
    tier: CONTEXT_PROJECTION_TIER,
    ledgerOutcome: CONTEXT_PROJECTION_LEDGER_OUTCOME,
  }),
  traceAttributes: Object.freeze({
    provider: 'context_projection.provider',
    carrier: 'context_projection.carrier',
    origin: 'context_projection.origin',
    topology: 'context_projection.topology',
    disposition: CONTEXT_PROJECTION_DISPOSITION,
    reason: CONTEXT_PROJECTION_REASON,
    transition: CONTEXT_PROJECTION_TRANSITION,
    mode: CONTEXT_PROJECTION_MODE,
    epoch: 'context_projection.epoch',
    deltaSize: CONTEXT_PROJECTION_DELTA_SIZE,
    tierT0Count: 'context_projection.tier_t0_count',
    tierT0Bytes: 'context_projection.tier_t0_bytes',
    tierT1Count: 'context_projection.tier_t1_count',
    tierT1Bytes: 'context_projection.tier_t1_bytes',
    tierT2Count: 'context_projection.tier_t2_count',
    tierT2Bytes: 'context_projection.tier_t2_bytes',
    tierInvalidCount: 'context_projection.tier_invalid_count',
    tierInvalidBytes: 'context_projection.tier_invalid_bytes',
    tierUnrecognizedCount: 'context_projection.tier_unrecognized_count',
    tierUnrecognizedBytes: 'context_projection.tier_unrecognized_bytes',
    deliveryLatencyMs: 'context_projection.delivery_latency_ms',
    ledgerOutcome: CONTEXT_PROJECTION_LEDGER_OUTCOME,
  }),
});

export const CONTEXT_PROJECTION_ENUMS = Object.freeze({
  providers: Object.freeze([
    'claude',
    'codex',
    'gemini',
    'antigravity',
    'kimi',
    'opencode',
    'acp',
    'catagent',
    'a2a',
    'unknown',
  ] as const),
  carriers: Object.freeze([
    'print_sdk',
    'bg_daemon',
    'interactive_pty',
    'api_key',
    'exec_json',
    'app_server',
    'gemini_cli',
    'antigravity_adapter',
    'cdp_bridge',
    'stream_json',
    'run_json',
    'acp',
    'direct_api',
    'remote',
    'unknown',
  ] as const),
  origins: Object.freeze(['interactive', 'headless', 'scheduled', 'connector', 'cloud', 'unknown'] as const),
  topologies: Object.freeze(['serial', 'parallel', 'independent'] as const),
  dispositions: Object.freeze(['fresh', 'resumed', 'replaced', 'unknown'] as const),
  reasons: Object.freeze(Object.keys(CONTINUITY_DISPOSITION_REASON_SET) as ContinuityDisposition['reason'][]),
  transitions: Object.freeze([
    'scope_first_seen',
    'fresh',
    'replaced',
    'unknown',
    'binding_mismatch',
    'resumed',
    'context_compacted',
    'context_compaction_replay',
  ] as const),
  contextModes: Object.freeze(['cold', 'hot'] as const),
  deltaSizes: Object.freeze(['small', 'large', 'absent'] as const),
  sourceTiers: Object.freeze(['T0', 'T1', 'T2', 'invalid'] as const),
  ledgerOutcomes: Object.freeze([
    'committed',
    'generation_mismatch',
    'reservation_superseded',
    'context_epoch_retired',
    'released',
    'no_reservation',
  ] as const),
});

export type BoundedTelemetryValue<T extends readonly string[]> = T[number] | 'unrecognized';
export type BoundedSourceTier = BoundedTelemetryValue<typeof CONTEXT_PROJECTION_ENUMS.sourceTiers>;
export type BoundedLedgerOutcome = BoundedTelemetryValue<typeof CONTEXT_PROJECTION_ENUMS.ledgerOutcomes>;

export interface BoundedContinuityProjection {
  readonly provider: string;
  readonly carrier: string;
  readonly origin: string;
  readonly topology: string;
  readonly disposition: string;
  readonly reason: string;
  readonly transition: string;
  readonly mode: string;
  readonly deltaSize: string;
  readonly epoch?: number;
}

export interface ProjectionTierSummary {
  readonly tier: BoundedSourceTier;
  readonly count: number;
  readonly bytes: number;
}

function bound(value: string | undefined, allowed: readonly string[]): string {
  return value !== undefined && allowed.includes(value) ? value : 'unrecognized';
}

export function projectBoundedContinuity(input: {
  readonly handshake: ContextContinuityHandshake;
  readonly transition: string;
  readonly contextMode: string;
  readonly contextEpoch?: number;
  readonly deltaSize?: string;
}): BoundedContinuityProjection {
  const { providerCarrier, invocationOrigin, routeTopology } = input.handshake.coordinate;
  const disposition = input.handshake.disposition;
  return {
    provider: bound(providerCarrier.provider, CONTEXT_PROJECTION_ENUMS.providers),
    carrier: bound(providerCarrier.carrier, CONTEXT_PROJECTION_ENUMS.carriers),
    origin: bound(invocationOrigin, CONTEXT_PROJECTION_ENUMS.origins),
    topology: bound(routeTopology, CONTEXT_PROJECTION_ENUMS.topologies),
    disposition: bound(disposition.state, CONTEXT_PROJECTION_ENUMS.dispositions),
    reason: bound(disposition.reason, CONTEXT_PROJECTION_ENUMS.reasons),
    transition: bound(input.transition, CONTEXT_PROJECTION_ENUMS.transitions),
    mode: bound(input.contextMode, CONTEXT_PROJECTION_ENUMS.contextModes),
    deltaSize: input.deltaSize === undefined ? 'absent' : bound(input.deltaSize, CONTEXT_PROJECTION_ENUMS.deltaSizes),
    ...(Number.isSafeInteger(input.contextEpoch) && (input.contextEpoch as number) >= 0
      ? { epoch: input.contextEpoch }
      : {}),
  };
}

export function summarizeFinalProjectionTiers(
  admitted: readonly {
    readonly presentation: { readonly sourceTier: string };
    readonly promptSegment: string;
  }[],
): readonly ProjectionTierSummary[] {
  const tiers = [...CONTEXT_PROJECTION_ENUMS.sourceTiers, 'unrecognized'] as const;
  const summary = new Map<BoundedSourceTier, { count: number; bytes: number }>(
    tiers.map((tier) => [tier, { count: 0, bytes: 0 }]),
  );
  for (const item of admitted) {
    const tier = bound(item.presentation.sourceTier, CONTEXT_PROJECTION_ENUMS.sourceTiers) as BoundedSourceTier;
    const current = summary.get(tier) as { count: number; bytes: number };
    current.count += 1;
    current.bytes += typeof item.promptSegment === 'string' ? Buffer.byteLength(item.promptSegment, 'utf8') : 0;
  }
  return tiers.map((tier) => ({ tier, ...(summary.get(tier) as { count: number; bytes: number }) }));
}

export function boundLedgerOutcome(outcome: string): BoundedLedgerOutcome {
  return bound(outcome, CONTEXT_PROJECTION_ENUMS.ledgerOutcomes) as BoundedLedgerOutcome;
}
