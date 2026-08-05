import { describe, expect, it } from 'vitest';
import { doesAssistantMessageRenderBubble } from '@/components/assistant-message-renderability';
import { derivePendingMemberInvocations } from '@/components/pending-member-projection';
import type { ChatMessage } from '@/stores/chat-types';

function assistantMessage(catId: string, invocationId: string, turnInvocationId?: string): ChatMessage {
  return {
    id: `msg-${invocationId}-${catId}`,
    type: 'assistant',
    catId,
    content: 'visible output',
    timestamp: 1,
    isStreaming: true,
    extra: { stream: { invocationId, turnInvocationId } },
  };
}

describe('derivePendingMemberInvocations', () => {
  it('does not re-project an avatar after a later user message for the same active invocation', () => {
    const messages: ChatMessage[] = [
      assistantMessage('codex', 'parent-1', 'turn-1'),
      {
        id: 'later-user',
        type: 'user',
        content: 'queued while codex is still running',
        timestamp: 2,
      },
    ];

    expect(
      derivePendingMemberInvocations({ 'parent-1': { catId: 'codex', mode: 'execute', startedAt: 0 } }, messages),
    ).toEqual([]);
    expect(doesAssistantMessageRenderBubble(messages[0])).toBe(true);
  });

  it('preserves trusted catId author precedence for legacy type=user records', () => {
    const legacyCatMessage = assistantMessage('codex', 'parent-1', 'turn-1');
    legacyCatMessage.type = 'user';
    legacyCatMessage.isStreaming = false;

    expect(doesAssistantMessageRenderBubble(legacyCatMessage)).toBe(true);
    expect(
      derivePendingMemberInvocations({ 'parent-1': { catId: 'codex', mode: 'execute', startedAt: 0 } }, [
        legacyCatMessage,
      ]),
    ).toEqual([]);
  });

  it('keeps the pending avatar when a system error owns no assistant avatar slot', () => {
    const systemError = assistantMessage('codex', 'parent-1', 'turn-1');
    systemError.type = 'system';
    systemError.content = 'Provider failed before the cat bubble appeared';
    systemError.isStreaming = false;

    expect(doesAssistantMessageRenderBubble(systemError)).toBe(false);
    expect(
      derivePendingMemberInvocations({ 'parent-1': { catId: 'codex', mode: 'execute', startedAt: 0 } }, [systemError]),
    ).toEqual([{ invocationId: 'parent-1', catId: 'codex' }]);
  });

  it('matches the per-turn identity when the active slot uses turnInvocationId', () => {
    expect(
      derivePendingMemberInvocations({ 'turn-1': { catId: 'codex', mode: 'execute', startedAt: 0 } }, [
        assistantMessage('codex', 'parent-1', 'turn-1'),
      ]),
    ).toEqual([]);
  });

  it('does not re-project an auxiliary execution already attached to a visible assistant bubble', () => {
    const visibleMessage = assistantMessage('gpt52', 'parent-1', 'ordinary-turn-1');
    visibleMessage.extra = {
      ...visibleMessage.extra,
      auxiliaryTurnExecutions: [
        {
          invocationId: 'routing-guard-turn-1',
          parentInvocationId: 'parent-1',
          executionKind: 'routing_guard',
        },
      ],
    };

    expect(
      derivePendingMemberInvocations({ 'routing-guard-turn-1': { catId: 'gpt52', mode: 'execute', startedAt: 0 } }, [
        visibleMessage,
      ]),
    ).toEqual([]);
  });

  it('matches a fan-out secondary slot whose active key carries the cat suffix', () => {
    expect(
      derivePendingMemberInvocations({ 'parent-1-codex-sol': { catId: 'codex-sol', mode: 'execute', startedAt: 0 } }, [
        assistantMessage('codex-sol', 'parent-1', 'turn-sol-1'),
      ]),
    ).toEqual([]);
  });

  it('does not invent a pending avatar for a hydration slot with no causal invocation identity', () => {
    expect(
      derivePendingMemberInvocations(
        { 'hydrated-thread-1-codex': { catId: 'codex', mode: 'execute', startedAt: 0 } },
        [],
      ),
    ).toEqual([]);
  });

  it('does not treat an explicit post correlated to the parent as the active invocation output', () => {
    const explicitPost = assistantMessage('codex', 'parent-1');
    explicitPost.extra = { ...explicitPost.extra, isExplicitPost: true };

    expect(
      derivePendingMemberInvocations({ 'parent-1': { catId: 'codex', mode: 'execute', startedAt: 0 } }, [explicitPost]),
    ).toEqual([{ invocationId: 'parent-1', catId: 'codex' }]);
  });

  it('keeps a pending avatar for a newer invocation from the same cat', () => {
    expect(
      derivePendingMemberInvocations({ 'parent-2': { catId: 'codex', mode: 'execute', startedAt: 2 } }, [
        assistantMessage('codex', 'parent-1'),
      ]),
    ).toEqual([{ invocationId: 'parent-2', catId: 'codex' }]);
  });

  it('does not let another cat with the same invocation id suppress the target avatar', () => {
    expect(
      derivePendingMemberInvocations({ shared: { catId: 'codex-sol', mode: 'execute', startedAt: 2 } }, [
        assistantMessage('codex', 'shared'),
      ]),
    ).toEqual([{ invocationId: 'shared', catId: 'codex-sol' }]);
  });

  it('keeps the placeholder when an identity-only assistant record would render no bubble', () => {
    const identityOnly = assistantMessage('codex', 'parent-1', 'turn-1');
    identityOnly.content = '';
    identityOnly.isStreaming = false;

    expect(
      derivePendingMemberInvocations({ 'parent-1': { catId: 'codex', mode: 'execute', startedAt: 0 } }, [identityOnly]),
    ).toEqual([{ invocationId: 'parent-1', catId: 'codex' }]);
    expect(doesAssistantMessageRenderBubble(identityOnly)).toBe(false);
  });
});
