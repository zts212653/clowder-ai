import type { TraceAnnotation } from '@cat-cafe/shared';

/** Semantic-sweep history is audit-only and must not steer automation. */
export function isReplayableStructuredAnnotation(annotation: TraceAnnotation): boolean {
  return annotation.source === 'structured-rule' && annotation.confidence === 1;
}

/** Priority is an evaluator reading order, not a truth or governance decision. */
export function isEvaluationPriorityAnnotation(annotation: TraceAnnotation): boolean {
  if (isReplayableStructuredAnnotation(annotation)) {
    return annotation.polarity === 'counterexample' || annotation.polarity === 'positive';
  }
  return (
    annotation.source === 'mcp-marker' &&
    annotation.confidence > 0 &&
    (annotation.polarity === 'counterexample' ||
      annotation.polarity === 'positive' ||
      annotation.polarity === 'candidate')
  );
}

/** Counterexample signals may wake independent evaluation, but are not metric truth. */
export function isEvaluationPriorityCounterexample(annotation: TraceAnnotation): boolean {
  return (
    annotation.polarity === 'counterexample' &&
    annotation.confidence === 1 &&
    (isReplayableStructuredAnnotation(annotation) || annotation.source === 'mcp-marker')
  );
}

/** MCP markers recur by invocation; structured rules retain their replayable incident coordinate. */
export function counterexampleWakeKey(annotation: TraceAnnotation): string | null {
  if (!isEvaluationPriorityCounterexample(annotation)) return null;
  return annotation.source === 'mcp-marker'
    ? `mcp:${annotation.objectiveId}:${annotation.episodeRef.invocationId}`
    : `structured:${annotation.incidentKey}`;
}
