/**
 * PR-3a2 (#6727 R4, Astra): a complete stream prefix and `streamNextIndex` describe one prefix. A
 * processing copy from the server — the History draft, a lifecycle snapshot — has no stream position
 * and may be ahead of what the page has received, so it never fills or extends that body.
 *
 * Positions come from the production record table; events go through the production background
 * entry; History lands through the production merge. Each order is compared with the body of a page
 * that only received the live events.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage, RichBlock } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { currentRecoveryGeneration } from '@/stores/thread-recovery';
import { markAllThreadRoomsLost, markThreadRoomLive } from '@/stores/thread-room-presence';
import { ResponseStreamRecords } from '../../../../api/dist/infrastructure/websocket/ResponseStreamRecords.js';
import { handleBackgroundAgentMessage } from '../agent-messages/background-handler';
import type { BackgroundAgentMessage } from '../agent-messages/types';
import { writeStoredSnapshot } from '../named-message-writer';
import { issueReplaceRead, mergeReplaceHydrationMessages } from '../useChatHistory';

const T = 'pr3a2-r4-thread';

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

type ServerEvent = Record<string, unknown> & { type: string };
/** The production record table, seen through the shapes this test hands it. */
type Recorder = {
  open(response: unknown): void;
  record(event: unknown, threadId: string): number | undefined;
};

function recordedStream(): Recorder {
  const records = new ResponseStreamRecords() as unknown as Recorder;
  records.open({ ...response(''), threadId: T, userId: 'owner', from: { kind: 'agent', catId: 'opus' }, mentions: [] });
  return records;
}

const base = { catId: 'opus', messageId: 'r', invocationId: 'parent', turnInvocationId: 'turn', timestamp: 101 };
const text = (content: string): ServerEvent => ({ ...base, type: 'text', content });
const info = (payload: unknown): ServerEvent => ({ ...base, type: 'system_info', content: JSON.stringify(payload) });
const tool = (id: string): ServerEvent => ({
  ...base,
  type: 'tool_use',
  content: '',
  toolName: 'Read',
  toolEventId: id,
});
const thinking = (chunk: string) => info({ type: 'thinking', text: chunk });
const block = (id: string) => info({ type: 'rich_block', block: { id, kind: 'card', v: 1, title: id } as RichBlock });

/** One numbered event, delivered through the production background entry exactly as broadcast. */
function deliver(event: ServerEvent, streamIndex: number) {
  handleBackgroundAgentMessage({ ...event, threadId: T, streamIndex } as unknown as BackgroundAgentMessage, {
    store: useChatStore.getState(),
    nextBgSeq: () => 1,
    addToast: () => {},
  });
}

function shown(): ChatMessage {
  const message = useChatStore
    .getState()
    .getThreadState(T)
    .messages.find((candidate) => candidate.id === 'r');
  if (!message) throw new Error('response not shown');
  return message;
}

/** What the stream writes, plus the position it claims to hold. */
function body(message: ChatMessage) {
  return {
    content: message.content,
    tools: message.toolEvents?.map((event) => event.id) ?? [],
    thinking: message.thinking ?? '',
    blocks: message.extra?.rich?.blocks.map((entry) => entry.id) ?? [],
    prefix: message.streamPrefix,
    next: message.streamNextIndex,
  };
}

/** The server's processing draft of `message`: the same body, as History or a snapshot carries it. */
function draftOf(message: ChatMessage): ChatMessage {
  return {
    ...response(message.content),
    ...(message.toolEvents ? { toolEvents: message.toolEvents } : {}),
    ...(message.thinking ? { thinking: message.thinking } : {}),
    ...(message.extra?.rich ? { extra: { ...response('').extra, rich: message.extra.rich } } : {}),
  };
}

function reset() {
  markAllThreadRoomsLost();
  useChatStore.setState({ currentThreadId: 'elsewhere', messages: [], threadStates: {} });
  markThreadRoomLive(T, true);
  writeStoredSnapshot(T, response(''));
}

/** A page that received every event live and nothing else: the body each order must end with. */
function liveOnly(events: readonly ServerEvent[]): ChatMessage {
  reset();
  const records = recordedStream();
  for (const event of events) deliver(event, records.record(event, T)!);
  return shown();
}

function landRead(issue: ReturnType<typeof issueReplaceRead>, history: ChatMessage[]) {
  const merged = mergeReplaceHydrationMessages(history, useChatStore.getState().getThreadState(T).messages, {
    ...issue,
    landedInGeneration: currentRecoveryGeneration(T),
  });
  useChatStore.getState().replaceThreadMessages(T, merged.messages);
}

type Order = 'read issued first, HTTP ahead' | 'read issued later, HTTP ahead' | 'HTTP after' | 'snapshot ahead';

/**
 * Deliver `events`; the last one is recorded and sent by the server but reaches the page only after
 * the draft (which already contains it) lands, except in the 'HTTP after' control.
 */
function run(events: readonly ServerEvent[], draft: ChatMessage, order: Order): ChatMessage {
  reset();
  const records = recordedStream();
  const early = order === 'read issued first, HTTP ahead' || order === 'HTTP after' ? issueReplaceRead(T) : undefined;
  const held = events.at(-1)!;
  for (const event of events.slice(0, -1)) deliver(event, records.record(event, T)!);
  const late = order === 'read issued later, HTTP ahead' ? issueReplaceRead(T) : undefined;
  const heldIndex = records.record(held, T)!;
  if (order === 'HTTP after') {
    deliver(held, heldIndex);
    landRead(early!, [draft]);
    return shown();
  }
  if (order === 'snapshot ahead') writeStoredSnapshot(T, draft);
  else landRead((early ?? late)!, [draft]);
  deliver(held, heldIndex);
  return shown();
}

const ORDERS: Order[] = [
  'read issued first, HTTP ahead',
  'read issued later, HTTP ahead',
  'HTTP after',
  'snapshot ahead',
];

const SCENARIOS: Array<[string, ServerEvent[]]> = [
  ['text after a tool, into an empty text', [tool('t0'), text('B|')]],
  ['a tool after text', [text('A|'), tool('t1')]],
  ['thinking after text', [text('A|'), thinking('reasoning')]],
  ['a streamed block after text', [text('A|'), block('b1')]],
  ['text after text', [text('A|'), text('B|')]],
];

beforeEach(reset);

describe('Astra R4: a processing draft neither fills nor extends a complete prefix', () => {
  for (const [name, events] of SCENARIOS) {
    for (const order of ORDERS) {
      it(`${name} — ${order}`, () => {
        const expected = liveOnly(events);
        expect(body(expected).next).toBe(events.length);
        expect(body(run(events, draftOf(expected), order))).toEqual(body(expected));
      });
    }
  }

  it('still lets the terminal replace the prefix it holds', () => {
    const expected = liveOnly([text('A|'), tool('t1')]);
    const issue = issueReplaceRead(T);
    landRead(issue, [{ ...draftOf(expected), ...response('final', 'completed'), toolEvents: undefined }]);
    const lifecycle = shown().lifecycle;
    const status = lifecycle?.kind === 'response' ? lifecycle.status : undefined;
    expect({ content: shown().content, tools: shown().toolEvents, status }).toEqual({
      content: 'final',
      tools: undefined,
      status: 'completed',
    });
  });

  it('keeps metadata the read brings to a prefix it does not touch', () => {
    const expected = liveOnly([text('A|')]);
    landRead(issueReplaceRead(T), [{ ...draftOf(expected), content: 'A|B|', metadata: { provider: 'p', model: 'm' } }]);
    expect({ content: shown().content, model: shown().metadata?.model }).toEqual({ content: 'A|', model: 'm' });
  });
});
