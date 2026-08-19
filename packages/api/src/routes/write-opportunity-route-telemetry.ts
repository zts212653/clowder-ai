import {
  MemoryContractTrialTelemetrySink,
  type MemoryContractTrialTraceOutcome,
} from '../domains/memory/people/AsrPersonMemoryContractTrialTelemetry.js';

const sink = new MemoryContractTrialTelemetrySink();

/** Payload-free runtime failure evidence for the durable boundary after contract validation. */
export function recordWriteOpportunityRouteError(outcome: MemoryContractTrialTraceOutcome): void {
  sink.record({ stage: 'error', outcome });
}
