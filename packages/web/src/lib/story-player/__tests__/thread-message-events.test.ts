import { describe, expect, it } from 'vitest';
import type { ChatMessage, ToolEvent } from '@/stores/chat-types';
import { adaptTranscriptEvents } from '../adapter';
import { buildReplayChatMessages } from '../replay-chat-bridge';
import {
  chatMessagesToTranscriptEvents,
  isSupplementalTranscriptEvent,
  mergeHubMessagesWithTranscriptSupplements,
} from '../thread-message-events';
import type { RawTranscriptEvent } from '../types';

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    type: 'user',
    content: 'hello',
    timestamp: 1000,
    ...overrides,
  };
}

function raw(overrides: Partial<RawTranscriptEvent> = {}): RawTranscriptEvent {
  return {
    v: 1,
    t: 1000,
    threadId: 'thread-1',
    catId: 'opus',
    sessionId: 'session-1',
    cliSessionId: 'cli-1',
    eventNo: 0,
    event: { type: 'text', content: 'opus transcript only' },
    ...overrides,
  };
}

describe('chatMessagesToTranscriptEvents', () => {
  it('preserves the real Hub participants instead of replaying only one cat session', () => {
    const events = chatMessagesToTranscriptEvents(
      [
        message({ id: 'u-1', type: 'user', content: '我呢？', timestamp: 1000 }),
        message({ id: 'o-1', type: 'assistant', catId: 'opus', content: '我先看一下。', timestamp: 1100 }),
        message({ id: 'c-1', type: 'assistant', catId: 'codex', content: '我来修。', timestamp: 1200 }),
      ],
      'thread-1',
    );

    const replayMessages = buildReplayChatMessages(adaptTranscriptEvents(events));

    expect(replayMessages).toHaveLength(3);
    expect(replayMessages.map((item) => item.type)).toEqual(['user', 'assistant', 'assistant']);
    expect(replayMessages.map((item) => item.catId)).toEqual([undefined, 'opus', 'codex']);
    expect(replayMessages.map((item) => item.content)).toEqual(['我呢？', '我先看一下。', '我来修。']);
  });

  it('expands a Hub assistant bubble with thinking and tool events into one replay bubble', () => {
    const events = chatMessagesToTranscriptEvents(
      [
        message({
          id: 'a-1',
          type: 'assistant',
          catId: 'codex',
          content: '修好了。',
          timestamp: 2000,
          thinking: 'Need a root-cause fix.',
          extra: { stream: { invocationId: 'parent-1', turnInvocationId: 'turn-1' } },
          toolEvents: [
            { id: 'tool-1', type: 'tool_use', label: 'Bash', detail: '{"cmd":"pnpm test"}', timestamp: 2010 },
            { id: 'tool-1', type: 'tool_result', label: 'Bash', detail: 'tests passed', timestamp: 2020 },
          ],
        }),
      ],
      'thread-1',
    );

    const replayMessages = buildReplayChatMessages(adaptTranscriptEvents(events));

    expect(replayMessages).toHaveLength(1);
    expect(replayMessages[0]).toMatchObject({
      type: 'assistant',
      catId: 'codex',
      invocationId: 'turn-1',
      content: '修好了。',
      thinking: 'Need a root-cause fix.',
    });
    expect(replayMessages[0]?.toolEvents).toEqual([
      expect.objectContaining({
        name: 'Bash',
        input: '{"cmd":"pnpm test"}',
        output: 'tests passed',
      }),
    ]);
  });

  it('pairs Hub tool results by native toolUseId instead of UI event ids', () => {
    const toolUse: ToolEvent = {
      id: 'tool-ui-1',
      type: 'tool_use',
      label: 'Bash',
      detail: '{"cmd":"pnpm test"}',
      timestamp: 2010,
      toolUseId: 'toolu-native-1',
    };
    const toolResult: ToolEvent = {
      id: 'tool-result-ui-1',
      type: 'tool_result',
      label: 'Bash',
      detail: 'tests passed',
      timestamp: 2020,
      toolUseId: 'toolu-native-1',
    };

    const events = chatMessagesToTranscriptEvents(
      [
        message({
          id: 'a-1',
          type: 'assistant',
          catId: 'codex',
          content: '修好了。',
          timestamp: 2000,
          extra: { stream: { invocationId: 'parent-1', turnInvocationId: 'turn-1' } },
          toolEvents: [toolUse, toolResult],
        }),
      ],
      'thread-1',
    );

    const replayMessages = buildReplayChatMessages(adaptTranscriptEvents(events));

    expect(replayMessages).toHaveLength(1);
    expect(replayMessages[0]?.toolEvents).toEqual([
      expect.objectContaining({
        id: 'tool_1',
        name: 'Bash',
        input: '{"cmd":"pnpm test"}',
        output: 'tests passed',
      }),
    ]);
  });

  it('pairs UI-only Hub tool rows positionally when native toolUseId is absent', () => {
    const toolUse: ToolEvent = {
      id: 'tool-ui-1',
      type: 'tool_use',
      label: 'Bash',
      detail: '{"cmd":"pnpm test"}',
      timestamp: 2010,
    };
    const toolResult: ToolEvent = {
      id: 'tool-result-ui-1',
      type: 'tool_result',
      label: 'Bash',
      detail: 'tests passed',
      timestamp: 2020,
    };

    const events = chatMessagesToTranscriptEvents(
      [
        message({
          id: 'a-1',
          type: 'assistant',
          catId: 'codex',
          content: '修好了。',
          timestamp: 2000,
          extra: { stream: { invocationId: 'parent-1', turnInvocationId: 'turn-1' } },
          toolEvents: [toolUse, toolResult],
        }),
      ],
      'thread-1',
    );

    const replayMessages = buildReplayChatMessages(adaptTranscriptEvents(events));

    expect(replayMessages).toHaveLength(1);
    expect(replayMessages[0]?.toolEvents).toEqual([
      expect.objectContaining({
        name: 'Bash',
        input: '{"cmd":"pnpm test"}',
        output: 'tests passed',
      }),
    ]);
  });

  it('keeps consecutive same-cat Hub bubbles separate when stream ids are absent', () => {
    const events = chatMessagesToTranscriptEvents(
      [
        message({ id: 'callback-1', type: 'assistant', catId: 'opus', content: 'first callback', timestamp: 1000 }),
        message({ id: 'callback-2', type: 'assistant', catId: 'opus', content: 'second callback', timestamp: 1100 }),
      ],
      'thread-1',
    );

    const replayMessages = buildReplayChatMessages(adaptTranscriptEvents(events));

    expect(replayMessages).toHaveLength(2);
    expect(replayMessages.map((item) => item.invocationId)).toEqual([
      'hub-message:callback-1',
      'hub-message:callback-2',
    ]);
    expect(replayMessages.map((item) => item.content)).toEqual(['first callback', 'second callback']);
  });

  it('keeps explicit post bubbles separate even when they share stream ids', () => {
    const events = chatMessagesToTranscriptEvents(
      [
        message({
          id: 'post-1',
          type: 'assistant',
          catId: 'opus',
          content: 'first post',
          timestamp: 1000,
          extra: { isExplicitPost: true, stream: { invocationId: 'parent-1', turnInvocationId: 'turn-1' } },
        }),
        message({
          id: 'post-2',
          type: 'assistant',
          catId: 'opus',
          content: 'second post',
          timestamp: 1100,
          extra: { isExplicitPost: true, stream: { invocationId: 'parent-1', turnInvocationId: 'turn-1' } },
        }),
      ],
      'thread-1',
    );

    const replayMessages = buildReplayChatMessages(adaptTranscriptEvents(events));

    expect(replayMessages).toHaveLength(2);
    expect(replayMessages.map((item) => item.invocationId)).toEqual(['hub-message:post-1', 'hub-message:post-2']);
    expect(replayMessages.map((item) => item.content)).toEqual(['first post', 'second post']);
  });

  it('propagates Hub tool result error status into replay tool events', () => {
    const toolUse: ToolEvent = {
      id: 'tool-ui-1',
      type: 'tool_use',
      label: 'Bash',
      detail: '{"cmd":"pnpm test"}',
      timestamp: 2010,
      toolUseId: 'toolu-native-1',
    };
    const toolResult: ToolEvent = {
      id: 'tool-result-ui-1',
      type: 'tool_result',
      label: 'Bash',
      detail: 'tests failed',
      timestamp: 2020,
      toolUseId: 'toolu-native-1',
      status: 'error',
    };

    const events = chatMessagesToTranscriptEvents(
      [
        message({
          id: 'a-1',
          type: 'assistant',
          catId: 'codex',
          content: '测试失败。',
          timestamp: 2000,
          extra: { stream: { invocationId: 'parent-1', turnInvocationId: 'turn-1' } },
          toolEvents: [toolUse, toolResult],
        }),
      ],
      'thread-1',
    );

    const replayMessages = buildReplayChatMessages(adaptTranscriptEvents(events));

    expect(replayMessages).toHaveLength(1);
    expect(replayMessages[0]?.toolEvents).toEqual([
      expect.objectContaining({
        status: 'error',
        isError: true,
        output: 'tests failed',
      }),
    ]);
  });

  it('keeps stream-origin Hub content out of assistant speech and exposes it as CLI stdout', () => {
    const events = chatMessagesToTranscriptEvents(
      [
        message({
          id: 'stream-1',
          type: 'assistant',
          catId: 'codex',
          content: 'internal stdout that live chat renders in CLI Output',
          timestamp: 2000,
          origin: 'stream',
          extra: { stream: { invocationId: 'parent-1', turnInvocationId: 'turn-1' } },
          toolEvents: [
            { id: 'tool-1', type: 'tool_use', label: 'Bash', detail: '{"cmd":"pnpm test"}', timestamp: 2010 },
            { id: 'tool-1', type: 'tool_result', label: 'Bash', detail: 'tests passed', timestamp: 2020 },
          ],
        }),
      ],
      'thread-1',
    );

    const replayMessages = buildReplayChatMessages(adaptTranscriptEvents(events));

    expect(replayMessages).toHaveLength(1);
    expect(replayMessages[0]).toMatchObject({
      type: 'assistant',
      catId: 'codex',
      invocationId: 'turn-1',
      content: '',
      cliStdout: 'internal stdout that live chat renders in CLI Output',
    });
    expect(replayMessages[0]?.toolEvents).toHaveLength(1);
  });

  it('keeps callback speech separate from stream-origin CLI stdout when they share stream ids', () => {
    const events = chatMessagesToTranscriptEvents(
      [
        message({
          id: 'stream-worklog',
          type: 'assistant',
          catId: 'codex',
          content: 'internal stdout from the running invocation',
          timestamp: 1000,
          origin: 'stream',
          extra: { stream: { invocationId: 'parent-1', turnInvocationId: 'turn-1' } },
        }),
        message({
          id: 'callback-speech',
          type: 'assistant',
          catId: 'codex',
          content: 'visible callback speech',
          timestamp: 1010,
          origin: 'callback',
          extra: { stream: { invocationId: 'parent-1', turnInvocationId: 'turn-1' } },
        }),
      ],
      'thread-1',
    );

    const replayMessages = buildReplayChatMessages(adaptTranscriptEvents(events));

    expect(replayMessages).toHaveLength(2);
    expect(replayMessages[0]).toMatchObject({
      type: 'assistant',
      catId: 'codex',
      invocationId: 'turn-1',
      content: '',
      cliStdout: 'internal stdout from the running invocation',
    });
    expect(replayMessages[1]).toMatchObject({
      type: 'assistant',
      catId: 'codex',
      invocationId: 'hub-message:callback-speech',
      content: 'visible callback speech',
    });
  });

  it('keeps one Hub bubble grouped when later tool timestamps cross another participant message', () => {
    const events = chatMessagesToTranscriptEvents(
      [
        message({
          id: 'assistant-with-tool',
          type: 'assistant',
          catId: 'codex',
          content: '我先跑一下测试。',
          timestamp: 1000,
          extra: { stream: { invocationId: 'parent-1', turnInvocationId: 'turn-1' } },
          toolEvents: [
            { id: 'tool-1', type: 'tool_use', label: 'Bash', detail: '{"cmd":"pnpm test"}', timestamp: 3000 },
            { id: 'tool-1', type: 'tool_result', label: 'Bash', detail: 'tests passed', timestamp: 3010 },
          ],
        }),
        message({ id: 'user-mid', type: 'user', content: '中途插一句。', timestamp: 2000 }),
      ],
      'thread-1',
    );

    const replayMessages = buildReplayChatMessages(adaptTranscriptEvents(events));

    expect(replayMessages).toHaveLength(2);
    expect(replayMessages[0]).toMatchObject({
      type: 'assistant',
      catId: 'codex',
      invocationId: 'turn-1',
      content: '我先跑一下测试。',
    });
    expect(replayMessages[0]?.toolEvents).toEqual([
      expect.objectContaining({
        name: 'Bash',
        input: '{"cmd":"pnpm test"}',
        output: 'tests passed',
      }),
    ]);
    expect(replayMessages[1]).toMatchObject({ type: 'user', content: '中途插一句。' });
  });

  it('uses deliveredAt for projection ordering before grouping stream records', () => {
    const events = chatMessagesToTranscriptEvents(
      [
        message({
          id: 'assistant-stream-start',
          type: 'assistant',
          catId: 'codex',
          content: 'stdout chunk 1',
          timestamp: 1000,
          origin: 'stream',
          extra: { stream: { invocationId: 'parent-1', turnInvocationId: 'turn-1' } },
        }),
        message({
          id: 'queued-user',
          type: 'user',
          content: 'late delivered user message',
          timestamp: 1500,
          deliveredAt: 4000,
        }),
        message({
          id: 'other-cat',
          type: 'assistant',
          catId: 'opus',
          content: 'another participant between chunks',
          timestamp: 2500,
        }),
        message({
          id: 'assistant-stream-end',
          type: 'assistant',
          catId: 'codex',
          content: 'stdout chunk 2',
          timestamp: 3000,
          origin: 'stream',
          extra: { stream: { invocationId: 'parent-1', turnInvocationId: 'turn-1' } },
        }),
      ],
      'thread-1',
    );

    const replayMessages = buildReplayChatMessages(adaptTranscriptEvents(events));

    expect(replayMessages).toHaveLength(3);
    expect(replayMessages[0]).toMatchObject({
      type: 'assistant',
      catId: 'codex',
      invocationId: 'turn-1',
      cliStdout: 'stdout chunk 1\n\nstdout chunk 2',
    });
    expect(replayMessages[1]).toMatchObject({
      type: 'assistant',
      catId: 'opus',
      content: 'another participant between chunks',
    });
    expect(replayMessages[2]).toMatchObject({
      type: 'user',
      content: 'late delivered user message',
      timestamp: 4000,
    });
  });
});

describe('mergeHubMessagesWithTranscriptSupplements', () => {
  it('uses Hub messages as the primary narrative and keeps only supplemental transcript notices', () => {
    const merged = mergeHubMessagesWithTranscriptSupplements(
      [message({ id: 'u-1', type: 'user', content: '真实用户消息', timestamp: 1000 })],
      [
        raw({ t: 900, eventNo: 0, event: { type: 'session_init', content: 'started' } }),
        raw({ t: 1100, eventNo: 1, event: { type: 'text', content: 'duplicate assistant transcript' } }),
        raw({ t: 1200, eventNo: 2, event: { type: 'system_info', content: '{"type":"session_seal_requested"}' } }),
      ],
      'thread-1',
    );

    expect(merged.map((event) => event.t)).toEqual([900, 1000, 1200]);
    expect(merged.map((event) => event.eventNo)).toEqual([0, 1, 2]);
    expect(merged.map((event) => event.event.type)).toEqual(['session_init', 'user', 'system_info']);
  });

  it('does not treat transcript speech/tool events as supplemental when Hub messages exist', () => {
    expect(isSupplementalTranscriptEvent(raw({ event: { type: 'text', content: 'assistant' } }))).toBe(false);
    expect(isSupplementalTranscriptEvent(raw({ event: { type: 'assistant', content: 'assistant' } }))).toBe(false);
    expect(isSupplementalTranscriptEvent(raw({ event: { type: 'tool_use', toolName: 'Bash' } }))).toBe(false);
    expect(isSupplementalTranscriptEvent(raw({ event: { type: 'tool_result', content: 'ok' } }))).toBe(false);
    expect(isSupplementalTranscriptEvent(raw({ event: { type: 'thinking', content: 'hmm' } }))).toBe(false);
    expect(isSupplementalTranscriptEvent(raw({ event: { type: 'system_info', content: '{}' } }))).toBe(true);
  });

  it('does not duplicate transcript thinking encoded as system_info when Hub thinking exists', () => {
    const merged = mergeHubMessagesWithTranscriptSupplements(
      [
        message({
          id: 'a-1',
          type: 'assistant',
          catId: 'codex',
          content: '我来修。',
          thinking: 'Need a root-cause fix.',
          timestamp: 1000,
        }),
      ],
      [raw({ t: 1001, eventNo: 1, event: { type: 'system_info', content: '{"type":"thinking","content":"dup"}' } })],
      'thread-1',
    );

    expect(merged.map((event) => event.event.type)).toEqual(['assistant', 'thinking']);
  });
});
