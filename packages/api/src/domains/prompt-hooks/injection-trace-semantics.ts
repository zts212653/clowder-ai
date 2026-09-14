import type { ObservedSegment } from '@cat-cafe/shared';

/**
 * Whether an observed trace row represents content that was actually fired.
 * Legacy v0 rows omitted pipelineStatus after recording an observed segment,
 * so absence remains fired for backward-compatible raw-trace interpretation.
 */
export function isFiredTraceSegment(segment: Pick<ObservedSegment, 'status' | 'pipelineStatus'>): boolean {
  return segment.status === 'observed' && (segment.pipelineStatus === 'fired' || !segment.pipelineStatus);
}
