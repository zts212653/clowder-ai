import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../stores/chat-types';
import { mergeReplaceHydrationMessages } from '../useChatHistory';

function makeMsg(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm-default',
    type: 'assistant',
    content: 'hello',
    timestamp: 1000,
    ...overrides,
  };
}

describe('mergeReplaceHydrationMessages — explicit post isolation', () => {
  it('does not match live stream bubbles to hydrated explicit posts by invocation id', () => {
    const history: ChatMessage[] = [
      makeMsg({
        id: 'explicit-post-1',
        catId: 'opus',
        origin: 'callback',
        content: 'standalone explicit post',
        timestamp: 1000,
        extra: {
          isExplicitPost: true,
          stream: { invocationId: 'inv-explicit' },
        },
      }),
    ];
    const current: ChatMessage[] = [
      makeMsg({
        id: 'stream-bubble-1',
        catId: 'opus',
        origin: 'stream',
        content: 'live stream still running',
        timestamp: 1001,
        isStreaming: true,
        extra: { stream: { invocationId: 'inv-explicit' } },
      }),
    ];

    const result = mergeReplaceHydrationMessages(history, current, {});

    expect(result.messages.map((msg) => msg.id).sort()).toEqual(['explicit-post-1', 'stream-bubble-1']);
    expect(result.stats.preservedLocalCount).toBe(1);
    expect(result.stats.reconciledToHistoryCount).toBe(0);
    expect(result.stats.replacedHistoryCount).toBe(0);
  });
});
