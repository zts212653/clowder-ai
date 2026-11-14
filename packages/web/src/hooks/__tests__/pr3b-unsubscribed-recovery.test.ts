/**
 * PR-3b (#6718 R1, Astra): returning to a thread whose room the page left while work still ran.
 * Astra's R1 traces, unchanged in scenario and expectation, now taken through the path the page
 * actually runs since PR-3a2: leaving the room on the way out; on the way back the server's replay
 * and the join confirmation (which opens a recovery round), then the History read issued after it.
 *
 * Stream positions come from the production record table, deletes from the production MessageStore,
 * live events through the production open-thread entry, History through the production merge.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { beginThreadRecovery, currentRecoveryGeneration } from '@/stores/thread-recovery';
import { markAllThreadRoomsLost } from '@/stores/thread-room-presence';
import { MessageStore } from '../../../../api/dist/domains/cats/services/stores/ports/MessageStore.js';
import { ResponseStreamRecords } from '../../../../api/dist/infrastructure/websocket/ResponseStreamRecords.js';
import { handleActiveAgentMessage } from '../agent-messages/active-handler';
import { writeStoredSnapshot } from '../named-message-writer';
import { applyResponseStreamReplay, isRunningResponse, type StreamReplay } from '../response-stream-replay';
import { issueReplaceRead, mergeReplaceHydrationMessages } from '../useChatHistory';
import { createStreamReplayRelay } from '../useSocket-stream-replay';

const T = 'pr3b-running-bg';
const ROOM = `thread:${T}`;

function response(content: string): ChatMessage {
  return {
    id: 'r',
    type: 'assistant',
    catId: 'opus',
    origin: 'stream',
    timestamp: 100,
    content,
    isStreaming: true,
    extra: { stream: { invocationId: 'parent', turnInvocationId: 'turn' } },
    lifecycle: {
      kind: 'response',
      orderKey: '100:turn',
      invocationId: 'turn',
      targetId: 'opus',
      inputEntryIds: [],
      inputMessageIds: [],
      status: 'processing',
      startedAt: 100,
    },
  } as ChatMessage;
}

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

function recordedStream(): Recorder {
  const records = new ResponseStreamRecords() as unknown as Recorder;
  records.open({ ...response(''), threadId: T, userId: 'owner', from: { kind: 'agent', catId: 'opus' }, mentions: [] });
  return records;
}

type ServerEvent = Record<string, unknown> & { type: string };
const text = (content: string): ServerEvent => ({
  type: 'text',
  catId: 'opus',
  messageId: 'r',
  invocationId: 'parent',
  turnInvocationId: 'turn',
  timestamp: 101,
  content,
});

/** What the server sends to a socket joining the room, before the acknowledgement. */
function serverReplay(records: Recorder, joinId: string): StreamReplay {
  return {
    threadId: T,
    joinId,
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

/** The relay as useSocket wires it; the agent-message queue is drained at once. */
function pageRelay() {
  return createStreamReplayRelay({
    runningResponses: (threadId) =>
      new Set(
        useChatStore
          .getState()
          .getThreadState(threadId)
          .messages.filter(isRunningResponse)
          .map((message) => message.id),
      ),
    enqueue: (item) => applyResponseStreamReplay(item.replay, undefined, item.runningAtConfirmation),
    beginRecovery: (threadId) => beginThreadRecovery(threadId),
    requestCatchUp: () => {},
  });
}

type Relay = ReturnType<typeof pageRelay>;

/** Join the room: the server's replay, then its acknowledgement (first confirmation of this period). */
function join(relay: Relay, records: Recorder | undefined, joinId: string) {
  if (records) relay.received(serverReplay(records, joinId));
  relay.confirmed(ROOM, { joinId, firstInNeededPeriod: true });
}

/** PR-3b: a thread out of the foreground leaves its room, work running or not. */
function leave(relay: Relay) {
  useChatStore.getState().setCurrentThread('other');
  relay.left(T);
}

/** One live event of the open thread, numbered by the server as it is broadcast. */
function live(records: Recorder, event: ServerEvent) {
  const streamIndex = records.record(event, T);
  const state = useChatStore.getState();
  handleActiveAgentMessage({ ...event, threadId: T, ...(streamIndex === undefined ? {} : { streamIndex }) } as never, {
    actions: state,
    rows: {
      rows: () => useChatStore.getState().messages,
      addRow: state.addMessage,
      patchRow: state.patchMessage,
      removeRow: state.removeMessage,
    },
    resolveCatName: (catId: string) => catId,
    timeoutDiagnostics: { set: () => {}, take: () => null },
  });
}

function land(issue: ReturnType<typeof issueReplaceRead>, history: ChatMessage[]) {
  const merged = mergeReplaceHydrationMessages(history, useChatStore.getState().getThreadState(T).messages, {
    ...issue,
    landedInGeneration: currentRecoveryGeneration(T),
  });
  useChatStore.getState().replaceThreadMessages(T, merged.messages);
}

beforeEach(() => {
  markAllThreadRoomsLost();
  useChatStore.setState({
    currentThreadId: T,
    messages: [],
    threadStates: {},
    catInvocations: {},
    activeInvocations: {},
  });
});

describe('Astra #6718 R1: returning to a still-running thread whose room the page left', () => {
  for (const [middle, tail] of [
    ['MISSED-MIDDLE|', 'C|'],
    ['B|', 'LONG-NEW-LIVE-TAIL|'],
  ]) {
    it(`holds A, ${middle} and ${tail} exactly once`, () => {
      const relay = pageRelay();
      const records = recordedStream();
      writeStoredSnapshot(T, response(''));
      join(relay, records, 'join-1');
      live(records, text('A|'));
      useChatStore.getState().setThreadHasActiveInvocation(T, true);

      leave(relay);
      records.record(text(middle), T); // broadcast to the room this page has left

      useChatStore.getState().setCurrentThread(T);
      join(relay, records, 'join-2');
      const issue = issueReplaceRead(T); // the catch-up read issued after the confirmation
      live(records, text(tail)); // arrives before that read lands
      land(issue, [response(`A|${middle}`)]); // the server's draft at the read

      const messages = useChatStore.getState().getThreadState(T).messages;
      expect(messages).toHaveLength(1);
      expect(messages[0]?.content).toBe(`A|${middle}${tail}`);
    });
  }

  it('does not revive a message deleted while the page was out of the room', () => {
    const relay = pageRelay();
    const server = new MessageStore();
    const saved = server.append({
      threadId: T,
      userId: 'owner',
      from: { kind: 'agent', catId: 'opus' },
      content: 'deleted content',
      mentions: [],
      timestamp: 100,
      origin: 'callback',
    });
    join(relay, undefined, 'join-1');
    useChatStore.getState().addMessageToThread(T, { ...saved, type: 'assistant' } as ChatMessage);
    useChatStore.getState().setThreadHasActiveInvocation(T, true);

    leave(relay);
    server.softDelete(saved.id, 'owner'); // its room event never reaches this page

    useChatStore.getState().setCurrentThread(T);
    join(relay, undefined, 'join-2');
    const issue = issueReplaceRead(T);
    const history = server.getByThread(T, 100, 'owner');
    expect(history).toEqual([]);
    land(issue, history as unknown as ChatMessage[]);

    expect(
      useChatStore
        .getState()
        .getThreadState(T)
        .messages.map((message) => message.id),
    ).toEqual([]);
  });
});
