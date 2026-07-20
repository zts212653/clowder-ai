/**
 * F257 — shared Redis constants for guard-rejection event storage.
 *
 * Single source of truth for the ZSET key and hard cap used by both
 * GuardRejectionEventLog (the storage layer) and the pagewise
 * threshold counter (the streaming read path).
 */

/** Redis ZSET key for guard-rejection events: { eventJSON → timestamp }. */
export const EVENTS_ZSET = 'guard-rejection:events';

/** Maximum events before truncation — shared between EventLog and pagewise counter. */
export const HARD_QUERY_CAP = 10_000;
