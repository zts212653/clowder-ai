import type { ChatMessage, ChatMessagePatch } from '@/stores/chat-types';
import { isThreadRoomReplaying } from '@/stores/thread-room-presence';
import type { AgentEventFields } from './agent-messages/types';
import type { NamedMessageStore } from './named-message-writer';

/**
 * PR-3a2 (#6727 R2/R3): whether the page holds a running reply's stream from its beginning, decided
 * once per event at the agent-message entry — before any branch draws, hides or ignores it.
 *
 * The server numbers every event it records into a response's stream (`streamIndex`, 0 = its first
 * broadcast since admission): text, tool events and every `system_info`, whether or not it changes
 * the body (usage, session seals and status payloads count too). So the position advances here, one
 * step per numbered event, and the body writers only project. A replay is not admitted here: its
 * record is contiguous from position 0, so its rebuild projects every event and takes the server's
 * `nextIndex` as the position (response-stream-replay.ts).
 *
 * - `start`: position 0 — the page will hold the stream from its beginning (a History draft it shows
 *   is the same stream and is rebuilt from here);
 * - `next`: the position the page expects;
 * - `held`: a position it already holds — the event is dropped whole;
 * - `gap`: positions missed, or a recordable event no record vouches for, of a reply the page has no
 *   verdict on, while its room's server records streams — incomplete from here;
 * - `legacy`: nothing to decide (an older server, or an unnumbered event of a reply already held).
 */
type Placement = 'start' | 'next' | 'held' | 'gap' | 'legacy';

/** Event types the server records into a response's stream (callback text is the post's own). */
function isRecordable(event: Pick<AgentEventFields, 'type' | 'origin'>): boolean {
  if (event.type === 'text') return event.origin !== 'callback';
  return event.type === 'tool_use' || event.type === 'tool_result' || event.type === 'system_info';
}

function placement(before: ChatMessage | undefined, event: AdmittedEvent, threadId: string): Placement {
  const index = event.streamIndex;
  if (index === undefined) {
    if (!isRecordable(event) || before?.streamPrefix) return 'legacy';
    return isThreadRoomReplaying(threadId) ? 'gap' : 'legacy';
  }
  const expected = before?.streamNextIndex;
  if (expected === undefined) return index === 0 ? 'start' : 'gap';
  if (index < expected) return 'held';
  return index === expected ? 'next' : 'gap';
}

type AdmittedEvent = Pick<AgentEventFields, 'type' | 'origin' | 'catId' | 'messageId' | 'streamIndex'> & {
  timestamp?: number;
  invocationId?: string;
  turnInvocationId?: string;
};

/** Records are created without the unread a new background message counts: the body writer counts it. */
type PositionStore = Pick<NamedMessageStore, 'getThreadState' | 'upsertLifecycleMessage' | 'patchThreadMessage'>;

function isCommittedResponse(message: ChatMessage | undefined): boolean {
  return message?.lifecycle?.kind === 'response' && message.lifecycle.status !== 'processing';
}

function newReply(event: AdmittedEvent, streamPrefix?: ChatMessage['streamPrefix']): ChatMessage {
  const parent = event.invocationId ?? event.turnInvocationId;
  const turn = event.turnInvocationId && event.turnInvocationId !== parent ? event.turnInvocationId : undefined;
  return {
    id: event.messageId!,
    type: 'assistant',
    from: { kind: 'agent', catId: event.catId },
    catId: event.catId,
    content: '',
    origin: 'stream',
    isStreaming: true,
    timestamp: event.timestamp ?? Date.now(),
    ...(parent ? { extra: { stream: { invocationId: parent, ...(turn ? { turnInvocationId: turn } : {}) } } } : {}),
    ...(streamPrefix ? { streamPrefix } : {}),
  };
}

/** The page's copy without what the stream writes, kept to rebuild it from position 0. */
function clearedStreamedBody(message: ChatMessage): ChatMessagePatch {
  return {
    content: '',
    toolEvents: undefined,
    thinking: undefined,
    thinkingChunks: undefined,
    ...(message.extra?.rich ? { extra: { ...message.extra, rich: undefined } } : {}),
  };
}

/**
 * Admit one agent event of `threadId` before it is handled. Returns false when the event is one the
 * page already holds and must not be handled again; otherwise the handler runs as usual (a reply
 * found incomplete here refuses its body writes on its own).
 */
export function admitStreamEvent(event: AdmittedEvent, threadId: string, store: () => PositionStore): boolean {
  if (!event.messageId) return true;
  const current = store();
  const before = current.getThreadState(threadId).messages.find((message) => message.id === event.messageId);
  if (isCommittedResponse(before) || before?.streamPrefix === 'incomplete') return true;
  const step = placement(before, event, threadId);
  if (step === 'held') return false;
  if (step === 'legacy') return true;
  if (step === 'gap') {
    if (before) current.patchThreadMessage(threadId, event.messageId, { streamPrefix: 'incomplete' });
    else current.upsertLifecycleMessage(threadId, newReply(event, 'incomplete'));
    return true;
  }
  if (!before) current.upsertLifecycleMessage(threadId, newReply(event));
  store().patchThreadMessage(threadId, event.messageId, {
    ...(step === 'start' && before ? clearedStreamedBody(before) : {}),
    ...(step === 'start' ? { streamPrefix: 'complete' as const } : {}),
    streamNextIndex: (event.streamIndex ?? 0) + 1,
  });
  return true;
}
