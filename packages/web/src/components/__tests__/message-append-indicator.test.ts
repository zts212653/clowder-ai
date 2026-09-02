import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { collectMessageAppendSources } from '../MessageAppendIndicator';

function source(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'source-1',
    type: 'user',
    content: '请把这一句追加到正在生成的回复中，不要另起一轮。',
    timestamp: 100,
    extra: {
      queueReceipt: {
        version: 1,
        entryId: 'entry-1',
        targets: [
          {
            catId: 'opus',
            state: 'seen',
            invocationId: 'child-1',
            seenAt: 120,
            authorIntent: {
              requested: 'continue_current',
              effective: 'continue_current',
              boundParentInvocationId: 'parent-1',
            },
          },
        ],
        reminderAttempts: [],
      },
    },
    ...overrides,
  };
}

describe('collectMessageAppendSources', () => {
  it('shows only exact persisted continue-current body exposure on the receiving reply', () => {
    const fallback = source({
      id: 'fallback',
      extra: {
        queueReceipt: {
          version: 1,
          entryId: 'entry-fallback',
          targets: [
            {
              catId: 'opus',
              state: 'seen',
              invocationId: 'child-1',
              seenAt: 125,
              authorIntent: {
                requested: 'continue_current',
                effective: 'next_work',
                boundParentInvocationId: 'parent-1',
                fallbackAt: 124,
                fallbackReason: 'parent_non_success_after_exposure',
              },
            },
          ],
          reminderAttempts: [],
        },
      },
    });

    expect(collectMessageAppendSources([fallback, source()], 'child-1')).toEqual([
      {
        messageId: 'source-1',
        sourceLabel: '你',
        quote: '请把这一句追加到正在生成的回复中，不要另起一轮。',
        seenAt: 120,
      },
    ]);
    expect(collectMessageAppendSources([source()], 'other-child')).toEqual([]);
  });
});
