import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../stores/chat-types';
import { getOrderedMessageTimeline } from '../../stores/message-timeline';
import { mergeReplaceHydrationMessages } from '../useChatHistory';

function makeMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'message-default',
    type: 'assistant',
    content: '',
    timestamp: 1_000,
    ...overrides,
  };
}

describe('mergeReplaceHydrationMessages — presentation timeline order', () => {
  it('reorders a history-only hydration by terminal completion time instead of storage order', () => {
    const completedResponse = makeMessage({
      id: 'response-started-first-completed-last',
      catId: 'cat-sol',
      timestamp: 1_000,
      lifecycle: {
        kind: 'response',
        orderKey: '1000:invocation-sol',
        invocationId: 'invocation-sol',
        targetId: 'cat-sol',
        inputEntryIds: ['entry-initial', 'entry-supplement'],
        inputMessageIds: ['user-initial', 'user-supplement'],
        status: 'completed',
        startedAt: 1_000,
        completedAt: 4_000,
      },
    });
    const userSupplement = makeMessage({
      id: 'user-supplement',
      type: 'user',
      catId: undefined,
      timestamp: 2_000,
      deliveredAt: 2_000,
      timelineOrderAt: 2_000,
    });
    const callbackInput = makeMessage({
      id: 'callback-input',
      catId: 'opus',
      origin: 'callback',
      timestamp: 3_000,
    });

    // API pagination returns storage order, where the response retains its
    // original delivery score. The browser must project that snapshot through
    // the presentation clock even when there is no pre-existing local state.
    const result = mergeReplaceHydrationMessages([completedResponse, userSupplement, callbackInput], [], {});

    expect(getOrderedMessageTimeline(result.messages).map((message) => message.id)).toEqual([
      'user-supplement',
      'callback-input',
      'response-started-first-completed-last',
    ]);
  });
});
