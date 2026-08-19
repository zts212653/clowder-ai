import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { mergeReplaceHydrationMessages } from '../useChatHistory';

describe('mergeReplaceHydrationMessages queued user receipt', () => {
  it('keeps the authoritative history receipt when another extra field forces a structured merge', () => {
    const current: ChatMessage = {
      id: 'queued-user',
      type: 'user',
      content: 'follow-up',
      timestamp: 1_000,
      extra: {
        targetCats: ['opus'],
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
        targetCats: ['opus'],
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

  it('preserves a live terminal receipt when history has not projected the additive field yet', () => {
    const history: ChatMessage = {
      id: 'queued-user',
      type: 'user',
      content: 'follow-up',
      timestamp: 1_000,
      extra: { targetCats: ['codex-sol'] },
    };
    const current: ChatMessage = {
      ...history,
      extra: {
        targetCats: ['codex-sol'],
        queueReceipt: {
          version: 1,
          entryId: 'entry-terminal',
          targets: [
            {
              catId: 'codex-sol',
              state: 'handled',
              outcome: {
                invocationId: 'turn-terminal',
                disposition: 'completed_with_turn',
                evidenceRef: { kind: 'invocation_lineage', invocationId: 'turn-terminal' },
                handledAt: 1_200,
              },
            },
          ],
          reminderAttempts: [],
        },
      },
    };

    const result = mergeReplaceHydrationMessages([history], [current], {});

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.extra?.queueReceipt?.targets[0]).toMatchObject({
      state: 'handled',
      outcome: { invocationId: 'turn-terminal', handledAt: 1_200 },
    });
  });

  it('preserves Gap F lineage and durable carriers beside targetCats', () => {
    const history: ChatMessage = {
      id: 'assistant-terminal',
      type: 'assistant',
      catId: 'codex-sol',
      content: 'done',
      timestamp: 2_000,
      extra: { targetCats: ['you'] },
    };
    const current: ChatMessage = {
      ...history,
      extra: {
        targetCats: ['you'],
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
