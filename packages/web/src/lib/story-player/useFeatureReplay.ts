'use client';

/**
 * F252 Phase E PR E-4 — Feature-Level Replay Orchestrator Hook
 *
 * Combines multi-thread event fetching + merging + the existing replay
 * pipeline (adapt → pacing → compress → engine) to provide feature-level
 * replay with multi-cam layout and spotlight/dim state.
 *
 * Architecture: Single unified replay engine. Events are merged from all
 * threads, and visible events are partitioned by sourceThreadId for
 * per-panel rendering. detectActiveThreads() drives layout decisions.
 *
 * AC-E5: Multi-cam split screen
 * AC-E3: Spotlight + Dim (panel mode per thread)
 */

import type { FeatureStoryRenderingDTO, SwimlaneDTO } from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { ActiveThreadState, CamLayout } from './active-thread-tracker';
import { detectActiveThreads } from './active-thread-tracker';
import { adaptTranscriptEvents } from './adapter';
import { annotateAdaptivePacing } from './adaptive-pacing';
import { buildThreadPanels, type ThreadPanelData } from './build-thread-panels';
import { type Chapter, extractChapters } from './chapters';
import { detectCrossFeatureEvent } from './cross-feature-detector';
import type { DensityBucket } from './event-density';
import { computeEventDensity } from './event-density';
import { mergeFeatureEvents } from './feature-replay-merger';
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
import type { GuestCardState, RawTranscriptEvent, ReplayEngineState, ReplayEvent, SpeedMultiplier } from './types';

// Re-export for consumers that import from this module
export type { ThreadPanelData } from './build-thread-panels';

export interface UseFeatureReplayResult {
  /** Per-thread panel data for MultiCamStage */
  threadPanels: ThreadPanelData[];
  /** Current layout mode */
  layout: CamLayout;
  /** Raw engine state (for ReplayControls) */
  engine: ReplayEngineState;
  /** Loading state */
  isLoading: boolean;
  /** Error message */
  error: string | null;
  /** Active skip indicator (Phase B) */
  activeSkip: { originalGapMs: number } | null;
  /** Chapters for timeline navigation (AC-B2) */
  chapters: Chapter[];
  /** Event density buckets for heatmap (AC-E7) */
  densityBuckets: DensityBucket[];
  /** Active guest card state, null when no cross-feature event (AC-E6) */
  guestCard: GuestCardState | null;
  /** Playback controls */
  togglePlayPause: () => void;
  doSeek: (index: number) => void;
  doSetSpeed: (speed: SpeedMultiplier) => void;
  doStepForward: () => void;
  doStepBackward: () => void;
  doToggleDisplayMode: () => void;
  doToggleAdaptivePacing: () => void;
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

interface FeatureEventData {
  events: ReplayEvent[];
  lanes: SwimlaneDTO[];
}

async function fetchFeatureReplayData(featId: string): Promise<FeatureEventData> {
  // 1. Fetch rendering DTO for thread list + metadata
  const res = await apiFetch(`/api/story/feat:${featId}/rendering`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { message?: string }).message || `Failed to fetch feature story: ${res.status}`);
  }
  const dto: FeatureStoryRenderingDTO = await res.json();

  if (dto.lanes.length === 0) {
    return { events: [], lanes: [] };
  }

  // 2. Fetch events for all threads in parallel
  const threadEventSets = await Promise.all(
    dto.lanes.map(async (lane) => {
      const events = await fetchThreadReplayEvents(lane.threadId);
      return [lane.threadId, events] as const;
    }),
  );

  const threadEventMap = new Map<string, RawTranscriptEvent[]>(threadEventSets);

  // 3. Merge into unified timeline
  const merged = mergeFeatureEvents(threadEventMap);

  // 4. Run through existing adapter pipeline
  const adapted = adaptTranscriptEvents(merged);
  const annotated = annotateAdaptivePacing(adapted);
  const compressed = compressEventTimestamps(annotated);

  return { events: compressed, lanes: dto.lanes };
}

// ---------------------------------------------------------------------------
// Sub-hooks (extracted from useReplayEngine pattern)
// ---------------------------------------------------------------------------

type EngineSetter = React.Dispatch<React.SetStateAction<ReplayEngineState>>;

function useFeatureReplayTick(setEngine: EngineSetter, engineRef: React.RefObject<ReplayEngineState>) {
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

function useFeatureReplayKeyboard(setEngine: EngineSetter) {
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

export function useFeatureReplay({ featId }: { featId: string }): UseFeatureReplayResult {
  const [events, setEvents] = useState<ReplayEvent[]>([]);
  const [lanes, setLanes] = useState<SwimlaneDTO[]>([]);
  const [engine, setEngine] = useState<ReplayEngineState>(() => createReplayEngine([]));
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const engineRef = useRef(engine);
  engineRef.current = engine;

  // ── Fetch feature events on mount ──
  useEffect(() => {
    let cancelled = false;

    fetchFeatureReplayData(featId)
      .then((data) => {
        if (cancelled) return;
        setEvents(data.events);
        setLanes(data.lanes);
        setEngine(createReplayEngine(data.events));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load feature events');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [featId]);

  // ── RAF tick loop + keyboard shortcuts ──
  const lastTickRef = useFeatureReplayTick(setEngine, engineRef);
  useFeatureReplayKeyboard(setEngine);

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

  // ── Derived state: active threads + per-panel data ──

  // Detect active threads at current playback position
  const activeState: ActiveThreadState = useMemo(
    () => detectActiveThreads(events, engine.currentIndex),
    [events, engine.currentIndex],
  );

  // Partition visible events by sourceThreadId → per-panel messages
  const visibleEvents = useMemo(() => events.slice(0, engine.currentIndex + 1), [events, engine.currentIndex]);

  // Build ThreadPanelData[] for MultiCamStage — delegates to pure function
  const threadPanels: ThreadPanelData[] = useMemo(
    () => buildThreadPanels(lanes, activeState, visibleEvents),
    [lanes, activeState, visibleEvents],
  );

  // ── Skip indicator ──
  const currentEvent = events[engine.currentIndex];
  const activeSkip =
    engine.adaptivePacing && currentEvent?.idleSkipMs != null ? { originalGapMs: currentEvent.idleSkipMs } : null;

  // ── Guest card (AC-E6) — detect cross-feature interactions ──
  // Exclude guest lanes (thread_merge targets from other features) so the
  // cross-feature detector fires for cross-posts to those threads (AC-E6).
  const featureThreadIds = useMemo(() => new Set(lanes.filter((l) => !l.guest).map((l) => l.threadId)), [lanes]);

  const guestCard: GuestCardState | null = useMemo(() => {
    if (!currentEvent) return null;
    const info = detectCrossFeatureEvent(currentEvent, featureThreadIds);
    if (!info) return null;
    return {
      targetThreadId: info.targetThreadId,
      contentSnippet: info.contentSnippet,
      catId: info.catId,
      eventIndex: info.eventIndex,
    };
  }, [currentEvent, featureThreadIds]);

  // ── Chapters + density (memoized on events) ──
  const chapters = useMemo(() => (events.length > 0 ? extractChapters(events) : []), [events]);
  const densityBuckets = useMemo(() => computeEventDensity(events, 50), [events]);

  return {
    threadPanels,
    layout: activeState.layout,
    engine,
    isLoading,
    error,
    activeSkip,
    chapters,
    densityBuckets,
    guestCard,
    togglePlayPause,
    doSeek,
    doSetSpeed,
    doStepForward,
    doStepBackward,
    doToggleDisplayMode,
    doToggleAdaptivePacing,
  };
}
