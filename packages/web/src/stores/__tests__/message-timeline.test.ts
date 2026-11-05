import { describe, expect, it } from 'vitest';
import {
  findEarliestMessageByCursor,
  getMessageTimelineCursorTime,
  getMessageTimelineOrderTime,
  getOrderedMessageTimeline,
} from '../message-timeline';

describe('getMessageTimelineOrderTime', () => {
  it('keeps a processing response at its durable start despite later streaming activity', () => {
    expect(
      getMessageTimelineOrderTime({
        type: 'assistant',
        catId: 'codex-sol',
        timestamp: 2_000,
        timelineOrderAt: 1_800,
        lifecycle: { kind: 'response', status: 'processing', startedAt: 1_000 },
      }),
    ).toBe(1_000);
  });

  it('keeps an active response at its start when later inputs arrive', () => {
    const response = {
      id: 'response',
      timestamp: 1_000,
      lifecycle: { kind: 'response', status: 'processing', startedAt: 1_000, latestInputTimelineOrderAt: 2_000 },
    };
    const messages = [
      response,
      { id: 'first-input', timestamp: 1_000, timelineOrderAt: 1_001 },
      { id: 'appended-input', timestamp: 1_500, timelineOrderAt: 2_000 },
    ];

    expect(getOrderedMessageTimeline(messages).map((message) => message.id)).toEqual([
      'first-input',
      'response',
      'appended-input',
    ]);
    expect(getMessageTimelineOrderTime(response)).toBe(1_000);
    expect(getMessageTimelineCursorTime(response)).toBe(1_000);
  });

  it('keeps legacy processing rows without a start clock at their source timestamp', () => {
    expect(
      getMessageTimelineOrderTime({
        type: 'assistant',
        catId: 'codex-sol',
        timestamp: 1_000,
        timelineOrderAt: 1_800,
        lifecycle: { kind: 'response', status: 'processing' },
      }),
    ).toBe(1_000);
  });

  it('keeps a terminal response at its original timestamp when the start field is absent', () => {
    expect(
      getMessageTimelineOrderTime({
        type: 'assistant',
        catId: 'codex-sol',
        timestamp: 1_000,
        timelineOrderAt: 1_800,
        lifecycle: { kind: 'response', status: 'completed', completedAt: 2_000 },
      }),
    ).toBe(1_000);
  });

  it('does not move a terminal response when an appended delivery clock overtakes completion', () => {
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
    expect(getMessageTimelineOrderTime(response)).toBe(1_000);
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
    ).toBe(1_000);
  });

  it('keeps pagination cursors on the storage score independently of the start-time presentation', () => {
    const message = {
      type: 'assistant',
      catId: 'codex-sol',
      timestamp: 1_000,
      timelineOrderAt: 1_800,
      lifecycle: { kind: 'response', status: 'completed', completedAt: 2_000 },
    };

    expect(getMessageTimelineOrderTime(message)).toBe(1_000);
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

  it('keeps queued user work at send time after delivery', () => {
    expect(getMessageTimelineOrderTime({ type: 'user', catId: null, timestamp: 1_000, deliveredAt: 1_500 })).toBe(
      1_000,
    );
  });

  it('keeps internal rows at their creation time', () => {
    expect(
      getMessageTimelineOrderTime({ type: 'assistant', catId: 'system', timestamp: 1_000, deliveredAt: 1_500 }),
    ).toBe(1_000);
  });

  it('keeps legacy delivered cat rows at their original timestamp', () => {
    expect(
      getMessageTimelineOrderTime({
        type: 'assistant',
        catId: 'opus',
        timestamp: 1_000,
        deliveredAt: 1_500,
      }),
    ).toBe(1_000);
  });
});

describe('presentation timeline view', () => {
  it('keeps three active responses and an independent callback in one transitive order', () => {
    const rows = [
      {
        id: 'b',
        timestamp: 90,
        timelineOrderAt: 90,
        lifecycle: { kind: 'response', status: 'processing', startedAt: 20 },
      },
      { id: 'callback', timestamp: 25 },
      {
        id: 'c',
        timestamp: 80,
        timelineOrderAt: 80,
        lifecycle: { kind: 'response', status: 'processing', startedAt: 15 },
      },
      { id: 'input', timestamp: 12 },
      {
        id: 'a',
        timestamp: 70,
        timelineOrderAt: 70,
        lifecycle: { kind: 'response', status: 'processing', startedAt: 10 },
      },
    ];

    expect(getOrderedMessageTimeline(rows).map((row) => row.id)).toEqual(['a', 'input', 'c', 'b', 'callback']);
    expect(findEarliestMessageByCursor(rows)?.id).toBe('input');
  });

  it('sorts by the presentation clock with a stable id tie-break and memoizes by input reference', () => {
    const messages = [
      { id: 'response', timestamp: 1_000, lifecycle: { kind: 'response', status: 'completed', completedAt: 4_000 } },
      { id: 'user-z', timestamp: 2_000 },
      { id: 'user-a', timestamp: 2_000 },
    ];

    const first = getOrderedMessageTimeline(messages);
    const second = getOrderedMessageTimeline(messages);

    expect(first.map((message) => message.id)).toEqual(['response', 'user-a', 'user-z']);
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
        lifecycle: { kind: 'response', status: 'completed', startedAt: 1_000, completedAt: 4_000 },
      },
      { id: 'storage-oldest', timestamp: 2_000, timelineOrderAt: 2_000 },
    ];

    expect(getOrderedMessageTimeline(messages)[0]?.id).toBe('inserted-first');
    expect(findEarliestMessageByCursor(messages)?.id).toBe('storage-oldest');
  });
});
