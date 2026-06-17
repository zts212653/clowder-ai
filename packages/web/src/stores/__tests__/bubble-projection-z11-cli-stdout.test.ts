/**
 * F194 Phase Z11 — CLI Output stdout consistency (co-creator R15, 2026-05-16).
 *
 * Bug: when projection merges a stream record + a post_message callback into one
 * canonical bubble (Z8 KD-27), bubble origin becomes `callback`. ChatMessage.tsx:122
 * only feeds content to `toCliEvents` when `origin === 'stream'`, so the merged
 * (callback-origin) bubble's CLI Output loses its stdout — only tools remain.
 * co-creator wants CLI Output behavior IDENTICAL whether or not there's a post_msg.
 *
 * Z11 initial fix kept Z8 merge and exposed cliStdout/speechContent. Runtime
 * evidence later showed this still violates the user's expected model:
 * post_message speech is its own bubble, while stream-origin CLI work logs stay
 * in the CLI bubble. Projection must therefore split callback-origin speech
 * records from stream-origin work-log records even when they share the same turn.
 */
import { describe, expect, it } from 'vitest';
import { projectCanonicalBubbles } from '../bubble-projection';
import type { ChatMessage } from '../chat-types';

describe('F194 Phase Z11 — projection keeps post_message speech separate from CLI work logs (AC-Z29)', () => {
  it('stream + callback same turn → two bubbles: CLI work log + post_message speech', () => {
    const parent = 'inv-z11-parent';
    const turn = 'turn-z11';
    const records: ChatMessage[] = [
      {
        id: 'rec-stream',
        type: 'assistant',
        catId: 'opus',
        content: 'Confirmed — branch at 47c91e45c, single fix commit',
        timestamp: 1000,
        origin: 'stream',
        isStreaming: true,
        toolEvents: [{ id: 't1', type: 'tool_use', label: 'bash', timestamp: 1000 }],
        extra: { stream: { invocationId: parent, turnInvocationId: turn } },
      },
      {
        id: 'rec-callback',
        type: 'assistant',
        catId: 'opus',
        content: '@codex Review continuity confirmed to 47c91e45 — APPROVE.',
        timestamp: 2000,
        origin: 'callback',
        isStreaming: false,
        extra: { stream: { invocationId: parent, turnInvocationId: turn } },
      },
    ];

    const { messages } = projectCanonicalBubbles({ records });
    expect(messages).toHaveLength(2);
    const streamBubble = messages[0]!;
    const callbackBubble = messages[1]!;
    expect(streamBubble.origin).toBe('stream');
    expect(streamBubble.content).toBe('Confirmed — branch at 47c91e45c, single fix commit');
    expect(streamBubble.toolEvents?.length).toBe(1);
    expect(streamBubble.extra?.stream?.cliStdout).toBeUndefined();
    expect(streamBubble.extra?.stream?.speechContent).toBeUndefined();
    expect(callbackBubble.origin).toBe('callback');
    expect(callbackBubble.content).toBe('@codex Review continuity confirmed to 47c91e45 — APPROVE.');
    expect(callbackBubble.toolEvents).toBeUndefined();
  });

  it('pure stream (no callback) → cliStdout/speechContent NOT set (rendering unchanged)', () => {
    const records: ChatMessage[] = [
      {
        id: 'rec-stream-only',
        type: 'assistant',
        catId: 'opus',
        content: '接球。先 runtime preflight + 看最近 commits',
        timestamp: 1000,
        origin: 'stream',
        isStreaming: false,
        toolEvents: [{ id: 't1', type: 'tool_use', label: 'bash', timestamp: 1000 }],
        extra: { stream: { invocationId: 'inv-pure-stream', turnInvocationId: 'turn-pure-stream' } },
      },
    ];
    const { messages } = projectCanonicalBubbles({ records });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.origin).toBe('stream');
    expect(messages[0]!.extra?.stream?.cliStdout).toBeUndefined();
    expect(messages[0]!.extra?.stream?.speechContent).toBeUndefined();
  });

  it('pure callback (no stream) → cliStdout/speechContent NOT set', () => {
    const records: ChatMessage[] = [
      {
        id: 'rec-cb-only',
        type: 'assistant',
        catId: 'opus',
        content: 'standalone post_message speech',
        timestamp: 1000,
        origin: 'callback',
        isStreaming: false,
        extra: { stream: { invocationId: 'inv-cb', turnInvocationId: 'turn-cb' } },
      },
    ];
    const { messages } = projectCanonicalBubbles({ records });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.origin).toBe('callback');
    expect(messages[0]!.extra?.stream?.cliStdout).toBeUndefined();
    expect(messages[0]!.extra?.stream?.speechContent).toBeUndefined();
  });

  it('multiple stream records + callback → stream parts merge, callback remains separate', () => {
    const parent = 'inv-multi';
    const turn = 'turn-multi';
    const records: ChatMessage[] = [
      {
        id: 's1',
        type: 'assistant',
        catId: 'codex',
        content: 'first stream chunk',
        timestamp: 1000,
        origin: 'stream',
        extra: { stream: { invocationId: parent, turnInvocationId: turn } },
      },
      {
        id: 's2',
        type: 'assistant',
        catId: 'codex',
        content: 'second stream chunk',
        timestamp: 1500,
        origin: 'stream',
        extra: { stream: { invocationId: parent, turnInvocationId: turn } },
      },
      {
        id: 'cb',
        type: 'assistant',
        catId: 'codex',
        content: 'final speech',
        timestamp: 2000,
        origin: 'callback',
        extra: { stream: { invocationId: parent, turnInvocationId: turn } },
      },
    ];
    const { messages } = projectCanonicalBubbles({ records });
    expect(messages).toHaveLength(2);
    expect(messages[0]!.origin).toBe('stream');
    expect(messages[0]!.content).toBe('first stream chunk\n\nsecond stream chunk');
    expect(messages[1]!.origin).toBe('callback');
    expect(messages[1]!.content).toBe('final speech');
  });
});
