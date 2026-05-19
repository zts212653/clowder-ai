/**
 * Redis key patterns for tool event log — F188 Phase F (AC-F10).
 *
 * Append-only event log per thread; complements ToolUsageCounter (aggregate count)
 * and bypasses TranscriptWriter dedup (砚砚 F188 二审 finding — toolNames → Set
 * loses sequence). Enables sequence/candidate/nudge metrics that aggregated
 * counters can't compute.
 *
 * Keys:
 *   tool-event-log:{threadId}  → ZSET; score=timestamp, member=JSON event
 *   skill-load-log:{sessionId} → ZSET; score=timestamp, member=JSON event
 *
 * TTL: 7 days (matches transcripts retention).
 */

export const TOOL_EVENT_LOG_TTL_SECONDS = 60 * 60 * 24 * 7;

export function toolEventLogKey(threadId: string): string {
  return `tool-event-log:${threadId}`;
}

export function skillLoadLogKey(sessionId: string): string {
  return `skill-load-log:${sessionId}`;
}
