import { CAT_CONFIGS } from '@cat-cafe/shared';
import { create } from 'zustand';
import { getBubbleInvocationId } from '@/debug/bubbleIdentity';
import { recordDebugEvent } from '@/debug/invocationEventDebug';
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
function snapshotActive(s: ChatState): ThreadState {
  return {
    messages: s.messages,
    isLoading: s.isLoading,
    isLoadingHistory: s.isLoadingHistory,
    hasMore: s.hasMore,
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
  const catConfig = CAT_CONFIGS[msg.catId ?? ''];
  const catName = catConfig?.displayName ?? msg.catId ?? '猫猫';
  const preview = typeof msg.content === 'string' ? msg.content.replace(/\n/g, ' ').slice(0, 120) : '';
  new Notification(`${catName} @ 了你`, {
    body: preview,
    icon: catConfig?.avatar ?? '/favicon.ico',
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

/** Merge incoming message into existing, preferring callback content over stream */
function mergeAssistantBubble(existing: ChatMessage, incoming: ChatMessage): ChatMessage {
  // Bridge rule: backfill invocationId from callback into stream placeholder
  const incomingInvId = getBubbleInvocationId(incoming);
  const existingInvId = getBubbleInvocationId(existing);
  const mergedExtra = { ...existing.extra };
  if (incomingInvId && !existingInvId) {
    mergedExtra.stream = { ...mergedExtra.stream, invocationId: incomingInvId };
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
    // Preserve extra from existing (CLI Output) + merge stream identity + crossPost
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
    return {
      messages: state.messages.map((m) => (m.id === messageId ? updater(m) : m)),
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

interface ChatState {
  // Per-thread state (flat — reflects the active thread for backward compat)
  messages: ChatMessage[];
  isLoading: boolean;
  isLoadingHistory: boolean;
  hasMore: boolean;
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
  hubState: { open: boolean; tab?: string } | null;
  openHub: (tab?: string) => void;
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
        // F117: Insert user bubbles for queue-sent messages not yet in the store
        if (serverMessages) {
          const existingIds = new Set(updated.map((m) => m.id));
          for (const sm of serverMessages) {
            if (!existingIds.has(sm.id)) {
              updated.push({
                id: sm.id,
                type: 'user',
                content: sm.content,
                timestamp: sm.timestamp,
                deliveredAt,
                contentBlocks: sm.contentBlocks as ChatMessage['contentBlocks'],
              });
            }
          }
          // Re-sort: delivered messages use deliveredAt so they appear at delivery
          // position (current tail), not their original send-time slot.
          updated.sort((a, b) => (a.deliveredAt ?? a.timestamp) - (b.deliveredAt ?? b.timestamp));
        }
        return updated;
      };

      if (threadId === state.currentThreadId) {
        return { messages: updateMsgs(state.messages) };
      }
      const existing = state.threadStates[threadId];
      if (!existing) return state;
      return {
        threadStates: {
          ...state.threadStates,
          [threadId]: { ...existing, messages: updateMsgs(existing.messages) },
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
  openHub: (tab) => set({ hubState: { open: true, tab } }),
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

      const messages = [...state.messages, msg];
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

  setLoading: (loading) => set({ isLoading: loading }),
  setHasActiveInvocation: (v) =>
    set((state) => {
      // Stamp completion time when transitioning active → inactive on the current thread,
      // so snapshotActive sees real completion time instead of stale message timestamps.
      if (!v && state.hasActiveInvocation) {
        return {
          hasActiveInvocation: false,
          threadStates: stampThreadCompletion(state.threadStates, state.currentThreadId),
        };
      }
      return { hasActiveInvocation: v };
    }),
  /** F108: Register a new active invocation slot */
  addActiveInvocation: (invocationId, catId, mode, startedAt?) =>
    set((state) => {
      const activeInvocations = {
        ...state.activeInvocations,
        [invocationId]: { catId, mode, startedAt: startedAt ?? Date.now() },
      };
      return { activeInvocations, hasActiveInvocation: true };
    }),
  /** F108: Remove an active invocation slot; derives hasActiveInvocation */
  removeActiveInvocation: (invocationId) =>
    set((state) => {
      if (!(invocationId in state.activeInvocations)) {
        const hasActive = Object.keys(state.activeInvocations).length > 0;
        if (!hasActive && state.hasActiveInvocation) {
          return {
            hasActiveInvocation: false,
            threadStates: stampThreadCompletion(state.threadStates, state.currentThreadId),
          };
        }
        return { hasActiveInvocation: hasActive };
      }
      const rest = Object.fromEntries(Object.entries(state.activeInvocations).filter(([k]) => k !== invocationId));
      const hasActive = Object.keys(rest).length > 0;
      // When the last invocation ends, stamp the completion time into threadStates
      // so snapshotActive's idle branch picks up the real "just finished streaming" time.
      return {
        activeInvocations: rest,
        hasActiveInvocation: hasActive,
        ...(!hasActive ? { threadStates: stampThreadCompletion(state.threadStates, state.currentThreadId) } : {}),
      };
    }),
  /** F108: Clear all active invocations (timeout/error/stop recovery) */
  clearAllActiveInvocations: () =>
    set((state) => ({
      activeInvocations: {},
      hasActiveInvocation: false,
      threadStates: stampThreadCompletion(state.threadStates, state.currentThreadId),
    })),
  setLoadingHistory: (loading) => set({ isLoadingHistory: loading }),
  setIntentMode: (mode) => set({ intentMode: mode }),

  setTargetCats: (cats) =>
    set((state) => {
      if (cats.length === 0) return { targetCats: [], catStatuses: {} };
      const merged = [...new Set([...state.targetCats, ...cats])];
      const statuses = { ...state.catStatuses };
      for (const c of cats) {
        if (!(c in statuses)) statuses[c] = 'pending' as const;
      }
      return { targetCats: merged, catStatuses: statuses };
    }),

  setCatStatus: (catId, status) =>
    set((state) => {
      if (state.catStatuses[catId] === status) return state;
      return { catStatuses: { ...state.catStatuses, [catId]: status } };
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
      return { targetCats: [], catStatuses: {}, catInvocations: cleanedInvocations };
    }),

  setCatInvocation: (catId, info) =>
    set((state) => ({
      catInvocations: {
        ...state.catInvocations,
        [catId]: { ...state.catInvocations[catId], ...info },
      },
    })),

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
      messages: state.messages.map((m) =>
        m.id === messageId ? { ...m, thinking: m.thinking ? `${m.thinking}\n\n---\n\n${thinking}` : thinking } : m,
      ),
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
          return { messages };
        }

        const messages = [...state.messages, msg];
        if (messages.length > MAX_BLOB_MESSAGES) {
          revokeBlobUrls(messages.slice(0, messages.length - MAX_BLOB_MESSAGES));
        }
        // F067: Notify even on active thread when tab is not focused
        // document.hidden is false when switching macOS apps (only true for tab switch/minimize)
        // document.hasFocus() correctly returns false when another app is in foreground
        if (msg.mentionsUser && typeof document !== 'undefined' && !document.hasFocus()) {
          fireOwnerMentionNotification(msg);
        }
        return { messages };
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
            messages: [...existing.messages, msg],
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
        return {
          catInvocations: {
            ...state.catInvocations,
            [catId]: { ...state.catInvocations[catId], ...info },
          },
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
        thinking: m.thinking ? `${m.thinking}\n\n---\n\n${thinking}` : thinking,
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
        return { isLoading: loading };
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
        return { hasActiveInvocation: active };
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
        return { activeInvocations, hasActiveInvocation: true };
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
        return { activeInvocations: rest, hasActiveInvocation: Object.keys(rest).length > 0 };
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
          threadStates: stampThreadCompletion(state.threadStates, state.currentThreadId),
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
        return { intentMode: mode, catStatuses: {} };
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
        if (cats.length === 0) return { targetCats: [], catStatuses: {} };
        const merged = [...new Set([...state.targetCats, ...cats])];
        const statuses = { ...state.catStatuses };
        for (const c of cats) {
          if (!(c in statuses)) statuses[c] = 'pending' as const;
        }
        return { targetCats: merged, catStatuses: statuses };
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
        if (cats.length === 0) return { targetCats: [], catStatuses: {} };
        const statuses: Record<string, CatStatusType> = {};
        for (const c of cats) statuses[c] = 'pending' as const;
        return { targetCats: [...cats], catStatuses: statuses };
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
        return { catStatuses: { ...state.catStatuses, [catId]: status } };
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
        return {
          messages: state.messages.map(applyMessageUpdate),
          ...(statusChanged ? { catStatuses: { ...state.catStatuses, [catId]: catStatus } } : {}),
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
        return {
          hasActiveInvocation: false,
          activeInvocations: {},
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
