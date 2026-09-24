import { describe, expect, it } from 'vitest';
import {
  findEarliestMessageByCursor,
  getMessageTimelineCursorTime,
  getMessageTimelineOrderTime,
  getOrderedMessageTimeline,
} from '../message-timeline';

describe('getMessageTimelineOrderTime', () => {
  it('keeps a processing response on its latest streaming activity time', () => {
    expect(
      getMessageTimelineOrderTime({
        type: 'assistant',
        catId: 'codex-sol',
        timestamp: 1_000,
        timelineOrderAt: 1_800,
        lifecycle: { kind: 'response', status: 'processing' },
      }),
    ).toBe(1_800);
  });

  it('places an active response after the newest admitted input even before its first chunk', () => {
    const response = {
      id: 'response',
      timestamp: 1_000,
      lifecycle: { kind: 'response', status: 'processing', latestInputTimelineOrderAt: 2_000 },
    };
    const messages = [
      response,
      { id: 'first-input', timestamp: 1_000, timelineOrderAt: 1_001 },
      { id: 'appended-input', timestamp: 1_500, timelineOrderAt: 2_000 },
    ];

    expect(getOrderedMessageTimeline(messages).map((message) => message.id)).toEqual([
      'first-input',
      'appended-input',
      'response',
    ]);
    expect(getMessageTimelineOrderTime(response)).toBe(2_001);
    expect(getMessageTimelineCursorTime(response)).toBe(1_000);
  });

  it('freezes a terminal response at completion when no later admitted input requires a floor', () => {
    expect(
      getMessageTimelineOrderTime({
        type: 'assistant',
        catId: 'codex-sol',
        timestamp: 1_000,
        timelineOrderAt: 1_800,
        lifecycle: { kind: 'response', status: 'completed', completedAt: 2_000 },
      }),
    ).toBe(2_000);
  });

  it('keeps a terminal response after an admitted input whose delivery clock overtook completion', () => {
    const response = {
      id: 'response',
      timestamp: 1_000,
      timelineOrderAt: 1_200,
      lifecycle: {
        kind: 'response',
        status: 'completed',
        completedAt: 1_500,
        latestInputTimelineOrderAt: 2_000,
      },
    };
    expect(getMessageTimelineOrderTime(response)).toBe(2_001);
    expect(getMessageTimelineCursorTime(response)).toBe(1_200);
  });

  it('lets a terminal lifecycle override a stale streaming flag', () => {
    expect(
      getMessageTimelineOrderTime({
        type: 'assistant',
        catId: 'codex-sol',
        isStreaming: true,
        timestamp: 1_000,
        timelineOrderAt: 1_800,
        lifecycle: { kind: 'response', status: 'completed', completedAt: 2_000 },
      }),
    ).toBe(2_000);
  });

  it('keeps pagination cursors on the storage score after presentation freezes at completion', () => {
    const message = {
      type: 'assistant',
      catId: 'codex-sol',
      timestamp: 1_000,
      timelineOrderAt: 1_800,
      lifecycle: { kind: 'response', status: 'completed', completedAt: 2_000 },
    };

    expect(getMessageTimelineOrderTime(message)).toBe(2_000);
    expect(getMessageTimelineCursorTime(message)).toBe(1_800);
  });

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

describe('presentation timeline view', () => {
  it('sorts by the presentation clock with a stable id tie-break and memoizes by input reference', () => {
    const messages = [
      { id: 'response', timestamp: 1_000, lifecycle: { kind: 'response', status: 'completed', completedAt: 4_000 } },
      { id: 'user-z', timestamp: 2_000 },
      { id: 'user-a', timestamp: 2_000 },
    ];

    const first = getOrderedMessageTimeline(messages);
    const second = getOrderedMessageTimeline(messages);

    expect(first.map((message) => message.id)).toEqual(['user-a', 'user-z', 'response']);
    expect(second).toBe(first);
    expect(messages.map((message) => message.id)).toEqual(['response', 'user-z', 'user-a']);
  });

  it('returns the original reference when input is already ordered', () => {
    const messages = [
      { id: 'a', timestamp: 1_000 },
      { id: 'b', timestamp: 2_000 },
    ];

    expect(getOrderedMessageTimeline(messages)).toBe(messages);
  });

  it('finds the storage-cursor minimum independently from presentation and insertion order', () => {
    const messages = [
      {
        id: 'inserted-first',
        timestamp: 3_000,
        timelineOrderAt: 3_000,
        lifecycle: { kind: 'response', status: 'completed', completedAt: 1_000 },
      },
      { id: 'storage-oldest', timestamp: 2_000, timelineOrderAt: 2_000 },
    ];

    expect(getOrderedMessageTimeline(messages)[0]?.id).toBe('inserted-first');
    expect(findEarliestMessageByCursor(messages)?.id).toBe('storage-oldest');
  });
});
