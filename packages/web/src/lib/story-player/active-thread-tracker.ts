/**
 * F252 Phase E PR E-4 — Active Thread Tracker
 *
 * AC-E5 + AC-E3: Detect which threads are active at a given playback
 * position to drive multi-cam layout (single/dual/multi) and
 * spotlight/dim visual state.
 *
 * Active = has events within `windowMs` before the current event's timestamp.
 * Spotlight = the thread whose event is currently playing.
 */

import type { ReplayEvent } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CamLayout = 'single' | 'dual' | 'multi';

export interface ActiveThreadState {
  /** Thread IDs with events near the current playback position */
  activeThreadIds: string[];
  /** Thread whose event is currently playing (spotlight) */
  spotlightThreadId: string | null;
  /** Layout mode derived from active thread count */
  layout: CamLayout;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect which threads are active at a given playback position.
 *
 * Scans backward from currentIndex collecting unique threadIds with events
 * within `windowMs` of the current event's timestamp. The current event's
 * thread is always spotlight and first in the active list.
 *
 * @param events - Replay events with sourceThreadId (from feature merger + adapter)
 * @param currentIndex - Current playback position
 * @param windowMs - Time window to consider threads "active" (default 30s)
 */
export function detectActiveThreads(
  events: readonly ReplayEvent[],
  currentIndex: number,
  windowMs = 30_000,
): ActiveThreadState {
  if (events.length === 0 || currentIndex < 0 || currentIndex >= events.length) {
    return { activeThreadIds: [], spotlightThreadId: null, layout: 'single' };
  }

  const current = events[currentIndex];
  const spotlightThreadId = current.sourceThreadId ?? null;
  const cutoff = current.timestamp - windowMs;

  // Collect unique threads with events in the window [cutoff, current.timestamp]
  const activeSet = new Set<string>();

  // Scan backward from currentIndex (events are time-sorted)
  for (let i = currentIndex; i >= 0; i--) {
    const ev = events[i];
    if (ev.timestamp < cutoff) break;
    if (ev.sourceThreadId) activeSet.add(ev.sourceThreadId);
  }

  // Ensure spotlight is in active set and first
  if (spotlightThreadId) activeSet.add(spotlightThreadId);

  const activeThreadIds = spotlightThreadId
    ? [spotlightThreadId, ...[...activeSet].filter((id) => id !== spotlightThreadId)]
    : [...activeSet];

  const count = activeThreadIds.length;
  const layout: CamLayout = count <= 1 ? 'single' : count === 2 ? 'dual' : 'multi';

  return { activeThreadIds, spotlightThreadId, layout };
}
