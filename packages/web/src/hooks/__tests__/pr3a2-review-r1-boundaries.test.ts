/**
 * PR-3a2 #6727 R1 (Astra): combined recovery boundaries, traced through the production writers,
 * replay, relay, coalescer and History merge; deletes go through the real API MessageStore. The
 * first group is Astra's probes ported onto the production read issue/land timing.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage, RichBlock } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { beginThreadRecovery, currentRecoveryGeneration } from '@/stores/thread-recovery';
import { markAllThreadRoomsLost, markThreadRoomLive } from '@/stores/thread-room-presence';
import { MessageStore } from '../../../../api/dist/domains/cats/services/stores/ports/MessageStore.js';
import { ResponseStreamRecords } from '../../../../api/dist/infrastructure/websocket/ResponseStreamRecords.js';
import { handleActiveAgentMessage } from '../agent-messages/active-handler';
import { handleBackgroundAgentMessage } from '../agent-messages/background-handler';
import type { BackgroundAgentMessage } from '../agent-messages/types';
import { writePostRichBlock, writeStoredSnapshot, writeStreamText } from '../named-message-writer';
import { applyResponseStreamReplay, isRunningResponse, type StreamReplay } from '../response-stream-replay';
import { issueReplaceRead, mergeReplaceHydrationMessages } from '../useChatHistory';
import { createAgentMessageCoalescer } from '../useSocket-message-coalescer';
import { createStreamReplayRelay, dispatchAgentQueueItem } from '../useSocket-stream-replay';

const T = 'pr3a2-r1-thread';

function response(content: string, status: 'processing' | 'completed' = 'processing'): ChatMessage {
  return {
    id: 'r',
    type: 'assistant',
    catId: 'opus',
    origin: 'stream',
    timestamp: 100,
    content,
    isStreaming: status === 'processing',
    extra: { stream: { invocationId: 'parent', turnInvocationId: 'turn' } },
    lifecycle: {
      kind: 'response',
      orderKey: '100:turn',
      invocationId: 'turn',
      targetId: 'opus',
      inputEntryIds: [],
      inputMessageIds: [],
      status,
      startedAt: 100,
      ...(status === 'processing' ? {} : { completedAt: 200 }),
    },
  } as ChatMessage;
}

const target = { threadId: T, messageId: 'r', catId: 'opus', invocationId: 'parent', turnInvocationId: 'turn' };

function textEvent(content: string) {
  return { type: 'text', catId: 'opus', messageId: 'r', content, invocationId: 'parent', timestamp: 100 } as const;
}

function replay(events: readonly Record<string, unknown>[], complete = true): StreamReplay {
  return {
    threadId: T,
    joinId: 'join-1',
    responses: [
      {
        messageId: 'r',
        catId: 'opus',
        timestamp: 100,
        events: events as unknown as StreamReplay['responses'][0]['events'],
        complete,
        nextIndex: events.length,
      },
    ],
  };
}

const noResponses = (): StreamReplay => ({ threadId: T, joinId: 'join-1', responses: [] });

function statusOf(message: ChatMessage | undefined): string | undefined {
  return message?.lifecycle?.kind === 'response' ? message.lifecycle.status : undefined;
}

function shown(id = 'r'): ChatMessage | undefined {
  return useChatStore
    .getState()
    .getThreadState(T)
    .messages.find((message) => message.id === id);
}

/** A replace read issued now, landed later exactly as `performFetchHistory` lands it. */
function issueRead() {
  const issue = issueReplaceRead(T);
  return (history: ChatMessage[]) => {
    const merged = mergeReplaceHydrationMessages(history, useChatStore.getState().getThreadState(T).messages, {
      ...issue,
      landedInGeneration: currentRecoveryGeneration(T),
    });
    useChatStore.getState().replaceThreadMessages(T, merged.messages);
    return merged.messages;
  };
}

function relayInto(queue: { push(item: unknown): void }) {
  return createStreamReplayRelay({
    runningResponses: (threadId) =>
      new Set(
        useChatStore
          .getState()
          .getThreadState(threadId)
          .messages.filter(isRunningResponse)
          .map((message) => message.id),
      ),
    enqueue: (item) => queue.push(item),
    beginRecovery: (threadId) => beginThreadRecovery(threadId),
    requestCatchUp: () => {},
  });
}

/** A live agent event of R through the production background entry. */
function live(event: Record<string, unknown>) {
  handleBackgroundAgentMessage(
    {
      catId: 'opus',
      messageId: 'r',
      invocationId: 'parent',
      turnInvocationId: 'turn',
      timestamp: 101,
      ...event,
      threadId: T,
    } as unknown as BackgroundAgentMessage,
    { store: useChatStore.getState(), nextBgSeq: () => 1, addToast: () => {} },
  );
}

async function drain() {
  for (let tick = 0; tick < 10; tick++) await Promise.resolve();
}

beforeEach(() => {
  markAllThreadRoomsLost();
  useChatStore.setState({ currentThreadId: 'elsewhere', messages: [], threadStates: {} });
});

describe('Astra R1 probes', () => {
  for (const missing of [false, true]) {
    it(`retains incomplete protection after the first confirmed recovery read (missing record=${missing})`, () => {
      writeStoredSnapshot(T, response('A|'));
      beginThreadRecovery(T);
      applyResponseStreamReplay(missing ? noResponses() : replay([], false));
      const land = issueRead();
      writeStreamText(target, { content: 'C|' });
      land([response('A|B|')]);
      writeStreamText(target, { content: 'D|' });
      expect({ content: shown()?.content, prefix: shown()?.streamPrefix }).toEqual({
        content: 'A|B|',
        prefix: 'incomplete',
      });
    });
  }

  it('rebuilds a formerly incomplete response when a later join supplies a complete prefix', () => {
    writeStoredSnapshot(T, response('A|'));
    applyResponseStreamReplay(noResponses());
    expect(shown()?.streamPrefix).toBe('incomplete');
    applyResponseStreamReplay(replay([textEvent('A|B|')]));
    writeStreamText(target, { content: 'C|' });
    expect(shown()?.content).toBe('A|B|C|');
  });

  it('preserves a terminal that arrived after the recovery read was taken', () => {
    writeStoredSnapshot(T, response('A|'));
    beginThreadRecovery(T);
    applyResponseStreamReplay(replay([], false));
    const land = issueRead();
    writeStoredSnapshot(T, response('FINAL', 'completed'));
    land([response('A|')]);
    expect({ content: shown()?.content, status: statusOf(shown()) }).toEqual({ content: 'FINAL', status: 'completed' });
  });

  it('keeps the body of a response first admitted after confirmation over a stale draft', () => {
    beginThreadRecovery(T);
    applyResponseStreamReplay(noResponses());
    writeStoredSnapshot(T, response(''));
    writeStreamText(target, { content: 'A LONG DRAFT' });
    const land = issueRead();
    writeStreamText(target, { content: 'X', textMode: 'replace' });
    land([response('A LONG DRAFT')]);
    expect(shown()?.content).toBe('X');
  });

  it('does not resurrect a message an HTTP read issued before confirmation brought in', () => {
    const server = new MessageStore();
    const saved = server.append({
      threadId: T,
      userId: 'owner',
      from: { kind: 'agent', catId: 'opus' },
      content: 'deleted body',
      mentions: [],
      timestamp: 100,
      origin: 'callback',
    });
    const captured = server
      .getByThread(T, 100, 'owner')
      .map((message) => ({ ...message, type: 'assistant' })) as unknown as ChatMessage[];
    const landOld = issueRead();
    server.softDelete(saved.id, 'owner');
    beginThreadRecovery(T);
    landOld(captured);
    issueRead()(server.getByThread(T, 100, 'owner') as unknown as ChatMessage[]);
    expect(shown(saved.id)).toBeUndefined();
  });

  it('keeps a card update received after the deciding read was issued', () => {
    const block = { id: 'b', kind: 'card', v: 1, title: 'old' } as unknown as RichBlock;
    const old = {
      id: 'post',
      type: 'assistant',
      catId: 'opus',
      content: 'post',
      timestamp: 100,
      origin: 'callback',
      extra: { rich: { v: 1, blocks: [block] } },
    } as ChatMessage;
    useChatStore.getState().addMessageToThread(T, old);
    beginThreadRecovery(T);
    const land = issueRead();
    writePostRichBlock({ threadId: T, messageId: 'post' }, { ...block, title: 'new authoritative card' } as RichBlock);
    land([old]);
    expect(shown('post')?.extra?.rich?.blocks?.[0]).toEqual({ ...block, title: 'new authoritative card' });
    expect(shown('post')?.cachedFrom).toBeUndefined();
  });

  it('does not judge a response admitted after the ack by a replay still in the queue', async () => {
    const queue = createAgentMessageCoalescer((item) =>
      dispatchAgentQueueItem<Record<string, unknown>>(item, (message) => live(message)),
    );
    const relay = relayInto(queue);
    relay.received(noResponses());
    relay.confirmed(`thread:${T}`, { joinId: 'join-1', firstInNeededPeriod: true });
    // Lifecycle snapshots reach the store directly, not through the agent-message queue.
    writeStoredSnapshot(T, response(''));
    // Admitted after the server took the replay: its first broadcast is position 0.
    queue.push({ type: 'text', content: 'A|B|', streamIndex: 0 });
    await drain();
    expect(shown()?.content).toBe('A|B|');
  });
});

describe('stream position decides whether the page holds a reply from its start', () => {
  function liveRoom() {
    const queue = createAgentMessageCoalescer((item) => dispatchAgentQueueItem(item, () => {}));
    const relay = relayInto(queue);
    relay.received(noResponses());
    relay.confirmed(`thread:${T}`, { joinId: 'join-1', firstInNeededPeriod: true });
    return { relay, drain };
  }
  const text = (content: string, streamIndex?: number, extra: Record<string, unknown> = {}) =>
    live({ type: 'text', content, ...(streamIndex === undefined ? {} : { streamIndex }), ...extra });

  it('holds a reply whose empty row History showed first, once its first broadcast arrives (Astra R2)', async () => {
    const room = liveRoom();
    await room.drain();
    // R is stored before QueueProcessor finishes its awaits and emits the admission snapshot.
    useChatStore.getState().replaceThreadMessages(T, [response('')]);
    writeStoredSnapshot(T, response(''));
    text('A LONG OLD DRAFT', 0);
    text('X', 1, { textMode: 'replace' });
    // Issued after X: the throttled draft it returns still lags behind the live body.
    issueRead()([response('A LONG OLD DRAFT')]);
    expect({ content: shown()?.content, prefix: shown()?.streamPrefix }).toEqual({ content: 'X', prefix: 'complete' });
  });

  it('rebuilds from position 0 over a draft the page showed of the same stream', async () => {
    const room = liveRoom();
    await room.drain();
    useChatStore.getState().replaceThreadMessages(T, [response('A|')]);
    text('A|', 0);
    text('B|', 1);
    expect(shown()?.content).toBe('A|B|');
  });

  it('skips positions it holds and stops splicing after a gap', async () => {
    const room = liveRoom();
    await room.drain();
    text('A|', 0);
    text('A|', 0);
    text('B|', 1);
    expect({ content: shown()?.content, next: shown()?.streamNextIndex }).toEqual({ content: 'A|B|', next: 2 });
    text('D|', 3);
    expect({ content: shown()?.content, prefix: shown()?.streamPrefix }).toEqual({
      content: 'A|B|',
      prefix: 'incomplete',
    });
  });

  it('cannot hold a reply first seen mid-stream', async () => {
    const room = liveRoom();
    await room.drain();
    text('mid-reply|', 5, { messageId: 'r2' });
    expect(shown('r2')).toMatchObject({ content: '', streamPrefix: 'incomplete' });
    text('more|', 6, { messageId: 'r2' });
    expect(shown('r2')?.content).toBe('');
  });

  it('marks a reply no record vouches for incomplete on its first unrecorded event', async () => {
    const room = liveRoom();
    await room.drain();
    // Brought by History (e.g. a reply running across a server restart), so nothing vouches for it.
    useChatStore.getState().replaceThreadMessages(T, [response('draft|')]);
    text('mid|');
    expect({ content: shown()?.content, prefix: shown()?.streamPrefix }).toEqual({
      content: 'draft|',
      prefix: 'incomplete',
    });
  });

  it('does not take an unnumbered status event for a missing stream position', async () => {
    const room = liveRoom();
    await room.drain();
    useChatStore.getState().replaceThreadMessages(T, [response('')]);
    live({ type: 'status', content: 'streaming' });
    text('A|', 0);
    expect({ content: shown()?.content, prefix: shown()?.streamPrefix }).toEqual({ content: 'A|', prefix: 'complete' });
  });

  it('continues a replayed reply at the position the replay named', async () => {
    const queue = createAgentMessageCoalescer((item) => dispatchAgentQueueItem(item, () => {}));
    const relay = relayInto(queue);
    writeStoredSnapshot(T, response('A|'));
    relay.received({
      ...replay([textEvent('A|B|'), textEvent('C|')]),
      responses: [{ ...replay([textEvent('A|B|'), textEvent('C|')]).responses[0]!, nextIndex: 3 }],
    });
    relay.confirmed(`thread:${T}`, { joinId: 'join-1', firstInNeededPeriod: true });
    await drain();
    text('C|', 2);
    text('D|', 3);
    expect({ content: shown()?.content, next: shown()?.streamNextIndex }).toEqual({ content: 'A|B|C|D|', next: 4 });
  });

  it('leaves the earlier behaviour for a server that sends no replay', () => {
    const queue = createAgentMessageCoalescer((item) => dispatchAgentQueueItem(item, () => {}));
    relayInto(queue).confirmed(`thread:${T}`, { firstInNeededPeriod: false });
    text('A|');
    text('B|');
    expect({ content: shown()?.content, prefix: shown()?.streamPrefix }).toEqual({
      content: 'A|B|',
      prefix: undefined,
    });
  });

  it('no longer treats unrecorded events as gaps once the page left the room', async () => {
    const room = liveRoom();
    await room.drain();
    room.relay.left(T);
    text('A|');
    expect({ content: shown()?.content, prefix: shown()?.streamPrefix }).toEqual({ content: 'A|', prefix: undefined });
  });
});

describe('Astra R3: every numbered event crosses one position, drawn or not', () => {
  /** The production record table, seen through the shapes this test hands it. */
  type Recorder = {
    open(response: unknown): void;
    record(event: unknown, threadId: string): number | undefined;
    forThread(threadId: string): Array<{
      response: { id: string; catId: string | null; timestamp: number };
      events: unknown[];
      complete: boolean;
      nextIndex: number;
    }>;
  };
  function recordedStream() {
    const records = new ResponseStreamRecords() as unknown as Recorder;
    records.open({
      ...response(''),
      threadId: T,
      userId: 'owner',
      from: { kind: 'agent', catId: 'opus' },
      mentions: [],
    });
    return records;
  }
  type ServerEvent = Record<string, unknown> & { type: string };
  /** The server's numbering, delivered through the production entry exactly as broadcast. */
  function broadcast(records: Recorder, event: ServerEvent) {
    const streamIndex = records.record(event, T);
    live({ ...event, ...(streamIndex === undefined ? {} : { streamIndex }) });
  }
  const text = (content: string): ServerEvent => ({ ...textEvent(content) });
  const info = (payload: unknown): ServerEvent => ({ ...textEvent(JSON.stringify(payload)), type: 'system_info' });
  const usage = () =>
    info({ type: 'invocation_usage', provider: 'test', model: 'model', usage: { inputTokens: 1, outputTokens: 1 } });
  function serverReplay(records: Recorder): StreamReplay {
    return {
      threadId: T,
      joinId: 'join-1',
      responses: records.forThread(T).map((entry) => ({
        messageId: entry.response.id,
        catId: entry.response.catId,
        timestamp: entry.response.timestamp,
        events: entry.events as unknown as StreamReplay['responses'][0]['events'],
        complete: entry.complete,
        nextIndex: entry.nextIndex,
      })),
    };
  }

  it('keeps contiguous live text across a numbered metadata-only event', () => {
    const records = recordedStream();
    markThreadRoomLive(T, true);
    writeStoredSnapshot(T, response(''));
    broadcast(records, text('A|'));
    broadcast(records, usage());
    broadcast(records, text('B|'));
    expect({ content: shown()?.content, prefix: shown()?.streamPrefix, next: shown()?.streamNextIndex }).toEqual({
      content: 'A|B|',
      prefix: 'complete',
      next: 3,
    });
  });

  it('rebuilds every text event across numbered metadata, then appends the next real position', () => {
    const records = recordedStream();
    records.record(text('A|'), T);
    records.record(usage(), T);
    records.record(text('B|'), T);
    markThreadRoomLive(T, true);
    applyResponseStreamReplay(serverReplay(records));
    broadcast(records, text('C|'));
    expect(shown()?.content).toBe('A|B|C|');
  });

  it('does not take a numbered non-body system row before the first text for a missing prefix', () => {
    const records = recordedStream();
    markThreadRoomLive(T, true);
    writeStoredSnapshot(T, response(''));
    broadcast(records, info({ type: 'session_seal_requested', catId: 'opus', sessionSeq: 1 }));
    broadcast(records, text('A|'));
    expect({ content: shown()?.content, prefix: shown()?.streamPrefix, next: shown()?.streamNextIndex }).toEqual({
      content: 'A|',
      prefix: 'complete',
      next: 2,
    });
  });

  it('control: advances positions for text, tool and thinking body projections', () => {
    const records = recordedStream();
    markThreadRoomLive(T, true);
    writeStoredSnapshot(T, response(''));
    broadcast(records, text('A|'));
    broadcast(records, { ...text(''), type: 'tool_use', toolName: 'Read', toolEventId: 'u' });
    broadcast(records, info({ type: 'thinking', text: 'thinking' }));
    broadcast(records, text('B|'));
    expect({ content: shown()?.content, prefix: shown()?.streamPrefix, next: shown()?.streamNextIndex }).toEqual({
      content: 'A|B|',
      prefix: 'complete',
      next: 4,
    });
  });

  it('crosses the same positions on the open thread as in the background', () => {
    const records = recordedStream();
    markThreadRoomLive(T, true);
    useChatStore.getState().setCurrentThread(T);
    writeStoredSnapshot(T, response(''));
    const state = useChatStore.getState();
    const ctx = {
      actions: state,
      rows: {
        rows: () => useChatStore.getState().messages,
        addRow: state.addMessage,
        patchRow: state.patchMessage,
        removeRow: state.removeMessage,
      },
      resolveCatName: (catId: string) => catId,
      timeoutDiagnostics: { set: () => {}, take: () => null },
    };
    const open = (event: ServerEvent) => {
      const streamIndex = records.record(event, T);
      handleActiveAgentMessage(
        {
          catId: 'opus',
          messageId: 'r',
          invocationId: 'parent',
          turnInvocationId: 'turn',
          timestamp: 101,
          ...event,
          threadId: T,
          ...(streamIndex === undefined ? {} : { streamIndex }),
        } as never,
        ctx,
      );
    };
    open(text('A|'));
    open(usage());
    open(text('B|'));
    expect({ content: shown()?.content, prefix: shown()?.streamPrefix, next: shown()?.streamNextIndex }).toEqual({
      content: 'A|B|',
      prefix: 'complete',
      next: 3,
    });
  });

  it('crosses one position per event through every system_info branch and a semantic early return', () => {
    const records = recordedStream();
    markThreadRoomLive(T, true);
    writeStoredSnapshot(T, response(''));
    broadcast(records, info({ type: 'web_search', count: 1 }));
    broadcast(records, info({ type: 'silent_completion' }));
    broadcast(records, info({ type: 'liveness_warning', level: 'warn', state: 'idle', silenceDurationMs: 1 }));
    broadcast(records, info({ type: 'a-future-protocol-payload' }));
    broadcast(records, { ...textEvent('plain system text'), type: 'system_info' });
    broadcast(records, text('A|'));
    expect({ content: shown()?.content, prefix: shown()?.streamPrefix, next: shown()?.streamNextIndex }).toEqual({
      content: 'A|',
      prefix: 'complete',
      next: 6,
    });
  });
});

describe('Astra R2: a write proves only the part it changed', () => {
  function backgroundText(content: string) {
    handleBackgroundAgentMessage(
      {
        type: 'text',
        catId: 'opus',
        threadId: T,
        messageId: 'r',
        content,
        timestamp: 101,
        invocationId: 'parent',
        turnInvocationId: 'turn',
      },
      { store: useChatStore.getState(), nextBgSeq: () => 1, addToast: () => {} },
    );
  }

  it('refreshes an incomplete body from the draft even when a refused delta touched its activity', () => {
    writeStoredSnapshot(T, response('A|'));
    beginThreadRecovery(T);
    markThreadRoomLive(T, true);
    applyResponseStreamReplay(replay([], false));
    const land = issueRead();
    backgroundText('C|');
    expect(shown()?.content).toBe('A|');
    land([response('A|B|')]);
    expect({ content: shown()?.content, prefix: shown()?.streamPrefix }).toEqual({
      content: 'A|B|',
      prefix: 'incomplete',
    });
  });

  it('keeps metadata written after the read without letting it vouch for a stale body', () => {
    writeStoredSnapshot(T, response('old local body'));
    beginThreadRecovery(T);
    const land = issueRead();
    useChatStore.getState().setThreadMessageMetadata(T, 'r', { provider: 'test', model: 'new-model' });
    land([response('server corrected body')]);
    expect({ content: shown()?.content, model: shown()?.metadata?.model }).toEqual({
      content: 'server corrected body',
      model: 'new-model',
    });
  });

  it('keeps metadata written after the read on an unmarked copy too', () => {
    writeStoredSnapshot(T, response('body'));
    const land = issueRead();
    useChatStore.getState().setThreadMessageMetadata(T, 'r', { provider: 'test', model: 'new-model' });
    land([{ ...response('body'), metadata: { provider: 'test', model: 'old-model' } }]);
    expect(shown()?.metadata?.model).toBe('new-model');
  });
});
