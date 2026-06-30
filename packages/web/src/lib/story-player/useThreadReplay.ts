'use client';

/**
 * F252 Phase E — Thread Replay Orchestrator Hook
 *
 * Combines useReplayEngine + bridgeReplayEvent to provide a complete
 * thread replay state for TheaterOverlay + ReplayMessageList.
 *
 * This is the single integration point that ties together:
 * - Thread-level event fetching (useReplayEngine with threadId)
 * - ReplayEvent → ChatMessage bridging
 * - Visible message computation
 */

import { useMemo } from 'react';
import type { Chapter } from './chapters';
import type { DensityBucket } from './event-density';
import { computeEventDensity } from './event-density';
import type { ReplayChatMessage } from './replay-chat-bridge';
import { buildReplayChatMessages } from './replay-chat-bridge';
import { useReplayEngine } from './useReplayEngine';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseThreadReplayOptions {
  /** Thread ID to replay */
  threadId: string;
}

export interface UseThreadReplayResult {
  /** Bridged visible messages (ready for ReplayMessageList) */
  messages: ReplayChatMessage[];
  /** Loading state */
  isLoading: boolean;
  /** Error message */
  error: string | null;
  /** Raw engine state (for ReplayControls) */
  engine: ReturnType<typeof useReplayEngine>['engine'];
  /** Active skip indicator — non-null when current event follows a long idle gap (Phase B) */
  activeSkip: { originalGapMs: number } | null;
  /** Chapters for timeline navigation (Phase B AC-B2) */
  chapters: Chapter[];
  /** Event density buckets for heatmap overlay (Phase E AC-E7) */
  densityBuckets: DensityBucket[];
  /** Playback controls */
  togglePlayPause: () => void;
  doSeek: (index: number) => void;
  doSetSpeed: ReturnType<typeof useReplayEngine>['doSetSpeed'];
  doStepForward: () => void;
  doStepBackward: () => void;
  doToggleDisplayMode: () => void;
  doToggleAdaptivePacing: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useThreadReplay({ threadId }: UseThreadReplayOptions): UseThreadReplayResult {
  const {
    engine,
    events,
    visibleEvents,
    isLoading,
    error,
    activeSkip,
    chapters,
    togglePlayPause,
    doSeek,
    doSetSpeed,
    doStepForward,
    doStepBackward,
    doToggleDisplayMode,
    doToggleAdaptivePacing,
  } = useReplayEngine({ threadId });

  // Bridge visible events to ChatMessage-compatible format
  const messages = useMemo(() => buildReplayChatMessages(visibleEvents), [visibleEvents]);

  // AC-E7: Compute event density for heatmap overlay
  // 50 buckets gives good visual resolution on typical progress bar widths
  const densityBuckets = useMemo(() => computeEventDensity(events, 50), [events]);

  return {
    messages,
    isLoading,
    error,
    engine,
    activeSkip,
    chapters,
    densityBuckets,
    togglePlayPause,
    doSeek,
    doSetSpeed,
    doStepForward,
    doStepBackward,
    doToggleDisplayMode,
    doToggleAdaptivePacing,
  };
}
