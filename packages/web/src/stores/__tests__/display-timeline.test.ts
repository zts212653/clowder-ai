import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../chat-types';
import { includeNewTimelineMessages } from '../display-timeline';

const message = (id: string, timestamp: number): ChatMessage => ({ id, timestamp, type: 'assistant', content: id });

describe('stable viewport order', () => {
  it('inserts a new card by its start time while keeping existing cards in place', () => {
    const updated = [{ ...message('a', 10), timelineOrderAt: 100 }, message('b', 20), message('new', 15)];
    expect(includeNewTimelineMessages(['a', 'b'], updated)).toEqual(['a', 'new', 'b']);
  });
  it('removes missing cards without swapping the survivors', () => {
    expect(includeNewTimelineMessages(['a', 'b', 'c'], [message('c', 1), message('a', 100)])).toEqual(['a', 'c']);
  });
  it('includes each newly hydrated ID only once', () => {
    expect(includeNewTimelineMessages([], [message('a', 10), message('a', 10), message('b', 20)])).toEqual(['a', 'b']);
  });
});
