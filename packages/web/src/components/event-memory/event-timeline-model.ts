/**
 * F227 PR-2 Task 8 — timeline presentation logic (render-independent).
 *
 * Encodes 烁烁's approved structure (design-gate doc):
 *   - hero    = the newest SHOWN (non-low) event — the narrative focal point
 *   - groups  = the rest, grouped by calendar day (date separators)
 *   - folded  = low-confidence events (discussion/mention noise), collapsed by default
 *
 * Pure functions over the newest-first list returned by GET /api/memory/events,
 * so they are unit-testable without the React render env.
 */

import type { StoredEventMemory } from '@cat-cafe/shared';

export interface TimelineDayGroup {
  dayLabel: string;
  events: StoredEventMemory[];
}

export interface TimelineModel {
  /** Newest shown event — rendered as the large hero card. */
  hero: StoredEventMemory | null;
  /** Remaining shown events, grouped by day (newest day first). */
  groups: TimelineDayGroup[];
  /** Low-confidence events, collapsed by default. */
  folded: StoredEventMemory[];
  /** Count after the magic-word filter (hero + groups + folded). */
  total: number;
}

export interface BuildTimelineOptions {
  /** Filter to a single magic word (event.type) before building. */
  magicWord?: string;
  /** Filter to a single event trigger (人工拉闸 / 猫自拉闸 …) before building (AC-A3 事件类型). */
  trigger?: string;
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function groupByDay(events: StoredEventMemory[]): TimelineDayGroup[] {
  const groups: TimelineDayGroup[] = [];
  let currentKey: string | null = null;
  for (const event of events) {
    const key = dayKey(event.timestamp);
    if (key !== currentKey) {
      groups.push({ dayLabel: dayLabel(event.timestamp), events: [] });
      currentKey = key;
    }
    groups[groups.length - 1].events.push(event);
  }
  return groups;
}

export function buildTimelineModel(events: readonly StoredEventMemory[], opts: BuildTimelineOptions): TimelineModel {
  const filtered = events.filter(
    (e) => (!opts.magicWord || e.type === opts.magicWord) && (!opts.trigger || e.trigger === opts.trigger),
  );
  const shown = filtered.filter((e) => e.confidence !== 'low');
  const folded = filtered.filter((e) => e.confidence === 'low');
  return {
    hero: shown[0] ?? null,
    groups: groupByDay(shown.slice(1)),
    folded,
    total: filtered.length,
  };
}

export interface MagicWordCount {
  word: string;
  count: number;
}

/** Per-magic-word counts across the whole (unfiltered) corpus, descending. */
export function magicWordCounts(events: readonly StoredEventMemory[]): MagicWordCount[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  }
  return [...counts.entries()].map(([word, count]) => ({ word, count })).sort((a, b) => b.count - a.count);
}
