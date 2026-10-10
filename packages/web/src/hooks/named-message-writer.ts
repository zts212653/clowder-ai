import type { ReplyPreview, RichBlock } from '@cat-cafe/shared';
import { hasAssistantBody } from '@/components/assistant-message-renderability';
import type { ServedModelFacts } from '@/lib/served-model-facts';
import type { ChatMessage, ChatMessageMetadata, TimeoutDiagnostics, TokenUsage, ToolEvent } from '@/stores/chat-types';
import { type ChatState, useChatStore } from '@/stores/chatStore';

/**
 * Every event of a dispatched turn names the stored message it belongs to: the turn's
 * response, which the server stores empty at admission, or a post_message's own record.
 * The client writes each event into the message it names. It never invents a bubble id,
 * guesses which bubble is live, renames bubbles or merges them — the same path serves
 * the open thread and background threads.
 */
export type NamedMessageStore = Pick<
  ChatState,
  | 'currentThreadId'
  | 'getThreadState'
  | 'addMessageToThread'
  | 'appendToThreadMessage'
  | 'patchThreadMessage'
  | 'appendToolEventToThread'
  | 'setThreadMessageThinking'
  | 'appendRichBlockToThread'
  | 'setThreadMessageStreaming'
  | 'setThreadMessageMetadata'
  | 'setThreadMessageUsage'
  | 'incrementUnread'
  | 'upsertLifecycleMessage'
>;

export interface NamedMessageTarget {
  threadId: string;
  messageId: string;
  catId: string;
  timestamp?: number;
  /** Chain (parent) invocation id, kept on a record this client creates. */
  invocationId?: string;
  /** Per-cat turn id, kept on a record this client creates. */
  turnInvocationId?: string;
}

type StoreSource = () => NamedMessageStore;

const liveStore: StoreSource = () => useChatStore.getState();

function findNamed(store: NamedMessageStore, target: NamedMessageTarget): ChatMessage | undefined {
  return store.getThreadState(target.threadId).messages.find((message) => message.id === target.messageId);
}

function streamIdentity(target: NamedMessageTarget): Pick<ChatMessage, 'extra'> {
  const parent = target.invocationId ?? target.turnInvocationId;
  if (!parent) return {};
  const turn = target.turnInvocationId && target.turnInvocationId !== parent ? target.turnInvocationId : undefined;
  return { extra: { stream: { invocationId: parent, ...(turn ? { turnInvocationId: turn } : {}) } } };
}

/**
 * A background thread counts one unread when a message first gains something to show —
 * whichever write gives it that body first: a streamed event or the stored snapshot.
 */
function countUnreadIfFirstBody(threadId: string, messageId: string, hadBody: boolean, source: StoreSource) {
  const current = source();
  if (hadBody || threadId === current.currentThreadId) return;
  const after = current.getThreadState(threadId).messages.find((message) => message.id === messageId);
  if (after && hasAssistantBody(after)) current.incrementUnread(threadId);
}

/**
 * Apply the server's stored snapshot of a message. The snapshot of a response can be what
 * first gives it a body (no streamed output reached this client, or the snapshot overtook
 * buffered output that the committed response then refuses), so it follows the same
 * first-body unread rule as streamed writes: one count per message, whichever arrives first.
 */
export function writeStoredSnapshot(threadId: string, message: ChatMessage, source: StoreSource = liveStore) {
  const store = source();
  const before = store.getThreadState(threadId).messages.find((candidate) => candidate.id === message.id);
  store.upsertLifecycleMessage(threadId, message);
  if (message.lifecycle?.kind !== 'response') return;
  countUnreadIfFirstBody(threadId, message.id, before ? hasAssistantBody(before) : false, source);
}

/**
 * Write streamed output into the named message. A client that has not seen the message yet
 * creates it under the server's id (adding a background message counts its one unread). A
 * background thread counts one unread when the message first gains something to show.
 */
function writeStreamed(target: NamedMessageTarget, write: (store: NamedMessageStore) => void, source: StoreSource) {
  const store = source();
  const before = findNamed(store, target);
  if (!before) {
    store.addMessageToThread(target.threadId, {
      id: target.messageId,
      type: 'assistant',
      from: { kind: 'agent', catId: target.catId },
      catId: target.catId,
      content: '',
      origin: 'stream',
      isStreaming: true,
      timestamp: target.timestamp ?? Date.now(),
      ...streamIdentity(target),
    });
    write(source());
    return;
  }
  // A committed response is the server's final truth; stream output can no longer change it.
  if (before.lifecycle?.kind === 'response' && before.lifecycle.status !== 'processing') return;
  const hadBody = hasAssistantBody(before);
  write(store);
  if (before.isStreaming !== true) source().setThreadMessageStreaming(target.threadId, target.messageId, true);
  countUnreadIfFirstBody(target.threadId, target.messageId, hadBody, source);
}

/** Durable child execution identity an event projects onto its response before history hydration. */
export type StreamExecutionIdentity = Pick<
  NonNullable<ChatMessage['extra']>,
  'turnExecution' | 'auxiliaryTurnExecutions'
>;

export interface StreamTextWrite {
  content: string;
  textMode?: 'append' | 'replace';
  metadata?: ChatMessageMetadata;
  replyTo?: string;
  replyPreview?: ReplyPreview;
  mentionsUser?: boolean;
  execution?: StreamExecutionIdentity;
}

export function writeStreamText(target: NamedMessageTarget, text: StreamTextWrite, source: StoreSource = liveStore) {
  writeStreamed(
    target,
    (store) => {
      if (text.textMode === 'replace') {
        store.patchThreadMessage(target.threadId, target.messageId, { content: text.content });
      } else if (text.content) {
        store.appendToThreadMessage(target.threadId, target.messageId, text.content);
      }
      if (text.metadata) store.setThreadMessageMetadata(target.threadId, target.messageId, text.metadata);
      const execution = text.execution;
      const hasExecution = Boolean(execution?.turnExecution || execution?.auxiliaryTurnExecutions);
      if (text.replyTo || text.replyPreview || text.mentionsUser || hasExecution) {
        store.patchThreadMessage(target.threadId, target.messageId, {
          ...(text.replyTo ? { replyTo: text.replyTo } : {}),
          ...(text.replyPreview ? { replyPreview: text.replyPreview } : {}),
          ...(text.mentionsUser ? { mentionsUser: true } : {}),
          ...(hasExecution
            ? {
                extra: {
                  ...(execution?.turnExecution ? { turnExecution: execution.turnExecution } : {}),
                  ...(execution?.auxiliaryTurnExecutions
                    ? { auxiliaryTurnExecutions: execution.auxiliaryTurnExecutions }
                    : {}),
                },
              }
            : {}),
        });
      }
    },
    source,
  );
}

export function writeToolEvent(target: NamedMessageTarget, event: ToolEvent, source: StoreSource = liveStore) {
  writeStreamed(target, (store) => store.appendToolEventToThread(target.threadId, target.messageId, event), source);
}

export function writeThinking(target: NamedMessageTarget, thinking: string, source: StoreSource = liveStore) {
  writeStreamed(target, (store) => store.setThreadMessageThinking(target.threadId, target.messageId, thinking), source);
}

export function writeRichBlock(target: NamedMessageTarget, block: RichBlock, source: StoreSource = liveStore) {
  writeStreamed(target, (store) => store.appendRichBlockToThread(target.threadId, target.messageId, block), source);
}

/**
 * Metadata and usage describe the named message (footer, child executions). They are not a
 * body: they never create the record, so an unseen message just waits for its own snapshot.
 */
export function writeMessageMetadata(
  target: Pick<NamedMessageTarget, 'threadId' | 'messageId'>,
  write: { metadata?: ChatMessageMetadata; usage?: TokenUsage; served?: ServedModelFacts },
  source: StoreSource = liveStore,
) {
  const store = source();
  if (!store.getThreadState(target.threadId).messages.some((message) => message.id === target.messageId)) return;
  // Metadata first: usage lands inside metadata and is a no-op while metadata is absent.
  if (write.metadata) store.setThreadMessageMetadata(target.threadId, target.messageId, write.metadata);
  if (write.usage) store.setThreadMessageUsage(target.threadId, target.messageId, write.usage);
  const current = store.getThreadState(target.threadId).messages.find((message) => message.id === target.messageId);
  if (write.served && current?.metadata) {
    store.patchThreadMessage(target.threadId, target.messageId, { metadata: { ...current.metadata, ...write.served } });
  }
}

/**
 * Timeout diagnostics explain the failure of the response they name, so they live on that
 * response. Like metadata they are not a body: they never create the record — a response this
 * client has not seen gets them from its terminal snapshot, which carries the persisted copy.
 */
export function writeTimeoutDiagnostics(
  target: Pick<NamedMessageTarget, 'threadId' | 'messageId'>,
  timeoutDiagnostics: TimeoutDiagnostics,
  source: StoreSource = liveStore,
) {
  const store = source();
  if (!store.getThreadState(target.threadId).messages.some((message) => message.id === target.messageId)) return;
  store.patchThreadMessage(target.threadId, target.messageId, { extra: { timeoutDiagnostics } });
}

export function writeCliDiagnostics(
  target: Pick<NamedMessageTarget, 'threadId' | 'messageId'>,
  cliDiagnostics: NonNullable<NonNullable<ChatMessage['extra']>['cliDiagnostics']>,
  source: StoreSource = liveStore,
) {
  const store = source();
  if (!store.getThreadState(target.threadId).messages.some((message) => message.id === target.messageId)) return;
  store.patchThreadMessage(target.threadId, target.messageId, { extra: { cliDiagnostics } });
}

/** A persisted post_message arrives whole under its own id; replaying it changes nothing. */
export function writePersistedPost(post: ChatMessage, threadId: string, source: StoreSource = liveStore) {
  const store = source();
  if (store.getThreadState(threadId).messages.some((message) => message.id === post.id)) return;
  store.addMessageToThread(threadId, { ...post, isStreaming: false });
}

/**
 * A post's own rich block belongs to that persisted post. It is not stream output: it never
 * creates a record (the post arrives whole under its own id) and never reopens the post.
 */
export function writePostRichBlock(
  target: Pick<NamedMessageTarget, 'threadId' | 'messageId'>,
  block: RichBlock,
  source: StoreSource = liveStore,
) {
  const store = source();
  if (!store.getThreadState(target.threadId).messages.some((message) => message.id === target.messageId)) return;
  store.appendRichBlockToThread(target.threadId, target.messageId, block);
}

/**
 * The turn's stream ended: the named message stops streaming. Its final body is the committed
 * response snapshot the server publishes at done, never text carried by the done event.
 */
export function finishNamedMessage(
  target: Pick<NamedMessageTarget, 'threadId' | 'messageId'>,
  source: StoreSource = liveStore,
) {
  const store = source();
  if (!store.getThreadState(target.threadId).messages.some((message) => message.id === target.messageId)) return;
  store.setThreadMessageStreaming(target.threadId, target.messageId, false);
}
