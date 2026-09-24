import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../chat-types';
import { commitTimelineOrderRound, includeNewTimelineMessages } from '../display-timeline';
import { getOrderedMessageTimeline } from '../message-timeline';

function message(id: string, time: number): ChatMessage {
  return { id, type: 'assistant', catId: 'opus', content: id, timestamp: time, timelineOrderAt: time };
}

function canonical(messages: readonly ChatMessage[]): string[] {
  return getOrderedMessageTimeline(messages).map((item) => item.id);
}

describe('viewport display-order rounds', () => {
  it('keeps existing cards still during alternating chunks, then matches the round snapshot', () => {
    const first: [ChatMessage, ChatMessage, ChatMessage] = [message('a', 10), message('b', 20), message('c', 30)];
    const initial = canonical(first);
    const aChunk: [ChatMessage, ChatMessage, ChatMessage] = [{ ...first[0], timelineOrderAt: 40 }, first[1], first[2]];
    const bChunk = [aChunk[0], { ...first[1], timelineOrderAt: 50 }, first[2]];

    expect(includeNewTimelineMessages(initial, aChunk)).toEqual(initial);
    expect(includeNewTimelineMessages(initial, bChunk)).toEqual(initial);

    const firstRound = commitTimelineOrderRound(first, initial, aChunk);
    expect(firstRound).toEqual(canonical(aChunk));
    expect(includeNewTimelineMessages(firstRound, bChunk)).toEqual(firstRound);
    expect(commitTimelineOrderRound(aChunk, firstRound, bChunk)).toEqual(canonical(bChunk));
  });

  it('keeps a terminal transition in place until the next round', () => {
    const first: [ChatMessage, ChatMessage] = [message('a', 10), message('b', 20)];
    const initial = canonical(first);
    const terminal = [{ ...first[0], timelineOrderAt: 30, isStreaming: false }, first[1]];
    expect(includeNewTimelineMessages(initial, terminal)).toEqual(initial);
    expect(commitTimelineOrderRound(first, initial, terminal)).toEqual(['b', 'a']);
  });

  it('shows new messages immediately without reordering existing IDs', () => {
    const first = [message('a', 10), message('b', 20)];
    const initial = canonical(first);
    const next = [...first, message('new', 15)];
    expect(includeNewTimelineMessages(initial, next)).toEqual(['a', 'new', 'b']);
    expect(commitTimelineOrderRound(first, initial, next)).toEqual(canonical(next));
  });

  it('differentially matches full canonical sorting over immutable updates, insertion, and deletion', () => {
    let snapshot = Array.from({ length: 35 }, (_, index) => message(`m-${index}`, index * 10));
    let ordered = canonical(snapshot);
    for (let step = 0; step < 140; step++) {
      const next = [...snapshot];
      if (step % 17 === 0 && next.length > 2) next.splice(step % next.length, 1);
      else if (step % 11 === 0) next.push(message(`new-${step}`, step * 3));
      else {
        const index = step % next.length;
        const previous = next[index];
        if (!previous) throw new Error('differential fixture unexpectedly empty');
        next[index] = { ...previous, timelineOrderAt: (step * 37) % 400 };
      }
      ordered = commitTimelineOrderRound(snapshot, ordered, next);
      expect(ordered).toEqual(canonical(next));
      snapshot = next;
    }
  });
});
