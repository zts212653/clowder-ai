/**
 * F257 V1 — Redis key patterns for the RoutingDecisionFact query projection.
 *
 * The authority record is the `routingFact` field embedded in the message hash
 * (written in the same append — §4.5.1). These keys are the asynchronously
 * derived query-side projection; they are rebuildable from the authority
 * records at any time and carry no truth of their own.
 *
 * All keys share the cat-cafe: prefix set by the Redis client. TTL=0
 * (persistent) — evaluation needs a ≥14d baseline window.
 */

export const RoutingFactKeys = {
  /** Owner-scoped time index of fact-carrying messages: ZSET score=timestamp member=messageId */
  index: (ownerUserId: string) => `routing-fact:idx:${ownerUserId}`,

  /** §4.5.1①: owner-scoped high-watermark — highest projected authority id (sortable messageId) */
  watermark: (ownerUserId: string) => `routing-fact:watermark:${ownerUserId}`,

  /** §4.5.1③: projection worker errors — ZSET score=errorTs member=messageId (visible, never swallowed) */
  projectionErrors: (ownerUserId: string) => `routing-fact:proj-errors:${ownerUserId}`,
} as const;
