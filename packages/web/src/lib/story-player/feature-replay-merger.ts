/**
 * F252 Phase E PR E-4 — Feature Replay Event Merger
 *
 * AC-E5: Merges events from multiple threads into a single time-sorted
 * stream for unified feature-level replay. Each event retains its
 * original threadId for per-panel partitioning in MultiCamStage.
 *
 * Reuses the same merge pattern as merge-session-events.ts (intra-thread)
 * but operates at inter-thread granularity.
 */

import type { RawTranscriptEvent } from './types';

/**
 * Merge events from multiple threads into a single time-sorted stream.
 * Re-indexes eventNo monotonically after merge. Each event keeps its
 * original threadId for downstream partitioning.
 *
 * @param threadEventMap - Map of threadId → events for that thread
 * @returns Merged, time-sorted, re-indexed event stream
 */
export function mergeFeatureEvents(threadEventMap: Map<string, RawTranscriptEvent[]>): RawTranscriptEvent[] {
  const all: RawTranscriptEvent[] = [];
  for (const events of threadEventMap.values()) {
    all.push(...events);
  }

  // Stable sort by timestamp (Array.prototype.sort is stable in V8/SpiderMonkey/JSC)
  all.sort((a, b) => a.t - b.t);

  // Re-index eventNo monotonically
  for (let i = 0; i < all.length; i++) {
    all[i] = { ...all[i], eventNo: i };
  }

  return all;
}
