import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { mergeReplaceHydrationMessages } from '../useChatHistory';

describe('mergeReplaceHydrationMessages queued user receipt', () => {
  it('keeps the authoritative history receipt when reconciling the same live user bubble', () => {
    const current: ChatMessage = {
      id: 'queued-user',
      type: 'user',
      content: 'follow-up',
      timestamp: 1_000,
      extra: {
        queueReceipt: {
          version: 1,
          entryId: 'entry-1',
          targets: [{ catId: 'opus', state: 'queued' }],
          reminderAttempts: [],
        },
      },
    };
    const history: ChatMessage = {
      ...current,
      extra: {
        queueReceipt: {
          version: 1,
          entryId: 'entry-1',
          targets: [{ catId: 'opus', state: 'seen', invocationId: 'inv-1', seenAt: 1_050 }],
          reminderAttempts: [],
        },
      },
    };

    const result = mergeReplaceHydrationMessages([history], [current], {});

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.extra?.queueReceipt?.targets[0]).toMatchObject({
      state: 'seen',
      invocationId: 'inv-1',
      seenAt: 1_050,
    });
  });
});
