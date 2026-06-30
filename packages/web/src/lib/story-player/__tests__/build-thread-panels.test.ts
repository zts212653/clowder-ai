/**
 * F252 Phase E PR E-4 — buildThreadPanels unit tests
 *
 * Tests the pure panel-building logic extracted from useFeatureReplay.
 * Key regression: dim mode must be reachable for non-active threads (P1 fix).
 */

import type { SwimlaneDTO } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import type { ActiveThreadState } from '../active-thread-tracker';
import { buildThreadPanels } from '../build-thread-panels';
import type { ReplayEvent } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLane(threadId: string, threadName: string, participants: string[] = []): SwimlaneDTO {
  return { threadId, threadName, participants, markers: [] } as SwimlaneDTO;
}

function makeEvent(index: number, threadId: string, timestamp: number): ReplayEvent {
  return {
    index,
    type: 'message',
    timestamp,
    role: 'assistant',
    content: `event-${index}`,
    eventNo: index,
    sourceThreadId: threadId,
  };
}

function defined<T>(value: T | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildThreadPanels', () => {
  const lanes: SwimlaneDTO[] = [
    makeLane('t1', 'Thread Alpha', ['opus']),
    makeLane('t2', 'Thread Beta', ['sonnet']),
    makeLane('t3', 'Thread Gamma', ['codex']),
  ];

  it('returns empty array when no lanes', () => {
    const activeState: ActiveThreadState = {
      activeThreadIds: [],
      spotlightThreadId: null,
      layout: 'single',
    };
    const result = buildThreadPanels([], activeState, []);
    expect(result).toEqual([]);
  });

  it('assigns spotlight mode to the spotlight thread', () => {
    const activeState: ActiveThreadState = {
      activeThreadIds: ['t1', 't2'],
      spotlightThreadId: 't1',
      layout: 'dual',
    };
    const events = [makeEvent(0, 't1', 1000), makeEvent(1, 't2', 2000)];
    const result = buildThreadPanels(lanes, activeState, events);

    const t1Panel = defined(result.find((p) => p.threadId === 't1'));
    expect(t1Panel.mode).toBe('spotlight');
  });

  it('assigns active mode to non-spotlight active threads', () => {
    const activeState: ActiveThreadState = {
      activeThreadIds: ['t1', 't2'],
      spotlightThreadId: 't1',
      layout: 'dual',
    };
    const events = [makeEvent(0, 't1', 1000), makeEvent(1, 't2', 2000)];
    const result = buildThreadPanels(lanes, activeState, events);

    const t2Panel = defined(result.find((p) => p.threadId === 't2'));
    expect(t2Panel.mode).toBe('active');
  });

  it('assigns dim mode to non-active threads (P1 regression)', () => {
    const activeState: ActiveThreadState = {
      activeThreadIds: ['t1', 't2'],
      spotlightThreadId: 't1',
      layout: 'dual',
    };
    // t3 has no events in the active window
    const events = [makeEvent(0, 't1', 1000), makeEvent(1, 't2', 2000)];
    const result = buildThreadPanels(lanes, activeState, events);

    const t3Panel = defined(result.find((p) => p.threadId === 't3'));
    expect(t3Panel.mode).toBe('dim');
    expect(t3Panel.threadName).toBe('Thread Gamma');
    expect(t3Panel.participants).toEqual(['codex']);
  });

  it('returns panels for ALL lanes, not just active threads', () => {
    const activeState: ActiveThreadState = {
      activeThreadIds: ['t1'],
      spotlightThreadId: 't1',
      layout: 'single',
    };
    const events = [makeEvent(0, 't1', 1000)];
    const result = buildThreadPanels(lanes, activeState, events);

    expect(result).toHaveLength(3);
    expect(result.map((p) => p.threadId)).toEqual(['t1', 't2', 't3']);
    expect(result.map((p) => p.mode)).toEqual(['spotlight', 'dim', 'dim']);
  });

  it('partitions visible events by sourceThreadId', () => {
    const activeState: ActiveThreadState = {
      activeThreadIds: ['t1', 't2'],
      spotlightThreadId: 't1',
      layout: 'dual',
    };
    const events = [makeEvent(0, 't1', 1000), makeEvent(1, 't2', 2000), makeEvent(2, 't1', 3000)];
    const result = buildThreadPanels(lanes, activeState, events);

    const t1Panel = defined(result.find((p) => p.threadId === 't1'));
    const t2Panel = defined(result.find((p) => p.threadId === 't2'));
    const t3Panel = defined(result.find((p) => p.threadId === 't3'));

    expect(t1Panel.messages).toHaveLength(1);
    expect(t1Panel.messages[0]?.content).toBe('event-0\n\nevent-2');
    expect(t2Panel.messages).toHaveLength(1);
    expect(t3Panel.messages).toHaveLength(0);
  });

  it('dim panels have empty messages when thread has no visible events', () => {
    const activeState: ActiveThreadState = {
      activeThreadIds: ['t1'],
      spotlightThreadId: 't1',
      layout: 'single',
    };
    const events = [makeEvent(0, 't1', 1000)];
    const result = buildThreadPanels(lanes, activeState, events);

    const t3Panel = defined(result.find((p) => p.threadId === 't3'));
    expect(t3Panel.mode).toBe('dim');
    expect(t3Panel.messages).toHaveLength(0);
  });

  it('handles all-active state (no dim panels)', () => {
    const activeState: ActiveThreadState = {
      activeThreadIds: ['t1', 't2', 't3'],
      spotlightThreadId: 't2',
      layout: 'multi',
    };
    const events = [makeEvent(0, 't1', 1000), makeEvent(1, 't2', 2000), makeEvent(2, 't3', 3000)];
    const result = buildThreadPanels(lanes, activeState, events);

    // Sorted: spotlight first, then active
    expect(result.map((p) => p.mode)).toEqual(['spotlight', 'active', 'active']);
  });

  it('handles no spotlight (all active)', () => {
    const activeState: ActiveThreadState = {
      activeThreadIds: ['t1', 't2'],
      spotlightThreadId: null,
      layout: 'dual',
    };
    const events = [makeEvent(0, 't1', 1000), makeEvent(1, 't2', 2000)];
    const result = buildThreadPanels(lanes, activeState, events);

    expect(result.map((p) => p.mode)).toEqual(['active', 'active', 'dim']);
  });

  // ── Ordering contract (P1 R2: MultiCamStage positional indexing) ──

  it('spotlight thread is always first regardless of lane order', () => {
    // Spotlight is t3 (lane index 2) — must appear at panels[0]
    const activeState: ActiveThreadState = {
      activeThreadIds: ['t3', 't1'],
      spotlightThreadId: 't3',
      layout: 'dual',
    };
    const events = [makeEvent(0, 't1', 1000), makeEvent(1, 't3', 2000)];
    const result = buildThreadPanels(lanes, activeState, events);

    expect(result[0].threadId).toBe('t3');
    expect(result[0].mode).toBe('spotlight');
  });

  it('active threads come before dim threads', () => {
    // t2 is spotlight, t3 is active, t1 is dim
    const activeState: ActiveThreadState = {
      activeThreadIds: ['t2', 't3'],
      spotlightThreadId: 't2',
      layout: 'dual',
    };
    const events = [makeEvent(0, 't2', 1000), makeEvent(1, 't3', 2000)];
    const result = buildThreadPanels(lanes, activeState, events);

    expect(result.map((p) => p.threadId)).toEqual(['t2', 't3', 't1']);
    expect(result.map((p) => p.mode)).toEqual(['spotlight', 'active', 'dim']);
  });

  it('active panels sorted by recency (activeThreadIds order), not lane order (P2 cloud)', () => {
    // 4 lanes: t1,t2,t3,t4. Spotlight=t2, active=[t2,t4,t1] (t4 more recent than t1).
    // Without recency tiebreaker: active group in lane order → t1,t4 → main stage shows t1 (wrong).
    // With recency tiebreaker: active group by activeThreadIds index → t4(idx1),t1(idx2) → main stage shows t4.
    const fourLanes = [
      makeLane('t1', 'Alpha'),
      makeLane('t2', 'Beta'),
      makeLane('t3', 'Gamma'),
      makeLane('t4', 'Delta'),
    ];
    const activeState: ActiveThreadState = {
      activeThreadIds: ['t2', 't4', 't1'], // t4 more recent than t1
      spotlightThreadId: 't2',
      layout: 'multi',
    };
    const events = [makeEvent(0, 't1', 1000), makeEvent(1, 't2', 2000), makeEvent(2, 't4', 3000)];
    const result = buildThreadPanels(fourLanes, activeState, events);

    // panels[0]=spotlight(t2), panels[1]=active-most-recent(t4), panels[2]=active-less-recent(t1), panels[3]=dim(t3)
    expect(result.map((p) => p.threadId)).toEqual(['t2', 't4', 't1', 't3']);
    expect(result.map((p) => p.mode)).toEqual(['spotlight', 'active', 'active', 'dim']);
    // Main stage (panels.slice(0,2)) = [t2(spotlight), t4(most recent active)] — correct per AC-E5
    expect(result[1].threadId).toBe('t4');
  });

  it('single layout panels[0] is spotlight even when spotlight is last lane', () => {
    // Minimal repro from reviewer: activeThreadIds=['t3'], lanes=[t1,t2,t3]
    // Without sort: panels[0] = t1 (dim) — wrong for SingleLayout
    const activeState: ActiveThreadState = {
      activeThreadIds: ['t3'],
      spotlightThreadId: 't3',
      layout: 'single',
    };
    const events = [makeEvent(0, 't3', 1000)];
    const result = buildThreadPanels(lanes, activeState, events);

    // panels[0] must be spotlight for SingleLayout to work
    expect(result[0].threadId).toBe('t3');
    expect(result[0].mode).toBe('spotlight');
    // dim panels follow
    expect(result[1].mode).toBe('dim');
    expect(result[2].mode).toBe('dim');
  });
});
