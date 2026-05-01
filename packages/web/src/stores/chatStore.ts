import { create } from 'zustand';
import { getBubbleInvocationId } from '@/debug/bubbleIdentity';
import { recordDebugEvent } from '@/debug/invocationEventDebug';
import { getCachedCats } from '@/hooks/useCatData';
import { saveThreadMessages as saveMessagesSnapshot, saveThreads as saveThreadsSnapshot } from '../utils/offline-store';
import type {
  CatInvocationInfo,
  CatStatusType,
  ChatMessage,
  ChatMessageMetadata,
  ChatMessagePatch,
  GameState,
  QueueEntry,
  RichBlock,
  Thread,
  ThreadState,
  TokenUsage,
  ToolEvent,
} from './chat-types';
import { DEFAULT_THREAD_STATE } from './chat-types';

// Re-export types so existing consumers keep working with `import { ... } from '@/stores/chatStore'`
export type {
  CatInvocationInfo,
  CatStatusType,
  ChatMessage,
  ChatMessageMetadata,
  ChatMessagePatch,
  EvidenceData,
  EvidenceResultData,
  GameState,
  ImageContent,
  MessageContent,
  QueueEntry,
  RichAudioBlock,
  RichBlock,
  RichBlockKind,
  RichCardBlock,
  RichChecklistBlock,
  RichDiffBlock,
  RichMediaGalleryBlock,
  TextContent,
  Thread,
  ThreadState,
  TokenUsage,
  ToolEvent,
} from './chat-types';
export { DEFAULT_THREAD_STATE } from './chat-types';

// ── Helpers ──

/** Snapshot the flat active-thread fields into a ThreadState object */
/**
 * F173 a2a-handoff bug fix: insert message at correct chronological position
 * if it carries `extra.systemKind === 'a2a_routing'`; otherwise simple append.
 *
 * Why narrow scope: addMessage is the streaming hot path (chunks every few ms,
 * dedup logic above). A global timestamp sort would touch F173 streaming/dedup
 * invariants and add O(n) per insert. Marker-gated insert avoids both.
 *
 * Why needed: a2a_handoff routing pill ("X → Y") emitted by route-serial.ts
 * arrives over WebSocket, can race against the next cat's stream bubble. If
 * the bubble arrives first (already appended), the handoff appended later
 * shows up visually after the bubble it was supposed to precede.
 */
function insertOrAppendMessage(messages: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  if (msg.extra?.systemKind !== 'a2a_routing') {
    return [...messages, msg];
  }
  // Linear scan from the end. Tie-break rules for a2a_routing:
  // - Strictly older (cur.ts < msg.ts): insert right after — handoff lands here.
  // - Same ts AND cur is also a2a_routing: insert AFTER cur to preserve
  //   arrival/server-emit order (multi-target handoffs from same backend yield).
  //   Without this, two same-ms handoffs would reverse order.
  //   砚砚 R2 P2.
  // - Same ts but cur is non-routing (bubble): skip — handoff biases EARLIER
  //   so routing semantically precedes the bubble. Cloud Codex R2 P2-1.
  // - Newer (cur.ts > msg.ts): skip.
  for (let i = messages.length - 1; i >= 0; i--) {
    const cur = messages[i]!;
    if (cur.timestamp < msg.timestamp) {
      const next = messages.slice();
      next.splice(i + 1, 0, msg);
      return next;
    }
    if (cur.timestamp === msg.timestamp && cur.extra?.systemKind === 'a2a_routing') {
      const next = messages.slice();
      next.splice(i + 1, 0, msg);
      return next;
    }
  }
  // All existing messages are newer (or are equal-ts non-routing bubbles) — insert at front
  return [msg, ...messages];
}

function snapshotActive(s: ChatState): ThreadState {
  return {
    messages: s.messages,
    isLoading: s.isLoading,
    isLoadingHistory: s.isLoadingHistory,
    hasMore: s.hasMore,
    hasDraft: s.hasDraft,
    hasActiveInvocation: s.hasActiveInvocation,
    activeInvocations: s.activeInvocations,
    intentMode: s.intentMode,
    targetCats: s.targetCats,
    catStatuses: s.catStatuses,
    catInvocations: s.catInvocations,
    currentGame: s.currentGame,
    unreadCount: 0, // active thread always 0
    hasUserMention: false,
    // If the thread is actively streaming, Date.now() is correct — there IS real activity.
    // Otherwise, preserve the real timestamp so a mere thread switch doesn't reorder the sidebar.
    lastActivity: s.hasActiveInvocation
      ? Date.now()
      : Math.max(
          s.threadStates[s.currentThreadId]?.lastActivity ?? 0,
          s.messages.length > 0
            ? (s.messages[s.messages.length - 1].deliveredAt ?? s.messages[s.messages.length - 1].timestamp)
            : 0,
        ),
    queue: s.queue,
    queuePaused: s.queuePaused,
    queuePauseReason: s.queuePauseReason,
    queueFull: s.queueFull,
    queueFullSource: s.queueFullSource,
    workspaceWorktreeId: s.workspaceWorktreeId,
    workspaceOpenTabs: s.workspaceOpenTabs,
    workspaceOpenFilePath: s.workspaceOpenFilePath,
    workspaceOpenFileLine: s.workspaceOpenFileLine,
  };
}

/** F173 Phase A — ThreadRuntimeWriter mirror helper.
 *  When a setThreadX writes to the active thread's flat state, this also mirrors
 *  the same patch into threadStates[currentThreadId] so threadStates is always
 *  the source of truth (flat is a compatibility mirror, KD-2).
 *
 *  Returns the threadStates patch only — the caller must spread the flat patch
 *  alongside this to emit a single zustand set() with both halves.
 *
 *  Pass the *new* values (post-mutation) so the mirror reflects the same outcome
 *  as the flat update.
 */
function mirrorActiveToThreadStates(
  state: ChatState,
  threadId: string,
  patch: Partial<ThreadState>,
): { threadStates: Record<string, ThreadState> } {
  const baseThreadState = state.threadStates[threadId] ?? snapshotActive(state);
  // F173 receive-review fix for砚砚 P1-2 — do NOT stamp lastActivity on mirror.
  // Mirror is field synchronization, not "real activity occurred". stampThreadCompletion
  // handles completion timing. Stamping here would break the sidebar sort stability
  // invariant: redundant setX calls on inactive threads would falsely bump their position.
  return {
    threadStates: {
      ...state.threadStates,
      [threadId]: {
        ...baseThreadState,
        ...patch,
      },
    },
  };
}

/** F173 Phase A — receive-review fix for砚砚 P1-2.
 *  Convenience wrapper: mirror an active-thread flat patch to threadStates[currentThreadId]
 *  in a single set() call, eliminating the "active flat write skips mirror" gap.
 */
function mirrorActiveFlat(
  state: ChatState,
  patch: Partial<ThreadState>,
): { threadStates: Record<string, ThreadState> } {
  return mirrorActiveToThreadStates(state, state.currentThreadId, patch);
}

/** Stamp completion time into threadStates for a given thread.
 *  Centralizes the "real activity just ended" semantic so all invocation-clearing
 *  paths share one definition. Optional `patch` merges extra fields before stamping. */
function stampThreadCompletion(
  threadStates: Record<string, ThreadState>,
  threadId: string,
  patch?: Partial<ThreadState>,
): Record<string, ThreadState> {
  const existing = threadStates[threadId];
  return {
    ...threadStates,
    [threadId]: {
      ...(existing ?? { ...DEFAULT_THREAD_STATE }),
      ...patch,
      lastActivity: Date.now(),
    },
  };
}

/** Flatten a ThreadState into partial ChatState fields */
function flattenThread(ts: ThreadState): Partial<ChatState> {
  const result: Partial<ChatState> = {
    messages: ts.messages,
    isLoading: ts.isLoading,
    isLoadingHistory: ts.isLoadingHistory,
    hasMore: ts.hasMore,
    hasDraft: ts.hasDraft ?? false,
    hasActiveInvocation: ts.hasActiveInvocation,
    activeInvocations: ts.activeInvocations,
    intentMode: ts.intentMode,
    targetCats: ts.targetCats,
    catStatuses: ts.catStatuses,
    catInvocations: ts.catInvocations,
    currentGame: ts.currentGame,
    queue: ts.queue,
    queuePaused: ts.queuePaused,
    queuePauseReason: ts.queuePauseReason,
    queueFull: ts.queueFull,
    queueFullSource: ts.queueFullSource,
    workspaceOpenTabs: ts.workspaceOpenTabs,
    workspaceOpenFilePath: ts.workspaceOpenFilePath,
    workspaceOpenFileLine: ts.workspaceOpenFileLine,
  };
  // Only restore worktreeId if the thread had one set — avoids wiping
  // the global selection for threads that never opened workspace.
  if (ts.workspaceWorktreeId != null) {
    result.workspaceWorktreeId = ts.workspaceWorktreeId;
  }
  return result;
}

const MAX_BLOB_MESSAGES = 200;

const UI_THINKING_EXPANDED_KEY = 'catcafe.ui.thinkingExpandedByDefault';
const THINKING_CHUNK_SEPARATOR = '\n\n---\n\n';

function loadUiThinkingExpandedByDefault(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(UI_THINKING_EXPANDED_KEY) === '1';
  } catch {
    return false;
  }
}

function persistUiThinkingExpandedByDefault(next: boolean) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(UI_THINKING_EXPANDED_KEY, next ? '1' : '0');
  } catch {
    // ignore storage failures (privacy mode, quota, etc.)
  }
}

function renderThinkingChunks(chunks: string[]): string {
  return chunks.join(THINKING_CHUNK_SEPARATOR);
}

function getThinkingChunks(message: Pick<ChatMessage, 'thinking' | 'thinkingChunks'>): string[] {
  if (message.thinkingChunks && message.thinkingChunks.length > 0) {
    if (!message.thinking || renderThinkingChunks(message.thinkingChunks) === message.thinking) {
      return message.thinkingChunks;
    }
  }
  return message.thinking ? [message.thinking] : [];
}

function appendThinkingChunk(
  message: Pick<ChatMessage, 'thinking' | 'thinkingChunks'>,
  next: string,
): Pick<ChatMessage, 'thinking' | 'thinkingChunks'> {
  const existingChunks = getThinkingChunks(message);
  if (existingChunks.length === 0) {
    return { thinking: next, thinkingChunks: [next] };
  }
  const lastChunk = existingChunks.at(-1)!;
  if (lastChunk === next) {
    return {
      thinking: renderThinkingChunks(existingChunks),
      thinkingChunks: existingChunks,
    };
  }
  if (next.startsWith(lastChunk)) {
    const thinkingChunks = [...existingChunks.slice(0, -1), next];
    return {
      thinking: renderThinkingChunks(thinkingChunks),
      thinkingChunks,
    };
  }
  if (lastChunk.startsWith(next)) {
    return {
      thinking: renderThinkingChunks(existingChunks),
      thinkingChunks: existingChunks,
    };
  }
  const thinkingChunks = [...existingChunks, next];
  return {
    thinking: renderThinkingChunks(thinkingChunks),
    thinkingChunks,
  };
}

export type BubbleExpandState = 'expanded' | 'collapsed';
export type BubbleOverride = 'global' | 'expanded' | 'collapsed';

export interface GlobalBubbleDefaults {
  thinking: BubbleExpandState;
  cliOutput: BubbleExpandState;
}

/**
 * Resolve whether a bubble type should be expanded.
 * Priority: thread override > global config > fallback (collapsed).
 */
export function resolveBubbleExpanded(
  threadOverride: BubbleOverride | undefined,
  globalDefault: BubbleExpandState,
): boolean {
  if (threadOverride && threadOverride !== 'global') {
    return threadOverride === 'expanded';
  }
  return globalDefault === 'expanded';
}

function revokeBlobUrls(messages: ChatMessage[]) {
  for (const msg of messages) {
    if (msg.contentBlocks) {
      for (const block of msg.contentBlocks) {
        if (block.type === 'image' && block.url.startsWith('blob:')) {
          URL.revokeObjectURL(block.url);
        }
      }
    }
  }
}

function collectBlobUrls(messages: ChatMessage[]): Set<string> {
  const blobUrls = new Set<string>();
  for (const msg of messages) {
    if (!msg.contentBlocks) continue;
    for (const block of msg.contentBlocks) {
      if (block.type === 'image' && block.url.startsWith('blob:')) {
        blobUrls.add(block.url);
      }
    }
  }
  return blobUrls;
}

function revokeRemovedBlobUrls(previousMessages: ChatMessage[], nextMessages: ChatMessage[]) {
  const retainedBlobUrls = collectBlobUrls(nextMessages);
  for (const msg of previousMessages) {
    if (!msg.contentBlocks) continue;
    for (const block of msg.contentBlocks) {
      if (block.type === 'image' && block.url.startsWith('blob:') && !retainedBlobUrls.has(block.url)) {
        URL.revokeObjectURL(block.url);
      }
    }
  }
}

type ReplaceMessageIdResult = {
  messages: ChatMessage[];
  droppedMessage?: ChatMessage;
  retainedMessage?: ChatMessage;
};

function replaceMessageIdInList(messages: ChatMessage[], fromId: string, toId: string): ReplaceMessageIdResult {
  if (fromId === toId) return { messages };
  const fromIndex = messages.findIndex((msg) => msg.id === fromId);
  if (fromIndex === -1) return { messages };

  const fromMessage = messages[fromIndex];
  const retainedMessage = messages.find((msg) => msg.id === toId);
  if (retainedMessage) {
    return {
      messages: messages.filter((msg) => msg.id !== fromId),
      droppedMessage: fromMessage,
      retainedMessage,
    };
  }

  return { messages: messages.map((msg) => (msg.id === fromId ? { ...msg, id: toId } : msg)) };
}

function recordMessageIdDedupDrop(
  threadId: string,
  droppedMessage: ChatMessage | undefined,
  retainedMessage: ChatMessage | undefined,
  toId: string,
) {
  if (!droppedMessage || !retainedMessage) return;
  recordDebugEvent({
    event: 'bubble_lifecycle',
    threadId,
    timestamp: Date.now(),
    action: 'drop',
    reason: 'replace_message_id_dedup',
    catId: droppedMessage.catId ?? retainedMessage.catId,
    messageId: toId,
    invocationId: droppedMessage.extra?.stream?.invocationId ?? retainedMessage.extra?.stream?.invocationId,
    origin: droppedMessage.origin ?? retainedMessage.origin,
  });
}

function applyMessagePatch(message: ChatMessage, patch: ChatMessagePatch): ChatMessage {
  return {
    ...message,
    ...patch,
    ...(patch.extra ? { extra: { ...message.extra, ...patch.extra } } : {}),
    ...(patch.metadata
      ? { metadata: message.metadata ? { ...message.metadata, ...patch.metadata } : patch.metadata }
      : {}),
  };
}

function patchMessageInList(messages: ChatMessage[], id: string, patch: ChatMessagePatch): ChatMessage[] {
  let changed = false;
  const nextMessages = messages.map((msg) => {
    if (msg.id !== id) return msg;
    changed = true;
    return applyMessagePatch(msg, patch);
  });
  return changed ? nextMessages : messages;
}

/** F067 Phase 2: Fire macOS notification when a cat @mentions the co-creator */
function fireOwnerMentionNotification(msg: ChatMessage) {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') {
    Notification.requestPermission();
    return;
  }
  const cats = getCachedCats();
  const catData = cats.find((c) => c.id === msg.catId);
  const catName = catData?.displayName ?? msg.catId ?? '猫猫';
  const preview = typeof msg.content === 'string' ? msg.content.replace(/\n/g, ' ').slice(0, 120) : '';
  new Notification(`${catName} @ 了你`, {
    body: preview,
    icon: catData?.avatar ?? '/favicon.ico',
    tag: `cocreator-mention-${msg.id}`,
  });
}

/**
 * TD112: Store-level assistant bubble dedup invariant.
 *
 * When an incoming assistant message enters the store, check if a semantically
 * equivalent bubble already exists. Returns the index of the existing message
 * to merge into, or -1 if no duplicate found.
 *
 * Two-layer strategy (per 砚砚 review):
 * 1. Hard rule: same catId + invocationId → always merge
 * 2. Soft rule: callback→stream upgrade — incoming is callback, candidate is
 *    same catId's latest stream assistant with no invocationId, within 8s,
 *    matching replyTo/visibility
 */
function findAssistantDuplicate(messages: ChatMessage[], incoming: ChatMessage): number {
  if (incoming.type !== 'assistant' || !incoming.catId) return -1;

  const incomingInvId = getBubbleInvocationId(incoming);

  // Phase 1: Hard rule — scan ALL same-cat assistants for exact invocationId match.
  // Must run first because bridge/soft rules on a newer message would mis-associate.
  if (incomingInvId) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const existing = messages[i]!;
      if (existing.type !== 'assistant' || existing.catId !== incoming.catId) continue;
      const existingInvId = getBubbleInvocationId(existing);
      if (existingInvId === incomingInvId) return i;
    }
  }

  // Phase 2: Soft rule — check only the MOST RECENT same-cat assistant.
  // Only for callbacks WITHOUT an invocationId → stream(no invocationId) upgrade.
  // Callbacks WITH invocationId are fully handled by Phase 1 (hard match);
  // if Phase 1 didn't match, the invocationId is stale/unrelated and soft bridge
  // must not merge into an invocationless stream from a different invocation.
  if (incoming.origin !== 'callback') return -1;
  if (incomingInvId) return -1;

  for (let i = messages.length - 1; i >= 0; i--) {
    const existing = messages[i]!;
    if (existing.type !== 'assistant' || existing.catId !== incoming.catId) continue;

    // Skip non-stream messages — bridge/soft only targets stream placeholders.
    // Cloud review P1: breaking on the first same-cat assistant (which may be
    // a callback) prevents reaching an older stream placeholder.
    if (existing.origin !== 'stream') continue;

    const existingInvId = getBubbleInvocationId(existing);
    if (
      !existingInvId &&
      Math.abs((incoming.timestamp ?? 0) - (existing.timestamp ?? 0)) < 8_000 &&
      incoming.replyTo === existing.replyTo &&
      (incoming.visibility ?? 'public') === (existing.visibility ?? 'public')
    ) {
      return i;
    }
    // Checked the most recent same-cat stream — stop scanning
    break;
  }

  return -1;
}

function mergeRichBlocks(existingBlocks: RichBlock[] = [], incomingBlocks: RichBlock[] = []): RichBlock[] | undefined {
  const merged: RichBlock[] = [];
  const seen = new Set<string>();
  for (const block of [...existingBlocks, ...incomingBlocks]) {
    if (seen.has(block.id)) continue;
    seen.add(block.id);
    merged.push(block);
  }
  return merged.length > 0 ? merged : undefined;
}

/** Merge incoming message into existing, preferring callback content over stream */
function mergeAssistantBubble(existing: ChatMessage, incoming: ChatMessage): ChatMessage {
  // Bridge rule: backfill invocationId from callback into stream placeholder
  const incomingInvId = getBubbleInvocationId(incoming);
  const existingInvId = getBubbleInvocationId(existing);
  const mergedExtra: ChatMessage['extra'] = { ...existing.extra, ...incoming.extra };
  const mergedRichBlocks = mergeRichBlocks(existing.extra?.rich?.blocks, incoming.extra?.rich?.blocks);
  if (mergedRichBlocks) {
    mergedExtra.rich = { v: 1, blocks: mergedRichBlocks };
  }
  const needsStreamMerge = [existing.extra?.stream, incoming.extra?.stream, incomingInvId && !existingInvId].some(
    Boolean,
  );
  if (needsStreamMerge) {
    mergedExtra.stream = {
      ...existing.extra?.stream,
      ...incoming.extra?.stream,
      ...(incomingInvId && !existingInvId ? { invocationId: incomingInvId } : {}),
    };
  }
  if (incoming.extra?.crossPost) {
    mergedExtra.crossPost = incoming.extra.crossPost;
  }

  return {
    ...existing,
    // Prefer incoming content if non-empty
    content: incoming.content || existing.content,
    // Callback > stream origin
    origin: incoming.origin === 'callback' ? 'callback' : existing.origin,
    isStreaming: false,
    // Merge metadata (incoming takes precedence)
    ...(incoming.metadata ? { metadata: incoming.metadata } : {}),
    ...(incoming.deliveredAt ? { deliveredAt: incoming.deliveredAt } : {}),
    ...(incoming.replyTo ? { replyTo: incoming.replyTo } : {}),
    ...(incoming.replyPreview ? { replyPreview: incoming.replyPreview } : {}),
    // Preserve extra from existing (CLI Output/rich blocks) + merge callback metadata
    extra: Object.keys(mergedExtra).length > 0 ? mergedExtra : undefined,
    ...(incoming.mentionsUser ? { mentionsUser: true } : {}),
  };
}

function updateThreadMessage(
  state: ChatState,
  threadId: string,
  messageId: string,
  updater: (message: ChatMessage) => ChatMessage,
): ChatState | Partial<ChatState> {
  if (threadId === state.currentThreadId) {
    // F173 KD-2 (PR-C Task 10): mirror message edits to threadStates[active]
    // so reconcile / streaming-flag flips stay in lockstep with flat.
    const messages = state.messages.map((m) => (m.id === messageId ? updater(m) : m));
    return {
      messages,
      ...mirrorActiveFlat(state, { messages }),
    };
  }

  const existing = state.threadStates[threadId];
  if (!existing) return state;
  return {
    threadStates: {
      ...state.threadStates,
      [threadId]: {
        ...existing,
        messages: existing.messages.map((m) => (m.id === messageId ? updater(m) : m)),
        lastActivity: Date.now(),
      },
    },
  };
}

// ── Store interface ──

export interface ChatState {
  // Per-thread state (flat — reflects the active thread for backward compat)
  messages: ChatMessage[];
  isLoading: boolean;
  isLoadingHistory: boolean;
  hasMore: boolean;
  hasDraft: boolean;
  /** Whether the thread has an active invocation (broader than isLoading — stays true during A2A chains) */
  hasActiveInvocation: boolean;
  /** F108: Per-invocation slot tracking — key=invocationId, value=slot info */
  activeInvocations: Record<string, { catId: string; mode: string; startedAt?: number }>;
  intentMode: 'execute' | 'ideate' | null;
  targetCats: string[];
  catStatuses: Record<string, CatStatusType>;
  catInvocations: Record<string, CatInvocationInfo>;
  /** F101: Active game in current thread */
  currentGame: GameState | null;
  /** F39: Message queue entries */
  queue: QueueEntry[];
  /** F39: Whether the queue is paused */
  queuePaused: boolean;
  /** F39: Pause reason */
  queuePauseReason?: 'canceled' | 'failed';
  /** F39: Queue full flag */
  queueFull: boolean;
  /** F39: Who triggered the full warning */
  queueFullSource?: 'user' | 'connector';

  // Multi-thread state map (preserves per-thread state across switches)
  threadStates: Record<string, ThreadState>;

  // Multi-thread UI
  viewMode: 'single' | 'split';
  splitPaneThreadIds: string[];
  splitPaneTargetId: string | null;

  // Global state
  currentThreadId: string;
  currentProjectPath: string;
  /** Transient: suppress initThreadUnread re-hydration for recently-cleared threads */
  _unreadSuppressedUntil: Record<string, number>;
  /** #586: Count of in-flight ack requests per thread — suppression clears only when 0 */
  _pendingAckCount: Record<string, number>;
  threads: Thread[];
  isLoadingThreads: boolean;
  /** F164: True when messages are from offline snapshot, not fresh API data */
  isOfflineSnapshot: boolean;
  /** UI: Whether Thinking blocks should be expanded by default (global preference). */
  uiThinkingExpandedByDefault: boolean;
  /** Global bubble display defaults from Config Hub (server-side). */
  globalBubbleDefaults: GlobalBubbleDefaults;

  // ── Active-thread actions (operate on flat state) ──
  addMessage: (msg: ChatMessage) => void;
  removeMessage: (id: string) => void;
  prependHistory: (msgs: ChatMessage[], hasMore: boolean) => void;
  replaceMessages: (msgs: ChatMessage[], hasMore: boolean) => void;
  /** F173 Phase C Task 5+6+7 — single hydration entry point.
   *  Server GET is authoritative: replaces flat messages AND overwrites
   *  IDB snapshot in one atomic call. Use this instead of bare
   *  replaceMessages + saveMessagesSnapshot whenever a server GET response
   *  fully replaces the current thread timeline. AC-C10. */
  hydrateThread: (threadId: string, msgs: ChatMessage[], hasMore: boolean) => void;
  replaceMessageId: (fromId: string, toId: string) => void;
  patchMessage: (id: string, patch: ChatMessagePatch) => void;
  appendToLastMessage: (content: string) => void;
  appendToMessage: (id: string, content: string) => void;
  appendToolEvent: (id: string, event: ToolEvent) => void;
  /** F22: Append a rich block to a message */
  appendRichBlock: (id: string, block: RichBlock) => void;
  /** F096: Update a specific rich block within a message */
  updateRichBlock: (messageId: string, blockId: string, patch: Record<string, unknown>) => void;
  setStreaming: (id: string, streaming: boolean) => void;
  setLoading: (loading: boolean) => void;
  setThreadHasDraft: (threadId: string, hasDraft: boolean) => void;
  setHasActiveInvocation: (v: boolean) => void;
  /** F108: Register a new active invocation slot */
  addActiveInvocation: (invocationId: string, catId: string, mode: string, startedAt?: number) => void;
  /** F108: Remove an active invocation slot; derives hasActiveInvocation */
  removeActiveInvocation: (invocationId: string) => void;
  /** F108: Clear all active invocations (timeout/error/stop recovery) */
  clearAllActiveInvocations: () => void;
  setLoadingHistory: (loading: boolean) => void;
  setIntentMode: (mode: 'execute' | 'ideate' | null) => void;
  setTargetCats: (cats: string[]) => void;
  setCatStatus: (catId: string, status: CatStatusType) => void;
  clearCatStatuses: () => void;
  setCatInvocation: (catId: string, info: Partial<CatInvocationInfo>) => void;
  setMessageUsage: (messageId: string, usage: TokenUsage) => void;
  /** Merge metadata onto an active-thread message (parallel to setThreadMessageMetadata) */
  setMessageMetadata: (messageId: string, metadata: ChatMessageMetadata) => void;
  /** F045: Set or append extended thinking content on an assistant message */
  setMessageThinking: (messageId: string, thinking: string) => void;
  /** F081: Persist stream invocation identity onto a message for replace/hydration reconcile */
  setMessageStreamInvocation: (messageId: string, invocationId: string) => void;
  clearMessages: () => void;
  /** Bug C: Monotonic counter + target threadId — increment to request a history catch-up fetch */
  streamCatchUpVersion: number;
  streamCatchUpThreadId: string | null;
  requestStreamCatchUp: (threadId: string) => void;
  /** F101: Update current game state */
  setCurrentGame: (game: GameState | null) => void;

  // ── Thread management ──
  setThreads: (threads: Thread[]) => void;
  setCurrentThread: (threadId: string) => void;
  setCurrentProject: (projectPath: string) => void;
  setLoadingThreads: (loading: boolean) => void;
  setOfflineSnapshot: (v: boolean) => void;
  updateThreadTitle: (threadId: string, title: string) => void;
  updateThreadParticipants: (threadId: string, participants: string[]) => void;
  updateThreadPin: (threadId: string, pinned: boolean) => void;
  updateThreadFavorite: (threadId: string, favorited: boolean) => void;
  updateThreadThinkingMode: (threadId: string, mode: 'debug' | 'play') => void;

  updateThreadPreferredCats: (threadId: string, preferredCats: string[]) => void;
  updateThreadBubbleDisplay: (threadId: string, field: 'bubbleThinking' | 'bubbleCli', value: BubbleOverride) => void;
  setGlobalBubbleDefaults: (defaults: GlobalBubbleDefaults) => void;
  fetchGlobalBubbleDefaults: () => Promise<void>;
  setUiThinkingExpandedByDefault: (next: boolean) => void;

  // ── Multi-thread actions (new) ──
  addMessageToThread: (threadId: string, msg: ChatMessage) => void;
  removeThreadMessage: (threadId: string, messageId: string) => void;
  replaceThreadMessageId: (threadId: string, fromId: string, toId: string) => void;
  patchThreadMessage: (threadId: string, messageId: string, patch: ChatMessagePatch) => void;
  appendToThreadMessage: (threadId: string, messageId: string, content: string) => void;
  appendToolEventToThread: (threadId: string, messageId: string, event: ToolEvent) => void;
  /** F22: Append a rich block to a message in a specific thread */
  appendRichBlockToThread: (threadId: string, messageId: string, block: RichBlock) => void;
  setThreadCatInvocation: (threadId: string, catId: string, info: Partial<CatInvocationInfo>) => void;
  setThreadMessageMetadata: (threadId: string, messageId: string, metadata: ChatMessageMetadata) => void;
  setThreadMessageUsage: (threadId: string, messageId: string, usage: TokenUsage) => void;
  setThreadMessageThinking: (threadId: string, messageId: string, thinking: string) => void;
  setThreadMessageStreamInvocation: (threadId: string, messageId: string, invocationId: string) => void;
  setThreadMessageStreaming: (threadId: string, messageId: string, streaming: boolean) => void;
  setThreadLoading: (threadId: string, loading: boolean) => void;
  setThreadHasActiveInvocation: (threadId: string, active: boolean) => void;
  /** F108: Add an active invocation to a thread (background or active) */
  addThreadActiveInvocation: (
    threadId: string,
    invocationId: string,
    catId: string,
    mode: string,
    startedAt?: number,
  ) => void;
  /** F108: Remove an active invocation from a thread; derives hasActiveInvocation */
  removeThreadActiveInvocation: (threadId: string, invocationId: string) => void;
  /** F108: Clear all active invocations for a thread (cancel fallback when invocationId unknown) */
  clearAllThreadActiveInvocations: (threadId: string) => void;
  setThreadIntentMode: (threadId: string, mode: 'execute' | 'ideate' | null) => void;
  setThreadTargetCats: (threadId: string, cats: string[]) => void;
  replaceThreadTargetCats: (threadId: string, cats: string[]) => void;
  getThreadState: (threadId: string) => ThreadState;
  incrementUnread: (threadId: string) => void;
  clearUnread: (threadId: string) => void;
  /** F072: Clear unread badges for all threads at once */
  clearAllUnread: () => void;
  /** #586: One ack resolved — decrement pending count; clear suppression when 0 */
  confirmUnreadAck: (threadId: string) => void;
  /** #586: Ack about to fire — increment pending count + set Infinity suppression */
  armUnreadSuppression: (threadId: string) => void;
  /** F069: Initialize unread state from API (page load recovery) */
  initThreadUnread: (threadId: string, unreadCount: number, hasUserMention: boolean) => void;
  updateThreadCatStatus: (threadId: string, catId: string, status: CatStatusType) => void;
  /** F173 PR-C Task 10: clear targetCats / catStatuses + mark stale catInvocations completed
   *  for a specific thread. Mirrors flat when active. Replaces the flat-only clearCatStatuses
   *  inside reconcile / hydration paths so KD-2 mirror invariant holds. */
  clearThreadCatStatuses: (threadId: string) => void;
  /** Batch content-append + metadata + streaming + catStatus into a single set() to prevent
   *  React update-depth overflow during high-frequency background streaming. */
  batchStreamChunkUpdate: (params: {
    threadId: string;
    messageId: string;
    catId: string;
    content: string;
    metadata?: ChatMessageMetadata;
    streaming: boolean;
    catStatus: CatStatusType;
  }) => void;
  setViewMode: (mode: 'single' | 'split') => void;
  setSplitPaneThreadIds: (ids: string[]) => void;
  setSplitPaneTarget: (threadId: string | null) => void;

  /** Clear hasActiveInvocation for a specific thread (active or background) */
  clearThreadActiveInvocation: (threadId: string) => void;
  /** Clear invocation-scoped UI state for a specific thread (active or background) */
  resetThreadInvocationState: (threadId: string) => void;

  // ── F39: Queue actions ──
  setQueue: (threadId: string, queue: QueueEntry[]) => void;
  setQueuePaused: (threadId: string, paused: boolean, reason?: 'canceled' | 'failed') => void;
  setQueueFull: (threadId: string, source: 'user' | 'connector') => void;
  /** F098-D + F117: Mark queued messages as delivered (set deliveredAt) + insert user bubbles for queue-sent messages */
  markMessagesDelivered: (
    threadId: string,
    messageIds: string[],
    deliveredAt: number,
    messages?: Array<{
      id: string;
      content: string;
      catId: string | null;
      timestamp: number;
      contentBlocks?: readonly unknown[];
      extra?: Record<string, unknown>;
      origin?: 'stream' | 'callback' | 'briefing';
      replyTo?: string;
      replyPreview?: { senderCatId: string | null; content: string; deleted?: boolean; kind?: string };
      mentionsUser?: boolean;
    }>,
  ) => void;

  // ── F63: Workspace Explorer ──
  rightPanelMode: 'status' | 'workspace';
  workspaceWorktreeId: string | null;
  workspaceOpenTabs: string[];
  workspaceOpenFilePath: string | null;
  workspaceOpenFileLine: number | null;
  workspaceEditToken: string | null;
  workspaceEditTokenExpiry: number | null;
  /** @internal Last workspace-file-set event context (timestamp + threadId).
   * Used by WorkspacePanel to distinguish fresh navigate from stale leftovers on mount. */
  _workspaceFileSetAt: { ts: number; threadId: string | null };
  setRightPanelMode: (mode: 'status' | 'workspace') => void;
  setWorkspaceWorktreeId: (id: string | null) => void;
  setWorkspaceOpenFile: (
    path: string | null,
    line?: number | null,
    worktreeId?: string | null,
    originThreadId?: string | null,
  ) => void;
  closeWorkspaceTab: (path: string) => void;
  restoreWorkspaceTabs: (tabs: string[], openFile: string | null) => void;
  setWorkspaceEditToken: (token: string | null, expiresIn?: number) => void;

  workspaceRevealPath: string | null;
  setWorkspaceRevealPath: (path: string | null, originThreadId?: string | null) => void;

  // Phase H + F139 + F160 + F168: Workspace mode
  workspaceMode: 'dev' | 'recall' | 'schedule' | 'tasks' | 'community';
  setWorkspaceMode: (mode: 'dev' | 'recall' | 'schedule' | 'tasks' | 'community') => void;

  // ── F120: Preview auto-open (always-mounted listener) ──
  pendingPreviewAutoOpen: { port: number; path: string } | null;
  setPendingPreviewAutoOpen: (data: { port: number; path: string }) => void;
  consumePreviewAutoOpen: () => { port: number; path: string } | null;

  // ── F63-AC15: Code-to-chat reference ──
  pendingChatInsert: { threadId: string; text: string } | null;
  setPendingChatInsert: (insert: { threadId: string; text: string } | null) => void;

  // ── Hub modal (F12) ──
  // F174 D2b-3 cloud P2 #1403: subTabNonce bumps on every openHub call so a
  // second deep-link with the SAME (tab, subTab) still triggers a re-sync —
  // value-only diff in HubObservabilityTab's useEffect would silently no-op.
  hubState: { open: boolean; tab?: string; subTab?: string; subTabNonce?: number } | null;
  /** F174 D2b-3: optional subTab for deep-linking into observability sub-routes etc. */
  openHub: (tab?: string, subTab?: string) => void;
  closeHub: () => void;

  // ── F079: Vote modal ──
  showVoteModal: boolean;
  setShowVoteModal: (show: boolean) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  isLoading: false,
  isLoadingHistory: false,
  hasMore: true,
  hasDraft: false,
  hasActiveInvocation: false,
  activeInvocations: {},
  intentMode: null,
  targetCats: [],
  catStatuses: {},
  catInvocations: {},
  currentGame: null,
  queue: [],
  queuePaused: false,
  queueFull: false,

  threadStates: {},
  viewMode: 'single',
  splitPaneThreadIds: [],
  splitPaneTargetId: null,

  currentThreadId: 'default',
  currentProjectPath: 'default',
  _unreadSuppressedUntil: {},
  _pendingAckCount: {},
  threads: [],
  isLoadingThreads: true,
  isOfflineSnapshot: false,
  uiThinkingExpandedByDefault: loadUiThinkingExpandedByDefault(),
  globalBubbleDefaults: {
    // Always start collapsed — server config overwrites via fetchGlobalBubbleDefaults().
    // Previously used localStorage as initial fallback, but this races with thread loading:
    // threads can finish before config, causing a flash of expanded bubbles from stale localStorage.
    thinking: 'collapsed',
    cliOutput: 'collapsed',
  },

  setGlobalBubbleDefaults: (defaults) => set({ globalBubbleDefaults: defaults }),

  fetchGlobalBubbleDefaults: async () => {
    try {
      const { apiFetch } = await import('@/utils/api-client');
      const res = await apiFetch('/api/config');
      if (!res.ok) return;
      const data = await res.json();
      const ui = data.config?.ui;
      if (ui?.bubbleDefaults) {
        set({
          globalBubbleDefaults: {
            thinking: ui.bubbleDefaults.thinking ?? 'collapsed',
            cliOutput: ui.bubbleDefaults.cliOutput ?? 'collapsed',
          },
        });
      }
    } catch {
      // Fallback to existing defaults on network error
    }
  },

  updateThreadBubbleDisplay: (threadId, field, value) =>
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId ? { ...t, [field]: value === 'global' ? undefined : value } : t,
      ),
    })),

  setUiThinkingExpandedByDefault: (next) => {
    persistUiThinkingExpandedByDefault(next);
    set({ uiThinkingExpandedByDefault: next });
  },

  // ── F39: Queue actions ──

  setQueue: (threadId, queue) =>
    set((state) => {
      const wasFull = threadId === state.currentThreadId ? state.queueFull : state.threadStates[threadId]?.queueFull;
      const isShrinking = wasFull && queue.length < 5; // MAX_QUEUE_DEPTH=5, clear full flag when below
      if (threadId === state.currentThreadId) {
        return {
          queue,
          queuePaused: queue.length === 0 ? false : state.queuePaused,
          ...(isShrinking ? { queueFull: false, queueFullSource: undefined } : {}),
        };
      }
      const existing = state.threadStates[threadId] ?? { ...DEFAULT_THREAD_STATE };
      return {
        threadStates: {
          ...state.threadStates,
          [threadId]: {
            ...existing,
            queue,
            queuePaused: queue.length === 0 ? false : existing.queuePaused,
            ...(isShrinking ? { queueFull: false, queueFullSource: undefined } : {}),
            lastActivity: Date.now(),
          },
        },
      };
    }),

  setQueuePaused: (threadId, paused, reason) =>
    set((state) => {
      if (threadId === state.currentThreadId) {
        return { queuePaused: paused, queuePauseReason: paused ? reason : undefined };
      }
      const existing = state.threadStates[threadId] ?? { ...DEFAULT_THREAD_STATE };
      return {
        threadStates: {
          ...state.threadStates,
          [threadId]: {
            ...existing,
            queuePaused: paused,
            queuePauseReason: paused ? reason : undefined,
            lastActivity: Date.now(),
          },
        },
      };
    }),

  setQueueFull: (threadId, source) =>
    set((state) => {
      if (threadId === state.currentThreadId) {
        return { queueFull: true, queueFullSource: source };
      }
      const existing = state.threadStates[threadId] ?? { ...DEFAULT_THREAD_STATE };
      return {
        threadStates: {
          ...state.threadStates,
          [threadId]: {
            ...existing,
            queueFull: true,
            queueFullSource: source,
            lastActivity: Date.now(),
          },
        },
      };
    }),

  markMessagesDelivered: (threadId, messageIds, deliveredAt, serverMessages) =>
    set((state) => {
      const idSet = new Set(messageIds);
      const updateMsgs = (msgs: ChatMessage[]) => {
        // Update deliveredAt on existing messages
        const updated = msgs.map((m) => (idSet.has(m.id) ? { ...m, deliveredAt } : m));
        const insertedIds = new Set<string>();
        const mentionMessages: ChatMessage[] = [];
        // F117: Insert user bubbles for queue-sent messages not yet in the store
        if (serverMessages) {
          const existingIds = new Set(updated.map((m) => m.id));
          for (const sm of serverMessages) {
            if (existingIds.has(sm.id)) continue;
            const incoming: ChatMessage = {
              id: sm.id,
              // #607: cat-originated messages (A2A triggers) have catId set
              type: sm.catId ? 'assistant' : 'user',
              content: sm.content,
              timestamp: sm.timestamp,
              deliveredAt,
              ...(sm.catId ? { catId: sm.catId } : {}),
              contentBlocks: sm.contentBlocks as ChatMessage['contentBlocks'],
              ...(sm.extra ? { extra: sm.extra as ChatMessage['extra'] } : {}),
              ...(sm.origin ? { origin: sm.origin } : {}),
              ...(sm.replyTo ? { replyTo: sm.replyTo } : {}),
              ...(sm.replyPreview ? { replyPreview: sm.replyPreview as ChatMessage['replyPreview'] } : {}),
              ...(sm.mentionsUser ? { mentionsUser: true } : {}),
            };

            const dupIdx = findAssistantDuplicate(updated, incoming);
            if (dupIdx >= 0) {
              const existing = updated[dupIdx]!;
              updated[dupIdx] = {
                ...mergeAssistantBubble(existing, incoming),
                id: incoming.id,
              };
              existingIds.add(incoming.id);
              if (incoming.mentionsUser && !existing.mentionsUser) {
                mentionMessages.push(incoming);
              }
            } else {
              updated.push(incoming);
              existingIds.add(incoming.id);
              insertedIds.add(incoming.id);
              if (incoming.mentionsUser) {
                mentionMessages.push(incoming);
              }
            }
          }
          // Re-sort: delivered messages use deliveredAt so they appear at delivery
          // position (current tail), not their original send-time slot.
          updated.sort((a, b) => (a.deliveredAt ?? a.timestamp) - (b.deliveredAt ?? b.timestamp));
        }
        return { messages: updated, insertedIds, mentionMessages };
      };

      if (threadId === state.currentThreadId) {
        const result = updateMsgs(state.messages);
        if (typeof document !== 'undefined' && !document.hasFocus()) {
          const newMention = result.mentionMessages[0];
          if (newMention) {
            fireOwnerMentionNotification(newMention);
          }
        }
        return { messages: result.messages };
      }
      const existing = state.threadStates[threadId] || { ...DEFAULT_THREAD_STATE };
      const result = updateMsgs(existing.messages);
      const newInserts = result.insertedIds.size;
      const newMentionMsg = result.mentionMessages[0];
      if (newMentionMsg) {
        fireOwnerMentionNotification(newMentionMsg);
      }
      return {
        threadStates: {
          ...state.threadStates,
          [threadId]: {
            ...existing,
            messages: result.messages,
            ...(newInserts > 0
              ? {
                  unreadCount: existing.unreadCount + newInserts,
                  lastActivity: deliveredAt,
                }
              : {}),
            ...(newMentionMsg ? { hasUserMention: true } : {}),
          },
        },
      };
    }),

  // ── F63: Workspace Explorer ──
  rightPanelMode: 'status' as const,
  workspaceWorktreeId: null,
  workspaceOpenTabs: [],
  workspaceOpenFilePath: null,
  workspaceOpenFileLine: null,
  workspaceEditToken: null,
  workspaceEditTokenExpiry: null,
  _workspaceFileSetAt: { ts: 0, threadId: null },
  setRightPanelMode: (mode) => set({ rightPanelMode: mode }),
  setWorkspaceWorktreeId: (id) => {
    // Guard: skip destructive reset when worktreeId is unchanged.
    // setWorkspaceWorktreeId unconditionally clears openFilePath/openTabs,
    // which causes "snapback" if callers (e.g. fetchWorktrees auto-select)
    // redundantly set the same worktreeId that's already active.
    if (id === get().workspaceWorktreeId) return;
    set({
      workspaceWorktreeId: id,
      workspaceOpenTabs: [],
      workspaceOpenFilePath: null,
      workspaceOpenFileLine: null,
      workspaceEditToken: null,
      workspaceEditTokenExpiry: null,
    });
  },
  setWorkspaceOpenFile: (path, line, targetWorktreeId, originThreadId) => {
    if (path) {
      const stamp = { ts: Date.now(), threadId: originThreadId ?? get().currentThreadId };
      // Switch worktree if a different one is specified
      if (targetWorktreeId && targetWorktreeId !== get().workspaceWorktreeId) {
        set({
          workspaceWorktreeId: targetWorktreeId,
          workspaceOpenTabs: [path],
          workspaceOpenFilePath: path,
          workspaceOpenFileLine: line ?? null,
          workspaceEditToken: null,
          workspaceEditTokenExpiry: null,
          rightPanelMode: 'workspace',
          _workspaceFileSetAt: stamp,
        });
      } else {
        const tabs = get().workspaceOpenTabs;
        const newTabs = tabs.includes(path) ? tabs : [...tabs, path];
        set({
          workspaceOpenTabs: newTabs,
          workspaceOpenFilePath: path,
          workspaceOpenFileLine: line ?? null,
          rightPanelMode: 'workspace',
          _workspaceFileSetAt: stamp,
        });
      }
    } else {
      set({
        workspaceOpenFilePath: null,
        workspaceOpenFileLine: null,
      });
    }
  },
  closeWorkspaceTab: (path) => {
    const { workspaceOpenTabs: tabs, workspaceOpenFilePath: active } = get();
    const newTabs = tabs.filter((t) => t !== path);
    if (active === path) {
      const idx = tabs.indexOf(path);
      const next = newTabs[Math.min(idx, newTabs.length - 1)] ?? null;
      set({ workspaceOpenTabs: newTabs, workspaceOpenFilePath: next, workspaceOpenFileLine: null });
    } else {
      set({ workspaceOpenTabs: newTabs });
    }
  },
  restoreWorkspaceTabs: (tabs, openFile) => {
    set({
      workspaceOpenTabs: tabs,
      workspaceOpenFilePath: openFile,
      workspaceOpenFileLine: null,
      workspaceEditToken: null,
      workspaceEditTokenExpiry: null,
    });
  },
  setWorkspaceEditToken: (token, expiresIn) =>
    set({
      workspaceEditToken: token,
      workspaceEditTokenExpiry: token && expiresIn ? Date.now() + expiresIn * 1000 : null,
    }),

  workspaceRevealPath: null,
  setWorkspaceRevealPath: (path, originThreadId) =>
    set((state) => ({
      workspaceRevealPath: path,
      rightPanelMode: 'workspace' as const,
      _workspaceFileSetAt: { ts: Date.now(), threadId: originThreadId ?? state.currentThreadId },
    })),

  // Phase H: Workspace mode
  workspaceMode: 'dev' as const,
  setWorkspaceMode: (mode) => set({ workspaceMode: mode, rightPanelMode: 'workspace' }),

  // ── F120: Preview auto-open ──
  pendingPreviewAutoOpen: null,
  setPendingPreviewAutoOpen: (data) => set({ pendingPreviewAutoOpen: data, rightPanelMode: 'workspace' }),
  consumePreviewAutoOpen: () => {
    const pending = get().pendingPreviewAutoOpen;
    if (pending) set({ pendingPreviewAutoOpen: null });
    return pending;
  },

  // ── F63-AC15: Code-to-chat reference ──
  pendingChatInsert: null,
  setPendingChatInsert: (insert) => set({ pendingChatInsert: insert }),

  hubState: null,
  openHub: (tab, subTab) =>
    set({
      hubState: {
        open: true,
        tab,
        subTab,
        // Per-invocation nonce so HubObservabilityTab.useEffect fires even when
        // (tab, subTab) values repeat (e.g. user navigates away then re-clicks 详情).
        subTabNonce: Date.now() + Math.random(),
      },
    }),
  closeHub: () => set({ hubState: null }),
  showVoteModal: false,
  setShowVoteModal: (show) => set({ showVoteModal: show }),

  // ── Active-thread actions ──

  addMessage: (msg) =>
    set((state) => {
      if (state.messages.some((m) => m.id === msg.id)) return state;

      // TD112: Store-level dedup — merge if semantic duplicate exists
      const dupIdx = findAssistantDuplicate(state.messages, msg);
      if (dupIdx >= 0) {
        const merged = mergeAssistantBubble(state.messages[dupIdx]!, msg);
        const messages = [...state.messages];
        messages[dupIdx] = merged;
        recordDebugEvent({
          event: 'bubble_lifecycle',
          threadId: state.currentThreadId,
          timestamp: Date.now(),
          action: 'merge',
          reason: 'td112_store_dedup',
          catId: msg.catId,
          messageId: state.messages[dupIdx]!.id,
          invocationId: getBubbleInvocationId(msg),
          origin: msg.origin,
        });
        // P2 fix: propagate mention notification even on merge
        if (msg.mentionsUser && typeof document !== 'undefined' && !document.hasFocus()) {
          fireOwnerMentionNotification(msg);
        }
        return { messages };
      }

      const messages = insertOrAppendMessage(state.messages, msg);
      if (messages.length > MAX_BLOB_MESSAGES) {
        revokeBlobUrls(messages.slice(0, messages.length - MAX_BLOB_MESSAGES));
      }
      // F067: Notify on active thread when user is not focused
      if (msg.mentionsUser && typeof document !== 'undefined' && !document.hasFocus()) {
        fireOwnerMentionNotification(msg);
      }
      return { messages };
    }),

  removeMessage: (id) =>
    set((state) => ({
      messages: state.messages.filter((m) => m.id !== id),
    })),

  prependHistory: (msgs, hasMore) =>
    set((state) => {
      const existingIds = new Set(state.messages.map((m) => m.id));
      const newMsgs = msgs.filter((m) => !existingIds.has(m.id));
      return { messages: [...newMsgs, ...state.messages], hasMore };
    }),

  replaceMessages: (msgs, hasMore) =>
    set((state) => {
      revokeRemovedBlobUrls(state.messages, msgs);
      return { messages: msgs, hasMore };
    }),

  hydrateThread: (threadId, msgs, hasMore) => {
    // F173 Phase C Task 5+6+7 — atomic server-authoritative hydration that
    // honors KD-2 (threadStates is the writer source, flat is compat mirror).
    //
    // 砚砚 P1 (PR #1413): bare replaceMessages + IDB write doesn't mirror
    // to threadStates → background hydrate would pollute flat / current-
    // thread updates wouldn't keep threadStates in sync. This action is
    // *the* thread-scoped writer for hydration:
    //   - current thread: write flat + mirror to threadStates (single set())
    //   - non-current thread: write only threadStates, never touch flat
    set((state) => {
      if (threadId === state.currentThreadId) {
        revokeRemovedBlobUrls(state.messages, msgs);
        return {
          messages: msgs,
          hasMore,
          ...mirrorActiveFlat(state, { messages: msgs, hasMore }),
        };
      }
      // background hydrate — confined to threadStates, flat untouched.
      // 砚砚 P1 round 2 (PR #1413): cannot use mirrorActiveToThreadStates
      // here because its fallback base is snapshotActive(state) — that
      // would leak the active thread's liveness/queue/workspace into the
      // background thread when threadStates[threadId] doesn't exist yet.
      // Use DEFAULT_THREAD_STATE as base for never-seen threads instead.
      const baseThreadState = state.threadStates[threadId] ?? { ...DEFAULT_THREAD_STATE };
      // Cloud Codex P2 (PR #1413): revoke blob: URLs dropped by hydration
      // to avoid leaking object URLs (locally uploaded images stay alive
      // until reload otherwise). No-op when prev messages is [].
      revokeRemovedBlobUrls(baseThreadState.messages, msgs);
      return {
        threadStates: {
          ...state.threadStates,
          [threadId]: { ...baseThreadState, messages: msgs, hasMore },
        },
      };
    });
    // IDB overwrite (fire-and-forget). Only persist when thread is still
    // current — avoids race against a thread switch that already cleared
    // the outgoing thread's IDB snapshot.
    if (get().currentThreadId === threadId) {
      void saveMessagesSnapshot(threadId, msgs, hasMore).catch(() => {});
    }
  },

  replaceMessageId: (fromId, toId) =>
    set((state) => {
      const result = replaceMessageIdInList(state.messages, fromId, toId);
      if (result.messages === state.messages) return state;
      recordMessageIdDedupDrop(state.currentThreadId, result.droppedMessage, result.retainedMessage, toId);
      revokeRemovedBlobUrls(state.messages, result.messages);
      return { messages: result.messages };
    }),

  patchMessage: (id, patch) =>
    set((state) => {
      const nextMessages = patchMessageInList(state.messages, id, patch);
      if (nextMessages === state.messages) return state;
      return { messages: nextMessages };
    }),

  appendToLastMessage: (content) =>
    set((state) => {
      const messages = [...state.messages];
      const last = messages[messages.length - 1];
      if (last && last.type === 'assistant') {
        messages[messages.length - 1] = { ...last, content: last.content + content };
      }
      return { messages };
    }),

  appendToMessage: (id, content) =>
    set((state) => ({
      messages: state.messages.map((m) => (m.id === id ? { ...m, content: m.content + content } : m)),
    })),

  appendToolEvent: (id, event) =>
    set((state) => ({
      messages: state.messages.map((m) => (m.id === id ? { ...m, toolEvents: [...(m.toolEvents ?? []), event] } : m)),
    })),

  appendRichBlock: (id, block) =>
    set((state) => ({
      messages: state.messages.map((m) => {
        if (m.id !== id) return m;
        const rich = m.extra?.rich ?? { v: 1 as const, blocks: [] };
        // Defensive dedup by block.id (server already deduplicates, this is a safety net)
        if (rich.blocks.some((b: { id: string }) => b.id === block.id)) return m;
        return { ...m, extra: { ...m.extra, rich: { ...rich, blocks: [...rich.blocks, block] } } };
      }),
    })),

  /** F096: Update a specific rich block within a message (e.g. set disabled + selectedIds) */
  updateRichBlock: (messageId: string, blockId: string, patch: Record<string, unknown>) =>
    set((state) => ({
      messages: state.messages.map((m) => {
        if (m.id !== messageId || !m.extra?.rich?.blocks) return m;
        return {
          ...m,
          extra: {
            ...m.extra,
            rich: {
              ...m.extra.rich,
              blocks: m.extra.rich.blocks.map((b) => (b.id === blockId ? { ...b, ...patch } : b)),
            },
          },
        };
      }),
    })),

  setStreaming: (id, streaming) =>
    set((state) => ({
      messages: state.messages.map((m) => (m.id === id ? { ...m, isStreaming: streaming } : m)),
    })),

  setLoading: (loading) => set((state) => ({ isLoading: loading, ...mirrorActiveFlat(state, { isLoading: loading }) })),
  setThreadHasDraft: (threadId, hasDraft) =>
    set((state) => {
      if (threadId === state.currentThreadId) {
        if (state.hasDraft === hasDraft) return state;
        return { hasDraft };
      }

      const existing = state.threadStates[threadId] ?? { ...DEFAULT_THREAD_STATE };
      if ((existing.hasDraft ?? false) === hasDraft) return state;
      return {
        threadStates: {
          ...state.threadStates,
          [threadId]: {
            ...existing,
            hasDraft,
          },
        },
      };
    }),
  setHasActiveInvocation: (v) =>
    set((state) => {
      // Stamp completion time when transitioning active → inactive on the current thread,
      // so snapshotActive sees real completion time instead of stale message timestamps.
      if (!v && state.hasActiveInvocation) {
        return {
          hasActiveInvocation: false,
          threadStates: stampThreadCompletion(state.threadStates, state.currentThreadId, {
            hasActiveInvocation: false,
          }),
        };
      }
      return { hasActiveInvocation: v, ...mirrorActiveFlat(state, { hasActiveInvocation: v }) };
    }),
  /** F108: Register a new active invocation slot */
  addActiveInvocation: (invocationId, catId, mode, startedAt?) =>
    set((state) => {
      const activeInvocations = {
        ...state.activeInvocations,
        [invocationId]: { catId, mode, startedAt: startedAt ?? Date.now() },
      };
      return {
        activeInvocations,
        hasActiveInvocation: true,
        ...mirrorActiveFlat(state, { activeInvocations, hasActiveInvocation: true }),
      };
    }),
  /** F108: Remove an active invocation slot; derives hasActiveInvocation */
  removeActiveInvocation: (invocationId) =>
    set((state) => {
      if (!(invocationId in state.activeInvocations)) {
        const hasActive = Object.keys(state.activeInvocations).length > 0;
        if (!hasActive && state.hasActiveInvocation) {
          return {
            hasActiveInvocation: false,
            threadStates: stampThreadCompletion(state.threadStates, state.currentThreadId, {
              hasActiveInvocation: false,
            }),
          };
        }
        return { hasActiveInvocation: hasActive, ...mirrorActiveFlat(state, { hasActiveInvocation: hasActive }) };
      }
      const rest = Object.fromEntries(Object.entries(state.activeInvocations).filter(([k]) => k !== invocationId));
      const hasActive = Object.keys(rest).length > 0;
      // When the last invocation ends, stamp the completion time into threadStates
      // so snapshotActive's idle branch picks up the real "just finished streaming" time.
      return {
        activeInvocations: rest,
        hasActiveInvocation: hasActive,
        ...(!hasActive
          ? {
              threadStates: stampThreadCompletion(state.threadStates, state.currentThreadId, {
                activeInvocations: rest,
                hasActiveInvocation: hasActive,
              }),
            }
          : mirrorActiveFlat(state, { activeInvocations: rest, hasActiveInvocation: hasActive })),
      };
    }),
  /** F108: Clear all active invocations (timeout/error/stop recovery) */
  clearAllActiveInvocations: () =>
    set((state) => ({
      activeInvocations: {},
      hasActiveInvocation: false,
      threadStates: stampThreadCompletion(state.threadStates, state.currentThreadId, {
        activeInvocations: {},
        hasActiveInvocation: false,
      }),
    })),
  setLoadingHistory: (loading) => set({ isLoadingHistory: loading }),
  setIntentMode: (mode) => set((state) => ({ intentMode: mode, ...mirrorActiveFlat(state, { intentMode: mode }) })),

  setTargetCats: (cats) =>
    set((state) => {
      if (cats.length === 0) {
        return { targetCats: [], catStatuses: {}, ...mirrorActiveFlat(state, { targetCats: [], catStatuses: {} }) };
      }
      const merged = [...new Set([...state.targetCats, ...cats])];
      const statuses = { ...state.catStatuses };
      for (const c of cats) {
        if (!(c in statuses)) statuses[c] = 'pending' as const;
      }
      return {
        targetCats: merged,
        catStatuses: statuses,
        ...mirrorActiveFlat(state, { targetCats: merged, catStatuses: statuses }),
      };
    }),

  setCatStatus: (catId, status) =>
    set((state) => {
      if (state.catStatuses[catId] === status) return state;
      const catStatuses = { ...state.catStatuses, [catId]: status };
      return { catStatuses, ...mirrorActiveFlat(state, { catStatuses }) };
    }),

  clearCatStatuses: () =>
    set((state) => {
      // #586 Bug 2: Mark stale catInvocations taskProgress as completed so
      // RightStatusPanel stays consistent with catStatuses being cleared.
      // Cloud review P1: Only touch 'running' snapshots — preserve 'interrupted'
      // which is a distinct semantic state (user-initiated cancel, etc.).
      const cleanedInvocations: Record<string, import('./chat-types').CatInvocationInfo> = {};
      for (const [catId, info] of Object.entries(state.catInvocations)) {
        if (info.taskProgress?.snapshotStatus === 'running') {
          cleanedInvocations[catId] = {
            ...info,
            taskProgress: { ...info.taskProgress, snapshotStatus: 'completed' },
          };
        } else {
          cleanedInvocations[catId] = info;
        }
      }
      return {
        targetCats: [],
        catStatuses: {},
        catInvocations: cleanedInvocations,
        ...mirrorActiveFlat(state, { targetCats: [], catStatuses: {}, catInvocations: cleanedInvocations }),
      };
    }),

  /** F173 PR-C Task 10: thread-scoped equivalent of clearCatStatuses.
   *  Active path: clears flat targetCats / catStatuses + marks stale catInvocations
   *  completed AND mirrors to threadStates[active] (KD-2). Background path: same
   *  cleanup applied directly to threadStates[threadId]; flat untouched. */
  clearThreadCatStatuses: (threadId) =>
    set((state) => {
      const cleanInvocations = (
        src: Record<string, import('./chat-types').CatInvocationInfo>,
      ): Record<string, import('./chat-types').CatInvocationInfo> => {
        const out: Record<string, import('./chat-types').CatInvocationInfo> = {};
        for (const [catId, info] of Object.entries(src)) {
          if (info.taskProgress?.snapshotStatus === 'running') {
            out[catId] = { ...info, taskProgress: { ...info.taskProgress, snapshotStatus: 'completed' } };
          } else {
            out[catId] = info;
          }
        }
        return out;
      };
      if (threadId === state.currentThreadId) {
        const cleaned = cleanInvocations(state.catInvocations);
        const patch = { targetCats: [] as string[], catStatuses: {}, catInvocations: cleaned };
        return {
          targetCats: [],
          catStatuses: {},
          catInvocations: cleaned,
          ...mirrorActiveFlat(state, patch),
        };
      }
      const existing = state.threadStates[threadId];
      if (!existing) return state;
      const cleaned = cleanInvocations(existing.catInvocations);
      return {
        threadStates: {
          ...state.threadStates,
          [threadId]: {
            ...existing,
            targetCats: [],
            catStatuses: {},
            catInvocations: cleaned,
          },
        },
      };
    }),

  setCatInvocation: (catId, info) =>
    set((state) => {
      const catInvocations = {
        ...state.catInvocations,
        [catId]: { ...state.catInvocations[catId], ...info },
      };
      return { catInvocations, ...mirrorActiveFlat(state, { catInvocations }) };
    }),

  setMessageUsage: (messageId, usage) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId && m.metadata ? { ...m, metadata: { ...m.metadata, usage } } : m,
      ),
    })),

  setMessageMetadata: (messageId, metadata) => {
    // Skip if message already has metadata (avoid per-chunk re-render during streaming)
    const msg = get().messages.find((m) => m.id === messageId);
    if (msg?.metadata) return;
    set((state) => ({
      messages: state.messages.map((m) => (m.id === messageId ? { ...m, metadata } : m)),
    }));
  },

  setMessageThinking: (messageId, thinking) =>
    set((state) => ({
      messages: state.messages.map((m) => (m.id === messageId ? { ...m, ...appendThinkingChunk(m, thinking) } : m)),
    })),

  setMessageStreamInvocation: (messageId, invocationId) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId
          ? {
              ...m,
              extra: {
                ...m.extra,
                stream: { ...m.extra?.stream, invocationId },
              },
            }
          : m,
      ),
    })),

  clearMessages: () =>
    set((state) => {
      revokeBlobUrls(state.messages);
      return { messages: [], hasMore: true };
    }),

  streamCatchUpVersion: 0,
  streamCatchUpThreadId: null,
  requestStreamCatchUp: (threadId: string) =>
    set((state) => ({
      streamCatchUpVersion: state.streamCatchUpVersion + 1,
      streamCatchUpThreadId: threadId,
    })),

  setCurrentGame: (game) => set({ currentGame: game }),

  // ── Thread management ──

  setThreads: (threads) => {
    set({ threads });
    // F164: Write-through to IndexedDB (fire-and-forget)
    void saveThreadsSnapshot(threads).catch(() => {});
  },
  setCurrentProject: (projectPath) =>
    set((state) => (state.currentProjectPath === projectPath ? state : { currentProjectPath: projectPath })),
  setLoadingThreads: (loading) => set({ isLoadingThreads: loading }),
  setOfflineSnapshot: (v) => set({ isOfflineSnapshot: v }),

  updateThreadTitle: (threadId, title) =>
    set((state) => ({
      threads: state.threads.map((t) => (t.id === threadId ? { ...t, title } : t)),
    })),

  updateThreadParticipants: (threadId, participants) =>
    set((state) => ({
      threads: state.threads.map((t) => (t.id === threadId ? { ...t, participants } : t)),
    })),

  updateThreadPin: (threadId, pinned) =>
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId ? { ...t, pinned, pinnedAt: pinned ? Date.now() : null } : t,
      ),
    })),

  updateThreadFavorite: (threadId, favorited) =>
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId ? { ...t, favorited, favoritedAt: favorited ? Date.now() : null } : t,
      ),
    })),

  updateThreadThinkingMode: (threadId, mode) =>
    set((state) => ({
      threads: state.threads.map((t) => (t.id === threadId ? { ...t, thinkingMode: mode } : t)),
    })),

  updateThreadPreferredCats: (threadId, preferredCats) =>
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId ? { ...t, preferredCats: preferredCats.length > 0 ? preferredCats : undefined } : t,
      ),
    })),

  /**
   * Switch active thread.
   * Saves current flat state into threadStates map, then restores the target thread's state.
   * This is the key mechanism that preserves per-thread state across switches.
   */
  setCurrentThread: (threadId) =>
    set((state) => {
      if (threadId === state.currentThreadId) return state;

      // Save current flat state to map
      const saved = snapshotActive(state);
      // F164: Write-through outgoing thread's messages to IndexedDB (fire-and-forget)
      // Always write — even empty arrays — so server-cleared threads don't leave stale snapshots
      void saveMessagesSnapshot(state.currentThreadId, saved.messages, saved.hasMore).catch(() => {});
      // Load target thread state (or defaults for first visit)
      const loaded = state.threadStates[threadId] ?? { ...DEFAULT_THREAD_STATE };

      return {
        currentThreadId: threadId,
        threadStates: {
          ...state.threadStates,
          [state.currentThreadId]: saved,
        },
        ...flattenThread(loaded),
      };
    }),

  // ── Multi-thread actions ──

  /** Add a message to a specific thread (for background thread socket updates) */
  addMessageToThread: (threadId, msg) =>
    set((state) => {
      // Active thread — delegate to flat state
      if (threadId === state.currentThreadId) {
        if (state.messages.some((m) => m.id === msg.id)) return state;

        // TD112: Store-level dedup for active thread
        const dupIdx = findAssistantDuplicate(state.messages, msg);
        if (dupIdx >= 0) {
          const merged = mergeAssistantBubble(state.messages[dupIdx]!, msg);
          const messages = [...state.messages];
          messages[dupIdx] = merged;
          recordDebugEvent({
            event: 'bubble_lifecycle',
            threadId,
            timestamp: Date.now(),
            action: 'merge',
            reason: 'td112_store_dedup_active',
            catId: msg.catId,
            messageId: state.messages[dupIdx]!.id,
            invocationId: getBubbleInvocationId(msg),
            origin: msg.origin,
          });
          // P2 fix: propagate mention notification even on merge
          if (msg.mentionsUser && typeof document !== 'undefined' && !document.hasFocus()) {
            fireOwnerMentionNotification(msg);
          }
          return {
            messages,
            ...mirrorActiveToThreadStates(state, threadId, { messages }),
          };
        }

        const messages = insertOrAppendMessage(state.messages, msg);
        if (messages.length > MAX_BLOB_MESSAGES) {
          revokeBlobUrls(messages.slice(0, messages.length - MAX_BLOB_MESSAGES));
        }
        // F067: Notify even on active thread when tab is not focused
        // document.hidden is false when switching macOS apps (only true for tab switch/minimize)
        // document.hasFocus() correctly returns false when another app is in foreground
        if (msg.mentionsUser && typeof document !== 'undefined' && !document.hasFocus()) {
          fireOwnerMentionNotification(msg);
        }
        return {
          messages,
          ...mirrorActiveToThreadStates(state, threadId, { messages }),
        };
      }

      // Background thread — update map + increment unread
      const existing = state.threadStates[threadId] ?? { ...DEFAULT_THREAD_STATE };
      if (existing.messages.some((m) => m.id === msg.id)) return state;

      // TD112: Store-level dedup for background thread
      const bgDupIdx = findAssistantDuplicate(existing.messages, msg);
      if (bgDupIdx >= 0) {
        const merged = mergeAssistantBubble(existing.messages[bgDupIdx]!, msg);
        const updatedMessages = [...existing.messages];
        updatedMessages[bgDupIdx] = merged;
        recordDebugEvent({
          event: 'bubble_lifecycle',
          threadId,
          timestamp: Date.now(),
          action: 'merge',
          reason: 'td112_store_dedup_background',
          catId: msg.catId,
          messageId: existing.messages[bgDupIdx]!.id,
          invocationId: getBubbleInvocationId(msg),
          origin: msg.origin,
        });
        // Cloud review P1: Propagate mention state even on merge
        if (msg.mentionsUser) fireOwnerMentionNotification(msg);
        return {
          threadStates: {
            ...state.threadStates,
            [threadId]: {
              ...existing,
              messages: updatedMessages,
              hasUserMention: existing.hasUserMention || !!msg.mentionsUser,
            },
          },
        };
      }

      // F067 Phase 2: Fire macOS notification for @co-creator mention
      if (msg.mentionsUser) fireOwnerMentionNotification(msg);

      return {
        threadStates: {
          ...state.threadStates,
          [threadId]: {
            ...existing,
            messages: insertOrAppendMessage(existing.messages, msg),
            unreadCount: existing.unreadCount + 1,
            hasUserMention: existing.hasUserMention || !!msg.mentionsUser,
            lastActivity: Date.now(),
          },
        },
      };
    }),

  removeThreadMessage: (threadId, messageId) =>
    set((state) => {
      if (threadId === state.currentThreadId) {
        const nextMessages = state.messages.filter((m) => m.id !== messageId);
        if (nextMessages.length === state.messages.length) return state;
        revokeRemovedBlobUrls(state.messages, nextMessages);
        return { messages: nextMessages };
      }

      const existing = state.threadStates[threadId];
      if (!existing) return state;
      const nextMessages = existing.messages.filter((m) => m.id !== messageId);
      if (nextMessages.length === existing.messages.length) return state;
      revokeRemovedBlobUrls(existing.messages, nextMessages);
      return {
        threadStates: {
          ...state.threadStates,
          [threadId]: {
            ...existing,
            messages: nextMessages,
            lastActivity: Date.now(),
          },
        },
      };
    }),

  replaceThreadMessageId: (threadId, fromId, toId) =>
    set((state) => {
      if (threadId === state.currentThreadId) {
        const result = replaceMessageIdInList(state.messages, fromId, toId);
        if (result.messages === state.messages) return state;
        recordMessageIdDedupDrop(threadId, result.droppedMessage, result.retainedMessage, toId);
        revokeRemovedBlobUrls(state.messages, result.messages);
        return { messages: result.messages };
      }

      const existing = state.threadStates[threadId];
      if (!existing) return state;

      const result = replaceMessageIdInList(existing.messages, fromId, toId);
      if (result.messages === existing.messages) return state;
      recordMessageIdDedupDrop(threadId, result.droppedMessage, result.retainedMessage, toId);
      revokeRemovedBlobUrls(existing.messages, result.messages);
      return {
        threadStates: {
          ...state.threadStates,
          [threadId]: {
            ...existing,
            messages: result.messages,
            lastActivity: Date.now(),
          },
        },
      };
    }),

  patchThreadMessage: (threadId, messageId, patch) =>
    set((state) => updateThreadMessage(state, threadId, messageId, (m) => applyMessagePatch(m, patch))),

  /** Append chunk content to a specific message in a specific thread. */
  appendToThreadMessage: (threadId, messageId, content) =>
    set((state) =>
      updateThreadMessage(state, threadId, messageId, (m) => ({
        ...m,
        content: m.content + content,
      })),
    ),

  /** Append tool event to a specific assistant message in a specific thread. */
  appendToolEventToThread: (threadId, messageId, event) =>
    set((state) =>
      updateThreadMessage(state, threadId, messageId, (m) => ({
        ...m,
        toolEvents: [...(m.toolEvents ?? []), event],
      })),
    ),

  /** F22: Append a rich block to a message in a specific thread. */
  appendRichBlockToThread: (threadId, messageId, block) =>
    set((state) =>
      updateThreadMessage(state, threadId, messageId, (m) => {
        const rich = m.extra?.rich ?? { v: 1 as const, blocks: [] };
        if (rich.blocks.some((b: { id: string }) => b.id === block.id)) return m;
        return { ...m, extra: { ...m.extra, rich: { ...rich, blocks: [...rich.blocks, block] } } };
      }),
    ),

  /** Set/merge cat invocation info for a specific thread (active or background). */
  setThreadCatInvocation: (threadId, catId, info) =>
    set((state) => {
      if (threadId === state.currentThreadId) {
        const catInvocations = {
          ...state.catInvocations,
          [catId]: { ...state.catInvocations[catId], ...info },
        };
        return {
          catInvocations,
          ...mirrorActiveToThreadStates(state, threadId, { catInvocations }),
        };
      }
      const existing = state.threadStates[threadId] ?? { ...DEFAULT_THREAD_STATE };
      return {
        threadStates: {
          ...state.threadStates,
          [threadId]: {
            ...existing,
            catInvocations: {
              ...existing.catInvocations,
              [catId]: { ...existing.catInvocations[catId], ...info },
            },
            lastActivity: Date.now(),
          },
        },
      };
    }),

  /** Set/merge metadata on a specific message in a specific thread (active or background). */
  setThreadMessageMetadata: (threadId, messageId, metadata) =>
    set((state) =>
      updateThreadMessage(state, threadId, messageId, (m) => ({
        ...m,
        metadata: m.metadata ? { ...m.metadata, ...metadata } : metadata,
      })),
    ),

  /** Set usage on a specific message in a specific thread (active or background). */
  setThreadMessageUsage: (threadId, messageId, usage) =>
    set((state) =>
      updateThreadMessage(state, threadId, messageId, (m) =>
        m.metadata ? { ...m, metadata: { ...m.metadata, usage } } : m,
      ),
    ),

  /** F045: Set/append extended thinking on an assistant message in a background thread. */
  setThreadMessageThinking: (threadId, messageId, thinking) =>
    set((state) =>
      updateThreadMessage(state, threadId, messageId, (m) => ({
        ...m,
        ...appendThinkingChunk(m, thinking),
      })),
    ),

  setThreadMessageStreamInvocation: (threadId, messageId, invocationId) =>
    set((state) =>
      updateThreadMessage(state, threadId, messageId, (m) => ({
        ...m,
        extra: {
          ...m.extra,
          stream: { ...m.extra?.stream, invocationId },
        },
      })),
    ),

  /** Update isStreaming for a specific message in a specific thread. */
  setThreadMessageStreaming: (threadId, messageId, streaming) =>
    set((state) =>
      updateThreadMessage(state, threadId, messageId, (m) => ({
        ...m,
        isStreaming: streaming,
      })),
    ),

  /** Update isLoading for a specific thread (active or background). */
  setThreadLoading: (threadId, loading) =>
    set((state) => {
      if (threadId === state.currentThreadId) {
        return {
          isLoading: loading,
          ...mirrorActiveToThreadStates(state, threadId, { isLoading: loading }),
        };
      }
      const existing = state.threadStates[threadId] ?? { ...DEFAULT_THREAD_STATE };
      return {
        threadStates: {
          ...state.threadStates,
          [threadId]: {
            ...existing,
            isLoading: loading,
            lastActivity: Date.now(),
          },
        },
      };
    }),

  /** Update hasActiveInvocation for a specific thread (active or background). */
  setThreadHasActiveInvocation: (threadId, active) =>
    set((state) => {
      if (threadId === state.currentThreadId) {
        return {
          hasActiveInvocation: active,
          ...mirrorActiveToThreadStates(state, threadId, { hasActiveInvocation: active }),
        };
      }
      const existing = state.threadStates[threadId] ?? { ...DEFAULT_THREAD_STATE };
      return {
        threadStates: {
          ...state.threadStates,
          [threadId]: {
            ...existing,
            hasActiveInvocation: active,
            lastActivity: Date.now(),
          },
        },
      };
    }),

  /** F108: Add an active invocation to a thread (background or active) */
  addThreadActiveInvocation: (threadId, invocationId, catId, mode, startedAt?) =>
    set((state) => {
      const ts = startedAt ?? Date.now();
      if (threadId === state.currentThreadId) {
        const activeInvocations = {
          ...state.activeInvocations,
          [invocationId]: { catId, mode, startedAt: ts },
        };
        return {
          activeInvocations,
          hasActiveInvocation: true,
          ...mirrorActiveToThreadStates(state, threadId, { activeInvocations, hasActiveInvocation: true }),
        };
      }
      const existing = state.threadStates[threadId] ?? { ...DEFAULT_THREAD_STATE };
      const activeInvocations = {
        ...existing.activeInvocations,
        [invocationId]: { catId, mode, startedAt: ts },
      };
      return {
        threadStates: {
          ...state.threadStates,
          [threadId]: { ...existing, activeInvocations, hasActiveInvocation: true, lastActivity: Date.now() },
        },
      };
    }),

  /** F108: Remove an active invocation from a thread; derives hasActiveInvocation */
  removeThreadActiveInvocation: (threadId, invocationId) =>
    set((state) => {
      if (threadId === state.currentThreadId) {
        const rest = Object.fromEntries(Object.entries(state.activeInvocations).filter(([k]) => k !== invocationId));
        const hasActiveInvocation = Object.keys(rest).length > 0;
        return {
          activeInvocations: rest,
          hasActiveInvocation,
          ...mirrorActiveToThreadStates(state, threadId, { activeInvocations: rest, hasActiveInvocation }),
        };
      }
      const existing = state.threadStates[threadId];
      if (!existing) return state;
      const rest = Object.fromEntries(Object.entries(existing.activeInvocations).filter(([k]) => k !== invocationId));
      return {
        threadStates: stampThreadCompletion(state.threadStates, threadId, {
          activeInvocations: rest,
          hasActiveInvocation: Object.keys(rest).length > 0,
        }),
      };
    }),

  /** F108: Clear all active invocations for a thread (cancel fallback when invocationId unknown). */
  clearAllThreadActiveInvocations: (threadId) =>
    set((state) => {
      if (threadId === state.currentThreadId) {
        return {
          activeInvocations: {},
          hasActiveInvocation: false,
          threadStates: stampThreadCompletion(state.threadStates, state.currentThreadId, {
            activeInvocations: {},
            hasActiveInvocation: false,
          }),
        };
      }
      const existing = state.threadStates[threadId];
      if (!existing) return state;
      return {
        threadStates: stampThreadCompletion(state.threadStates, threadId, {
          activeInvocations: {},
          hasActiveInvocation: false,
        }),
      };
    }),

  /** Update intentMode for a specific thread (active or background).
   *  Also resets catStatuses — new intent mode = new invocation = fresh statuses. */
  setThreadIntentMode: (threadId, mode) =>
    set((state) => {
      if (threadId === state.currentThreadId) {
        return {
          intentMode: mode,
          catStatuses: {},
          ...mirrorActiveToThreadStates(state, threadId, { intentMode: mode, catStatuses: {} }),
        };
      }
      const existing = state.threadStates[threadId] ?? { ...DEFAULT_THREAD_STATE };
      return {
        threadStates: {
          ...state.threadStates,
          [threadId]: {
            ...existing,
            intentMode: mode,
            catStatuses: {},
            lastActivity: Date.now(),
          },
        },
      };
    }),

  /** Update targetCats for a specific thread (active or background).
   *  Also pre-seeds catStatuses with 'pending' — mirrors active setTargetCats
   *  so ThreadCatStatus renders the working indicator immediately. */
  setThreadTargetCats: (threadId, cats) =>
    set((state) => {
      if (threadId === state.currentThreadId) {
        if (cats.length === 0) {
          return {
            targetCats: [],
            catStatuses: {},
            ...mirrorActiveToThreadStates(state, threadId, { targetCats: [], catStatuses: {} }),
          };
        }
        const merged = [...new Set([...state.targetCats, ...cats])];
        const statuses = { ...state.catStatuses };
        for (const c of cats) {
          if (!(c in statuses)) statuses[c] = 'pending' as const;
        }
        return {
          targetCats: merged,
          catStatuses: statuses,
          ...mirrorActiveToThreadStates(state, threadId, { targetCats: merged, catStatuses: statuses }),
        };
      }
      const existing = state.threadStates[threadId] ?? { ...DEFAULT_THREAD_STATE };
      if (cats.length === 0) {
        return {
          threadStates: {
            ...state.threadStates,
            [threadId]: { ...existing, targetCats: [], catStatuses: {}, lastActivity: Date.now() },
          },
        };
      }
      const prevCats = existing.targetCats ?? [];
      const prevStatuses = (existing.catStatuses ?? {}) as Record<string, CatStatusType>;
      const merged = [...new Set([...prevCats, ...cats])];
      const statuses: Record<string, CatStatusType> = { ...prevStatuses };
      for (const c of cats) {
        if (!(c in statuses)) statuses[c] = 'pending' as const;
      }
      return {
        threadStates: {
          ...state.threadStates,
          [threadId]: {
            ...existing,
            targetCats: merged,
            catStatuses: statuses,
            lastActivity: Date.now(),
          },
        },
      };
    }),

  /** Server-authoritative replace for queue hydration / history restore.
   *  Unlike setThreadTargetCats (merge), this overwrites targetCats entirely
   *  so stale cats are removed. */
  replaceThreadTargetCats: (threadId, cats) =>
    set((state) => {
      if (threadId === state.currentThreadId) {
        if (cats.length === 0) {
          return {
            targetCats: [],
            catStatuses: {},
            ...mirrorActiveToThreadStates(state, threadId, { targetCats: [], catStatuses: {} }),
          };
        }
        const statuses: Record<string, CatStatusType> = {};
        for (const c of cats) statuses[c] = 'pending' as const;
        const targetCats = [...cats];
        return {
          targetCats,
          catStatuses: statuses,
          ...mirrorActiveToThreadStates(state, threadId, { targetCats, catStatuses: statuses }),
        };
      }
      const existing = state.threadStates[threadId] ?? { ...DEFAULT_THREAD_STATE };
      if (cats.length === 0) {
        return {
          threadStates: {
            ...state.threadStates,
            [threadId]: { ...existing, targetCats: [], catStatuses: {}, lastActivity: Date.now() },
          },
        };
      }
      const statuses: Record<string, CatStatusType> = {};
      for (const c of cats) statuses[c] = 'pending' as const;
      return {
        threadStates: {
          ...state.threadStates,
          [threadId]: {
            ...existing,
            targetCats: [...cats],
            catStatuses: statuses,
            lastActivity: Date.now(),
          },
        },
      };
    }),

  /** Get a thread's state (active thread returns flat state, others return map) */
  getThreadState: (threadId) => {
    const state = get();
    if (threadId === state.currentThreadId) return snapshotActive(state);
    return state.threadStates[threadId] ?? { ...DEFAULT_THREAD_STATE };
  },

  incrementUnread: (threadId) =>
    set((state) => {
      if (threadId === state.currentThreadId) return state;
      const ts = state.threadStates[threadId];
      if (!ts) return state;
      return {
        threadStates: {
          ...state.threadStates,
          [threadId]: { ...ts, unreadCount: ts.unreadCount + 1 },
        },
      };
    }),

  clearUnread: (threadId) =>
    set((state) => {
      const ts = state.threadStates[threadId];
      if (!ts || (ts.unreadCount === 0 && !ts.hasUserMention)) return state;
      // #586 Bug 3: Use Infinity instead of 10s timeout. Suppression persists
      // until confirmUnreadAck() is called after POST /read/latest succeeds,
      // preventing stale server unread counts from overwriting cleared state.
      return {
        threadStates: {
          ...state.threadStates,
          [threadId]: { ...ts, unreadCount: 0, hasUserMention: false },
        },
        _unreadSuppressedUntil: {
          ...state._unreadSuppressedUntil,
          [threadId]: Infinity,
        },
      };
    }),

  clearAllUnread: () =>
    set((state) => {
      const updated: Record<string, ThreadState> = {};
      // #586 P1-1 fix: clearAllUnread is called AFTER POST /mark-all succeeds
      // (server cursors already updated), so a short grace window suffices.
      // Using Infinity here would permanently block initThreadUnread for threads
      // the user never opens (no ChatContainer ack effect to release them).
      const suppressUntil = Date.now() + 30_000;
      const suppressed: Record<string, number> = { ...state._unreadSuppressedUntil };
      let changed = false;
      for (const [tid, ts] of Object.entries(state.threadStates)) {
        if (ts.unreadCount > 0 || ts.hasUserMention) {
          updated[tid] = { ...ts, unreadCount: 0, hasUserMention: false };
          suppressed[tid] = suppressUntil;
          changed = true;
        } else {
          updated[tid] = ts;
        }
      }
      return changed ? { threadStates: updated, _unreadSuppressedUntil: suppressed } : state;
    }),

  confirmUnreadAck: (threadId) =>
    set((state) => {
      // #586 final: Decrement pending ack count. Only clear suppression when
      // ALL in-flight acks have resolved — this prevents an early-resolving ack
      // from clearing suppression while a newer ack is still in flight.
      const count = Math.max(0, (state._pendingAckCount[threadId] ?? 1) - 1);
      const newCounts = { ...state._pendingAckCount, [threadId]: count };
      if (count > 0) {
        // Still have pending acks — keep suppression, just update counter
        return { _pendingAckCount: newCounts };
      }
      // All acks resolved — safe to clear suppression
      if (!state._unreadSuppressedUntil[threadId]) return { _pendingAckCount: newCounts };
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [threadId]: _removed, ...rest } = state._unreadSuppressedUntil;
      return { _unreadSuppressedUntil: rest, _pendingAckCount: newCounts };
    }),

  armUnreadSuppression: (threadId) =>
    set((state) => ({
      // #586 final: Increment pending ack count + set Infinity suppression.
      // Each ack attempt increments; confirmUnreadAck decrements. Suppression
      // only clears when counter reaches 0 (all in-flight acks resolved).
      _unreadSuppressedUntil: {
        ...state._unreadSuppressedUntil,
        [threadId]: Infinity,
      },
      _pendingAckCount: {
        ...state._pendingAckCount,
        [threadId]: (state._pendingAckCount[threadId] ?? 0) + 1,
      },
    })),

  initThreadUnread: (threadId, unreadCount, hasUserMention) =>
    set((state) => {
      if (threadId === state.currentThreadId) return state;
      // Skip re-hydration if this thread was recently cleared (ack race suppression)
      const suppressUntil = state._unreadSuppressedUntil[threadId];
      if (suppressUntil && Date.now() < suppressUntil) return state;
      const existing = state.threadStates[threadId] ?? { ...DEFAULT_THREAD_STATE };
      if (existing.unreadCount === unreadCount && existing.hasUserMention === hasUserMention) return state;
      return {
        threadStates: {
          ...state.threadStates,
          [threadId]: { ...existing, unreadCount, hasUserMention },
        },
      };
    }),

  /** Update a specific cat's status in a background thread (for sidebar indicators) */
  updateThreadCatStatus: (threadId, catId, status) =>
    set((state) => {
      if (threadId === state.currentThreadId) {
        if (state.catStatuses[catId] === status) return state;
        const catStatuses = { ...state.catStatuses, [catId]: status };
        return { catStatuses, ...mirrorActiveToThreadStates(state, threadId, { catStatuses }) };
      }
      const existing = state.threadStates[threadId] ?? { ...DEFAULT_THREAD_STATE };
      if (existing.catStatuses[catId] === status) return state;
      return {
        threadStates: {
          ...state.threadStates,
          [threadId]: {
            ...existing,
            catStatuses: { ...existing.catStatuses, [catId]: status },
            lastActivity: Date.now(),
          },
        },
      };
    }),

  batchStreamChunkUpdate: ({ threadId, messageId, catId, content, metadata, streaming, catStatus }) =>
    set((state) => {
      const applyMessageUpdate = (m: ChatMessage): ChatMessage => {
        if (m.id !== messageId) return m;
        return {
          ...m,
          content: m.content + content,
          ...(metadata ? { metadata: m.metadata ? { ...m.metadata, ...metadata } : metadata } : {}),
          isStreaming: streaming,
        };
      };

      if (threadId === state.currentThreadId) {
        const statusChanged = state.catStatuses[catId] !== catStatus;
        const messages = state.messages.map(applyMessageUpdate);
        const newCatStatuses = statusChanged ? { ...state.catStatuses, [catId]: catStatus } : state.catStatuses;
        return {
          messages,
          ...(statusChanged ? { catStatuses: newCatStatuses } : {}),
          ...mirrorActiveToThreadStates(state, threadId, {
            messages,
            ...(statusChanged ? { catStatuses: newCatStatuses } : {}),
          }),
        };
      }

      const existing = state.threadStates[threadId];
      if (!existing) return state;
      const statusChanged = existing.catStatuses[catId] !== catStatus;
      return {
        threadStates: {
          ...state.threadStates,
          [threadId]: {
            ...existing,
            messages: existing.messages.map(applyMessageUpdate),
            ...(statusChanged ? { catStatuses: { ...existing.catStatuses, [catId]: catStatus } } : {}),
            lastActivity: Date.now(),
          },
        },
      };
    }),

  /** Clear hasActiveInvocation for a specific thread (active or background) */
  clearThreadActiveInvocation: (threadId) =>
    set((state) => {
      // Active-thread clear is used by hydration/reconciliation paths to drop stale slots.
      // Do not stamp lastActivity here: that would turn routine state repair into fake recency.
      // Real completion paths stamp via removeActiveInvocation / setHasActiveInvocation(false) /
      // clearAllActiveInvocations / resetThreadInvocationState.
      if (threadId === state.currentThreadId) {
        // F173 KD-2 (PR-C Task 10): mirror to threadStates[active] so reconcile
        // sees the same view it would on a background thread.
        const patch = { hasActiveInvocation: false, activeInvocations: {} };
        return {
          hasActiveInvocation: false,
          activeInvocations: {},
          ...mirrorActiveFlat(state, patch),
        };
      }
      // Background thread — update in threadStates map (no-op if unknown)
      const ts = state.threadStates[threadId];
      if (!ts) return state;
      return {
        threadStates: {
          ...state.threadStates,
          [threadId]: { ...ts, hasActiveInvocation: false, activeInvocations: {} },
        },
      };
    }),

  /** Clear invocation-scoped UI state for a specific thread (active or background) */
  resetThreadInvocationState: (threadId) =>
    set((state) => {
      const resetPatch = {
        isLoading: false,
        hasActiveInvocation: false,
        intentMode: null,
        targetCats: [] as string[],
        catStatuses: {} as Record<string, CatStatusType>,
      };

      // Active thread — clear flat state + stamp completion time
      if (threadId === state.currentThreadId) {
        return {
          ...resetPatch,
          threadStates: stampThreadCompletion(state.threadStates, state.currentThreadId),
        };
      }

      // Background thread — update in threadStates map (no-op if unknown)
      const ts = state.threadStates[threadId];
      if (!ts) return state;
      return {
        threadStates: stampThreadCompletion(state.threadStates, threadId, resetPatch),
      };
    }),

  setViewMode: (mode) => set({ viewMode: mode }),
  setSplitPaneThreadIds: (ids) => set({ splitPaneThreadIds: ids }),
  setSplitPaneTarget: (threadId) => set({ splitPaneTargetId: threadId }),
}));
