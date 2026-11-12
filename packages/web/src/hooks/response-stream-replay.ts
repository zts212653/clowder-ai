import type { ResponseStreamReplay } from '@cat-cafe/shared';
import { createStore } from 'zustand/vanilla';
import { type ChatMessage, DEFAULT_THREAD_STATE } from '@/stores/chat-types';
import { type ChatState, chatStoreCreator, useChatStore } from '@/stores/chatStore';
import { nextLocalWriteSeq } from '@/stores/local-write-clock';
import { withStreamedBodyOf } from '@/stores/streamed-body';
import { namedTarget, streamTextWrite, touchStreamActivity } from './agent-messages/named-target';
import { applySemanticEvent, projectBodySystemInfo } from './agent-messages/system-info';
import type { SystemInfoPort } from './agent-messages/system-info-port';
import { isRecord } from './agent-messages/system-projections';
import { toolResultEvent, toolUseEvent } from './agent-messages/tool-events';
import type { AgentMsg } from './agent-messages/types';
import { finishNamedMessage, type NamedMessageStore, writeStreamText, writeToolEvent } from './named-message-writer';

/**
 * PR-3a2 (contract §3.11.1): a response still streaming when this page joined its thread room is
 * rebuilt from the server's replay of every event already broadcast into it. Live events that follow
 * on the same connection then append to a body that holds everything before them.
 *
 * The replay is a projection write only: the body is rebuilt in a detached copy of the chat store by
 * the very writers live events use (so the result is what the page would hold had it been subscribed
 * all along) and committed in one write. Nothing else a live event does happens here — no unread
 * count, no cat status, no system row, no done or error handling.
 */
export type StreamReplay = ResponseStreamReplay<AgentMsg>;

/** A replay waiting in the agent-message queue, kept in order with the live events around it. */
export class StreamReplayItem {
  /**
   * @param runningAtConfirmation the responses the page showed as running when it accepted this
   *   join. Only they can be missing from the replay; a response the page first saw after that
   *   acknowledgement (e.g. through the user room while the replay waited in the queue) was admitted
   *   after the server took the replay.
   */
  constructor(
    readonly replay: StreamReplay,
    readonly runningAtConfirmation?: ReadonlySet<string>,
  ) {}
}

/** The detached store keeps the replayed thread off its "current thread" slot. */
const DETACHED_CURRENT_THREAD = '__response-stream-replay__';

function isCommittedResponse(message: ChatMessage): boolean {
  return message.lifecycle?.kind === 'response' && message.lifecycle.status !== 'processing';
}

/** A response this page shows as still running: processing, or a stream copy not yet hydrated. */
export function isRunningResponse(message: ChatMessage): boolean {
  if (message.lifecycle) return message.lifecycle.kind === 'response' && message.lifecycle.status === 'processing';
  return message.type === 'assistant' && message.origin === 'stream' && message.isStreaming === true;
}

/** The page's copy without what the stream writes (text, tools, thinking, streamed blocks). */
function withoutStreamedBody(message: ChatMessage): ChatMessage {
  const copy: ChatMessage = { ...message, content: '' };
  delete copy.toolEvents;
  delete copy.thinking;
  delete copy.thinkingChunks;
  // The replay vouches for the whole prefix: an earlier verdict must not block its own rebuild.
  delete copy.streamPrefix;
  delete copy.streamNextIndex;
  if (message.extra?.rich) copy.extra = { ...message.extra, rich: undefined };
  return copy;
}

/**
 * Marks a rebuilt copy: the whole stream up to `nextIndex` held, nothing left for a recovery read to
 * decide. A body write of the server's state at the join: a History read issued earlier cannot take
 * it back.
 */
function rebuiltCopy(message: ChatMessage, nextIndex: number): ChatMessage {
  const copy: ChatMessage = {
    ...message,
    streamPrefix: 'complete',
    streamNextIndex: nextIndex,
    localBodyWriteSeq: nextLocalWriteSeq(),
  };
  delete copy.cachedFrom;
  delete copy.recoveryGeneration;
  return copy;
}

function replayPort(threadId: string, event: AgentMsg, index: number, store: () => NamedMessageStore): SystemInfoPort {
  const none = () => {};
  return {
    path: 'background',
    threadId,
    store,
    resolveCatName: (catId) => catId,
    createdAt: event.timestamp ?? Date.now(),
    newId: (kind) => `replay-${kind}-${event.messageId}-${index}`,
    catInvocation: () => undefined,
    setCatStatus: none,
    setCatInvocation: none,
    rows: () => [],
    addRow: none,
    patchRow: none,
    removeRow: none,
  };
}

/** One replayed event, written the way the live handlers write its body (status effects left out). */
function projectReplayedEvent(event: AgentMsg, threadId: string, index: number, store: () => NamedMessageStore) {
  const port = replayPort(threadId, event, index, store);
  if (event.semanticEvent && applySemanticEvent(event, port)) return;
  const target = namedTarget(event, threadId);
  if (!target) return;
  switch (event.type) {
    case 'text':
      if (!event.content || event.origin === 'callback') return;
      writeStreamText(target, streamTextWrite(event), store);
      touchStreamActivity(store(), threadId, target.messageId);
      if (event.isFinal) finishNamedMessage(target, store);
      return;
    case 'tool_use':
    case 'tool_result': {
      const kind = event.type === 'tool_use' ? 'use' : 'result';
      const base = {
        id: event.toolEventId ?? `replay-tool-${kind}-${event.messageId}-${index}`,
        executionRef: event.toolExecutionRef,
        toolUseId: event.toolUseId,
        catId: event.catId,
        toolInput: event.toolInput,
        timestamp: event.timestamp ?? Date.now(),
      };
      const toolEvent =
        event.type === 'tool_use'
          ? toolUseEvent({ ...base, toolName: event.toolName })
          : toolResultEvent({ ...base, content: event.content });
      writeToolEvent(target, toolEvent, store);
      touchStreamActivity(store(), threadId, target.messageId);
      return;
    }
    case 'system_info': {
      if (!event.content) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.content);
      } catch {
        return;
      }
      if (isRecord(parsed)) projectBodySystemInfo(parsed, event, port);
      return;
    }
    default:
      return;
  }
}

/** Rebuild one response from its replayed events, starting from the page's copy without its body. */
function* rebuildResponse(
  threadId: string,
  messageId: string,
  base: ChatMessage | undefined,
  events: readonly AgentMsg[],
): Generator<void, ChatMessage | undefined, unknown> {
  const detached = createStore<ChatState>()(chatStoreCreator);
  detached.setState({
    currentThreadId: DETACHED_CURRENT_THREAD,
    threadStates: { [threadId]: { ...DEFAULT_THREAD_STATE, messages: base ? [withoutStreamedBody(base)] : [] } },
  });
  const store = () => detached.getState();
  for (const [index, event] of events.entries()) {
    // The record is contiguous from the response's first broadcast; its next position is the server's.
    projectReplayedEvent({ ...event, threadId, messageId }, threadId, index, store);
    yield;
  }
  return store()
    .getThreadState(threadId)
    .messages.find((message) => message.id === messageId);
}

/** A response this page has not seen and cannot rebuild: shown once History brings its draft. */
function incompletePlaceholder(entry: StreamReplay['responses'][number]): ChatMessage | undefined {
  if (!entry.catId) return undefined;
  return {
    id: entry.messageId,
    type: 'assistant',
    from: { kind: 'agent', catId: entry.catId },
    catId: entry.catId,
    content: '',
    origin: 'stream',
    isStreaming: true,
    timestamp: entry.timestamp,
    streamPrefix: 'incomplete',
  };
}

/**
 * Apply a replay accepted together with its join. A response already committed on this page is left
 * alone (the terminal always wins, checked before anything is cleared). A response the server cannot
 * vouch for, and a response this page shows as processing that the replay does not carry (e.g. one
 * still running across a server restart), are marked incomplete.
 */
export function* iterateResponseStreamReplay(
  replay: StreamReplay,
  live: () => ChatState = useChatStore.getState,
  runningAtConfirmation?: ReadonlySet<string>,
): Generator<void, void, unknown> {
  const { threadId } = replay;
  const current = live().getThreadState(threadId).messages;
  const byId = new Map(current.map((message) => [message.id, message]));
  const next = new Map<string, ChatMessage>();
  const replayed = new Set<string>();

  for (const entry of replay.responses) {
    replayed.add(entry.messageId);
    const local = byId.get(entry.messageId);
    if (local && isCommittedResponse(local)) continue;
    if (!entry.complete) {
      if (local) next.set(local.id, { ...local, streamPrefix: 'incomplete' });
      else {
        const placeholder = incompletePlaceholder(entry);
        if (placeholder) next.set(entry.messageId, placeholder);
      }
      continue;
    }
    const rebuilt = yield* rebuildResponse(threadId, entry.messageId, local, entry.events);
    if (!rebuilt) continue;
    next.set(entry.messageId, rebuilt);
  }

  // History and lifecycle snapshots can land while the detached rebuild yields. Recheck and commit
  // together: terminal snapshots win, newly arrived rows survive, and a deleted row stays deleted.
  const latest = live().getThreadState(threadId).messages;
  const entries = new Map(replay.responses.map((entry) => [entry.messageId, entry]));
  const present = new Set(latest.map((message) => message.id));
  let changed = false;
  const messages = latest.map((message) => {
    if (isCommittedResponse(message)) return message;
    const replacement = next.get(message.id);
    if (replacement) {
      changed = true;
      const entry = entries.get(message.id)!;
      if (!entry.complete) return { ...message, streamPrefix: 'incomplete' as const };
      const rebased =
        message === byId.get(message.id)
          ? replacement
          : withStreamedBodyOf(
              {
                ...replacement,
                ...message,
                extra: { ...replacement.extra, ...message.extra },
                metadata: message.metadata ?? replacement.metadata,
              },
              replacement,
            );
      return rebuiltCopy(rebased, entry.nextIndex);
    }
    if (replayed.has(message.id) || !isRunningResponse(message) || message.streamPrefix === 'incomplete')
      return message;
    if (runningAtConfirmation && !runningAtConfirmation.has(message.id)) return message;
    changed = true;
    return { ...message, streamPrefix: 'incomplete' as const };
  });
  for (const [id, replacement] of next) {
    if (present.has(id) || byId.has(id)) continue;
    changed = true;
    const entry = entries.get(id)!;
    messages.push(entry.complete ? rebuiltCopy(replacement, entry.nextIndex) : replacement);
  }
  if (changed) live().replaceThreadMessages(threadId, messages);
}

/** Synchronous compatibility projection. The socket hot path must use the queued iterator. */
export function applyResponseStreamReplay(
  replay: StreamReplay,
  live: () => ChatState = useChatStore.getState,
  runningAtConfirmation?: ReadonlySet<string>,
): void {
  const steps = iterateResponseStreamReplay(replay, live, runningAtConfirmation);
  while (!steps.next().done) {
    // Non-interactive callers explicitly drain the same projection without browser scheduling.
  }
}
