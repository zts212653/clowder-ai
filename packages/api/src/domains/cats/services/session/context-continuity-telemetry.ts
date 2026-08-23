import type { Span } from '@opentelemetry/api';
import {
  contextProjectionDeliveryLatency,
  contextProjectionLedgerOutcomeTotal,
  contextProjectionTierBytes,
  contextProjectionTierCount,
  contextProjectionTransitionTotal,
} from '../../../../infrastructure/telemetry/instruments.js';
import type { ContextContinuityHandshake } from '../types.js';
import {
  type BoundedLedgerOutcome,
  type BoundedSourceTier,
  boundLedgerOutcome,
  CONTEXT_PROJECTION_TELEMETRY_CONTRACT,
  projectBoundedContinuity,
  summarizeFinalProjectionTiers,
} from './context-projection-telemetry-contract.js';

type ProjectionItem = {
  readonly presentation: { readonly sourceTier: string };
  readonly promptSegment: string;
};

function setFinite(span: Span | undefined, key: string, value: number | undefined): void {
  if (span && value !== undefined && Number.isFinite(value) && value >= 0) {
    span.setAttribute(key, Math.round(value));
  }
}

function safelyRecord(observation: () => void): void {
  try {
    observation();
  } catch {
    // F153 telemetry is descriptive. A broken exporter/span cannot rewrite
    // provider delivery, ledger state, retries, or omission semantics.
  }
}

function tierTraceKeys(tier: BoundedSourceTier): readonly [string, string] {
  const keys = CONTEXT_PROJECTION_TELEMETRY_CONTRACT.traceAttributes;
  switch (tier) {
    case 'T0':
      return [keys.tierT0Count, keys.tierT0Bytes];
    case 'T1':
      return [keys.tierT1Count, keys.tierT1Bytes];
    case 'T2':
      return [keys.tierT2Count, keys.tierT2Bytes];
    case 'invalid':
      return [keys.tierInvalidCount, keys.tierInvalidBytes];
    case 'unrecognized':
      return [keys.tierUnrecognizedCount, keys.tierUnrecognizedBytes];
  }
}

/** Emit only after the final generation exists; inputs contain no body-bearing coordinates. */
export function recordContextProjectionFinalGeneration(
  span: Span | undefined,
  input: {
    readonly handshake: ContextContinuityHandshake;
    readonly transition: string;
    readonly contextMode: string;
    readonly contextEpoch?: number;
    readonly deltaSize?: string;
    readonly admitted: readonly ProjectionItem[];
  },
): void {
  safelyRecord(() => {
    const projection = projectBoundedContinuity(input);
    const contract = CONTEXT_PROJECTION_TELEMETRY_CONTRACT;
    const metricAttributes = {
      [contract.metricAttributes.disposition]: projection.disposition,
      [contract.metricAttributes.reason]: projection.reason,
      [contract.metricAttributes.transition]: projection.transition,
      [contract.metricAttributes.mode]: projection.mode,
      [contract.metricAttributes.deltaSize]: projection.deltaSize,
    };
    contextProjectionTransitionTotal.add(1, metricAttributes);

    if (span) {
      const keys = contract.traceAttributes;
      span.setAttribute(keys.provider, projection.provider);
      span.setAttribute(keys.carrier, projection.carrier);
      span.setAttribute(keys.origin, projection.origin);
      span.setAttribute(keys.topology, projection.topology);
      span.setAttribute(keys.disposition, projection.disposition);
      span.setAttribute(keys.reason, projection.reason);
      span.setAttribute(keys.transition, projection.transition);
      span.setAttribute(keys.mode, projection.mode);
      span.setAttribute(keys.deltaSize, projection.deltaSize);
      setFinite(span, keys.epoch, projection.epoch);
    }

    for (const summary of summarizeFinalProjectionTiers(input.admitted)) {
      const tierAttributes = { [contract.metricAttributes.tier]: summary.tier };
      contextProjectionTierCount.record(summary.count, tierAttributes);
      contextProjectionTierBytes.record(summary.bytes, tierAttributes);
      const [countKey, bytesKey] = tierTraceKeys(summary.tier);
      setFinite(span, countKey, summary.count);
      setFinite(span, bytesKey, summary.bytes);
    }
  });
}

/** Record latency only after a provider receipt exists. */
export function recordContextProjectionDeliveryLatency(span: Span | undefined, latencyMs: number): void {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
  safelyRecord(() => {
    const rounded = Math.round(latencyMs);
    contextProjectionDeliveryLatency.record(rounded);
    setFinite(span, CONTEXT_PROJECTION_TELEMETRY_CONTRACT.traceAttributes.deliveryLatencyMs, rounded);
  });
}

export function ledgerOutcomeFromCommits(outcomes: readonly string[]): BoundedLedgerOutcome {
  if (outcomes.length === 0) return 'no_reservation';
  const bounded = outcomes.map(boundLedgerOutcome);
  for (const outcome of [
    'generation_mismatch',
    'context_epoch_retired',
    'reservation_superseded',
    'unrecognized',
    'committed',
  ] as const) {
    if (bounded.includes(outcome)) return outcome;
  }
  return 'unrecognized';
}

export function recordContextProjectionLedgerOutcome(span: Span | undefined, outcome: string): void {
  safelyRecord(() => {
    const bounded = boundLedgerOutcome(outcome);
    const contract = CONTEXT_PROJECTION_TELEMETRY_CONTRACT;
    contextProjectionLedgerOutcomeTotal.add(1, {
      [contract.metricAttributes.ledgerOutcome]: bounded,
    });
    span?.setAttribute(contract.traceAttributes.ledgerOutcome, bounded);
  });
}
