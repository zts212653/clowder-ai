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

  // F183 Phase E AC-E3 — Phase B+C harness-level smoke. The fixture's
  // reducer adapter mirrors the in-place upgrade contract (stream → callback
  // share `msg-{inv}-{cat}` id) but does NOT exercise production
  // BubbleReducer (that's covered by `bubble-reducer.test.ts` directly).
  // 砚砚 R1 P3: this is a harness smoke for the AC-E3 framework, not a
  // production-coverage replacement. Keep narrow.
  it('AC-E3 phase B+C harness smoke: stream → callback upgrade leaves no duplicate identity', () => {
    // Reducer: stream_chunk creates/updates a single bubble keyed by
    // (catId, invocationId, bubbleKind). callback_final upgrades the same
    // bubble in place via stream-key match (no new bubble).
    const result = replayBubbleEvents(
      [
        {
          type: 'stream_chunk',
          threadId: 'thread-A',
          actorId: 'opus',
          canonicalInvocationId: 'inv-X',
          bubbleKind: 'assistant_text',
          originPhase: 'stream',
          sourcePath: 'active',
          messageId: 'msg-inv-X-opus',
          seq: 1,
          payload: { content: 'streaming text' },
        },
        {
          type: 'callback_final',
          threadId: 'thread-A',
          actorId: 'opus',
          canonicalInvocationId: 'inv-X',
          bubbleKind: 'assistant_text',
          originPhase: 'callback/history',
          sourcePath: 'callback',
          messageId: 'msg-inv-X-opus', // same id → in-place upgrade
          seq: 2,
          payload: { content: 'final callback text' },
        },
      ],
      {
        reduceEvent: (state, event) => {
          // stream_chunk creates the bubble; callback_final upgrades in place
          const incoming = messageFromEvent(event);
          const idx = state.messages.findIndex((m) => m.id === incoming.id);
          const next = [...state.messages];
          if (idx >= 0) {
            next[idx] = { ...next[idx]!, ...incoming };
          } else {
            next.push(incoming);
          }
          return { messages: next, incomingMessage: incoming };
        },
      },
    );

    // Single bubble survives, callback content wins, no violations
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.content).toBe('final callback text');
    expect(result.violations).toHaveLength(0);
  });

  // F183 Phase E AC-E3 — Phase D IDB cache hydration via REAL production
  // helper `mergeReplaceHydrationMessages`. 砚砚 R1 P3 fix: the prior
  // version hand-wrote `filter(cachedFrom !== 'idb')` in the fixture
  // reducer, which proved nothing about production behavior. This version
  // drives the actual mergeReplaceHydrationMessages export so any future
  // regression in that helper would surface as a harness violation.
  it('AC-E3 phase D scenario via real mergeReplaceHydrationMessages: cached IDB dropped, no violations', async () => {
    const { mergeReplaceHydrationMessages } = await import('@/hooks/useChatHistory');
    const idbMsg: ChatMessage = {
      id: 'msg-cached-deleted',
      type: 'assistant',
      catId: 'opus',
      content: 'stale cache',
      timestamp: 100,
      cachedFrom: 'idb',
      extra: { stream: { invocationId: 'inv-old' } },
    };
    const result = replayBubbleEvents(
      [
        {
          type: 'callback_final',
          threadId: 'thread-D',
          actorId: 'opus',
          canonicalInvocationId: 'inv-fresh',
          bubbleKind: 'assistant_text',
          originPhase: 'callback/history',
          sourcePath: 'callback',
          messageId: 'msg-fresh',
          seq: 1,
          payload: { content: 'fresh from server' },
        },
      ],
      {
        initialMessagesByThread: { 'thread-D': [idbMsg] },
        // Production-driven adapter: each event becomes a "history replace"
        // where history = [incoming], current = state.messages. This mirrors
        // useChatHistory.ts:545 production wire-up of the merge call.
        reduceEvent: (state, event) => {
          const incoming = messageFromEvent(event);
          const merged = mergeReplaceHydrationMessages([incoming], state.messages, {});
          return { messages: merged.messages, incomingMessage: incoming };
        },
      },
    );

    // Real mergeReplaceHydrationMessages dropped the cached IDB; fresh present.
    expect(result.messages.find((m) => m.id === 'msg-cached-deleted')).toBeUndefined();
    expect(result.messages.find((m) => m.id === 'msg-fresh')).toBeDefined();
    expect(result.violations).toHaveLength(0);
  });
});
