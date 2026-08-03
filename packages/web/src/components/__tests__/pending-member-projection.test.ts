import { describe, expect, it } from 'vitest';
import { derivePendingMemberInvocations, hasInvocationStartedExecuting } from '@/components/pending-member-projection';
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
});

describe('hasInvocationStartedExecuting', () => {
  const pending = { invocationId: 'inv-1', catId: 'codex' };
  const lifecycle = (stage: 'child_spawned' | 'initialized' | 'thread_ready' | 'turn_accepted' | 'active') => ({
    stage,
    lastActivityAt: 0,
    recoveryAttempt: 0,
    turnStartSent: true,
    turnAccepted: stage === 'turn_accepted' || stage === 'active',
    itemObserved: stage === 'active',
  });

  it('stays pending without lifecycle evidence for this invocation', () => {
    expect(hasInvocationStartedExecuting(pending, undefined)).toBe(false);
    expect(hasInvocationStartedExecuting(pending, { invocationId: 'inv-1' })).toBe(false);
  });

  it('stays pending while the backend is still starting up', () => {
    expect(
      hasInvocationStartedExecuting(pending, { invocationId: 'inv-1', appServerLifecycle: lifecycle('child_spawned') }),
    ).toBe(false);
    expect(
      hasInvocationStartedExecuting(pending, { invocationId: 'inv-1', appServerLifecycle: lifecycle('initialized') }),
    ).toBe(false);
    expect(
      hasInvocationStartedExecuting(pending, { invocationId: 'inv-1', appServerLifecycle: lifecycle('thread_ready') }),
    ).toBe(false);
  });

  it('exits once this invocation’s turn is accepted or active', () => {
    expect(
      hasInvocationStartedExecuting(pending, { invocationId: 'inv-1', appServerLifecycle: lifecycle('turn_accepted') }),
    ).toBe(true);
    expect(
      hasInvocationStartedExecuting(pending, { invocationId: 'inv-1', appServerLifecycle: lifecycle('active') }),
    ).toBe(true);
  });

  it('binds via turnInvocationId and strips the fan-out suffix', () => {
    expect(
      hasInvocationStartedExecuting(pending, { turnInvocationId: 'inv-1', appServerLifecycle: lifecycle('active') }),
    ).toBe(true);
    expect(
      hasInvocationStartedExecuting(
        { invocationId: 'inv-1-codex', catId: 'codex' },
        { invocationId: 'inv-1', appServerLifecycle: lifecycle('active') },
      ),
    ).toBe(true);
  });

  it('ignores a stale lifecycle snapshot from a previous invocation', () => {
    expect(
      hasInvocationStartedExecuting(pending, { invocationId: 'inv-old', appServerLifecycle: lifecycle('active') }),
    ).toBe(false);
    expect(
      hasInvocationStartedExecuting(pending, {
        invocationId: 'inv-old',
        turnInvocationId: 'inv-old-t',
        appServerLifecycle: lifecycle('active'),
      }),
    ).toBe(false);
  });
});
