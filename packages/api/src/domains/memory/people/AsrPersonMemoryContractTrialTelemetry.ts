import type { WriteOpportunityDispositionV1 } from '@cat-cafe/shared';
import { trace as otelTrace } from '@opentelemetry/api';
import { OPERATION_NAME, STATUS } from '../../../infrastructure/telemetry/genai-semconv.js';
import { personMemoryOutcome } from '../../../infrastructure/telemetry/instruments.js';

export type MemoryContractTrialTraceStage = 'eligible' | 'delivered' | 'omitted' | 'disposition' | 'error' | 'burden';

export type MemoryContractTrialTraceOutcome =
  | 'admitted'
  | 'delivered'
  | 'omitted'
  | 'recorded'
  | 'owner_approval_requested'
  | 'rearmed_after_defer'
  | 'invalid_scene'
  | 'invalid_lineage'
  | 'receipt_not_deferred'
  | 'scope_mismatch'
  | 'predicate_revision_mismatch'
  | 'scope_revoked'
  | 'expired'
  | 'not_yet_eligible'
  | 'duplicate_generation'
  | 'generation_exhausted'
  | 'terminal_ledger_unavailable'
  | 'disposition_authority_unavailable'
  | 'opportunity_not_eligible'
  | 'continuity_authority_unavailable'
  | 'invalid_presentation_evidence'
  | 'already_disposed'
  | 'delivery_required'
  | 'invalid_disposition'
  | 'disposition_lineage_mismatch'
  | 'source_revision_mismatch'
  | 'rearm_predicate_not_met';

export interface MemoryContractTrialTraceEvent {
  readonly stage: MemoryContractTrialTraceStage;
  readonly outcome: MemoryContractTrialTraceOutcome;
  readonly disposition?: WriteOpportunityDispositionV1['disposition'];
  readonly units?: number;
}

export interface MemoryContractTrialTraceSink {
  record(event: MemoryContractTrialTraceEvent): void;
}

const contractTrialTracer = otelTrace.getTracer('cat-cafe-api', '0.1.0');

export function memoryContractTrialTraceAttributes(
  event: MemoryContractTrialTraceEvent,
): Record<string, string | number> {
  return {
    'memory.contract.stage': event.stage,
    'memory.contract.outcome': event.outcome,
    ...(event.disposition ? { 'memory.contract.disposition': event.disposition } : {}),
    ...(event.units === undefined ? {} : { 'memory.contract.burden_units': event.units }),
  };
}

/** Production sink: bounded metrics plus payload-free span evidence for every contract stage. */
export class MemoryContractTrialTelemetrySink implements MemoryContractTrialTraceSink {
  record(event: MemoryContractTrialTraceEvent): void {
    const metricStatus = event.stage === 'error' ? 'error' : event.stage === 'omitted' ? 'not_available' : 'success';
    personMemoryOutcome.add(event.units ?? 1, {
      [OPERATION_NAME]: `person_memory.contract_trial.${event.stage}`,
      [STATUS]: metricStatus,
    });
    const span = contractTrialTracer.startSpan('cat_cafe.person_memory.contract_trial', {
      attributes: memoryContractTrialTraceAttributes(event),
    });
    span.end();
  }
}
