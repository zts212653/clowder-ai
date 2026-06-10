import type { StoredEventMemory } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { buildTimelineModel, magicWordCounts } from '../event-timeline-model';

/**
 * F227 PR-2 Task 8 — timeline presentation logic (render-independent).
 * Encodes gemini's approved structure: hero = newest shown event, low-confidence
 * folded, the rest grouped by day (date separators). Pure so it is testable
 * without the React render env.
 */

let seq = 0;
function evt(over: Partial<StoredEventMemory> = {}): StoredEventMemory {
  seq += 1;
  return {
    eventId: `e${seq}`,
    ownerUserId: 'owner-1',
    type: '脚手架',
    trigger: 'human_brake',
    cat: 'opus',
    threadId: 't1',
    messageId: `m${seq}`,
    timestamp: 1_700_000_000_000,
    summary: 's',
    cognitiveTransition: 'user_brake',
    relatedHarness: null,
    confidence: 'high',
    ...over,
  };
}

// 2026-06-07 vs 2026-06-05 (>1 day apart) in ms.
const DAY = 86_400_000;
const T_JUN7 = 1_780_000_000_000;
const T_JUN6 = T_JUN7 - DAY;

describe('F227 buildTimelineModel', () => {
  it('returns the newest shown event as the hero and the rest grouped below', () => {
    const events = [evt({ timestamp: T_JUN7, messageId: 'newest' }), evt({ timestamp: T_JUN6, messageId: 'older' })];
    const model = buildTimelineModel(events, {});
    expect(model.hero?.messageId).toBe('newest');
    expect(model.groups.flatMap((g) => g.events.map((e) => e.messageId))).toEqual(['older']);
    expect(model.total).toBe(2);
  });

  it('folds low-confidence events out of hero/groups into folded', () => {
    const events = [
      evt({ confidence: 'high', messageId: 'h' }),
      evt({ confidence: 'low', messageId: 'lo1' }),
      evt({ confidence: 'low', messageId: 'lo2' }),
    ];
    const model = buildTimelineModel(events, {});
    expect(model.hero?.messageId).toBe('h');
    expect(model.folded.map((e) => e.messageId)).toEqual(['lo1', 'lo2']);
    // low events must NOT appear in hero/groups
    const shownIds = [model.hero?.messageId, ...model.groups.flatMap((g) => g.events.map((e) => e.messageId))];
    expect(shownIds).not.toContain('lo1');
  });

  it('groups the non-hero events by day with a label per day', () => {
    const events = [
      evt({ timestamp: T_JUN7, messageId: 'hero' }),
      evt({ timestamp: T_JUN7 - 1000, messageId: 'same-day' }),
      evt({ timestamp: T_JUN6, messageId: 'prev-day' }),
    ];
    const model = buildTimelineModel(events, {});
    // hero is its own; the remaining two span two days → two groups
    expect(model.groups.length).toBe(2);
    expect(model.groups[0].events.map((e) => e.messageId)).toEqual(['same-day']);
    expect(model.groups[1].events.map((e) => e.messageId)).toEqual(['prev-day']);
    expect(model.groups[0].dayLabel).not.toBe(model.groups[1].dayLabel);
  });

  it('filters by magic word (event type) before building', () => {
    const events = [evt({ type: '脚手架', messageId: 'a' }), evt({ type: '补锅匠', messageId: 'b' })];
    const model = buildTimelineModel(events, { magicWord: '补锅匠' });
    expect(model.total).toBe(1);
    expect(model.hero?.messageId).toBe('b');
  });

  it('filters by trigger (事件类型) before building (AC-A3)', () => {
    const events = [evt({ trigger: 'human_brake', messageId: 'h' }), evt({ trigger: 'cat_brake', messageId: 'c' })];
    const model = buildTimelineModel(events, { trigger: 'cat_brake' });
    expect(model.total).toBe(1);
    expect(model.hero?.messageId).toBe('c');
  });

  it('applies magic word AND trigger filters together', () => {
    const events = [
      evt({ type: '脚手架', trigger: 'human_brake', messageId: 'a' }),
      evt({ type: '脚手架', trigger: 'cat_brake', messageId: 'b' }),
      evt({ type: '补锅匠', trigger: 'human_brake', messageId: 'c' }),
    ];
    const model = buildTimelineModel(events, { magicWord: '脚手架', trigger: 'human_brake' });
    expect(model.total).toBe(1);
    expect(model.hero?.messageId).toBe('a');
  });

  it('handles an all-low corpus (no hero, everything folded)', () => {
    const events = [evt({ confidence: 'low', messageId: 'x' }), evt({ confidence: 'low', messageId: 'y' })];
    const model = buildTimelineModel(events, {});
    expect(model.hero).toBeNull();
    expect(model.groups).toEqual([]);
    expect(model.folded.length).toBe(2);
  });

  it('handles empty input', () => {
    const model = buildTimelineModel([], {});
    expect(model.hero).toBeNull();
    expect(model.groups).toEqual([]);
    expect(model.folded).toEqual([]);
    expect(model.total).toBe(0);
  });
});

describe('F227 magicWordCounts', () => {
  it('counts events per type across the whole (unfiltered) corpus, descending', () => {
    const events = [evt({ type: '脚手架' }), evt({ type: '脚手架' }), evt({ type: '补锅匠' }), evt({ type: '脚手架' })];
    const counts = magicWordCounts(events);
    expect(counts[0]).toEqual({ word: '脚手架', count: 3 });
    expect(counts.find((c) => c.word === '补锅匠')?.count).toBe(1);
  });

  it('returns [] for no events', () => {
    expect(magicWordCounts([])).toEqual([]);
  });
});
