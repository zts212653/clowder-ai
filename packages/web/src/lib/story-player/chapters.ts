/**
 * F252 Phase B — Chapter System (AC-B2, single-session)
 *
 * Extracts narrative chapters from a single-session event stream.
 * Chapters mark significant transition points for timeline navigation:
 * - Session start / end boundaries
 * - Invocation boundaries (agent re-activation)
 * - Pass-ball events (@mention / cross_post)
 * - Post-idle resumption (after long gap)
 *
 * Multi-session chapters from F233 FeatTrajectoryProjection.entries
 * are Phase C scope (requires F233 emitters for thread_split/phase_transition/pr_merged).
 *
 * Pure function — no side effects, no mutation.
 */

import type { ReplayEvent } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChapterKind = 'session_start' | 'session_end' | 'invocation' | 'pass_ball' | 'post_idle';

export interface Chapter {
  /** Chapter type */
  kind: ChapterKind;
  /** Human-readable label for UI display */
  label: string;
  /** Index in the events array to jump to */
  eventIndex: number;
  /** Timestamp (from the event) for timeline display */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Priority for deduplication (higher = wins when multiple chapters at same index)
// ---------------------------------------------------------------------------

const KIND_PRIORITY: Record<ChapterKind, number> = {
  pass_ball: 4, // Highest — most narrative impact
  invocation: 3,
  post_idle: 2,
  session_start: 1,
  session_end: 0,
};

// ---------------------------------------------------------------------------
// Label extraction
// ---------------------------------------------------------------------------

/** Extract @mention target from content for chapter label */
function extractMentionTarget(content: string): string | null {
  const match = content.match(/^(?:[-*>]\s*|\d+\.\s*)?@(\S+)/m);
  return match ? `@${match[1]}` : null;
}

/** Format idle gap duration for chapter label */
function formatIdleDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.round(ms / 1000)}s`;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  return remainMin > 0 ? `${hours}h ${remainMin}m` : `${hours}h`;
}

// ---------------------------------------------------------------------------
// Chapter extraction
// ---------------------------------------------------------------------------

/** Build pass-ball chapter label from event content/tool */
function passBallLabel(event: ReplayEvent): string {
  if (event.type === 'tool_call' && event.toolName?.includes('cross_post')) {
    return '→ cross_post';
  }
  const target = extractMentionTarget(event.content);
  return target ? `→ ${target}` : '→ Pass Ball';
}

/** Scan a single event for chapter-worthy signals and push candidates */
function collectEventChapters(
  event: ReplayEvent,
  i: number,
  lastInvocationId: string | undefined,
  candidates: Chapter[],
): string | undefined {
  let currentInvocationId = lastInvocationId;

  // Invocation boundaries
  if (event.invocationId != null) {
    if (currentInvocationId != null && event.invocationId !== currentInvocationId) {
      candidates.push({
        kind: 'invocation',
        label: `Invocation ${event.invocationId.slice(0, 8)}`,
        eventIndex: i,
        timestamp: event.timestamp,
      });
    }
    currentInvocationId = event.invocationId;
  }

  // Pass-ball events
  if (event.isPassBall) {
    candidates.push({
      kind: 'pass_ball',
      label: passBallLabel(event),
      eventIndex: i,
      timestamp: event.timestamp,
    });
  }

  // Post-idle gaps
  if (event.idleSkipMs != null && i > 0) {
    candidates.push({
      kind: 'post_idle',
      label: `After ${formatIdleDuration(event.idleSkipMs)} idle`,
      eventIndex: i,
      timestamp: event.timestamp,
    });
  }

  return currentInvocationId;
}

/** Deduplicate chapters: keep highest-priority kind at each eventIndex, sort */
function deduplicateAndSort(candidates: Chapter[]): Chapter[] {
  const byIndex = new Map<number, Chapter>();
  for (const chapter of candidates) {
    const existing = byIndex.get(chapter.eventIndex);
    if (!existing || KIND_PRIORITY[chapter.kind] > KIND_PRIORITY[existing.kind]) {
      byIndex.set(chapter.eventIndex, chapter);
    }
  }
  return Array.from(byIndex.values()).sort((a, b) => a.eventIndex - b.eventIndex);
}

/**
 * Extract narrative chapters from a single-session event stream.
 *
 * Returns chapters sorted by eventIndex, with at most one chapter per index.
 * When multiple chapter-worthy signals coincide at the same event,
 * the highest-priority kind wins (pass_ball > invocation > post_idle).
 */
export function extractChapters(events: ReplayEvent[]): Chapter[] {
  if (events.length === 0) return [];

  const candidates: Chapter[] = [
    { kind: 'session_start', label: 'Session Start', eventIndex: 0, timestamp: events[0].timestamp },
  ];

  // Session end (only if > 1 event to avoid duplicate with start)
  if (events.length > 1) {
    candidates.push({
      kind: 'session_end',
      label: 'Session End',
      eventIndex: events.length - 1,
      timestamp: events[events.length - 1].timestamp,
    });
  }

  // Scan events for chapter signals
  let lastInvocationId: string | undefined;
  for (let i = 0; i < events.length; i++) {
    lastInvocationId = collectEventChapters(events[i], i, lastInvocationId, candidates);
  }

  return deduplicateAndSort(candidates);
}

const VISIBLE_KIND_PRIORITY: Record<ChapterKind, number> = {
  pass_ball: 4,
  post_idle: 3,
  invocation: 2,
  session_start: 1,
  session_end: 0,
};

/**
 * Select a bounded, collision-resistant subset of chapter badges for the progress bar.
 *
 * The full chapter list remains available for seek logic, but rendering hundreds
 * of badges on a long replay creates an unreadable wall of icons. This keeps the
 * strongest narrative markers first, with a minimum event-distance gap.
 */
export function selectVisibleChapters(chapters: Chapter[], totalEvents: number, maxVisible = 24): Chapter[] {
  if (chapters.length <= maxVisible) return chapters;
  if (maxVisible <= 0) return [];

  const minGap = Math.max(1, Math.floor(Math.max(totalEvents - 1, 1) / maxVisible));
  const selected: Chapter[] = [];
  const prioritized = chapters.slice().sort((a, b) => {
    const priorityDiff = VISIBLE_KIND_PRIORITY[b.kind] - VISIBLE_KIND_PRIORITY[a.kind];
    if (priorityDiff !== 0) return priorityDiff;
    return a.eventIndex - b.eventIndex;
  });

  for (const chapter of prioritized) {
    if (selected.length >= maxVisible) break;
    if (selected.some((existing) => Math.abs(existing.eventIndex - chapter.eventIndex) < minGap)) continue;
    selected.push(chapter);
  }

  // If the gap filter was too strict for a tiny timeline, fill remaining slots by priority.
  for (const chapter of prioritized) {
    if (selected.length >= maxVisible) break;
    if (selected.includes(chapter)) continue;
    selected.push(chapter);
  }

  return selected.sort((a, b) => a.eventIndex - b.eventIndex);
}
