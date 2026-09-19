import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { mergeReplaceHydrationMessages } from '../useChatHistory';

describe('mergeReplaceHydrationMessages metadata ownership boundary', () => {
  it('preserves Gap F lineage and durable carriers beside targetCats', () => {
    const history: ChatMessage = {
      id: 'assistant-terminal',
      type: 'assistant',
      catId: 'codex-sol',
      content: 'done',
      timestamp: 2_000,
      extra: { targetCats: ['operator'] },
    };
    const current: ChatMessage = {
      ...history,
      extra: {
        targetCats: ['operator'],
        turnExecution: {
          invocationId: 'turn-primary',
          parentInvocationId: 'parent-1',
          executionKind: 'ordinary',
        },
        auxiliaryTurnExecutions: [
          {
            invocationId: 'turn-guard',
            parentInvocationId: 'parent-1',
            executionKind: 'routing_guard',
          },
        ],
        messageBundle: {
          v: 1,
          sourceThreadId: 'thread-source',
          items: [{ kind: 'message', messageId: 'message-source' }],
        },
        invocationReconciliation: {
          v: 1,
          invocationId: 'parent-1',
          catIds: ['codex-sol'],
          turnInvocationIds: ['turn-primary'],
          phase: 'succeeded',
          updatedAt: 2_100,
        },
      },
    };

    const result = mergeReplaceHydrationMessages([history], [current], {});
    const extra = result.messages[0]?.extra;

    expect(extra?.turnExecution?.invocationId).toBe('turn-primary');
    expect(extra?.auxiliaryTurnExecutions?.[0]?.invocationId).toBe('turn-guard');
    expect(extra?.messageBundle?.items).toEqual([{ kind: 'message', messageId: 'message-source' }]);
    expect(extra?.invocationReconciliation?.phase).toBe('succeeded');
  });

  it('does not pass undeclared runtime extra fields through the hydration boundary', () => {
    const history: ChatMessage = {
      id: 'unknown-extra',
      type: 'user',
      content: 'plain message',
      timestamp: 3_000,
      extra: { untrustedCarrier: { value: 'must-not-cross' } } as ChatMessage['extra'],
    };
    const current: ChatMessage = {
      id: 'unknown-extra',
      type: 'user',
      content: 'plain message',
      timestamp: 3_000,
    };

    const result = mergeReplaceHydrationMessages([history], [current], {});

    expect(result.messages[0]?.extra).toBeUndefined();
  });
});
