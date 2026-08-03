import { OPERATION_NAME, STATUS } from '../../../infrastructure/telemetry/genai-semconv.js';
import { personMemoryOutcome, personMemoryStageDuration } from '../../../infrastructure/telemetry/instruments.js';

const PERSON_MEMORY_STAGES = [
  'stage',
  'publish',
  'decision',
  'materialize',
  'undo',
  'recall',
  'drill',
  'correct',
  'retire',
  'amend',
  'redact',
  'forget',
] as const;

const PERSON_MEMORY_OUTCOMES = [
  'success',
  'replayed',
  'not_available',
  'invalid',
  'conflict',
  'error',
  'ambiguous',
  'budget_exceeded',
  'stale_ignored',
] as const;

export type PersonMemoryTelemetryStage = (typeof PERSON_MEMORY_STAGES)[number];
export type PersonMemoryTelemetryOutcome = (typeof PERSON_MEMORY_OUTCOMES)[number];

const stageSet = new Set<string>(PERSON_MEMORY_STAGES);
const outcomeSet = new Set<string>(PERSON_MEMORY_OUTCOMES);

export function personMemoryMetricAttributes(stage: string, outcome: string): Record<string, string> {
  if (!stageSet.has(stage)) throw new Error(`invalid person-memory telemetry stage: ${stage}`);
  if (!outcomeSet.has(outcome)) throw new Error(`invalid person-memory telemetry outcome: ${outcome}`);
  return {
    [OPERATION_NAME]: `person_memory.${stage}`,
    [STATUS]: outcome,
  };
}

export function recordPersonMemoryStage(
  stage: PersonMemoryTelemetryStage,
  outcome: PersonMemoryTelemetryOutcome,
  durationMs: number,
): void {
  const attributes = personMemoryMetricAttributes(stage, outcome);
  personMemoryStageDuration.record(Math.max(0, durationMs), attributes);
  personMemoryOutcome.add(1, attributes);
}

export async function observePersonMemoryStage<T>(
  stage: PersonMemoryTelemetryStage,
  operation: () => Promise<T>,
  outcomeOf: (result: T) => PersonMemoryTelemetryOutcome = () => 'success',
): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await operation();
    recordPersonMemoryStage(stage, outcomeOf(result), performance.now() - startedAt);
    return result;
  } catch (error) {
    recordPersonMemoryStage(stage, 'error', performance.now() - startedAt);
    throw error;
  }
}
