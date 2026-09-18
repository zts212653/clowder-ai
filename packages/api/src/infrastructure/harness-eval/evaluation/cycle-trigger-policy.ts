import type { CycleRecord, CycleTriggerPolicy, CycleTriggerPolicyChange } from '@cat-cafe/shared';
import type { EvaluationModelDefinition } from '../objective-registry.js';
import type { EvaluationCatalog } from './evaluation-catalog.js';

const CUMULATIVE_STEP = 100;
const CADENCE_STEP_DAYS = 7;
const CADENCE_KEEP_STREAK_TO_RAISE = 2;
const DORMANT_CUMULATIVE_THRESHOLD = 500;
const DORMANT_CADENCE_DAYS = 21;
const DORMANT_KEEP_STREAK = 4;

export function initialCycleTriggerPolicy(model: EvaluationModelDefinition): CycleTriggerPolicy {
  return {
    ...model.cycleTrigger,
    consecutiveKeepCycles: 0,
    consecutiveCadenceKeepCycles: 0,
  };
}

export function cycleTriggerPolicyFor(catalog: EvaluationCatalog, record: CycleRecord): CycleTriggerPolicy {
  if (record.triggerPolicy) return structuredClone(record.triggerPolicy);
  const objective = catalog.registry.objectives.find((candidate) => candidate.id === record.objectiveId);
  const model = catalog.registry.evaluationModels.find((candidate) => candidate.id === objective?.evaluationModelId);
  if (!model) throw new Error(`cycle_evaluation_model_not_found:${record.objectiveId}`);
  return initialCycleTriggerPolicy(model);
}

export function adaptCycleTriggerPolicy(
  catalog: EvaluationCatalog,
  record: CycleRecord,
  decision: CycleTriggerPolicyChange['decision'],
  appliedAt: number,
): { change: CycleTriggerPolicyChange; lifecycle: 'active' | 'dormant' } {
  const floor = modelFor(catalog, record.objectiveId).cycleTrigger;
  const before = cycleTriggerPolicyFor(catalog, record);
  const after = structuredClone(before);
  if (decision === 'keep') {
    after.cumulativeThreshold += CUMULATIVE_STEP;
    after.consecutiveKeepCycles += 1;
    // A mixed trigger does not prove that cadence was the binding reason. D only
    // relaxes after repeated cadence-only keep cycles (low volume + no problem).
    const cadenceTriggered = record.triggeredBy?.length === 1 && record.triggeredBy[0] === 'cadence';
    after.consecutiveCadenceKeepCycles = cadenceTriggered ? after.consecutiveCadenceKeepCycles + 1 : 0;
    if (after.consecutiveCadenceKeepCycles >= CADENCE_KEEP_STREAK_TO_RAISE) {
      after.cadenceDays += CADENCE_STEP_DAYS;
      after.consecutiveCadenceKeepCycles = 0;
    }
  } else {
    after.cumulativeThreshold = Math.max(floor.cumulativeThreshold, after.cumulativeThreshold - CUMULATIVE_STEP);
    after.cadenceDays = Math.max(floor.cadenceDays, after.cadenceDays - CADENCE_STEP_DAYS);
    after.consecutiveKeepCycles = 0;
    after.consecutiveCadenceKeepCycles = 0;
  }
  // M is intentionally frozen at the factory floor until incident keys become root-cause coordinates.
  after.counterexampleThreshold = floor.counterexampleThreshold;
  after.minimumIntervalMs = floor.minimumIntervalMs;
  const lifecycle =
    after.cumulativeThreshold >= DORMANT_CUMULATIVE_THRESHOLD &&
    after.cadenceDays >= DORMANT_CADENCE_DAYS &&
    after.consecutiveKeepCycles >= DORMANT_KEEP_STREAK
      ? 'dormant'
      : 'active';
  return { change: { decision, before, after, appliedAt }, lifecycle };
}

function modelFor(catalog: EvaluationCatalog, objectiveId: string): EvaluationModelDefinition {
  const objective = catalog.registry.objectives.find((candidate) => candidate.id === objectiveId);
  const model = catalog.registry.evaluationModels.find((candidate) => candidate.id === objective?.evaluationModelId);
  if (!model) throw new Error(`cycle_evaluation_model_not_found:${objectiveId}`);
  return model;
}
