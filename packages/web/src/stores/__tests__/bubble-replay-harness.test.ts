import { describe, expect, it } from 'vitest';
import { type BubbleEventFixture, replayBubbleEvents } from '@/stores/bubble-replay-harness';
import type { ChatMessage } from '@/stores/chat-types';

function messageFromEvent(event: BubbleEventFixture): ChatMessage {
  return {
    id: event.messageId ?? `${event.type}-${event.seq ?? 0}`,
    type: event.bubbleKind === 'system_status' ? 'system' : 'assistant',
    catId: event.actorId === 'system' ? undefined : event.actorId,
    content: String(event.payload?.content ?? event.type),
    timestamp: event.timestamp ?? 1,
    origin:
      event.originPhase === 'stream' ? 'stream' : event.originPhase === 'callback/history' ? 'callback' : undefined,
    extra: event.canonicalInvocationId ? { stream: { invocationId: event.canonicalInvocationId } } : undefined,
  };
}

describe('F183 bubble replay harness', () => {
  it('preserves initial messages when replay has no events', () => {
    const initial: ChatMessage = {
      id: 'initial-message',
      type: 'assistant',
      catId: 'codex',
      content: 'steady state',
      timestamp: 100,
      extra: { stream: { invocationId: 'inv-initial' } },
    };

    const result = replayBubbleEvents([], { initialMessages: [initial] });

    expect(result.messages).toEqual([initial]);
    expect(result.violations).toHaveLength(0);
  });

  it('replays BubbleEvent fixtures through an injected reducer adapter', () => {
    const result = replayBubbleEvents(
      [
        {
          type: 'stream_chunk',
          threadId: 'thread-1',
          actorId: 'codex',
          canonicalInvocationId: 'inv-1',
          bubbleKind: 'assistant_text',
          originPhase: 'stream',
          sourcePath: 'active',
          messageId: 'msg-stream',
          payload: { content: 'stream text' },
        },
      ],
      {
        reduceEvent: ({ messages }, event) => ({
          messages: [...messages, messageFromEvent(event)],
          incomingMessage: messageFromEvent(event),
        }),
      },
    );

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.content).toBe('stream text');
    expect(result.violations).toHaveLength(0);
  });

  it('collects invariant violations after each replayed event', () => {
    const events: BubbleEventFixture[] = [
      {
        type: 'stream_chunk',
        threadId: 'thread-1',
        actorId: 'codex',
        canonicalInvocationId: 'inv-1',
        bubbleKind: 'assistant_text',
        originPhase: 'stream',
        sourcePath: 'active',
        messageId: 'msg-stream',
      },
      {
        type: 'callback_final',
        threadId: 'thread-1',
        actorId: 'codex',
        canonicalInvocationId: 'inv-1',
        bubbleKind: 'assistant_text',
        originPhase: 'callback/history',
        sourcePath: 'callback',
        messageId: 'msg-callback',
      },
    ];

    const result = replayBubbleEvents(events, {
      reduceEvent: ({ messages }, event) => ({
        messages: [...messages, messageFromEvent(event)],
        incomingMessage: messageFromEvent(event),
      }),
    });

    expect(result.messages).toHaveLength(2);
    expect(result.violations).toEqual([
      expect.objectContaining({
        violationKind: 'duplicate',
        eventType: 'callback_final',
        existingMessageId: 'msg-stream',
        incomingMessageId: 'msg-callback',
      }),
    ]);
  });

  it('keeps replay invariant checks isolated per thread', () => {
    const events: BubbleEventFixture[] = [
      {
        type: 'stream_chunk',
        threadId: 'thread-1',
        actorId: 'codex',
        canonicalInvocationId: 'inv-shared',
        bubbleKind: 'assistant_text',
        originPhase: 'stream',
        sourcePath: 'active',
        messageId: 'thread-1-message',
      },
      {
        type: 'stream_chunk',
        threadId: 'thread-2',
        actorId: 'codex',
        canonicalInvocationId: 'inv-shared',
        bubbleKind: 'assistant_text',
        originPhase: 'stream',
        sourcePath: 'active',
        messageId: 'thread-2-message',
      },
    ];

    const result = replayBubbleEvents(events, {
      reduceEvent: ({ messages }, event) => ({
        messages: [...messages, messageFromEvent(event)],
        incomingMessage: messageFromEvent(event),
      }),
    });

    expect(result.messages).toHaveLength(2);
    expect(result.violations).toHaveLength(0);
  });

  it('uses deterministic timestamps for replay violations when fixture omits timestamp', () => {
    const events: BubbleEventFixture[] = [
      {
        type: 'stream_chunk',
        threadId: 'thread-1',
        actorId: 'codex',
        canonicalInvocationId: 'inv-1',
        bubbleKind: 'assistant_text',
        originPhase: 'stream',
        sourcePath: 'active',
        messageId: 'msg-stream',
      },
      {
        type: 'callback_final',
        threadId: 'thread-1',
        actorId: 'codex',
        canonicalInvocationId: 'inv-1',
        bubbleKind: 'assistant_text',
        originPhase: 'callback/history',
        sourcePath: 'callback',
        messageId: 'msg-callback',
      },
    ];

    const result = replayBubbleEvents(events, {
      reduceEvent: ({ messages }, event) => ({
        messages: [...messages, messageFromEvent(event)],
        incomingMessage: messageFromEvent(event),
      }),
    });

    expect(result.violations).toEqual([
      expect.objectContaining({
        timestamp: 0,
      }),
    ]);
  });
});
