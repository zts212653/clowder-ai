import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as renderability from '@/components/assistant-message-renderability';
import { hasAssistantBody } from '@/components/assistant-message-renderability';
import * as cli from '@/components/cli-output/toCliEvents';
import type { ChatMessage, ToolEvent } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import * as writer from '../named-message-writer';
import { type StreamReplay, StreamReplayItem } from '../response-stream-replay';
import { createAgentMessageCoalescer } from '../useSocket-message-coalescer';
import { dispatchAgentQueueItem } from '../useSocket-stream-replay';

const threadId = 'responsiveness';
const target = { threadId, messageId: 'r', catId: 'opus' };
let clock = 0;
const tasks: (() => void)[] = [];
const queues: ReturnType<typeof createAgentMessageCoalescer>[] = [];

function response(content = ''): ChatMessage {
  return {
    id: 'r',
    type: 'assistant',
    catId: 'opus',
    content,
    timestamp: 1,
    origin: 'stream',
    isStreaming: true,
    lifecycle: {
      kind: 'response',
      status: 'processing',
      orderKey: '1:turn',
      invocationId: 'turn',
      targetId: 'opus',
      inputEntryIds: [],
      inputMessageIds: [],
      startedAt: 1,
    },
  };
}

async function drain() {
  for (let tick = 0; tick < 100; tick++) await Promise.resolve();
}

async function finish() {
  while (tasks.length) {
    tasks.shift()?.();
    await drain();
  }
}

function queue(handler: Parameters<typeof createAgentMessageCoalescer>[0]) {
  const subject = createAgentMessageCoalescer(handler, (task) => tasks.push(task));
  queues.push(subject);
  return subject;
}

function replay(): StreamReplay {
  return {
    threadId,
    joinId: 'j',
    responses: [
      {
        messageId: 'r',
        catId: 'opus',
        timestamp: 1,
        complete: true,
        nextIndex: 80,
        events: Array.from({ length: 80 }, (_, index) => ({
          ...target,
          type: index % 2 === 0 ? 'tool_use' : 'tool_result',
          toolEventId: `e${index}`,
          toolUseId: `call-${Math.floor(index / 2)}`,
          toolName: 'Read',
          content: 'synthetic',
          timestamp: index + 2,
        })),
      },
    ],
  };
}

beforeEach(() => {
  clock = 0;
  tasks.length = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  useChatStore.setState({ currentThreadId: threadId, messages: [response()], threadStates: {}, deletedMessageIds: {} });
});

afterEach(() => {
  queues.splice(0).forEach((subject) => {
    subject.dispose();
  });
  vi.restoreAllMocks();
});

describe('issue #1968: bounded work without dropping or reordering messages', () => {
  it('checks visible tool bodies without materializing the CLI timeline', () => {
    const project = vi.spyOn(cli, 'toCliEvents');
    const tools: ToolEvent[] = Array.from({ length: 1000 }, (_, index) => ({
      id: `t${index}`,
      type: 'tool_use',
      label: 'opus → Read',
      timestamp: index,
    }));
    expect(hasAssistantBody({ ...response(), toolEvents: tools })).toBe(true);
    expect(project).not.toHaveBeenCalled();
  });

  it('skips current-thread body checks while counting the first background body once', () => {
    const bodyCheck = vi.spyOn(renderability, 'hasAssistantBody');
    writer.writeStreamText(target, { content: 'ACTIVE' });
    writer.writeStoredSnapshot(threadId, response('SNAPSHOT'));
    expect(bodyCheck).not.toHaveBeenCalled();
    useChatStore.setState({ currentThreadId: 'elsewhere', messages: [], threadStates: {} });
    writer.writeStoredSnapshot(threadId, response());
    writer.writeStreamText(target, { content: 'FIRST' });
    writer.writeStreamText(target, { content: 'SECOND' });
    expect(useChatStore.getState().getThreadState(threadId).unreadCount).toBe(1);
  });

  it('keeps hidden tools, orphan results, speech cache and explicit CLI overrides equivalent', () => {
    const tools: ToolEvent[] = [
      { id: 'u', type: 'tool_use', label: 'opus → unknown', timestamp: 1 },
      { id: 'r', type: 'tool_result', label: 'result', timestamp: 2 },
      { id: 'v', type: 'tool_use', label: 'opus → Read', timestamp: 3 },
    ];
    // Exhaust all length-four sequences, including consecutive unknown uses and orphan results.
    Array.from({ length: 81 }, (_, key) => key).forEach((key) => {
      const sequence = Array.from({ length: 4 }, (_, place) => tools[Math.floor(key / 3 ** place) % 3]);
      expect(hasAssistantBody({ ...response(), toolEvents: sequence })).toBe(
        cli.toCliEvents(sequence, undefined).length > 0,
      );
    });
    expect(hasAssistantBody({ ...response(), toolEvents: [tools[2]] }, { hasCliBlock: false })).toBe(false);
    expect(
      hasAssistantBody({ ...response(), extra: { stream: { cliStdout: '', speechContent: 'CACHED SPEECH' } } }),
    ).toBe(true);
  });

  it('gives another browser task a turn before draining an expensive burst', async () => {
    const received: number[] = [];
    const subject = queue((item) => {
      received.push(item as number);
      clock += 2;
    });
    Array.from({ length: 80 }, (_, index) => subject.push(index));
    await drain();
    expect(received.length).toBeGreaterThan(0);
    expect(received.length).toBeLessThan(80);
    expect(tasks).toHaveLength(1);
    subject.push(80);
    expect(tasks).toHaveLength(1);
    await finish();
    expect(received).toEqual(Array.from({ length: 81 }, (_, index) => index));
  });

  it('steps inside one replay and keeps following live writes behind it', async () => {
    const originalWrite = writer.writeToolEvent;
    const writes = vi.spyOn(writer, 'writeToolEvent').mockImplementation((...args) => {
      clock += 2;
      originalWrite(...args);
    });
    const live = vi.fn(() => writer.writeStreamText(target, { content: 'LIVE' }));
    const subject = queue((item) => dispatchAgentQueueItem(item, live));
    subject.push('before');
    subject.push(new StreamReplayItem(replay()));
    subject.push('after');
    await drain();
    expect(writes.mock.calls.length).toBeGreaterThan(0);
    expect(writes.mock.calls.length).toBeLessThan(80);
    expect(live).toHaveBeenCalledTimes(1);
    subject.push('arrived-while-suspended');
    await finish();
    const shown = useChatStore.getState().getThreadState(threadId).messages[0];
    expect(shown.toolEvents).toHaveLength(80);
    expect(shown.content).toBe('LIVELIVE');
    expect(live).toHaveBeenCalledTimes(3);
  });

  it('preserves terminal snapshots and unrelated messages received while replay yields', async () => {
    const originalWrite = writer.writeToolEvent;
    vi.spyOn(writer, 'writeToolEvent').mockImplementation((...args) => {
      clock += 2;
      originalWrite(...args);
    });
    const subject = queue((item) => dispatchAgentQueueItem(item, () => {}));
    subject.push(new StreamReplayItem(replay()));
    await drain();
    expect(tasks.length).toBeGreaterThan(0);
    const terminal = response('SERVER FINAL');
    if (terminal.lifecycle?.kind === 'response')
      terminal.lifecycle = { ...terminal.lifecycle, status: 'completed', completedAt: 10 };
    writer.writeStoredSnapshot(threadId, terminal);
    useChatStore.getState().addMessageToThread(threadId, { id: 'new', type: 'user', content: 'NEW', timestamp: 10 });
    await finish();
    const messages = useChatStore.getState().getThreadState(threadId).messages;
    expect(messages.map((message) => message.id)).toEqual(['r', 'new']);
    expect(messages[0].content).toBe('SERVER FINAL');
    expect(messages[0].lifecycle).toMatchObject({ kind: 'response', status: 'completed' });
  });

  it('cancels a suspended replay without committing its detached body', async () => {
    const originalWrite = writer.writeToolEvent;
    vi.spyOn(writer, 'writeToolEvent').mockImplementation((...args) => {
      clock += 2;
      originalWrite(...args);
    });
    const subject = queue((item) => dispatchAgentQueueItem(item, () => {}));
    subject.push(new StreamReplayItem(replay()));
    await drain();
    expect(tasks.length).toBeGreaterThan(0);
    subject.dispose();
    await finish();
    expect(useChatStore.getState().getThreadState(threadId).messages[0].toolEvents).toBeUndefined();
  });

  it('merges a same-id History arrival once and keeps its newer metadata', async () => {
    useChatStore.setState({ messages: [] });
    const originalWrite = writer.writeToolEvent;
    vi.spyOn(writer, 'writeToolEvent').mockImplementation((...args) => {
      clock += 2;
      originalWrite(...args);
    });
    const subject = queue((item) => dispatchAgentQueueItem(item, () => {}));
    subject.push(new StreamReplayItem(replay()));
    await drain();
    expect(tasks.length).toBeGreaterThan(0);
    const draft = { ...response('STALE HISTORY'), metadata: { model: 'new-model', provider: 'new-provider' } };
    writer.writeStoredSnapshot(threadId, draft);
    await finish();
    const messages = useChatStore.getState().getThreadState(threadId).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].toolEvents).toHaveLength(80);
    expect(messages[0].content).toBe('');
    expect(messages[0].metadata).toEqual(draft.metadata);
  });

  it('does not resurrect a response removed while its replay is suspended', async () => {
    const originalWrite = writer.writeToolEvent;
    vi.spyOn(writer, 'writeToolEvent').mockImplementation((...args) => {
      clock += 2;
      originalWrite(...args);
    });
    const subject = queue((item) => dispatchAgentQueueItem(item, () => {}));
    subject.push(new StreamReplayItem(replay()));
    await drain();
    expect(tasks.length).toBeGreaterThan(0);
    useChatStore.getState().replaceThreadMessages(threadId, []);
    await finish();
    expect(useChatStore.getState().getThreadState(threadId).messages).toEqual([]);
  });

  it.each([
    'unseen',
    'hydrated-then-deleted',
    'existing-with-live-tail',
  ] as const)('keeps deletion authoritative during yielded replay: %s', async (scenario) => {
    useChatStore.setState({ messages: scenario === 'existing-with-live-tail' ? [response()] : [] });
    const originalWrite = writer.writeToolEvent;
    vi.spyOn(writer, 'writeToolEvent').mockImplementation((...args) => {
      clock += 2;
      originalWrite(...args);
    });
    const subject = queue((item) =>
      dispatchAgentQueueItem(item, () => writer.writeStreamText(target, { content: 'LIVE' })),
    );
    subject.push(new StreamReplayItem(replay()));
    await drain();
    expect(tasks.length).toBeGreaterThan(0);
    if (scenario === 'hydrated-then-deleted') writer.writeStoredSnapshot(threadId, response('HISTORY'));
    if (scenario === 'existing-with-live-tail') subject.push('LIVE');
    useChatStore.getState().removeThreadMessage(threadId, target.messageId);
    expect(
      useChatStore
        .getState()
        .getThreadState(threadId)
        .messages.map((message) => message.id),
    ).toEqual([]);
    await finish();
    expect(
      useChatStore
        .getState()
        .getThreadState(threadId)
        .messages.map((message) => message.id),
    ).toEqual([]);
  });

  it.each(['active', 'background'])('keeps stale writes deleted and permits explicit restore: %s', (view) => {
    if (view === 'background') useChatStore.getState().setCurrentThread('elsewhere');
    useChatStore.getState().removeThreadMessage(threadId, target.messageId);
    const terminal = response('FINAL');
    if (terminal.lifecycle?.kind === 'response')
      terminal.lifecycle = { ...terminal.lifecycle, status: 'completed', completedAt: 10 };
    writer.writeStoredSnapshot(threadId, terminal);
    expect(useChatStore.getState().getThreadState(threadId).messages).toEqual([]);
    useChatStore.getState().hydrateThread(threadId, [terminal], false);
    expect(useChatStore.getState().getThreadState(threadId).messages).toEqual([]);
    useChatStore.getState().replaceThreadMessages(threadId, [terminal]);
    expect(useChatStore.getState().getThreadState(threadId).messages).toEqual([]);
    writer.writeStreamText(target, { content: 'LATE' });
    expect(useChatStore.getState().getThreadState(threadId).messages).toEqual([]);
    expect(useChatStore.getState().getThreadState(threadId).unreadCount).toBe(0);

    writer.writeStreamText({ ...target, messageId: 'fresh' }, { content: 'NEW' });
    expect(
      useChatStore
        .getState()
        .getThreadState(threadId)
        .messages.map((message) => message.id),
    ).toEqual(['fresh']);
    expect(useChatStore.getState().getThreadState(threadId).unreadCount).toBe(view === 'background' ? 1 : 0);

    useChatStore.getState().clearThreadMessageDeletion(threadId, target.messageId);
    writer.writeStoredSnapshot(threadId, terminal);
    expect(
      useChatStore
        .getState()
        .getThreadState(threadId)
        .messages.map((message) => message.id),
    ).toEqual(['fresh', 'r']);
    expect(useChatStore.getState().getThreadState(threadId).messages[1].content).toBe('FINAL');
  });
});
