import { describe, expect, it } from 'vitest';
import { buildReplayChatMessages } from '../replay-chat-bridge';
import type { ReplayEvent } from '../types';

function makeEvent(overrides: Partial<ReplayEvent> & { type: ReplayEvent['type'] }): ReplayEvent {
  return {
    index: 0,
    timestamp: 1000,
    role: 'assistant',
    content: '',
    eventNo: 0,
    ...overrides,
  };
}

describe('buildReplayChatMessages', () => {
  it('coalesces same-invocation assistant text, thinking, and tool calls into one bubble', () => {
    const events: ReplayEvent[] = [
      makeEvent({
        type: 'message',
        role: 'assistant',
        content: '我先看一下。',
        catId: 'opus',
        invocationId: 'inv-1',
        index: 0,
        timestamp: 1000,
      }),
      makeEvent({
        type: 'tool_call',
        catId: 'opus',
        invocationId: 'inv-1',
        index: 1,
        timestamp: 1100,
        toolName: 'Bash',
        toolInput: '{"cmd":"pwd"}',
        toolResult: '/repo',
      }),
      makeEvent({
        type: 'thinking',
        content: 'Need inspect output',
        catId: 'opus',
        invocationId: 'inv-1',
        index: 2,
        timestamp: 1200,
      }),
      makeEvent({
        type: 'message',
        role: 'assistant',
        content: '找到了。',
        catId: 'opus',
        invocationId: 'inv-1',
        index: 3,
        timestamp: 1300,
      }),
    ];

    const result = buildReplayChatMessages(events);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'replay_0',
      type: 'assistant',
      catId: 'opus',
      invocationId: 'inv-1',
      content: '我先看一下。\n\n找到了。',
      thinking: 'Need inspect output',
    });
    expect(result[0]?.toolEvents).toHaveLength(1);
    expect(result[0]?.toolEvents?.[0]).toMatchObject({
      id: 'tool_1',
      name: 'Bash',
      output: '/repo',
    });
  });

  it('does not merge assistant bubbles across user turns', () => {
    const events: ReplayEvent[] = [
      makeEvent({
        type: 'message',
        role: 'assistant',
        content: 'first',
        catId: 'opus',
        invocationId: 'inv-1',
        index: 0,
      }),
      makeEvent({
        type: 'message',
        role: 'user',
        content: 'interrupt',
        index: 1,
      }),
      makeEvent({
        type: 'message',
        role: 'assistant',
        content: 'second',
        catId: 'opus',
        invocationId: 'inv-1',
        index: 2,
      }),
    ];

    const result = buildReplayChatMessages(events);

    expect(result.map((msg) => msg.content)).toEqual(['first', 'interrupt', 'second']);
    expect(result.map((msg) => msg.type)).toEqual(['assistant', 'user', 'assistant']);
  });

  it('does not merge assistant bubbles across invocation boundaries', () => {
    const result = buildReplayChatMessages([
      makeEvent({
        type: 'message',
        role: 'assistant',
        content: 'first',
        catId: 'opus',
        invocationId: 'inv-1',
        index: 0,
      }),
      makeEvent({
        type: 'message',
        role: 'assistant',
        content: 'second',
        catId: 'opus',
        invocationId: 'inv-2',
        index: 1,
      }),
    ]);

    expect(result.map((msg) => msg.content)).toEqual(['first', 'second']);
    expect(result.map((msg) => msg.id)).toEqual(['replay_0', 'replay_1']);
  });

  it('drops empty system separators but still treats them as assistant-turn boundaries', () => {
    const events: ReplayEvent[] = [
      makeEvent({
        type: 'message',
        role: 'assistant',
        content: 'before',
        catId: 'opus',
        invocationId: 'inv-1',
        index: 0,
      }),
      makeEvent({
        type: 'system',
        role: 'system',
        content: '',
        index: 1,
      }),
      makeEvent({
        type: 'message',
        role: 'assistant',
        content: 'after',
        catId: 'opus',
        invocationId: 'inv-1',
        index: 2,
      }),
    ];

    const result = buildReplayChatMessages(events);

    expect(result.map((msg) => msg.content)).toEqual(['before', 'after']);
    expect(result.map((msg) => msg.id)).toEqual(['replay_0', 'replay_2']);
  });
});
