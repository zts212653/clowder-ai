import type { MetricDefinition, TraceAnnotation } from '@cat-cafe/shared';
import { isReplayableStructuredAnnotation } from '../trace-annotation/high-confidence-annotation.js';

export function metricWindowStartFor(metric: MetricDefinition, now: number): number {
  if (metric.kind === 'counter' && metric.trigger.kind === 'distinct-counterexamples') {
    return metric.trigger.lookbackMs ? now - metric.trigger.lookbackMs : 0;
  }
  if (metric.kind === 'rate' && metric.trigger.kind === 'minimum-sample') {
    return now - metric.trigger.windowMs;
  }
  return 0;
}

export function selectCandidates(metric: MetricDefinition, annotations: TraceAnnotation[]): TraceAnnotation[] {
  if (metric.kind === 'counter' && metric.trigger.kind === 'distinct-counterexamples') {
    return distinctByIncident(
      annotations.filter(
        (annotation) => annotation.polarity === 'counterexample' && isReplayableStructuredAnnotation(annotation),
      ),
    );
  }
  if (metric.kind === 'rate' && metric.trigger.kind === 'minimum-sample') {
    return distinctByIncident(
      annotations
        .filter((annotation) => annotation.polarity === 'positive' || annotation.polarity === 'counterexample')
        .filter(isReplayableStructuredAnnotation),
    );
  }
  if (metric.trigger.kind === 'cadence') {
    return distinctByIncident(
      annotations
        .filter((annotation) => annotation.polarity === 'positive' || annotation.polarity === 'counterexample')
        .filter(isReplayableStructuredAnnotation),
    );
  }
  throw new Error(`evaluation_trigger_not_supported:${metric.id}`);
}

function distinctByIncident(annotations: TraceAnnotation[]): TraceAnnotation[] {
  const incidents = new Set<string>();
  return [...annotations]
    .sort((left, right) => left.createdAt - right.createdAt || left.annotationId.localeCompare(right.annotationId))
    .filter((annotation) => {
      if (incidents.has(annotation.incidentKey)) return false;
      incidents.add(annotation.incidentKey);
      return true;
    });
}
