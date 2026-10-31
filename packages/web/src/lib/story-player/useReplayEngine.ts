/**
 * F252 Story Player — React Hook for Replay Engine
 *
 * Bridges the pure replay-engine state machine with React state and
 * requestAnimationFrame timing. All replay logic is in replay-engine.ts;
 * this hook only handles:
 * - React state management (useState/useRef)
 * - RAF-based tick loop
 * - Keyboard shortcut bindings
 * - Session events fetching
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { adaptTranscriptEvents } from './adapter';
import { annotateAdaptivePacing } from './adaptive-pacing';
import { type Chapter, extractChapters } from './chapters';
import {
  compressEventTimestamps,
  createReplayEngine,
  pause,
  play,
  seek,
  setDisplayMode,
  setSpeed,
  stepBackward,
  stepForward,
  tick,
  toggleAdaptivePacing,
} from './replay-engine';
import { fetchThreadReplayEvents } from './thread-replay-fetcher';
import type { RawTranscriptEvent, ReplayEngineState, ReplayEvent, SpeedMultiplier } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseReplayEngineOptions {
  /** Session ID for single-session replay */
  sessionId?: string;
  /** Thread ID for thread-level replay (all sessions concatenated) — AC-E2 */
  threadId?: string;
  // INV-4: exactly one of sessionId or threadId must be provided
}

export interface UseReplayEngineResult {
  /** Current engine state */
  engine: ReplayEngineState;
  /** All replay events (adapted from raw) */
  events: ReplayEvent[];
  /** Events up to and including currentIndex (visible events) */
  visibleEvents: ReplayEvent[];
  /** Loading state */
  isLoading: boolean;
  /** Error message */
  error: string | null;
  /** Active skip indicator — non-null when current event follows a long idle gap */
  activeSkip: { originalGapMs: number } | null;
  /** Chapters for timeline navigation (AC-B2) */
  chapters: Chapter[];
  /** Controls */
  togglePlayPause: () => void;
  doSeek: (index: number) => void;
  doSetSpeed: (speed: SpeedMultiplier) => void;
  doStepForward: () => void;
  doStepBackward: () => void;
  doToggleDisplayMode: () => void;
  doToggleAdaptivePacing: () => void;
}

// ---------------------------------------------------------------------------
// Event fetching
// ---------------------------------------------------------------------------

async function fetchAllSessionEvents(sessionId: string): Promise<RawTranscriptEvent[]> {
  const all: RawTranscriptEvent[] = [];
  // API returns nextCursor as { eventNo: number } (TranscriptReader.ts:37)
  let cursorEventNo: number | undefined;

  // Paginate through all events using project's apiFetch (handles URL, credentials, 401 retry)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const params = new URLSearchParams({ view: 'raw', limit: '200' });
    if (cursorEventNo != null) params.set('cursor', String(cursorEventNo));

    const response = await apiFetch(`/api/sessions/${sessionId}/events?${params.toString()}`);

    if (!response.ok) {
      throw new Error(`Failed to fetch events: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      events: RawTranscriptEvent[];
      nextCursor?: { eventNo: number };
    };

    all.push(...data.events);

    if (!data.nextCursor) break;
    cursorEventNo = data.nextCursor.eventNo;
  }

  return all;
}

// ---------------------------------------------------------------------------
// Sub-hooks (extracted to reduce cognitive complexity)
// ---------------------------------------------------------------------------

type EngineSetter = React.Dispatch<React.SetStateAction<ReplayEngineState>>;

/** RAF-based tick loop that drives the replay engine forward */
function useReplayTick(setEngine: EngineSetter, engineRef: React.RefObject<ReplayEngineState>) {
  const lastTickRef = useRef<number>(0);

  useEffect(() => {
    let rafId: number;

    function rafLoop(timestamp: number) {
      if (lastTickRef.current === 0) lastTickRef.current = timestamp;
      const delta = timestamp - lastTickRef.current;
      lastTickRef.current = timestamp;

      if (engineRef.current?.state === 'playing') {
        setEngine((prev) => tick(prev, delta));
      }
      rafId = requestAnimationFrame(rafLoop);
    }

    rafId = requestAnimationFrame(rafLoop);
    return () => cancelAnimationFrame(rafId);
  }, [setEngine, engineRef]);

  return lastTickRef;
}

/** Keyboard shortcuts: Space=play/pause, ←→=step */
function useReplayKeyboard(setEngine: EngineSetter) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLButtonElement ||
        (target instanceof HTMLElement && target.getAttribute('role') === 'slider')
      )
        return;

      if (e.key === ' ') {
        e.preventDefault();
        setEngine((prev) => (prev.state === 'playing' ? pause(prev) : play(prev)));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setEngine((prev) => stepForward(prev));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setEngine((prev) => stepBackward(prev));
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setEngine]);
}

// ---------------------------------------------------------------------------
// Main hook
// ---------------------------------------------------------------------------

export function useReplayEngine(options: UseReplayEngineOptions): UseReplayEngineResult {
  const { sessionId, threadId } = options;

  // INV-4: exactly one of sessionId or threadId must be provided
  if (sessionId && threadId) {
    throw new Error('useReplayEngine: provide sessionId OR threadId, not both');
  }
  if (!sessionId && !threadId) {
    throw new Error('useReplayEngine: provide sessionId or threadId');
  }

  const [events, setEvents] = useState<ReplayEvent[]>([]);
  const [engine, setEngine] = useState<ReplayEngineState>(() => createReplayEngine([]));
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const engineRef = useRef(engine);
  engineRef.current = engine;

  // ── Fetch events on mount ──
  // AC-E2: threadId → fetch all sessions, merge by timestamp
  // sessionId → single session fetch (existing behavior)
  const fetchKey = sessionId ?? threadId ?? '';
  useEffect(() => {
    let cancelled = false;

    const fetchPromise = threadId ? fetchThreadReplayEvents(threadId) : fetchAllSessionEvents(sessionId!);

    fetchPromise
      .then((rawEvents) => {
        if (cancelled) return;
        const adapted = adaptTranscriptEvents(rawEvents);
        // AC-B1: Annotate idle gaps + pass-ball events (uses raw timestamps)
        const annotated = annotateAdaptivePacing(adapted);
        // AC-A2: Apply log compression to tool wait gaps (10s→3s, 60s→6s, 600s→12s)
        // Note: idle gap handling is now dynamic in the engine (P1-1 fix) —
        // toggle ON/OFF actually changes playback behavior instead of being baked in.
        const compressed = compressEventTimestamps(annotated);
        setEvents(compressed);
        setEngine(createReplayEngine(compressed));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load session events');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [fetchKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const lastTickRef = useReplayTick(setEngine, engineRef);
  useReplayKeyboard(setEngine);

  // ── Controls ──
  const togglePlayPause = useCallback(() => {
    setEngine((prev) => (prev.state === 'playing' ? pause(prev) : play(prev)));
    lastTickRef.current = 0;
  }, [lastTickRef]);

  const doSeek = useCallback((index: number) => {
    setEngine((prev) => seek(prev, index));
  }, []);

  const doSetSpeed = useCallback((speed: SpeedMultiplier) => {
    setEngine((prev) => setSpeed(prev, speed));
  }, []);

  const doStepForward = useCallback(() => {
    setEngine((prev) => stepForward(prev));
  }, []);

  const doStepBackward = useCallback(() => {
    setEngine((prev) => stepBackward(prev));
  }, []);

  const doToggleDisplayMode = useCallback(() => {
    setEngine((prev) => setDisplayMode(prev, prev.displayMode === 'cinematic' ? 'faithful' : 'cinematic'));
  }, []);

  const doToggleAdaptivePacing = useCallback(() => {
    setEngine((prev) => toggleAdaptivePacing(prev));
  }, []);

  const visibleEvents = events.slice(0, engine.currentIndex + 1);

  // AC-B1: Compute skip indicator — only when adaptive pacing is ON (P2 fix: no banner in fixed-speed mode)
  const currentEvent = events[engine.currentIndex];
  const activeSkip =
    engine.adaptivePacing && currentEvent?.idleSkipMs != null ? { originalGapMs: currentEvent.idleSkipMs } : null;

  // AC-B2: Extract chapters for timeline navigation
  // Memoized on events ref — extractChapters is O(n) and events only changes on initial load,
  // but tick updates engine state every RAF frame triggering re-renders
  const chapters = useMemo(() => (events.length > 0 ? extractChapters(events) : []), [events]);

  return {
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
  };
}
