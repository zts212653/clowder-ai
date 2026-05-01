import { describe, expect, it } from 'vitest';
import {
  assertNoBubbleInvariantViolations,
  deriveBubbleKindFromMessage,
  deriveBubbleStableIdentity,
  findBubbleStoreInvariantViolations,
  validateIncomingBubbleEvent,
} from '@/stores/bubble-invariants';
import type { ChatMessage } from '@/stores/chat-types';

function msg(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    type: 'assistant',
    catId: 'codex',
    content: `content-${id}`,
    timestamp: 1000,
    extra: { stream: { invocationId: 'inv-1' } },
    ...overrides,
  };
}

describe('F183 bubble invariant gate', () => {
  it('derives ADR-033 stable identity from a ChatMessage', () => {
    expect(deriveBubbleStableIdentity(msg('m1'), 'thread-1')).toEqual({
      threadId: 'thread-1',
      actorId: 'codex',
      canonicalInvocationId: 'inv-1',
      bubbleKind: 'assistant_text',
    });
  });

  it('keeps text-bearing messages as assistant_text when tool events append later', () => {
    const withToolEvents = msg('m-with-tools', {
      content: 'final answer with tool evidence',
      toolEvents: [
        {
          id: 'tool-1',
          type: 'tool_use',
          label: 'rg',
          timestamp: 1001,
        },
      ],
    });

    expect(deriveBubbleKindFromMessage(withToolEvents)).toBe('assistant_text');
    expect(deriveBubbleStableIdentity(withToolEvents, 'thread-1')).toMatchObject({
      bubbleKind: 'assistant_text',
    });
  });

  it('keeps pure tool-only messages in tool_or_cli kind', () => {
    expect(
      deriveBubbleKindFromMessage(
        msg('m-tool-only', {
          content: '',
          toolEvents: [
            {
              id: 'tool-1',
              type: 'tool_result',
              label: 'rg',
              timestamp: 1002,
            },
          ],
        }),
      ),
    ).toBe('tool_or_cli');
  });

  it('detects duplicate stable identity inside a thread', () => {
    const violations = findBubbleStoreInvariantViolations(
      [msg('stream-1', { origin: 'stream' }), msg('callback-1', { origin: 'callback', content: 'final' })],
      {
        threadId: 'thread-1',
        eventType: 'callback_final',
        sourcePath: 'callback',
        timestamp: 1234,
      },
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      threadId: 'thread-1',
      actorId: 'codex',
      canonicalInvocationId: 'inv-1',
      bubbleKind: 'assistant_text',
      eventType: 'callback_final',
      originPhase: 'callback/history',
      sourcePath: 'callback',
      existingMessageId: 'stream-1',
      incomingMessageId: 'callback-1',
      recoveryAction: 'quarantine',
      violationKind: 'duplicate',
      timestamp: 1234,
    });
  });

  it('hard-fails duplicate stable identity in dev/test assertion mode', () => {
    expect(() =>
      assertNoBubbleInvariantViolations(
        [msg('stream-1', { origin: 'stream' }), msg('callback-1', { origin: 'callback' })],
        {
          threadId: 'thread-1',
          eventType: 'callback_final',
          sourcePath: 'callback',
        },
      ),
    ).toThrow(/duplicate stable bubble identity/);
  });

  it('detects phase regression when stream arrives after callback/history', () => {
    const violation = validateIncomingBubbleEvent(
      [msg('final-1', { origin: 'callback' })],
      msg('late-stream', { origin: 'stream' }),
      {
        threadId: 'thread-1',
        eventType: 'stream_chunk',
        originPhase: 'stream',
        sourcePath: 'active',
        timestamp: 2000,
      },
    );

    expect(violation).toMatchObject({
      violationKind: 'phase-regression',
      existingMessageId: 'final-1',
      incomingMessageId: 'late-stream',
      originPhase: 'stream',
      recoveryAction: 'quarantine',
    });
  });

  it('does not treat missing origin as callback/history for phase regression', () => {
    const violation = validateIncomingBubbleEvent(
      [msg('legacy-history-without-origin', { origin: undefined })],
      msg('legitimate-stream-update', { origin: 'stream' }),
      {
        threadId: 'thread-1',
        eventType: 'stream_chunk',
        originPhase: 'stream',
        sourcePath: 'active',
        timestamp: 2100,
      },
    );

    expect(violation).toBeNull();
  });

  it('detects canonical key split for the same message instance', () => {
    const violation = validateIncomingBubbleEvent(
      [msg('same-message-id', { extra: { stream: { invocationId: 'inv-old' } } })],
      msg('same-message-id', { extra: { stream: { invocationId: 'inv-new' } } }),
      {
        threadId: 'thread-1',
        eventType: 'history_hydrate',
        originPhase: 'callback/history',
        sourcePath: 'hydration',
        timestamp: 3000,
      },
    );

    expect(violation).toMatchObject({
      violationKind: 'canonical-split',
      actorId: 'codex',
      canonicalInvocationId: 'inv-new',
      existingMessageId: 'same-message-id',
      incomingMessageId: 'same-message-id',
      recoveryAction: 'sot-override',
    });
  });
});
