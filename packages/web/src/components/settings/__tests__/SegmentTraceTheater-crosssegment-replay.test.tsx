// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SegmentTraceTheater } from '../SegmentTraceTheater';

const apiFetch = vi.fn();

vi.mock('../../../utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

const counterexample = {
  annotationId: 'ann-1',
  incidentKey: 'incident-1',
  objectiveId: 'tool-access-correct-use',
  metricId: 'tool-schema-failure-count',
  source: 'structured-rule' as const,
  createdAt: 1_700_000_000_000,
  rationale: 'tool name did not exist',
  threadId: 'thread-x',
  turnId: 'turn-x',
  catId: 'opus',
  segmentIds: ['S13'],
};

const readiness = {
  trigger: undefined,
  injections: [],
  injectionsCapped: false,
  structuredCounterexamples: [counterexample],
} as never;

describe('SegmentTraceTheater cross-segment replay', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('replays the segment the row is attributed to, not the page it is opened from', async () => {
    await act(async () => {
      root.render(
        <SegmentTraceTheater
          segmentId="C1"
          observations={[]}
          window={{ startMs: 0, endMs: 1 }}
          readiness={readiness}
        />,
      );
    });

    const row = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('tool name did not exist'),
    );
    expect(row, 'the counterexample row renders').toBeTruthy();
    // The click mounts the replay panel, whose effect fires the fetch: await the
    // act so the state updates it schedules are flushed inside it.
    await act(async () => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const replayCalls = apiFetch.mock.calls.map((call) => String(call[0])).filter((url) => url.includes('/replay'));
    expect(replayCalls.length, 'the replay fetch fired').toBeGreaterThan(0);
    // The row belongs to S13; opening it from C1 must not replay C1's snapshot.
    expect(replayCalls[0]).toContain('/api/segment-lifeline/S13/replay');
    expect(replayCalls[0]).not.toContain('/api/segment-lifeline/C1/replay');
  });

  it('stays on the page segment when the row is attributed to it as well', async () => {
    const shared = { ...counterexample, segmentIds: ['C1', 'S13'] };
    await act(async () => {
      root.render(
        <SegmentTraceTheater
          segmentId="C1"
          observations={[]}
          window={{ startMs: 0, endMs: 1 }}
          readiness={{ ...(readiness as object), structuredCounterexamples: [shared] } as never}
        />,
      );
    });

    const row = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('tool name did not exist'),
    );
    // The click mounts the replay panel, whose effect fires the fetch: await the
    // act so the state updates it schedules are flushed inside it.
    await act(async () => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const replayCalls = apiFetch.mock.calls.map((call) => String(call[0])).filter((url) => url.includes('/replay'));
    expect(replayCalls[0]).toContain('/api/segment-lifeline/C1/replay');
  });
});
