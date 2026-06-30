/**
 * F252 Phase B — Adaptive Pacing Tests (AC-B1)
 *
 * RED tests written first — implementation in adaptive-pacing.ts does not exist yet.
 *
 * AC-B1 spec:
 * - Idle gap > 5min → auto-skip + show "⏩ 跳过 23 分钟"
 * - Pass-ball events (@mention) → auto-slowdown + highlight
 * - User can toggle to fixed speed override
 */

import { describe, expect, it } from 'vitest';
import {
  annotateAdaptivePacing,
  compressIdleGaps,
  DEFAULT_IDLE_THRESHOLD_MS,
  DEFAULT_SKIP_DISPLAY_MS,
} from '../adaptive-pacing';
import type { ReplayEvent } from '../types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<ReplayEvent> & { timestamp: number }): ReplayEvent {
  return {
    index: 0,
    type: 'message',
    role: 'assistant',
    content: '',
    eventNo: 0,
    ...overrides,
  };
}

/** Create a sequence of events with specified gaps between them (in ms) */
function makeEventSequence(gaps: number[], baseTimestamp = 1000000): ReplayEvent[] {
  const events: ReplayEvent[] = [makeEvent({ index: 0, timestamp: baseTimestamp, eventNo: 0 })];
  let t = baseTimestamp;
  for (let i = 0; i < gaps.length; i++) {
    t += gaps[i];
    events.push(makeEvent({ index: i + 1, timestamp: t, eventNo: i + 1 }));
  }
  return events;
}

const FIVE_MIN = 5 * 60 * 1000;
const TEN_MIN = 10 * 60 * 1000;
const TWENTY_THREE_MIN = 23 * 60 * 1000;
const ONE_MIN = 60 * 1000;
const THIRTY_SEC = 30 * 1000;

// ==========================================================================
// § 1  Idle gap detection
// ==========================================================================

describe('F252 adaptive pacing — idle gap detection', () => {
  it('annotates event following a gap > threshold with idleSkipMs', () => {
    const events = makeEventSequence([TEN_MIN]); // 10 min gap
    const result = annotateAdaptivePacing(events);

    expect(result[0].idleSkipMs).toBeUndefined(); // first event has no preceding gap
    expect(result[1].idleSkipMs).toBe(TEN_MIN); // second event follows 10min idle
  });

  it('does NOT annotate gaps below threshold', () => {
    const events = makeEventSequence([ONE_MIN]); // 1 min gap
    const result = annotateAdaptivePacing(events);

    expect(result[1].idleSkipMs).toBeUndefined();
  });

  it('does NOT annotate gaps exactly at threshold', () => {
    const events = makeEventSequence([FIVE_MIN]); // exactly 5 min
    const result = annotateAdaptivePacing(events);

    // Threshold is ">" not ">="
    expect(result[1].idleSkipMs).toBeUndefined();
  });

  it('annotates gap just above threshold', () => {
    const events = makeEventSequence([FIVE_MIN + 1]);
    const result = annotateAdaptivePacing(events);

    expect(result[1].idleSkipMs).toBe(FIVE_MIN + 1);
  });

  it('handles multiple idle gaps in sequence', () => {
    // 2min, 23min, 30sec, 10min
    const events = makeEventSequence([2 * ONE_MIN, TWENTY_THREE_MIN, THIRTY_SEC, TEN_MIN]);
    const result = annotateAdaptivePacing(events);

    expect(result[0].idleSkipMs).toBeUndefined();
    expect(result[1].idleSkipMs).toBeUndefined(); // 2min < threshold
    expect(result[2].idleSkipMs).toBe(TWENTY_THREE_MIN); // 23min > threshold
    expect(result[3].idleSkipMs).toBeUndefined(); // 30sec < threshold
    expect(result[4].idleSkipMs).toBe(TEN_MIN); // 10min > threshold
  });

  it('does NOT tag gap after tool_call as idle (tool waits use Phase A compression)', () => {
    const events = [
      makeEvent({ index: 0, timestamp: 1000, eventNo: 0, type: 'tool_call', toolName: 'Read', content: '' }),
      makeEvent({ index: 1, timestamp: 1000 + TEN_MIN, eventNo: 1, type: 'message', content: 'result processed' }),
    ];
    const result = annotateAdaptivePacing(events);
    // Tool-call waits are not "idle" — they're active work. Phase A log compression handles them.
    expect(result[1].idleSkipMs).toBeUndefined();
  });

  it('accepts custom threshold', () => {
    const events = makeEventSequence([ONE_MIN + 1]);
    // Default threshold is 5min — 1min gap wouldn't be flagged
    const result = annotateAdaptivePacing(events, { idleThresholdMs: ONE_MIN });

    expect(result[1].idleSkipMs).toBe(ONE_MIN + 1);
  });

  it('does not mutate original events', () => {
    const events = makeEventSequence([TEN_MIN]);
    const original1 = { ...events[1] };
    annotateAdaptivePacing(events);

    expect(events[1]).toEqual(original1);
  });

  it('default threshold is 5 minutes', () => {
    expect(DEFAULT_IDLE_THRESHOLD_MS).toBe(FIVE_MIN);
  });
});

// ==========================================================================
// § 2  Idle gap compression
// ==========================================================================

describe('F252 adaptive pacing — idle gap compression', () => {
  it('collapses idle gaps to short display duration', () => {
    // 10min gap → compressed to DEFAULT_SKIP_DISPLAY_MS
    const events = makeEventSequence([TEN_MIN]);
    const annotated = annotateAdaptivePacing(events);
    const compressed = compressIdleGaps(annotated);

    const gap = compressed[1].timestamp - compressed[0].timestamp;
    expect(gap).toBe(DEFAULT_SKIP_DISPLAY_MS);
  });

  it('preserves idleSkipMs annotation after compression', () => {
    const events = makeEventSequence([TEN_MIN]);
    const annotated = annotateAdaptivePacing(events);
    const compressed = compressIdleGaps(annotated);

    // idleSkipMs should still reflect the ORIGINAL gap for UI display
    expect(compressed[1].idleSkipMs).toBe(TEN_MIN);
  });

  it('does not affect non-idle gaps', () => {
    const events = makeEventSequence([THIRTY_SEC, TEN_MIN, ONE_MIN]);
    const annotated = annotateAdaptivePacing(events);
    const compressed = compressIdleGaps(annotated);

    // Gap 0→1: 30sec (no idle) — preserved
    const gap01 = compressed[1].timestamp - compressed[0].timestamp;
    expect(gap01).toBe(THIRTY_SEC);

    // Gap 1→2: 10min (idle) — compressed
    const gap12 = compressed[2].timestamp - compressed[1].timestamp;
    expect(gap12).toBe(DEFAULT_SKIP_DISPLAY_MS);

    // Gap 2→3: 1min (no idle) — preserved
    const gap23 = compressed[3].timestamp - compressed[2].timestamp;
    expect(gap23).toBe(ONE_MIN);
  });

  it('accumulates compression correctly across multiple idle gaps', () => {
    // Events at: 0, +30s, +10min, +30s, +23min
    const events = makeEventSequence([THIRTY_SEC, TEN_MIN, THIRTY_SEC, TWENTY_THREE_MIN]);
    const annotated = annotateAdaptivePacing(events);
    const compressed = compressIdleGaps(annotated);

    const totalOriginalDuration = THIRTY_SEC + TEN_MIN + THIRTY_SEC + TWENTY_THREE_MIN;
    const totalCompressedDuration = compressed[4].timestamp - compressed[0].timestamp;
    // Should be: 30s + skipDisplay + 30s + skipDisplay
    const expectedDuration = THIRTY_SEC + DEFAULT_SKIP_DISPLAY_MS + THIRTY_SEC + DEFAULT_SKIP_DISPLAY_MS;
    expect(totalCompressedDuration).toBe(expectedDuration);
    expect(totalCompressedDuration).toBeLessThan(totalOriginalDuration);
  });

  it('handles empty and single-event arrays', () => {
    expect(compressIdleGaps([])).toEqual([]);
    const single = [makeEvent({ timestamp: 1000 })];
    expect(compressIdleGaps(single)).toEqual(single);
  });

  it('does not mutate original events', () => {
    const events = makeEventSequence([TEN_MIN]);
    const annotated = annotateAdaptivePacing(events);
    const origTimestamp = annotated[1].timestamp;
    compressIdleGaps(annotated);

    expect(annotated[1].timestamp).toBe(origTimestamp);
  });
});

// Pass-ball detection + combined annotation tests moved to adaptive-pass-ball.test.ts
// (P1-3 fix: split to stay under 350-line hard limit)
