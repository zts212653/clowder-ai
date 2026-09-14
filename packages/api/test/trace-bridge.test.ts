/**
 * F257: trace-bridge.ts — pipeline -> v0 trace conversion tests
 *
 * Verifies that buildFromPipeline correctly converts PipelineResult
 * (all 46 hooks) into v0 InjectionTraceSummary + InjectionTraceDetail,
 * fixing the 15/46 segment trace gap.
 */
import { describe, expect, it } from 'vitest';
import type { PipelineResult } from '../src/domains/prompt-hooks/HookPipeline.js';
import { buildFromPipeline } from '../src/domains/prompt-hooks/trace-bridge.js';

function makeFiredEvent(hookId: string, stage: 'session-init' | 'per-turn') {
  return {
    hookId,
    stage,
    timestamp: Date.now(),
    status: 'fired' as const,
    version: 1,
    contentHash: `hash-${hookId}`,
    tokenEstimate: 100,
  };
}

function makeSkippedEvent(hookId: string, stage: 'session-init' | 'per-turn') {
  return {
    hookId,
    stage,
    timestamp: Date.now(),
    status: 'skipped' as const,
    reasonCode: 'condition-false',
    reason: 'Resolver returned false',
  };
}

function makeDisabledEvent(hookId: string, stage: 'session-init' | 'per-turn') {
  return {
    hookId,
    stage,
    timestamp: Date.now(),
    status: 'disabled' as const,
    disabledBy: 'operator' as const,
  };
}

function makePatch(hookId: string, content: string) {
  return { hookId, content, order: 100 };
}

describe('buildFromPipeline', () => {
  it('returns null when both results are null', () => {
    expect(
      buildFromPipeline(null, null, {
        turnId: 't1',
        threadId: 'th1',
        catId: 'cat1',
        hasNativeL0: false,
      }),
    ).toBeNull();
  });

  it('converts all session hooks (S+L+B+C) to segments', () => {
    const sessionResult: PipelineResult = {
      events: [
        makeFiredEvent('S1', 'session-init'),
        makeFiredEvent('S2', 'session-init'),
        makeSkippedEvent('S3', 'session-init'),
        makeFiredEvent('L1', 'session-init'),
        makeFiredEvent('L2', 'session-init'),
        makeFiredEvent('B1', 'session-init'),
        makeDisabledEvent('C1', 'session-init'),
      ],
      patches: [
        makePatch('S1', 'content-S1'),
        makePatch('S2', 'content-S2'),
        makePatch('L1', 'content-L1'),
        makePatch('L2', 'content-L2'),
        makePatch('B1', 'content-B1'),
      ],
    };

    const result = buildFromPipeline(sessionResult, null, {
      turnId: 't1',
      threadId: 'th1',
      catId: 'cat1',
      hasNativeL0: false,
    });

    expect(result).not.toBeNull();
    const { summary, detail } = result!;

    // All 7 hooks should appear as segments
    expect(summary.segments).toHaveLength(7);
    expect(detail.segments).toHaveLength(7);

    // S1, S2, L1, L2, B1 = observed (fired)
    expect(summary.totalSegmentsObserved).toBe(5);
    // S3, C1 = absent (skipped/disabled)
    expect(summary.totalSegmentsAbsent).toBe(2);

    // Verify segment IDs include non-S-prefix hooks (the fix!)
    const segmentIds = summary.segments.map((s) => s.segmentId);
    expect(segmentIds).toContain('L1');
    expect(segmentIds).toContain('L2');
    expect(segmentIds).toContain('B1');
    expect(segmentIds).toContain('C1');
  });

  it('converts all turn hooks (D+R+N) to segments', () => {
    const turnResult: PipelineResult = {
      events: [
        makeFiredEvent('D1', 'per-turn'),
        makeFiredEvent('D2', 'per-turn'),
        makeSkippedEvent('D5', 'per-turn'),
        makeFiredEvent('R1', 'per-turn'),
        makeFiredEvent('N1', 'per-turn'),
      ],
      patches: [
        makePatch('D1', 'content-D1'),
        makePatch('D2', 'content-D2'),
        makePatch('R1', 'content-R1'),
        makePatch('N1', 'content-N1'),
      ],
    };

    const result = buildFromPipeline(null, turnResult, {
      turnId: 't1',
      threadId: 'th1',
      catId: 'cat1',
      hasNativeL0: false,
    });

    expect(result).not.toBeNull();
    const { summary } = result!;

    expect(summary.segments).toHaveLength(5);
    expect(summary.totalSegmentsObserved).toBe(4);
    expect(summary.totalSegmentsAbsent).toBe(1);

    // R1 and N1 should be present (not just D-prefix)
    const segmentIds = summary.segments.map((s) => s.segmentId);
    expect(segmentIds).toContain('R1');
    expect(segmentIds).toContain('N1');
  });

  it('combines session and turn traces into one summary', () => {
    const sessionResult: PipelineResult = {
      events: [makeFiredEvent('S1', 'session-init'), makeFiredEvent('L1', 'session-init')],
      patches: [makePatch('S1', 'session-content'), makePatch('L1', 'l1-content')],
    };
    const turnResult: PipelineResult = {
      events: [makeFiredEvent('D1', 'per-turn')],
      patches: [makePatch('D1', 'turn-content')],
    };

    const result = buildFromPipeline(sessionResult, turnResult, {
      turnId: 't1',
      threadId: 'th1',
      catId: 'cat1',
      hasNativeL0: false,
    });

    expect(result).not.toBeNull();
    const { summary, detail } = result!;

    // 2 session + 1 turn = 3 total segments
    expect(summary.segments).toHaveLength(3);
    expect(summary.totalSegmentsObserved).toBe(3);
    expect(summary.totalSegmentsAbsent).toBe(0);

    // Detail should have correct per-stage char counts
    expect(detail.sessionCharCount).toBeGreaterThan(0);
    expect(detail.turnCharCount).toBeGreaterThan(0);
  });

  it('sets native-l0 delivery channel when sessionFromNativeCompiler is true', () => {
    const sessionResult: PipelineResult = {
      events: [makeFiredEvent('L1', 'session-init')],
      patches: [makePatch('L1', 'native-content')],
    };

    const result = buildFromPipeline(sessionResult, null, {
      turnId: 't1',
      threadId: 'th1',
      catId: 'cat1',
      hasNativeL0: true,
      sessionFromNativeCompiler: true,
    });

    expect(result).not.toBeNull();
    const sessionDelivery = result!.summary.delivery.find((d) => d.stage === 'session-init');
    expect(sessionDelivery?.channel).toBe('native-l0');
  });
});
