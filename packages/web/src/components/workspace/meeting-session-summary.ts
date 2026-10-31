'use client';

import { type Dispatch, type SetStateAction, useEffect, useRef } from 'react';
import type { TranscriptLine } from './audio-transcript-contract';

/**
 * The last stopped capture session's result, mirrored from the F195 producer (the `/stop` summary and the SSE
 * `stopped` event) so the docked panel and the floating window can unmount and remount without losing it.
 * This is a same-page-session mirror, not a new authority and not a store: it is written only by producer events,
 * cleared the moment a new capture starts, and discarded on page reload — the declared boundary that no persisted
 * "last transcript" producer exists (gap-list #3) is unchanged.
 *
 * R2 fences (review R2-1): the mirror carries the owning thread's identity and restores only into that same thread,
 * only after the current audio status has actually been read — so a fresh mount can never pour a previous session
 * into a different thread or into a capture that is already running again. Retention itself is v2-only (review
 * R2-2): the classic panel keeps its original unload/reload behavior byte-for-byte.
 */
export interface MeetingSessionSummary {
  threadId: string;
  transcriptPath: string | null;
  recordingPath: string | null;
  recordingPaths: Record<string, string>;
  durationSec: number;
  lines: TranscriptLine[];
}

let retained: MeetingSessionSummary | null = null;

export function retainMeetingSessionSummary(summary: MeetingSessionSummary): void {
  retained = summary;
}

export function readMeetingSessionSummary(): MeetingSessionSummary | null {
  return retained;
}

export function clearMeetingSessionSummary(): void {
  retained = null;
}

type StopSummaryShape = {
  transcript_path?: string;
  recording_path?: string;
  recording_paths?: Record<string, string>;
  duration_s?: number;
};

export function retainFromStopEvent(
  event: StopSummaryShape,
  lines: TranscriptLine[],
  elapsedSec: number,
  threadId: string,
): void {
  retainMeetingSessionSummary({
    threadId,
    transcriptPath: event.transcript_path ?? null,
    recordingPath: event.recording_path ?? null,
    recordingPaths: event.recording_paths ?? {},
    durationSec: event.duration_s ?? elapsedSec,
    lines,
  });
}

interface MeetingSummarySetters {
  setSavedPath: Dispatch<SetStateAction<string | null>>;
  setSavedRecordingPath: Dispatch<SetStateAction<string | null>>;
  setSavedRecordingPaths: Dispatch<SetStateAction<Record<string, string>>>;
  setElapsed: Dispatch<SetStateAction<number>>;
  setLines: Dispatch<SetStateAction<TranscriptLine[]>>;
  /** R4-P1a: the restored result's owning thread, so downstream consumers (Files origin) keep the same identity. */
  setSavedResultOwner: Dispatch<SetStateAction<string | null>>;
}

/**
 * Restore the same session's stopped result after a panel departure (review P1-2). Fences, in order:
 * `enabled` (v2 lifecycle only — classic behavior is untouched), `statusResolved` (the current status was read, so
 * a re-entered running capture or a missed `started` event can never inherit old lines), and the owning threadId
 * (review R2-1: another thread never sees this session's result). Runs only when the flag flips, so an
 * already-occupied panel is never overwritten.
 */
export function useRestoreMeetingSessionSummary(
  hasCurrentResult: boolean,
  setters: MeetingSummarySetters,
  opts: { enabled: boolean; statusResolved: boolean; currentThreadId?: string },
): void {
  const ref = useRef(setters);
  ref.current = setters;
  useEffect(() => {
    if (!opts.enabled || !opts.statusResolved) return;
    if (hasCurrentResult) return;
    const retained = readMeetingSessionSummary();
    if (!retained || retained.threadId !== opts.currentThreadId) return;
    ref.current.setSavedPath(retained.transcriptPath);
    ref.current.setSavedRecordingPath(retained.recordingPath);
    ref.current.setSavedRecordingPaths(retained.recordingPaths);
    ref.current.setSavedResultOwner(retained.threadId);
    ref.current.setElapsed((current) => (current > 0 ? current : retained.durationSec));
    ref.current.setLines((current) => (current.length > 0 ? current : retained.lines));
  }, [hasCurrentResult, opts.enabled, opts.statusResolved, opts.currentThreadId]);
}
