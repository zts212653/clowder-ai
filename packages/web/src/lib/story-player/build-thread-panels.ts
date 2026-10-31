/**
 * F252 Phase E — Pure panel-builder logic
 *
 * Extracted from useFeatureReplay for testability and to stay within
 * the 350-line file limit. Maps ALL lanes to ThreadPanelData with
 * correct mode assignment and positional ordering for MultiCamStage.
 */

import type { SwimlaneDTO } from '@cat-cafe/shared';
import type { ActiveThreadState } from './active-thread-tracker';
import type { ReplayChatMessage } from './replay-chat-bridge';
import { buildReplayChatMessages } from './replay-chat-bridge';
import type { ReplayEvent } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ThreadPanelData {
  threadId: string;
  threadName: string;
  participants: string[];
  mode: 'spotlight' | 'active' | 'dim';
  messages: ReplayChatMessage[];
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build ThreadPanelData[] from lanes, active thread state, and visible events.
 *
 * Maps ALL lanes (not just active threads) so that non-active threads get
 * 'dim' mode — essential for AC-E3 spotlight/dim visual state.
 */
export function buildThreadPanels(
  lanes: SwimlaneDTO[],
  activeState: ActiveThreadState,
  visibleEvents: ReplayEvent[],
): ThreadPanelData[] {
  if (lanes.length === 0) return [];

  // Group visible events by sourceThreadId
  const eventsByThread = new Map<string, ReplayEvent[]>();
  for (const ev of visibleEvents) {
    if (!ev.sourceThreadId) continue;
    let arr = eventsByThread.get(ev.sourceThreadId);
    if (!arr) {
      arr = [];
      eventsByThread.set(ev.sourceThreadId, arr);
    }
    arr.push(ev);
  }

  const panels = lanes.map((lane) => {
    const { threadId } = lane;
    const threadEvents = eventsByThread.get(threadId) ?? [];
    const mode: ThreadPanelData['mode'] =
      threadId === activeState.spotlightThreadId
        ? 'spotlight'
        : activeState.activeThreadIds.includes(threadId)
          ? 'active'
          : 'dim';

    return {
      threadId,
      threadName: lane.threadName,
      participants: lane.participants,
      mode,
      messages: buildReplayChatMessages(threadEvents),
    };
  });

  // Sort: spotlight first → active (recency) → dim.
  // MultiCamStage uses positional indexing (panels[0] = primary,
  // panels.slice(0,2) = main stage), so ordering matters.
  // Within the same mode group, preserve recency from activeThreadIds
  // (AC-E5: main stage shows the 2 most recently active threads).
  const MODE_ORDER: Record<ThreadPanelData['mode'], number> = { spotlight: 0, active: 1, dim: 2 };
  panels.sort((a, b) => {
    const modeDiff = MODE_ORDER[a.mode] - MODE_ORDER[b.mode];
    if (modeDiff !== 0) return modeDiff;
    // Recency tiebreaker: lower index in activeThreadIds = more recent
    const aIdx = activeState.activeThreadIds.indexOf(a.threadId);
    const bIdx = activeState.activeThreadIds.indexOf(b.threadId);
    return (aIdx === -1 ? Infinity : aIdx) - (bIdx === -1 ? Infinity : bIdx);
  });

  return panels;
}
