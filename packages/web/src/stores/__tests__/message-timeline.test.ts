import { describe, expect, it } from 'vitest';
import { getMessageTimelineOrderTime } from '../message-timeline';

describe('getMessageTimelineOrderTime', () => {
  it('keeps real-cat speech at authoring time after execution delivery', () => {
    expect(
      getMessageTimelineOrderTime({
        type: 'assistant',
        catId: 'codex-sol',
        timestamp: 1_000,
        deliveredAt: 1_500,
        timelineOrderAt: 1_000,
      }),
    ).toBe(1_000);
  });

  it('orders queued user work by delivery time', () => {
    expect(getMessageTimelineOrderTime({ type: 'user', catId: null, timestamp: 1_000, deliveredAt: 1_500 })).toBe(
      1_500,
    );
  });

  it('does not treat internal system cats as published real-cat speech', () => {
    expect(
      getMessageTimelineOrderTime({ type: 'assistant', catId: 'system', timestamp: 1_000, deliveredAt: 1_500 }),
    ).toBe(1_500);
  });

  it('keeps legacy delivered cat rows on their historical delivery score', () => {
    expect(
      getMessageTimelineOrderTime({
        type: 'assistant',
        catId: 'opus',
        timestamp: 1_000,
        deliveredAt: 1_500,
      }),
    ).toBe(1_500);
  });
});
