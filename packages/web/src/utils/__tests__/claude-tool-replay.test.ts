import { describe, expect, it } from 'vitest';
import { adaptTranscriptEvents } from '@/lib/story-player/adapter';

describe('native child tool result history replay', () => {
  it('pairs equal native IDs separately by invocation and parent tool scope', () => {
    const envelope = {
      v: 1,
      t: 100,
      threadId: 'thread',
      catId: 'opus',
      sessionId: 'session',
      cliSessionId: 'native',
      invocationId: 'invoke',
    };
    const raw = [
      { ...envelope, eventNo: 0, event: { type: 'tool_use', toolUseId: 'same', toolName: 'RootRead', toolInput: {} } },
      {
        ...envelope,
        eventNo: 1,
        event: { type: 'tool_use', toolUseId: 'same', toolParentUseId: 'parent', toolName: 'ChildRead', toolInput: {} },
      },
      {
        ...envelope,
        eventNo: 2,
        event: {
          type: 'tool_result',
          toolUseId: 'same',
          toolParentUseId: 'parent',
          content: 'child failure',
          toolResultStatus: 'error',
        },
      },
      {
        ...envelope,
        eventNo: 3,
        event: { type: 'tool_result', toolUseId: 'same', content: 'root success', toolResultStatus: 'ok' },
      },
      {
        ...envelope,
        invocationId: 'other-invocation',
        eventNo: 4,
        event: { type: 'tool_use', toolUseId: 'same', toolName: 'OtherRead', toolInput: {} },
      },
      {
        ...envelope,
        invocationId: 'other-invocation',
        eventNo: 5,
        event: { type: 'tool_result', toolUseId: 'same', content: 'other success', toolResultStatus: 'ok' },
      },
    ];
    const replay = adaptTranscriptEvents(raw);
    const calls = replay.filter((event) => event.type === 'tool_call');
    expect(calls).toHaveLength(3);
    expect(calls.map((event) => [event.toolName, event.toolResult, event.toolIsError])).toEqual([
      ['RootRead', 'root success', false],
      ['ChildRead', 'child failure', true],
      ['OtherRead', 'other success', false],
    ]);
  });
});
