import type { EvaluationUnitRef, MetricDefinition, TraceAnnotation } from '@cat-cafe/shared';
import type { ObjectiveEvaluationRuntime } from './ObjectiveEvaluationRuntime.js';

export function distinctUnitRefs(unitRefs: EvaluationUnitRef[]): EvaluationUnitRef[] {
  const seen = new Set<string>();
  return unitRefs.filter((unitRef) => {
    const key = `${unitRef.unitType}:${unitRef.unitId}:${unitRef.clauseId ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function distinctIncidents(annotations: TraceAnnotation[]): TraceAnnotation[] {
  const seen = new Set<string>();
  return annotations
    .slice()
    .sort((left, right) => left.createdAt - right.createdAt || left.annotationId.localeCompare(right.annotationId))
    .filter((annotation) => {
      if (seen.has(annotation.incidentKey)) return false;
      seen.add(annotation.incidentKey);
      return true;
    });
}

export function triggerRequirement(metric: MetricDefinition): number | null {
  if (metric.trigger.kind === 'distinct-counterexamples') return metric.trigger.threshold;
  if (metric.trigger.kind === 'minimum-sample') return metric.trigger.minimum;
  return null;
}

export function unitRefsForObjective(runtime: ObjectiveEvaluationRuntime, objectiveId: string): EvaluationUnitRef[] {
  return runtime.catalog.manifest.units.flatMap((unit) =>
    unit.objectives
      .filter((attachment) => attachment.objectiveId === objectiveId)
      .map(() => ({
        unitType: 'segment' as const,
        unitId: unit.unitId,
      })),
  );
}
