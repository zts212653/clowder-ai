/** Structured scheduling mode used by explicit routing decisions. */
export type A2ARoutingMode = 'serial' | 'parallel';

/** Inline mentions remain explicitly serial; this constant grants no custody. */
export const A2A_INLINE_MENTION_MODE: A2ARoutingMode = 'serial';

/**
 * User-visible projection for one admitted parallel A2A target. Serial A2A
 * successors are independent durable wakes and do not emit handoff projections.
 */
export interface A2ARoutingProjection {
  readonly mode: 'parallel';
  readonly index: number;
  readonly total: number;
}

/** Read-only interpretation of a routing projection; never creates a wake. */
export function isRoutingProjectionStartingNow(projection: {
  readonly mode: A2ARoutingMode;
  readonly index: number;
}): boolean {
  return projection.mode === 'parallel' || projection.index <= 1;
}
