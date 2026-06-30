/**
 * F252 Phase E — Pure session event merge function
 *
 * Combines events from multiple sessions into a single time-sorted stream.
 * Pure function — no API calls, no side effects.
 */

import type { RawTranscriptEvent } from './types';

/**
 * Merge events from multiple sessions, sorted by timestamp.
 * Re-indexes eventNo monotonically after merge.
 *
 * INV-5: Output is sorted by t (ascending). Stable sort preserves
 * relative order of same-timestamp events.
 */
export function mergeSessionEvents(sessionEventSets: RawTranscriptEvent[][]): RawTranscriptEvent[] {
  const all = sessionEventSets.flat();

  // Sort by timestamp (stable — Array.prototype.sort is stable in V8/SpiderMonkey/JSC)
  all.sort((a, b) => a.t - b.t);

  // Re-index eventNo monotonically
  for (let i = 0; i < all.length; i++) {
    all[i] = { ...all[i], eventNo: i };
  }

  return all;
}
