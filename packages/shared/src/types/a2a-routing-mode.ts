/** Structured scheduling mode used by explicit routing decisions. */
export type A2ARoutingMode = 'serial' | 'parallel';

/**
 * User-visible projection for one admitted parallel A2A target. Serial A2A
 * successors are independent durable wakes and do not emit handoff projections.
 */
export interface A2ARoutingProjection {
  readonly mode: 'parallel';
  readonly index: number;
  readonly total: number;
}
