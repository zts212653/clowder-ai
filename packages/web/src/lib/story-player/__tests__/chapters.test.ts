/**
 * F252 Phase B — Chapter System Tests (AC-B2, single-session)
 *
 * Single-session chapters derived from event structure:
 * - Session start / end boundaries
 * - Invocation boundaries (when invocationId changes)
 * - Pass-ball events (already annotated by adaptive pacing)
 * - Post-idle gaps (already annotated)
 *
 * Multi-session chapters from F233 FeatTrajectoryProjection.entries
 * deferred to Phase C pre-work (F233 emitters not yet ready).
 */

import { describe, expect, it } from 'vitest';
import { extractChapters, selectVisibleChapters } from '../chapters';
import type { ReplayEvent } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<ReplayEvent> & { timestamp: number; index: number }): ReplayEvent {
  return {
    type: 'message',
    role: 'assistant',
    content: '',
    eventNo: overrides.index,
    ...overrides,
  };
}

/** Assert value is defined and return it (narrows type, avoids non-null assertion) */
function defined<T>(value: T | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}

// ==========================================================================
// § 1  Session boundary chapters
// ==========================================================================

describe('F252 chapters — session boundaries', () => {
  it('always creates a "Session Start" chapter at index 0', () => {
    const events = [makeEvent({ index: 0, timestamp: 1000 }), makeEvent({ index: 1, timestamp: 2000 })];
    const chapters = extractChapters(events);

    const start = defined(chapters.find((c) => c.kind === 'session_start'));
    expect(start.eventIndex).toBe(0);
  });

  it('always creates a "Session End" chapter at last index', () => {
    const events = [
      makeEvent({ index: 0, timestamp: 1000 }),
      makeEvent({ index: 1, timestamp: 2000 }),
      makeEvent({ index: 2, timestamp: 3000 }),
    ];
    const chapters = extractChapters(events);

    const end = defined(chapters.find((c) => c.kind === 'session_end'));
    expect(end.eventIndex).toBe(2);
  });

  it('returns empty array for empty events', () => {
    expect(extractChapters([])).toEqual([]);
  });

  it('returns only start chapter for single event', () => {
    const events = [makeEvent({ index: 0, timestamp: 1000 })];
    const chapters = extractChapters(events);

    // Single event = start only, no end (same event)
    expect(chapters.length).toBe(1);
    expect(chapters[0].kind).toBe('session_start');
  });
});

// ==========================================================================
// § 2  Invocation boundary chapters
// ==========================================================================

describe('F252 chapters — invocation boundaries', () => {
  it('creates chapter when invocationId changes', () => {
    const events = [
      makeEvent({ index: 0, timestamp: 1000, invocationId: 'inv-1' }),
      makeEvent({ index: 1, timestamp: 2000, invocationId: 'inv-1' }),
      makeEvent({ index: 2, timestamp: 3000, invocationId: 'inv-2' }),
      makeEvent({ index: 3, timestamp: 4000, invocationId: 'inv-2' }),
    ];
    const chapters = extractChapters(events);

    const invocations = chapters.filter((c) => c.kind === 'invocation');
    expect(invocations.length).toBe(1);
    expect(invocations[0].eventIndex).toBe(2);
  });

  it('creates chapters for multiple invocation transitions', () => {
    const events = [
      makeEvent({ index: 0, timestamp: 1000, invocationId: 'inv-1' }),
      makeEvent({ index: 1, timestamp: 2000, invocationId: 'inv-2' }),
      makeEvent({ index: 2, timestamp: 3000, invocationId: 'inv-3' }),
    ];
    const chapters = extractChapters(events);

    const invocations = chapters.filter((c) => c.kind === 'invocation');
    expect(invocations.length).toBe(2);
    expect(invocations[0].eventIndex).toBe(1);
    expect(invocations[1].eventIndex).toBe(2);
  });

  it('skips events without invocationId', () => {
    const events = [
      makeEvent({ index: 0, timestamp: 1000 }), // no invocationId
      makeEvent({ index: 1, timestamp: 2000, invocationId: 'inv-1' }),
      makeEvent({ index: 2, timestamp: 3000, invocationId: 'inv-1' }),
    ];
    const chapters = extractChapters(events);

    // No invocation chapter — first invocationId is treated as start
    const invocations = chapters.filter((c) => c.kind === 'invocation');
    expect(invocations.length).toBe(0);
  });
});

// ==========================================================================
// § 3  Pass-ball chapters
// ==========================================================================

describe('F252 chapters — pass-ball events', () => {
  it('creates chapter for pass-ball events', () => {
    const events = [
      makeEvent({ index: 0, timestamp: 1000 }),
      makeEvent({ index: 1, timestamp: 2000, isPassBall: true, content: '@codex\nreview please' }),
      makeEvent({ index: 2, timestamp: 3000 }),
    ];
    const chapters = extractChapters(events);

    const passBall = defined(chapters.find((c) => c.kind === 'pass_ball'));
    expect(passBall.eventIndex).toBe(1);
  });

  it('includes @mention target in chapter label', () => {
    const events = [
      makeEvent({ index: 0, timestamp: 1000 }),
      makeEvent({ index: 1, timestamp: 2000, isPassBall: true, content: '@codex\nreview please' }),
    ];
    const chapters = extractChapters(events);

    const passBall = defined(chapters.find((c) => c.kind === 'pass_ball'));
    expect(passBall.label).toContain('@codex');
  });

  it('labels cross_post tool calls distinctly', () => {
    const events = [
      makeEvent({ index: 0, timestamp: 1000 }),
      makeEvent({
        index: 1,
        timestamp: 2000,
        type: 'tool_call',
        toolName: 'cat_cafe_cross_post_message',
        isPassBall: true,
      }),
    ];
    const chapters = extractChapters(events);

    const passBall = defined(chapters.find((c) => c.kind === 'pass_ball'));
    expect(passBall.label).toContain('cross_post');
  });
});

// ==========================================================================
// § 4  Post-idle chapters
// ==========================================================================

describe('F252 chapters — post-idle gaps', () => {
  it('creates chapter for events following idle gap', () => {
    const events = [
      makeEvent({ index: 0, timestamp: 1000 }),
      makeEvent({ index: 1, timestamp: 2000, idleSkipMs: 600_000 }), // 10min skip
      makeEvent({ index: 2, timestamp: 3000 }),
    ];
    const chapters = extractChapters(events);

    const idle = defined(chapters.find((c) => c.kind === 'post_idle'));
    expect(idle.eventIndex).toBe(1);
  });

  it('includes skip duration in label', () => {
    const events = [
      makeEvent({ index: 0, timestamp: 1000 }),
      makeEvent({ index: 1, timestamp: 2000, idleSkipMs: 23 * 60 * 1000 }),
    ];
    const chapters = extractChapters(events);

    const idle = defined(chapters.find((c) => c.kind === 'post_idle'));
    expect(idle.label).toContain('23');
  });
});

// ==========================================================================
// § 5  Chapter ordering and deduplication
// ==========================================================================

describe('F252 chapters — ordering and deduplication', () => {
  it('returns chapters sorted by eventIndex', () => {
    const events = [
      makeEvent({ index: 0, timestamp: 1000, invocationId: 'inv-1' }),
      makeEvent({ index: 1, timestamp: 2000, isPassBall: true, content: '@codex\nhi' }),
      makeEvent({ index: 2, timestamp: 3000, invocationId: 'inv-2' }),
      makeEvent({ index: 3, timestamp: 4000 }),
      makeEvent({ index: 4, timestamp: 5000, idleSkipMs: 600_000 }),
      makeEvent({ index: 5, timestamp: 6000 }),
    ];
    const chapters = extractChapters(events);

    for (let i = 1; i < chapters.length; i++) {
      expect(chapters[i].eventIndex).toBeGreaterThanOrEqual(chapters[i - 1].eventIndex);
    }
  });

  it('does not create duplicate chapters at same eventIndex', () => {
    // Event that is both pass-ball AND starts a new invocation AND follows idle
    const events = [
      makeEvent({ index: 0, timestamp: 1000, invocationId: 'inv-1' }),
      makeEvent({
        index: 1,
        timestamp: 2000,
        invocationId: 'inv-2',
        isPassBall: true,
        idleSkipMs: 600_000,
        content: '@codex\nreview',
      }),
    ];
    const chapters = extractChapters(events);

    // Should merge into one chapter at index 1, not three
    const chaptersAtIndex1 = chapters.filter((c) => c.eventIndex === 1);
    expect(chaptersAtIndex1.length).toBe(1);
  });

  it('merged chapter uses the highest-priority kind', () => {
    // Priority: pass_ball > invocation > post_idle (most narrative impact first)
    const events = [
      makeEvent({ index: 0, timestamp: 1000, invocationId: 'inv-1' }),
      makeEvent({
        index: 1,
        timestamp: 2000,
        invocationId: 'inv-2',
        isPassBall: true,
        idleSkipMs: 600_000,
        content: '@codex\nreview',
      }),
    ];
    const chapters = extractChapters(events);

    const atIndex1 = defined(chapters.find((c) => c.eventIndex === 1));
    expect(atIndex1.kind).toBe('pass_ball');
  });

  it('each chapter has unique eventIndex within result', () => {
    const events = [
      makeEvent({ index: 0, timestamp: 1000, invocationId: 'inv-1' }),
      makeEvent({ index: 1, timestamp: 2000, invocationId: 'inv-1' }),
      makeEvent({ index: 2, timestamp: 3000, invocationId: 'inv-2', isPassBall: true, content: '@opus\nhi' }),
      makeEvent({ index: 3, timestamp: 4000, invocationId: 'inv-2' }),
      makeEvent({ index: 4, timestamp: 5000, invocationId: 'inv-3', idleSkipMs: 300_001 }),
    ];
    const chapters = extractChapters(events);

    const indices = chapters.map((c) => c.eventIndex);
    expect(new Set(indices).size).toBe(indices.length);
  });
});

// ==========================================================================
// § 6  Chapter type contract
// ==========================================================================

describe('F252 chapters — type contract', () => {
  it('each chapter has required fields', () => {
    const events = [
      makeEvent({ index: 0, timestamp: 1000 }),
      makeEvent({ index: 1, timestamp: 2000, isPassBall: true, content: '@codex\nhi' }),
      makeEvent({ index: 2, timestamp: 3000 }),
    ];
    const chapters = extractChapters(events);

    for (const chapter of chapters) {
      expect(chapter).toHaveProperty('kind');
      expect(chapter).toHaveProperty('label');
      expect(chapter).toHaveProperty('eventIndex');
      expect(chapter).toHaveProperty('timestamp');
      expect(typeof chapter.kind).toBe('string');
      expect(typeof chapter.label).toBe('string');
      expect(typeof chapter.eventIndex).toBe('number');
      expect(typeof chapter.timestamp).toBe('number');
    }
  });
});

// ==========================================================================
// § 7  Progress bar density clipping
// ==========================================================================

describe('F252 chapters — progress bar density clipping', () => {
  it('clips dense chapter lists so the progress bar does not render hundreds of overlapping badges', () => {
    const chapters = Array.from({ length: 160 }, (_, i) => ({
      kind: i % 5 === 0 ? ('pass_ball' as const) : ('invocation' as const),
      label: `chapter ${i}`,
      eventIndex: i * 10,
      timestamp: 1000 + i * 1000,
    }));

    const selected = selectVisibleChapters(chapters, 2000);

    expect(selected.length).toBeLessThanOrEqual(24);
    expect(selected.map((c) => c.eventIndex)).toEqual(
      [...selected].sort((a, b) => a.eventIndex - b.eventIndex).map((c) => c.eventIndex),
    );
  });

  it('keeps sparse chapter lists unchanged', () => {
    const chapters = [
      { kind: 'pass_ball' as const, label: 'pass', eventIndex: 10, timestamp: 1000 },
      { kind: 'post_idle' as const, label: 'idle', eventIndex: 90, timestamp: 2000 },
    ];

    expect(selectVisibleChapters(chapters, 100)).toEqual(chapters);
  });
});
