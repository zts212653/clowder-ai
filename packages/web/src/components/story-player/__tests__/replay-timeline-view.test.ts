import { describe, expect, it } from 'vitest';
import type { ReplayEvent } from '@/lib/story-player/types';
import { replayTimelineView } from '../replay-timeline-view';

function event(overrides: Partial<ReplayEvent>): ReplayEvent {
  return { index: 0, eventNo: 0, type: 'message', role: 'assistant', content: '', timestamp: 1000, ...overrides };
}

describe('replay timeline is a read-only projection of original engine events', () => {
  it('uses original array seek coordinates and preserves each actor, including unknown sources', () => {
    const events = Object.freeze([
      Object.freeze(event({ index: 12, role: 'user' })),
      Object.freeze(event({ index: 18, catId: 'codex61-sol' })),
      Object.freeze(event({ index: 29, type: 'tool_call', catId: 'codex61-sol' })),
      Object.freeze(event({ index: 31, catId: 'opus55' })),
      Object.freeze(event({ index: 52, role: 'system' })),
      Object.freeze(event({ index: 77 })),
    ]);
    const original = JSON.stringify(events);
    const view = replayTimelineView(events);
    expect(view.spans).toEqual([
      { from: 0, to: 0, role: 'user', catId: undefined },
      { from: 1, to: 2, role: 'assistant', catId: 'codex61-sol' },
      { from: 3, to: 3, role: 'assistant', catId: 'opus55' },
      { from: 4, to: 4, role: 'system', catId: undefined },
      { from: 5, to: 5, role: 'assistant', catId: undefined },
    ]);
    expect(JSON.stringify(events)).toBe(original);
  });

  it('shows only owner-classified idle annotations, never reclassifies elapsed gaps or tool waits', () => {
    const view = replayTimelineView([
      event({ timestamp: 1000 }),
      event({ timestamp: 721000, type: 'tool_call' }),
      event({ timestamp: 1441000 }),
      event({ timestamp: 1442000, idleSkipMs: 360000 }),
    ]);
    expect(view.idleGaps).toEqual([{ from: 2, to: 3, durationMs: 360000 }]);
  });

  it('does not invent a preceding interval for the first event or an empty replay', () => {
    expect(replayTimelineView([])).toEqual({ spans: [], idleGaps: [] });
    expect(replayTimelineView([event({ idleSkipMs: 60000 })]).idleGaps).toEqual([]);
  });
});
