'use client';

import { type CliDiagnostics, type ReplyPreview, timelineMessageKind } from '@cat-cafe/shared';
import { type MouseEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useThreadChatHistoryAdmission } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import { recordDebugEvent } from '@/debug/invocationEventDebug';
import { selectThreadMessagesRaw } from '@/hooks/useThreadScopedSelectors';
import { resolveProviderSemanticMessage } from '@/lib/provider-semantic-registry';
import type { QueueEntry, TaskProgressItem, TimeoutDiagnostics } from '@/stores/chat-types';
import {
  type ChatMessage as ChatMessageData,
  captureThreadWorkspaceState,
  hydrateThreadWorkspaceState,
  useChatStore,
} from '@/stores/chatStore';
import {
  findEarliestMessageByCursor,
  getMessageTimelineCursorTime,
  getMessageTimelineOrderTime,
} from '@/stores/message-timeline';
import type { TaskItem } from '@/stores/taskStore';
import { useTaskStore } from '@/stores/taskStore';
import { apiFetch } from '@/utils/api-client';
import { CHAT_LAYOUT_CHANGED_EVENT, readChatLayoutViewportAnchor } from '@/utils/chat-layout-change';
import {
  describeChatReadingAnchor,
  findChatReadingSuccessor,
  readChatScrollState,
  resolveChatReadingAnchor,
  type SavedScrollState,
  saveChatScrollState,
} from '@/utils/chat-scroll-memory';
import {
  findCrossPostTargetMessageId,
  peekPendingCrossPostScroll,
  resolveCrossPostScrollTarget,
} from '@/utils/crosspost-scroll-target';
import {
  loadThreadMessages as loadCachedMessages,
  loadThreadActiveState,
  loadThreadWorkspaceState,
  saveThreadMessages as saveMessagesSnapshot,
  saveThreadActiveState,
} from '@/utils/offline-store';
import {
  captureMessageScrollAnchor,
  captureMessageScrollAnchorForElement,
  captureMessageScrollAnchorForMessage,
  MESSAGE_VIEWPORT_MOUNTED_EVENT,
  type MessageScrollAnchor,
  restoreMessageScrollAnchor,
  restoreTimelineScrollAnchor,
  scrollToMessage,
  type TimelineScrollAnchor,
} from '@/utils/scrollToMessage';
import {
  peekPendingTeleport,
  resolvePendingTeleport,
  shouldLoadOlderForTeleport,
  TELEPORT_RESOLVE_EVENT,
} from '@/utils/teleport';
import { hydrateQueueActiveInvocationSlots, type QueueActiveInvocationSlot } from './queue-active-invocation-hydration';
import { useViewportMessageTimeline } from './useViewportMessageTimeline';

type RestoreFrameKind = 'restore' | 'navigation' | 'correction';
type NavigationSettleSample = { top: number; messageAnchor: MessageScrollAnchor };
type NavigationSettleState = {
  framesRemaining: number;
  stableFrames: number;
  previousSample?: NavigationSettleSample;
};
type NavigationSettleResult =
  | { kind: 'retry' }
  | { kind: 'settled'; sample: NavigationSettleSample }
  | { kind: 'expired' };

export interface ChatUserScrollGesture {
  scrollTo(top: number): boolean;
  end(): void;
}

const taskCacheByThread = new Map<string, TaskItem[]>();
const SCROLL_BOTTOM_THRESHOLD_PX = 24;
const MAX_RESTORE_FRAMES = 90;
const NAVIGATION_STABLE_FRAMES = 2;

export function __resetTaskCacheForTest() {
  taskCacheByThread.clear();
}

export function deriveQueueHydrationTargetCats({
  intentMode,
  previousTargetCats,
  activeCatIds,
}: {
  intentMode: 'execute' | 'ideate' | null | undefined;
  previousTargetCats: string[];
  activeCatIds: string[];
}): string[] {
  if (intentMode === 'ideate' && previousTargetCats.length > 0 && activeCatIds.length > 0) {
    return Array.from(new Set([...previousTargetCats, ...activeCatIds]));
  }
  return activeCatIds;
}

function isNearBottom(el: { scrollTop: number; scrollHeight: number; clientHeight: number }): boolean {
  return el.scrollHeight - el.clientHeight - el.scrollTop <= SCROLL_BOTTOM_THRESHOLD_PX;
}

/**
 * Decide the bottom-follow anchor from a scroll observation. Geometry alone cannot distinguish
 * user scrolling from smooth-follow or layout corrections, so leaving bottom follow requires an
 * explicit upward-input signal. Intentional message jumps set the saved anchor to offset directly.
 *
 * Exported for unit testing — see __tests__/resolveScrollAnchor.test.ts.
 */
export function resolveScrollAnchor(
  el: { scrollTop: number; scrollHeight: number; clientHeight: number },
  prev: SavedScrollState | null,
  userScrolledUp = false,
): SavedScrollState['anchor'] {
  if (isNearBottom(el)) return 'bottom';
  if (prev?.anchor !== 'bottom') return 'offset';
  return userScrolledUp && el.scrollTop < prev.top ? 'offset' : 'bottom';
}

function rememberScrollState(threadId: string, el: HTMLElement, userScrolledUp = false, preserveOffsetAnchor = false) {
  const previous = readChatScrollState(threadId) ?? null;
  const anchor = resolveScrollAnchor(el, previous, userScrolledUp);
  if (anchor === 'bottom') {
    saveChatScrollState(threadId, { top: el.scrollTop, anchor });
    return;
  }
  const messageAnchor =
    preserveOffsetAnchor && previous?.anchor === 'offset'
      ? (previous.messageAnchor ?? captureMessageScrollAnchor(el))
      : captureMessageScrollAnchor(el);
  const messages = useChatStore.getState().getThreadState(threadId).messages;
  saveChatScrollState(threadId, {
    top: el.scrollTop,
    anchor,
    messageAnchor: messageAnchor ? describeChatReadingAnchor(messageAnchor, messages) : undefined,
  });
}

function tryRestoreSavedScrollState(el: HTMLElement, saved: SavedScrollState): boolean {
  const messageAnchorRestored =
    saved.anchor === 'offset' && saved.messageAnchor ? restoreMessageScrollAnchor(el, saved.messageAnchor) : false;
  if (messageAnchorRestored) return true;
  if (saved.anchor === 'offset' && saved.messageAnchor) return false;

  const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
  const targetTop = saved.anchor === 'bottom' ? maxTop : Math.min(saved.top, maxTop);
  el.scrollTop = targetTop;
  const canSettle = saved.anchor === 'bottom' ? maxTop > 0 : maxTop >= saved.top;
  return canSettle && Math.abs(el.scrollTop - targetTop) <= 1;
}

function captureNavigationSettleSample(el: HTMLElement, messageId: string): NavigationSettleSample | undefined {
  const messageAnchor = captureMessageScrollAnchorForMessage(el, messageId);
  return messageAnchor ? { top: el.scrollTop, messageAnchor } : undefined;
}

function isStableNavigationSample(previous: NavigationSettleSample, current: NavigationSettleSample): boolean {
  // Smooth scrolling still moves by one pixel near its end. Treating those
  // frames as stationary saves an obsolete offset that later scrolls preserve.
  return (
    current.top === previous.top && current.messageAnchor.viewportOffsetPx === previous.messageAnchor.viewportOffsetPx
  );
}

function advanceNavigationSettle(
  state: NavigationSettleState,
  el: HTMLElement | null,
  messageId: string,
  stale: boolean,
): NavigationSettleResult {
  if (stale) return { kind: 'expired' };

  state.framesRemaining -= 1;
  const sample = el ? captureNavigationSettleSample(el, messageId) : undefined;
  if (!sample) return state.framesRemaining > 0 ? { kind: 'retry' } : { kind: 'expired' };

  state.stableFrames =
    state.previousSample && isStableNavigationSample(state.previousSample, sample) ? state.stableFrames + 1 : 0;
  state.previousSample = sample;
  return state.stableFrames >= NAVIGATION_STABLE_FRAMES || state.framesRemaining <= 0
    ? { kind: 'settled', sample }
    : { kind: 'retry' };
}

const HISTORY_PAGE_SIZE = 50;
// In export mode (?export=true), load all messages in one request for screenshot capture.
// Normal browsing still uses 50-per-page pagination.
const EXPORT_LIMIT = 10000;
/** Stream output was live when it was cached, so the cache may trail the server: reload the thread whole. */
function cacheHoldsStreamOutput(messages: readonly ChatMessageData[]): boolean {
  return messages.some(
    (message) => message.type === 'assistant' && (message.origin === 'stream' || message.isStreaming === true),
  );
}

function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && (err as { name?: string }).name === 'AbortError';
}

type ReplaceHydrationMergeStats = {
  preservedLocalCount: number;
  mergedByIdCount: number;
};

type ReplaceHydrationMergeResult = {
  messages: ChatMessageData[];
  stats: ReplaceHydrationMergeStats;
};

type MessageExtra = NonNullable<ChatMessageData['extra']>;
type MessageRichPayload = MessageExtra['rich'];

function getMessageRichness(msg: ChatMessageData): [number, number, number, number] {
  return [
    msg.content.length,
    msg.thinking?.length ?? 0,
    msg.toolEvents?.length ?? 0,
    msg.extra?.rich?.blocks.length ?? 0,
  ];
}

function getMessagePhasePriority(msg: ChatMessageData): number {
  if (msg.origin === 'callback') return 2;
  if (msg.origin === 'stream') return 1;
  return 0;
}

function pickLongerText(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a.length >= b.length ? a : b;
}

function pickRicherToolEvents(
  a: ChatMessageData['toolEvents'],
  b: ChatMessageData['toolEvents'],
): ChatMessageData['toolEvents'] {
  if (!a?.length) return b;
  if (!b?.length) return a;
  return a.length >= b.length ? a : b;
}

function mergeRichPayload(
  preferred: MessageRichPayload | undefined,
  fallback: MessageRichPayload | undefined,
): MessageRichPayload | undefined {
  if (!preferred && !fallback) return undefined;
  const blocks = [...(preferred?.blocks ?? [])];
  const seen = new Set(blocks.map((block) => block.id));
  for (const block of fallback?.blocks ?? []) {
    if (seen.has(block.id)) continue;
    seen.add(block.id);
    blocks.push(block);
  }
  return { v: 1 as const, blocks };
}

type RequiredMessageExtraFields = {
  [Key in Exclude<keyof MessageExtra, 'rich'>]-?: MessageExtra[Key] | undefined;
};

function pickMessageExtraField<Key extends keyof MessageExtra>(
  preferred: ChatMessageData['extra'],
  fallback: ChatMessageData['extra'],
  key: Key,
): MessageExtra[Key] | undefined {
  return preferred?.[key] ?? fallback?.[key];
}

function mergeMessageExtra(
  preferred: ChatMessageData['extra'],
  fallback: ChatMessageData['extra'],
): ChatMessageData['extra'] | undefined {
  const rich = mergeRichPayload(preferred?.rich, fallback?.rich);
  const pick = <Key extends keyof MessageExtra>(key: Key) => pickMessageExtraField(preferred, fallback, key);
  // This object is intentionally exhaustive and fail-closed: adding a typed
  // ChatMessage.extra carrier makes TypeScript require an explicit merge rule,
  // while unknown runtime properties are still discarded. Most carriers are
  // immutable/additive projections, so the selected message wins and the other
  // side only fills a missing field. `rich` remains the sole structural merge.
  const fields: RequiredMessageExtraFields = {
    liveCompanion: pick('liveCompanion'),
    custodyOfferV1: pick('custodyOfferV1'),
    contentModificationRequestV1: pick('contentModificationRequestV1'),
    semanticEvent: pick('semanticEvent'),
    routingWarnings: pick('routingWarnings'),
    crossPost: pick('crossPost'),
    stream: pick('stream'),
    turnExecution: pick('turnExecution'),
    auxiliaryTurnExecutions: pick('auxiliaryTurnExecutions'),
    targetCats: pick('targetCats'),
    messageBundle: pick('messageBundle'),
    isExplicitPost: pick('isExplicitPost'),
    scheduler: pick('scheduler'),
    timeoutDiagnostics: pick('timeoutDiagnostics'),
    // F212 Phase B: diagnostics outlive one live event and must survive hydration.
    cliDiagnostics: pick('cliDiagnostics'),
    governanceBlocked: pick('governanceBlocked'),
    freshness: pick('freshness'),
    cloudBridgeRetry: pick('cloudBridgeRetry'),
    recall: pick('recall'),
    coordination: pick('coordination'),
    localReviewVerdict: pick('localReviewVerdict'),
    systemKind: pick('systemKind'),
    a2aRouting: pick('a2aRouting'),
    recovery: pick('recovery'),
    systemInfo: pick('systemInfo'),
    providerRecovery: pick('providerRecovery'),
  };
  const definedFields = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Omit<
    MessageExtra,
    'rich'
  >;
  if (!rich && Object.keys(definedFields).length === 0) return undefined;

  return {
    ...(rich ? { rich } : {}),
    ...definedFields,
  };
}

function getMessageOrderTimestamp(msg: ChatMessageData): number {
  return getMessageTimelineOrderTime(msg);
}

function shouldPreferCurrentMessage(current: ChatMessageData, history: ChatMessageData): boolean {
  const currentPhasePriority = getMessagePhasePriority(current);
  const historyPhasePriority = getMessagePhasePriority(history);
  if (currentPhasePriority !== historyPhasePriority) {
    return currentPhasePriority > historyPhasePriority;
  }

  // Once both sides are already at callback phase, authoritative server history
  // should win unless the local callback is strictly newer. This prevents a stale
  // cached callback bubble from surviving thread-switch hydration until the next F5.
  if (currentPhasePriority === 2) {
    return getMessageOrderTimestamp(current) > getMessageOrderTimestamp(history);
  }

  const currentRichness = getMessageRichness(current);
  const historyRichness = getMessageRichness(history);
  for (let i = 0; i < currentRichness.length; i++) {
    if (currentRichness[i] === historyRichness[i]) continue;
    return currentRichness[i]! > historyRichness[i]!;
  }
  return false;
}

function mergeSameIdHydrationMessage(history: ChatMessageData, current: ChatMessageData): ChatMessageData {
  const merged = mergeSameIdHydrationFields(history, current);
  // A committed response is the server's final truth: its body and lifecycle win outright;
  // fields only this client holds (custody offers, blob URLs) still merge as usual.
  if (history.lifecycle?.kind === 'response' && history.lifecycle.status !== 'processing') {
    return {
      ...merged,
      content: history.content,
      toolEvents: history.toolEvents,
      thinking: history.thinking,
      thinkingChunks: history.thinkingChunks,
      ...(history.metadata ? { metadata: history.metadata } : {}),
      lifecycle: history.lifecycle,
      isStreaming: false,
    };
  }
  return history.lifecycle ? { ...merged, lifecycle: history.lifecycle } : merged;
}

function mergeSameIdHydrationFields(history: ChatMessageData, current: ChatMessageData): ChatMessageData {
  const preferCurrent = shouldPreferCurrentMessage(current, history);
  const preferred = preferCurrent ? current : history;
  const fallback = preferCurrent ? history : current;
  const toolEvents = pickRicherToolEvents(preferred.toolEvents, fallback.toolEvents);
  const thinking = pickLongerText(preferred.thinking, fallback.thinking);
  const getConsistentThinkingChunks = (message: ChatMessageData): string[] | undefined => {
    if (!message.thinkingChunks || message.thinkingChunks.length === 0) return undefined;
    const rendered = message.thinkingChunks.join('\n\n---\n\n');
    if (!message.thinking || rendered === message.thinking) {
      return message.thinkingChunks;
    }
    return undefined;
  };
  const preferredThinkingChunks = getConsistentThinkingChunks(preferred);
  const fallbackThinkingChunks = getConsistentThinkingChunks(fallback);
  const thinkingChunks =
    (thinking && thinking === preferred.thinking ? preferredThinkingChunks : undefined) ??
    (thinking && thinking === fallback.thinking ? fallbackThinkingChunks : undefined);
  const extra = mergeMessageExtra(preferred.extra, fallback.extra);

  const merged: ChatMessageData = {
    ...fallback,
    ...preferred,
    content: preferred.content || fallback.content,
    ...((preferred.contentBlocks ?? fallback.contentBlocks)
      ? { contentBlocks: preferred.contentBlocks ?? fallback.contentBlocks }
      : {}),
    ...(toolEvents ? { toolEvents } : {}),
    ...((preferred.metadata ?? fallback.metadata) ? { metadata: preferred.metadata ?? fallback.metadata } : {}),
    ...(thinking ? { thinking } : {}),
    ...(thinkingChunks ? { thinkingChunks } : {}),
    ...(extra ? { extra } : {}),
    ...((preferred.summary ?? fallback.summary) ? { summary: preferred.summary ?? fallback.summary } : {}),
    ...((preferred.source ?? fallback.source) ? { source: preferred.source ?? fallback.source } : {}),
    ...((preferred.visibility ?? fallback.visibility)
      ? { visibility: preferred.visibility ?? fallback.visibility }
      : {}),
    ...((preferred.whisperTo ?? fallback.whisperTo) ? { whisperTo: preferred.whisperTo ?? fallback.whisperTo } : {}),
    ...((preferred.revealedAt ?? fallback.revealedAt)
      ? { revealedAt: preferred.revealedAt ?? fallback.revealedAt }
      : {}),
    ...((preferred.deliveredAt ?? fallback.deliveredAt)
      ? { deliveredAt: preferred.deliveredAt ?? fallback.deliveredAt }
      : {}),
    ...((preferred.timelineOrderAt ?? fallback.timelineOrderAt) !== undefined
      ? { timelineOrderAt: preferred.timelineOrderAt ?? fallback.timelineOrderAt }
      : {}),
    ...((preferred.replyTo ?? fallback.replyTo) ? { replyTo: preferred.replyTo ?? fallback.replyTo } : {}),
    ...((preferred.replyPreview ?? fallback.replyPreview)
      ? { replyPreview: preferred.replyPreview ?? fallback.replyPreview }
      : {}),
    ...(preferred.mentionsUser || fallback.mentionsUser ? { mentionsUser: true } : {}),
    ...(preferred.isStreaming !== undefined ? { isStreaming: preferred.isStreaming } : {}),
  };
  if (extra) return merged;

  // The top-level spreads above may contain a runtime-only `extra`. When the
  // typed fail-closed merge accepted no carrier, remove that raw object instead
  // of accidentally preserving it through the preferred message.
  const withoutExtra = { ...merged };
  delete withoutExtra.extra;
  return withoutExtra;
}

/**
 * Fetched history and local records share one identity: the message id. A record the page
 * returns is merged with its local copy by id; a local record the page does not contain is
 * kept (optimistic sends, live rows, older pages), except IndexedDB copies — the server is
 * authoritative for those. Exported for unit testing.
 */
export function mergeReplaceHydrationMessages(
  historyMsgs: ChatMessageData[],
  currentMsgs: ChatMessageData[],
): ReplaceHydrationMergeResult {
  const historyIndexById = new Map(historyMsgs.map((message, index) => [message.id, index]));
  const mergedMsgs = [...historyMsgs];
  let preservedLocalCount = 0;
  let mergedByIdCount = 0;

  for (const currentMsg of currentMsgs) {
    if (currentMsg.cachedFrom === 'idb') continue;
    const msg = currentMsg;

    const historyIndex = historyIndexById.get(msg.id);
    if (historyIndex !== undefined) {
      mergedMsgs[historyIndex] = mergeSameIdHydrationMessage(mergedMsgs[historyIndex]!, msg);
      mergedByIdCount++;
      continue;
    }
    mergedMsgs.push(msg);
    preservedLocalCount++;
  }

  return { messages: mergedMsgs, stats: { preservedLocalCount, mergedByIdCount } };
}

/**
 * Hook for managing chat history: fetching, pagination, scroll handling.
 * Extracted from ChatContainer to reduce component size.
 *
 * @param threadId - The active thread ID (from URL route param).
 */
export function useChatHistory(threadId: string) {
  const historyAdmission = useThreadChatHistoryAdmission();
  const historyConsumerIdRef = useRef<symbol | null>(null);
  historyConsumerIdRef.current ??= Symbol('thread-chat-history-consumer');
  const historyConsumerId = historyConsumerIdRef.current;
  const {
    messages: rawMessages,
    currentThreadId: storeCurrentThreadId,
    isLoadingHistory,
    hasMore,
    replaceThreadMessages,
    hydrateThread,
    setThreadLoadingHistory,
    setCatInvocation,
    replaceThreadTargetCats,
    updateThreadCatStatus,
    setQueue,
    isOfflineSnapshot,
  } = useChatStore(
    useShallow((s) => ({
      messages: selectThreadMessagesRaw(s, threadId),
      currentThreadId: s.currentThreadId,
      isLoadingHistory: s.isLoadingHistory,
      hasMore: s.hasMore,
      replaceThreadMessages: s.replaceThreadMessages,
      hydrateThread: s.hydrateThread,
      setThreadLoadingHistory: s.setThreadLoadingHistory,
      setCatInvocation: s.setCatInvocation,
      replaceThreadTargetCats: s.replaceThreadTargetCats,
      updateThreadCatStatus: s.updateThreadCatStatus,
      setQueue: s.setQueue,
      isOfflineSnapshot: s.isOfflineSnapshot,
    })),
  );
  const { setTasks } = useTaskStore();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messages = useViewportMessageTimeline(threadId, rawMessages, () => {
    if (useChatStore.getState().currentThreadId !== threadId) return;
    const el = scrollContainerRef.current;
    const saved = readChatScrollState(threadId);
    if (!el || saved?.anchor !== 'offset' || saved.messageAnchor) return;
    saveChatScrollState(threadId, {
      ...saved,
      top: el.scrollTop,
      messageAnchor: captureMessageScrollAnchor(el) ?? saved.messageAnchor,
    });
  });

  // Scroll state for prepend handling
  const prevFirstIdRef = useRef<string | null>(null);
  const prevCountRef = useRef(0);
  const scrollSnapshotRef = useRef<number | null>(null);
  const restoreFrameRef = useRef<number | null>(null);
  const restoreFrameKindRef = useRef<RestoreFrameKind | null>(null);
  const restoreGenerationRef = useRef(0);
  const readingRestoreRef = useRef<{ threadId: string; saved: SavedScrollState; cursor?: string } | null>(null);
  const historyPhaseRef = useRef({ hasMore, isOfflineSnapshot, isLoadingHistory });
  historyPhaseRef.current = { hasMore, isOfflineSnapshot, isLoadingHistory };
  const userScrollUpRef = useRef(false);
  const userScrollIntentRef = useRef(false);
  const previousTimelineIdsRef = useRef<string[]>([]);
  const previousTimelineThreadRef = useRef(threadId);
  const userScrollGestureRef = useRef<symbol | null>(null);

  // Track loading guard per-thread to prevent double-fetch
  const loadingRef = useRef(false);

  // P1 fix: AbortController to cancel in-flight requests on thread switch
  const abortRef = useRef<AbortController | null>(null);
  // Always-current threadId for stale response checks
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;

  const isStaleThreadRequest = useCallback((controller: AbortController, capturedThreadId: string) => {
    return controller.signal.aborted || abortRef.current !== controller || threadIdRef.current !== capturedThreadId;
  }, []);

  const cancelPendingRestore = useCallback((preserveUserGesture = false) => {
    restoreGenerationRef.current += 1;
    if (!preserveUserGesture) userScrollGestureRef.current = null;
    restoreFrameKindRef.current = null;
    if (restoreFrameRef.current !== null) {
      cancelAnimationFrame(restoreFrameRef.current);
      restoreFrameRef.current = null;
    }
  }, []);

  const markScrollIntent = useCallback(
    (upward: boolean) => {
      readingRestoreRef.current = null;
      userScrollIntentRef.current = true;
      if (upward) userScrollUpRef.current = true;
      cancelPendingRestore();
    },
    [cancelPendingRestore],
  );

  const followBottomAnchor = useCallback((behavior: ScrollBehavior = 'auto') => {
    const currentThread = threadIdRef.current;
    const el = scrollContainerRef.current;
    if (!el || useChatStore.getState().currentThreadId !== currentThread) return;

    const saved = readChatScrollState(currentThread);
    if (saved?.anchor !== 'bottom') return;

    messagesEndRef.current?.scrollIntoView({ behavior });
    saveChatScrollState(currentThread, {
      top: Math.max(0, el.scrollHeight - el.clientHeight),
      anchor: 'bottom',
    });
  }, []);

  const jumpToLatest = useCallback(() => {
    const currentThread = threadIdRef.current;
    const el = scrollContainerRef.current;
    if (!el || useChatStore.getState().currentThreadId !== currentThread) return;

    cancelPendingRestore();
    readingRestoreRef.current = null;
    userScrollUpRef.current = false;
    saveChatScrollState(currentThread, {
      top: Math.max(0, el.scrollHeight - el.clientHeight),
      anchor: 'bottom',
    });
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [cancelPendingRestore]);

  const scheduleRestore = useCallback(
    (saved: SavedScrollState) => {
      cancelPendingRestore();
      restoreFrameKindRef.current = 'restore';
      const generation = restoreGenerationRef.current;
      let framesRemaining = MAX_RESTORE_FRAMES;
      // Capture threadId at schedule time so a stale callback can't mutate
      // the next thread's scroll state if it fires before effect cleanup.
      const scheduledForThread = threadIdRef.current;

      const apply = () => {
        // Stale guard: if thread switched before cleanup cancelled us, no-op.
        if (generation !== restoreGenerationRef.current) return;
        if (threadIdRef.current !== scheduledForThread) {
          cancelPendingRestore();
          return;
        }

        const el = scrollContainerRef.current;
        if (!el) {
          restoreFrameRef.current = null;
          restoreFrameKindRef.current = null;
          return;
        }

        const phase = historyPhaseRef.current;
        const missingAnchor =
          saved.anchor === 'offset' &&
          saved.messageAnchor &&
          !useChatStore
            .getState()
            .getThreadState(scheduledForThread)
            .messages.some((m) => m.id === saved.messageAnchor?.messageId);
        const waitingForHistory = missingAnchor && (phase.hasMore || phase.isOfflineSnapshot || phase.isLoadingHistory);
        if (!waitingForHistory && tryRestoreSavedScrollState(el, saved)) {
          if (!phase.isOfflineSnapshot && !phase.isLoadingHistory) readingRestoreRef.current = null;
          saveChatScrollState(scheduledForThread, { ...saved, top: el.scrollTop });
          restoreFrameRef.current = null;
          restoreFrameKindRef.current = null;
          window.dispatchEvent(new Event(CHAT_LAYOUT_CHANGED_EVENT));
          return;
        }

        framesRemaining -= 1;
        if (framesRemaining <= 0) {
          restoreFrameRef.current = null;
          restoreFrameKindRef.current = null;
          return;
        }
        restoreFrameRef.current = requestAnimationFrame(apply);
      };

      restoreFrameRef.current = requestAnimationFrame(apply);
    },
    [cancelPendingRestore],
  );

  const scheduleCurrentAnchorCorrection = useCallback(() => {
    if (restoreFrameKindRef.current === 'restore' || restoreFrameKindRef.current === 'navigation') return;
    cancelPendingRestore(true);
    const scheduledForThread = threadIdRef.current;
    const saved = readChatScrollState(scheduledForThread);
    if (!saved) return;

    restoreFrameKindRef.current = 'correction';
    const generation = restoreGenerationRef.current;
    restoreFrameRef.current = requestAnimationFrame(() => {
      if (generation !== restoreGenerationRef.current) return;
      if (threadIdRef.current !== scheduledForThread) {
        cancelPendingRestore();
        return;
      }
      restoreFrameRef.current = null;
      restoreFrameKindRef.current = null;

      const el = scrollContainerRef.current;
      if (!el || useChatStore.getState().currentThreadId !== scheduledForThread) return;
      if (saved.anchor === 'bottom') {
        followBottomAnchor('auto');
        return;
      }
      if (saved.messageAnchor && restoreMessageScrollAnchor(el, saved.messageAnchor)) {
        saveChatScrollState(scheduledForThread, { ...saved, top: el.scrollTop });
      }
    });
  }, [cancelPendingRestore, followBottomAnchor]);

  // F052: after a cross-post jump, retry scrolling to the source bubble until the message
  // DOM has rendered (thread switch remounts + paginates async). Gives up after
  // MAX_RESTORE_FRAMES so a paged-out source can't spin forever — the caller already fell
  // back to default scroll-restore in that case. Stale-guarded by threadIdRef like scheduleRestore.
  const scheduleScrollToMessage = useCallback(
    (messageId: string) => {
      // A cross-post jump preempts the default scroll-restore so the two raf loops don't fight
      // over scrollTop (restore pulls to cached offset, this pulls to the target bubble).
      cancelPendingRestore();
      restoreFrameKindRef.current = 'navigation';
      readingRestoreRef.current = null;
      const generation = restoreGenerationRef.current;
      const scheduledForThread = threadIdRef.current;
      let framesRemaining = MAX_RESTORE_FRAMES;
      const finishNavigation = () => {
        restoreFrameKindRef.current = null;
        restoreFrameRef.current = null;
      };
      const tick = () => {
        if (generation !== restoreGenerationRef.current) return;
        if (threadIdRef.current !== scheduledForThread) {
          cancelPendingRestore();
          return;
        }
        const el = scrollContainerRef.current;
        if (!el || useChatStore.getState().currentThreadId !== scheduledForThread) {
          finishNavigation();
          return;
        }
        if (scrollToMessage(messageId, el)) {
          const settleState: NavigationSettleState = {
            framesRemaining,
            stableFrames: 0,
          };
          const settle = () => {
            if (generation !== restoreGenerationRef.current) return;
            if (threadIdRef.current !== scheduledForThread) {
              cancelPendingRestore();
              return;
            }
            const result = advanceNavigationSettle(
              settleState,
              scrollContainerRef.current,
              messageId,
              threadIdRef.current !== scheduledForThread,
            );
            if (result.kind === 'retry') {
              restoreFrameRef.current = requestAnimationFrame(settle);
              return;
            }
            if (result.kind === 'settled') {
              saveChatScrollState(scheduledForThread, {
                top: result.sample.top,
                anchor: 'offset',
                messageAnchor: describeChatReadingAnchor(
                  result.sample.messageAnchor,
                  useChatStore.getState().getThreadState(scheduledForThread).messages,
                ),
              });
            }
            finishNavigation();
          };
          restoreFrameRef.current = requestAnimationFrame(settle);
          return;
        }
        framesRemaining -= 1;
        if (framesRemaining <= 0) {
          finishNavigation();
          return;
        }
        restoreFrameRef.current = requestAnimationFrame(tick);
      };
      restoreFrameRef.current = requestAnimationFrame(tick);
    },
    [cancelPendingRestore],
  );

  // Foreground controls use the same reading owner as cross-posts/teleports.
  // An independent surface can still navigate its own DOM without writing memory.
  const jumpToMessage = useCallback(
    (messageId: string): boolean => {
      if (
        threadIdRef.current !== threadId ||
        !scrollContainerRef.current ||
        !useChatStore
          .getState()
          .getThreadState(threadId)
          .messages.some((message) => message.id === messageId)
      ) {
        return false;
      }
      if (useChatStore.getState().currentThreadId === threadId) {
        scheduleScrollToMessage(messageId);
        return true;
      }
      cancelPendingRestore();
      return scrollToMessage(messageId, scrollContainerRef.current);
    },
    [threadId, scheduleScrollToMessage, cancelPendingRestore],
  );

  // Fix: /queue returns before /messages. If /queue says idle it clears
  // hasActiveInvocation. When /messages then returns draft messages (isDraft=true,
  // meaning a cat is still streaming), we must restore the active invocation state
  // so the cancel button stays visible.
  const restoreActiveFromDrafts = useCallback(
    (forThread: string, rawMessages: Array<{ isDraft?: boolean; catId?: string }>) => {
      const draftCatIds = [...new Set(rawMessages.filter((m) => m.isDraft && m.catId).map((m) => m.catId!))];
      if (draftCatIds.length === 0) return;

      const store = useChatStore.getState();
      const isCurrentThread = store.currentThreadId === forThread;
      const threadState = store.threadStates[forThread];
      const alreadyActive = isCurrentThread ? store.hasActiveInvocation : threadState?.hasActiveInvocation === true;
      // A draft is a causally newer active edge even when the coarse bit is
      // already true. Re-enter the proof-aware writer so a terminal-correlated
      // cached slot cannot suppress this invocationless evidence.
      store.setThreadHasActiveInvocation(forThread, true);
      if (alreadyActive) return;

      for (const catId of draftCatIds) {
        const syntheticId = `hydrated-${forThread}-${catId}`;
        if (isCurrentThread) {
          store.addActiveInvocation(syntheticId, catId, 'execute');
        } else {
          store.addThreadActiveInvocation(forThread, syntheticId, catId, 'execute');
        }
      }
    },
    [],
  );

  // Fetch history page from API
  // When replace=true, clears existing messages before setting (used for force-refresh).
  const performFetchHistory = useCallback(
    async (cursor?: string, options?: { replace?: boolean }) => {
      if (loadingRef.current) return;
      const controller = abortRef.current;
      if (!controller) return;
      const fetchForThread = threadId; // capture at call time

      loadingRef.current = true;
      setThreadLoadingHistory(fetchForThread, true);
      try {
        const isExport =
          typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('export') === 'true';
        const limit = isExport ? EXPORT_LIMIT : HISTORY_PAGE_SIZE;
        const params = new URLSearchParams({ limit: String(limit) });
        if (cursor) params.set('before', cursor);
        params.set('threadId', fetchForThread);
        const res = await apiFetch(`/api/messages?${params}`, {
          signal: controller.signal,
        });
        if (!res.ok) return;
        // Stale check: discard if the request was superseded while the response body was in flight.
        if (isStaleThreadRequest(controller, fetchForThread)) return;
        const data = await res.json();
        if (isStaleThreadRequest(controller, fetchForThread)) return false;
        const historyMsgs = (data.messages ?? [])
          .map(
            (m: {
              id: string;
              type: string;
              from?: import('@cat-cafe/shared').MessageFrom;
              catId?: string;
              content: string;
              lifecycle?: import('@cat-cafe/shared').LifecycleStoredMessageMetadata;
              contentBlocks?: unknown[];
              toolEvents?: unknown[];
              metadata?: {
                provider: string;
                model: string;
                sessionId?: string;
                subexecutionEvents?: NonNullable<ChatMessageData['metadata']>['subexecutionEvents'];
                /** F212 Phase B (云端 codex P2 2026-05-27): stored CLI diagnostics on error events;
                 *  copied into extra.cliDiagnostics below so the folded panel survives cold hydration. */
                cliDiagnostics?: CliDiagnostics;
                /** F118 AC-C3 / F117: timeout diagnostics persisted with a failed response;
                 *  copied into extra.timeoutDiagnostics below like cliDiagnostics. */
                timeoutDiagnostics?: TimeoutDiagnostics;
              };
              origin?: 'stream' | 'callback' | 'briefing';
              thinking?: string;
              extra?: ChatMessageData['extra'];
              timestamp: number;
              summary?: {
                id: string;
                topic: string;
                conclusions: string[];
                openQuestions: string[];
                createdBy: string;
              };
              visibility?: 'public' | 'whisper';
              whisperTo?: string[];
              revealedAt?: number;
              isDraft?: boolean;
              source?: { connector: string; label: string; icon: string; url?: string };
              mentionsUser?: boolean;
              deliveredAt?: number;
              timelineOrderAt?: number;
              replyTo?: string;
              replyPreview?: ReplyPreview;
            }) =>
              ({
                id: m.id,
                // Shared rule when the envelope names its sender; the chain below only covers an
                // absent `from` (legacy rows and summaries), which the shared rule leaves undecided.
                type: (timelineMessageKind(m.from, Boolean(m.source)) ??
                  (m.type === 'system'
                    ? 'system'
                    : m.summary
                      ? 'summary'
                      : m.source
                        ? 'connector'
                        : m.catId
                          ? 'assistant'
                          : 'user')) as 'user' | 'assistant' | 'system' | 'summary' | 'connector',
                ...(m.from ? { from: m.from } : {}),
                catId: m.catId,
                content: (() => {
                  if (!m.extra?.semanticEvent) return m.content;
                  const semantic = resolveProviderSemanticMessage(m.extra.semanticEvent);
                  return semantic.action === 'replace' ? semantic.projection.content : m.content;
                })(),
                ...(m.lifecycle ? { lifecycle: m.lifecycle } : {}),
                ...(m.contentBlocks ? { contentBlocks: m.contentBlocks } : {}),
                ...(m.toolEvents ? { toolEvents: m.toolEvents as import('../stores/chat-types').ToolEvent[] } : {}),
                ...(m.metadata ? { metadata: m.metadata } : {}),
                ...(m.origin ? { origin: m.origin } : {}),
                ...(m.thinking ? { thinking: m.thinking } : {}),
                // F212 Phase B (云端 codex P2 2026-05-27): cliDiagnostics rides on stored
                // message metadata (Phase A providers stamp __cliError/__cliTimeout payload
                // there). Cold hydration / F5 / re-fetch must copy it into `extra.cliDiagnostics`
                // so ChatMessage's folded panel renders — otherwise the diagnostic panel disappears
                // on page reload even though the stored payload still has the data.
                // Precedence: prefer extra.cliDiagnostics (active-path may write here) over
                // metadata.cliDiagnostics (api-persisted authoritative copy).
                ...(() => {
                  const extra = mergeMessageExtra(m.extra, {
                    ...(m.metadata?.cliDiagnostics ? { cliDiagnostics: m.metadata.cliDiagnostics } : {}),
                    ...(m.metadata?.timeoutDiagnostics ? { timeoutDiagnostics: m.metadata.timeoutDiagnostics } : {}),
                  });
                  return extra ? { extra } : {};
                })(),
                ...(m.summary ? { summary: m.summary } : {}),
                ...(m.visibility ? { visibility: m.visibility } : {}),
                ...(m.whisperTo ? { whisperTo: m.whisperTo } : {}),
                ...(m.revealedAt ? { revealedAt: m.revealedAt } : {}),
                ...(m.deliveredAt ? { deliveredAt: m.deliveredAt } : {}),
                ...(m.timelineOrderAt !== undefined ? { timelineOrderAt: m.timelineOrderAt } : {}),
                ...(m.source ? { source: m.source } : {}),
                ...(m.mentionsUser ? { mentionsUser: true } : {}),
                ...(m.replyTo ? { replyTo: m.replyTo } : {}),
                ...(m.replyPreview ? { replyPreview: m.replyPreview } : {}),
                // #80: Restore streaming indicator for draft messages recovered from Redis
                ...(m.isDraft ? { isStreaming: true } : {}),
                timestamp: m.timestamp,
              }) as ChatMessageData,
          )
          .filter(
            (message: ChatMessageData) =>
              !message.extra?.semanticEvent ||
              resolveProviderSemanticMessage(message.extra.semanticEvent).action !== 'suppress',
          );
        if (options?.replace) {
          // Merge only against the captured Thread's projection, then replace that
          // projection atomically. The flat compatibility view may already point at
          // another Thread by the time this async callback commits.
          const currentState = useChatStore.getState();
          const targetProjection =
            currentState.currentThreadId === fetchForThread ? currentState : currentState.threadStates[fetchForThread];
          const mergeResult = mergeReplaceHydrationMessages(historyMsgs, targetProjection?.messages ?? []);
          const mergedMsgs = mergeResult.messages;
          recordDebugEvent({
            event: 'history_replace',
            threadId: fetchForThread,
            action: mergeResult.stats.preservedLocalCount > 0 ? 'merge_local' : 'replace_exact',
            queueLength: mergedMsgs.length,
            reason: [
              `history=${historyMsgs.length}`,
              `targetLocal=${targetProjection?.messages.length ?? 0}`,
              `preservedLocal=${mergeResult.stats.preservedLocalCount}`,
              `mergedById=${mergeResult.stats.mergedByIdCount}`,
            ].join(','),
          });
          // F173 Phase C Task 5+6+7 — single hydration entry. Atomic
          // server-authoritative replace + IDB overwrite via writer
          // (instead of bare replaceMessages + saveMessagesSnapshot pair).
          // AC-C10: server GET 是 authoritative，IDB snapshot 必须被 GET
          // 响应覆盖而不是合并。
          hydrateThread(fetchForThread, mergedMsgs, data.hasMore ?? false);
          restoreActiveFromDrafts(fetchForThread, data.messages ?? []);
          return true;
        }
        // An older page joins the loaded records by id; a record already loaded is newer.
        const currentState = useChatStore.getState();
        const beforePrepend =
          currentState.currentThreadId === fetchForThread
            ? currentState.messages
            : (currentState.threadStates[fetchForThread]?.messages ?? []);
        const loadedIds = new Set(beforePrepend.map((message) => message.id));
        const union = [
          ...historyMsgs.filter((message: ChatMessageData) => !loadedIds.has(message.id)),
          ...beforePrepend,
        ];
        // hasMore propagates older-history pagination state.
        replaceThreadMessages(fetchForThread, union, data.hasMore ?? false);
        restoreActiveFromDrafts(fetchForThread, data.messages ?? []);
        // F164: Snapshot fetched messages to IndexedDB (fire-and-forget)
        const snapshotState = useChatStore.getState();
        if (snapshotState.currentThreadId === fetchForThread) {
          void saveMessagesSnapshot(fetchForThread, snapshotState.messages, data.hasMore ?? false).catch(() => {});
        }
        return true;
      } catch (err) {
        // AbortError is expected during thread switch — ignore silently
        if (isAbortError(err)) return false;
        return false;
      } finally {
        // Do not let stale/aborted request clear loading state for a newer thread request.
        if (abortRef.current === controller && threadIdRef.current === fetchForThread) {
          loadingRef.current = false;
          setThreadLoadingHistory(fetchForThread, false);
        }
      }
    },
    [
      setThreadLoadingHistory,
      replaceThreadMessages,
      hydrateThread,
      restoreActiveFromDrafts,
      isStaleThreadRequest,
      threadId,
    ],
  );

  const fetchHistory = useCallback(
    async (cursor?: string, options?: { replace?: boolean; freshnessToken?: number }) => {
      const freshnessKey = typeof options?.freshnessToken === 'number' ? `:fresh:${options.freshnessToken}` : '';
      const requestKey = `messages:${cursor ?? 'latest'}:${options?.replace ? 'replace' : 'prepend'}${freshnessKey}`;
      while (true) {
        const result = await historyAdmission.runRequest({
          threadId,
          consumerId: historyConsumerId,
          requestKey,
          task: () => performFetchHistory(cursor, options),
        });
        if (result.status === 'completed') return result.value;

        // The shared request originated from a consumer that unmounted. Its
        // controller and stale guards belong to that departed surface, so the
        // result cannot satisfy this still-live consumer. Re-enter admission;
        // equal-key survivors will coalesce onto the replacement request.
        const controller = abortRef.current;
        if (!controller || isStaleThreadRequest(controller, threadId)) return;
      }
    },
    [historyAdmission, historyConsumerId, isStaleThreadRequest, performFetchHistory, threadId],
  );

  const fetchTasks = useCallback(async () => {
    const fetchForThread = threadId;
    const controller = abortRef.current;
    if (!controller) return false;

    try {
      const res = await apiFetch(`/api/tasks?threadId=${encodeURIComponent(fetchForThread)}&kind=work`, {
        signal: controller.signal,
      });
      if (!res.ok) return false;
      if (abortRef.current !== controller) return false;
      if (threadIdRef.current !== fetchForThread) return false;
      const data = await res.json();
      const tasks = data.tasks ?? [];
      taskCacheByThread.set(fetchForThread, tasks);
      setTasks(tasks);
      return true;
    } catch {
      return false;
    }
  }, [threadId, setTasks]);

  // F045: Fetch cached task progress on mount to restore Plan Checklist after page refresh
  const fetchTaskProgress = useCallback(async () => {
    const fetchForThread = threadId;
    const controller = abortRef.current;
    if (!controller) return false;

    try {
      const res = await apiFetch(`/api/threads/${encodeURIComponent(fetchForThread)}/task-progress`, {
        signal: controller.signal,
      });
      if (!res.ok) return false;
      if (abortRef.current !== controller) return false;
      if (threadIdRef.current !== fetchForThread) return false;
      const data = (await res.json()) as {
        taskProgress?: Record<
          string,
          {
            tasks: Array<{ id: string; subject: string; status: string; activeForm?: string }>;
            status?: 'running' | 'completed' | 'interrupted';
            updatedAt?: number;
            lastInvocationId?: string;
            interruptReason?: string;
          }
        >;
      };
      if (data.taskProgress) {
        const restoredCats: string[] = [];
        for (const [catId, progress] of Object.entries(data.taskProgress)) {
          setCatInvocation(catId, {
            taskProgress: {
              tasks: progress.tasks.map(
                (t): TaskProgressItem => ({
                  id: t.id,
                  subject: t.subject,
                  status:
                    t.status === 'in_progress' ? 'in_progress' : t.status === 'completed' ? 'completed' : 'pending',
                  ...(t.activeForm ? { activeForm: t.activeForm } : {}),
                }),
              ),
              lastUpdate: progress.updatedAt ?? Date.now(),
              ...(progress.status ? { snapshotStatus: progress.status } : {}),
              ...(progress.lastInvocationId ? { lastInvocationId: progress.lastInvocationId } : {}),
              ...(progress.interruptReason ? { interruptReason: progress.interruptReason } : {}),
            },
          });
          // Only restore cats that still look active.
          // Completed snapshots should remain in history, not current targetCats.
          const hasTasks = progress.tasks.length > 0;
          const isCompletedSnapshot = progress.status === 'completed';
          if (hasTasks && !isCompletedSnapshot) {
            restoredCats.push(catId);
          }
        }
        // Restore targetCats so RightStatusPanel shows the Plan Checklist.
        // Only restore if no live targetCats exist — avoids overwriting fresh
        // intent_mode socket events when the HTTP response arrives late.
        const currentTargets = useChatStore.getState().targetCats;
        if (restoredCats.length > 0 && currentTargets.length === 0) {
          replaceThreadTargetCats(fetchForThread, restoredCats);
        }
      }
      return true;
    } catch {
      return false;
    }
  }, [threadId, setCatInvocation, replaceThreadTargetCats]);

  // F194 Phase Z10 (砚砚 R1 P1): track which AbortController has had a successful
  // fetchQueue completion (active OR idle). IDB restore checks this set — if
  // fetchQueue already wrote server truth, IDB restore must NOT overwrite
  // (otherwise stale IDB "active" resurrects after server confirmed idle).
  // WeakSet keys on controller so cleanup happens when controller is GC'd.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const queueFetchedControllers = useRef(new WeakSet<AbortController>()).current;

  // F39 Bug 1: Fetch queue state on mount/thread-switch to survive F5 refresh
  const fetchQueue = useCallback(async () => {
    const fetchForThread = threadId;
    const controller = abortRef.current;
    if (!controller) return false;

    try {
      const res = await apiFetch(`/api/threads/${encodeURIComponent(fetchForThread)}/queue`, {
        signal: controller.signal,
      });
      if (!res.ok) return false;
      if (abortRef.current !== controller) return false;
      if (threadIdRef.current !== fetchForThread) return false;
      const data = (await res.json()) as {
        queue: QueueEntry[];
        activeInvocations?: QueueActiveInvocationSlot[];
      };
      // Always sync server state — clears stale local data when server queue is empty
      setQueue(fetchForThread, data.queue);
      // Issue #83: Reconcile processing state from server-side InvocationTracker.
      // Uses thread-scoped APIs so it works correctly for both active and background threads,
      // and always overwrites stale snapshots restored by setCurrentThread().
      const store = useChatStore.getState();
      // F194 Phase Z10 AC-Z28: write-through to IDB so F5 first paint
      // restores last-known active state (avoids R14 fake-idle gap).
      const activeStateSnapshot: Record<string, { catId: string; mode: string; startedAt?: number }> = {};
      if (data.activeInvocations && data.activeInvocations.length > 0) {
        const activeCatIds = data.activeInvocations.map((s) => s.catId);
        const activeByCatId = new Map(data.activeInvocations.map((slot) => [slot.catId, slot]));
        const livenessSnapshot =
          fetchForThread === store.currentThreadId
            ? { intentMode: store.intentMode, targetCats: store.targetCats, catStatuses: store.catStatuses }
            : store.threadStates[fetchForThread];
        const hydratedTargetCats = deriveQueueHydrationTargetCats({
          intentMode: livenessSnapshot?.intentMode,
          previousTargetCats: livenessSnapshot?.targetCats ?? [],
          activeCatIds,
        });
        const previousStatuses = livenessSnapshot?.catStatuses ?? {};
        Object.assign(
          activeStateSnapshot,
          hydrateQueueActiveInvocationSlots({
            threadId: fetchForThread,
            slots: data.activeInvocations,
            targetCatIds: hydratedTargetCats,
          }),
        );
        for (const catId of hydratedTargetCats) {
          if (!activeByCatId.has(catId) && previousStatuses[catId]) {
            updateThreadCatStatus(fetchForThread, catId, previousStatuses[catId]);
          }
        }
        // F194 Phase Z10 AC-Z28: persist for next F5.
        void saveThreadActiveState(fetchForThread, {
          hasActiveInvocation: true,
          activeInvocations: activeStateSnapshot,
        }).catch(() => {});
      } else {
        // Server says no active invocations — clear any stale processing state
        // that may have been restored from a threadStates snapshot.
        // clearThreadActiveInvocation clears BOTH hasActiveInvocation boolean
        // AND the activeInvocations slot map, preventing re-derivation bugs.
        store.clearThreadActiveInvocation(fetchForThread);
        replaceThreadTargetCats(fetchForThread, []);
        // F194 Phase Z10 AC-Z28: persist idle snapshot so F5 doesn't show
        // stale "active" — server truth wins.
        void saveThreadActiveState(fetchForThread, {
          hasActiveInvocation: false,
          activeInvocations: {},
        }).catch(() => {});
      }
      // F194 Phase Z10 (砚砚 R1 P1): mark controller as fetched after server
      // truth (active OR idle) has been applied. IDB restore skips overwriting
      // if this controller is marked — prevents stale-active resurrection.
      queueFetchedControllers.add(controller);
      return true;
    } catch {
      return false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, setQueue, updateThreadCatStatus]);

  // Restore per-thread tasks before paint so revisiting a thread does not show
  // an empty secondary panel while revalidation is still in flight.
  useLayoutEffect(() => {
    setTasks(taskCacheByThread.get(threadId) ?? []);
  }, [threadId, setTasks]);

  // Load history + tasks when threadId changes (handles initial mount and navigation)
  useEffect(() => {
    // The surface already projects the incoming thread before this passive effect.
    // Its geometry cannot update the departing thread; handleScroll owns that save.
    // Reset retained refs so the incoming messages take the initial restore path.
    prevCountRef.current = 0;
    prevFirstIdRef.current = null;
    readingRestoreRef.current = null;

    // Abort any in-flight requests from previous thread
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    loadingRef.current = false;
    const controller = abortRef.current;

    const startBootstrap = async (registrationGeneration: symbol) => {
      // Check if this thread has cached messages in the threadStates map.
      // If so, the store's setCurrentThread already restored them — skip API fetch.
      const state = useChatStore.getState();
      const workspaceStateAtLoadStart = captureThreadWorkspaceState(state, threadId);
      const cached = state.threadStates[threadId];
      const hasCachedMessages = cached && cached.messages.length > 0;
      const isThreadSynced = state.currentThreadId === threadId;

      // F120 durable workspace restore: the server remains authoritative for
      // thread/messages, while this user-visible local view (surface, exact
      // preview target, worktree and panel visibility) is restored from IDB.
      // A live event or manual navigation that wins the race invalidates the
      // captured expectation, so stale disk state cannot overwrite newer UI.
      void (async () => {
        try {
          const snapshot = await loadThreadWorkspaceState(threadId);
          if (isStaleThreadRequest(controller, threadId) || !snapshot) return;
          hydrateThreadWorkspaceState(threadId, snapshot, workspaceStateAtLoadStart);
        } catch {
          // Best-effort local view restore; normal workspace navigation remains available.
        }
      })();
      // #80 fix-A: If the thread has an active invocation, force-refresh from API
      // so that DraftStore drafts are merged into the response. Without this,
      // switching away and back shows stale cached messages (no streaming draft).
      const hasActiveInvocation = cached?.hasActiveInvocation === true;
      const hasCachedStreamOutput = cached ? cacheHoldsStreamOutput(cached.messages) : false;
      const pendingTeleport = peekPendingTeleport(threadId);
      const pendingCrossPost = peekPendingCrossPostScroll(threadId);
      const hasMissingTeleportTarget = Boolean(
        cached && pendingTeleport && !cached.messages.some((message) => message.id === pendingTeleport.messageId),
      );
      const hasMissingCrossPostTarget = Boolean(
        cached &&
          pendingCrossPost &&
          !findCrossPostTargetMessageId(
            cached.messages,
            pendingCrossPost.sourceInvocationId,
            pendingCrossPost.senderCatId,
          ),
      );
      let secondaryHydrationStarted = false;
      const hydrateSecondaryPanels = async () => {
        if (secondaryHydrationStarted) return false;
        secondaryHydrationStarted = true;
        if (isStaleThreadRequest(controller, threadId)) return false;
        const outcomes = await Promise.all([fetchTasks(), fetchTaskProgress(), fetchQueue()]);
        return outcomes.every((succeeded) => succeeded);
      };

      // F164: Reset offline badge on every thread switch so stale state from
      // a previous thread's aborted fetch never leaks to the new thread.
      if (useChatStore.getState().currentThreadId === threadId) {
        useChatStore.getState().setOfflineSnapshot(false);
      }

      // F194 Phase Z10 AC-Z28 (R14): restore IDB active state snapshot for F5
      // first paint so UI doesn't show fake "idle" gap while fetchQueue is
      // pending. fetchQueue (running in parallel via hydrateSecondaryPanels)
      // overwrites with server truth ~100ms later. If fetchQueue completes
      // before IDB load (unlikely — IDB faster than network), the IDB restore
      // skips so it doesn't regress fresh server truth.
      void (async () => {
        try {
          const snapshot = await loadThreadActiveState(threadId);
          if (isStaleThreadRequest(controller, threadId)) return;
          if (!snapshot) return;
          // F194 Phase Z10 (砚砚 R1 P1): if fetchQueue already wrote server truth
          // (active OR idle), IDB restore must NOT overwrite. The previous
          // `currentState.hasActiveInvocation === true` check only handled the
          // server-active case; server-idle case let stale IDB active resurrect.
          if (queueFetchedControllers.has(controller)) return;
          if (snapshot.hasActiveInvocation) {
            const store = useChatStore.getState();
            store.clearThreadActiveInvocation(threadId);
            store.setThreadHasActiveInvocation(threadId, true);
            for (const [invId, slot] of Object.entries(snapshot.activeInvocations)) {
              store.addThreadActiveInvocation(threadId, invId, slot.catId, slot.mode, slot.startedAt);
            }
          }
        } catch {
          // best-effort restore; fetchQueue is the authoritative source.
        }
      })();

      const bootstrap = async (): Promise<boolean> => {
        if (!hasCachedMessages) {
          // F164: Try IndexedDB snapshot before API fetch
          let restoredFromIdb = false;
          try {
            const idbSnapshot = await loadCachedMessages(threadId);
            if (isStaleThreadRequest(controller, threadId)) return false;
            if (idbSnapshot && idbSnapshot.messages.length > 0) {
              replaceThreadMessages(threadId, idbSnapshot.messages, idbSnapshot.hasMore);
              if (useChatStore.getState().currentThreadId === threadId) {
                useChatStore.getState().setOfflineSnapshot(true);
              }
              restoredFromIdb = true;
            } else if (isThreadSynced) {
              replaceThreadMessages(threadId, [], true);
            }
          } catch {
            if (isStaleThreadRequest(controller, threadId)) return false;
            if (isThreadSynced) {
              replaceThreadMessages(threadId, [], true);
            }
          }
          if (isStaleThreadRequest(controller, threadId)) return false;
          // Always fetch fresh data from API (replace snapshot)
          const fetchOk = await fetchHistory(undefined, { replace: true });
          // F164: Clear offline badge only after successful API fetch
          if (restoredFromIdb && fetchOk && useChatStore.getState().currentThreadId === threadId) {
            useChatStore.getState().setOfflineSnapshot(false);
          }
          return fetchOk === true;
        } else if (
          hasActiveInvocation ||
          (cached && cached.unreadCount > 0) ||
          hasCachedStreamOutput ||
          hasMissingTeleportTarget ||
          hasMissingCrossPostTarget
        ) {
          // #80 fix-A P1: Force-refresh with replace mode — the async response handler
          // will clear stale cache after setCurrentThread has run, then set fresh data
          // including DraftStore drafts in correct timestamp order.
          // F069-R4: Also force-refresh when the thread has unread messages. Without this,
          // the cached message list may lack the server's latest real messages, causing
          // the read-ack in ChatContainer to send an old sortable ID — the server still
          // counts messages after that ID as unread, and the badge reappears.
          // F123: If the cached snapshot already contains unstable bubble identity
          // (duplicate same-invocation bubbles or local-only draft/stream state),
          // thread switch must reconcile against authoritative history instead of
          // trusting the cached timeline until a later F5.
          return (await fetchHistory(undefined, { replace: true })) === true;
        }
        return true;
      };

      // AC-4: secondary panels hydrate in parallel with message history. The
      // admission stays running until both paths settle so owner loss can
      // promote a survivor instead of preserving a partial ready state.
      let outcome: 'succeeded' | 'failed' = 'failed';
      try {
        const [secondaryReady, historyReady] = await Promise.all([hydrateSecondaryPanels(), bootstrap()]);
        if (secondaryReady && historyReady) {
          // A freshly-created thread can complete its first History request before
          // Queue moves from queued -> processing. If the route transition also
          // misses the one-shot queue_updated event, the durable HTTP hydration is
          // the only remaining proof that delivery has started. Decide only after
          // both initial requests settle: checking inside fetchQueue would mistake
          // a still-pending History request for an empty authoritative timeline and
          // issue an unnecessary second fetch on every active thread open.
          const store = useChatStore.getState();
          const hydratedThread = store.getThreadState(threadId);
          if (
            !isStaleThreadRequest(controller, threadId) &&
            hydratedThread.hasActiveInvocation &&
            hydratedThread.messages.length === 0
          ) {
            store.requestStreamCatchUp(threadId);
          }
          outcome = 'succeeded';
        }
      } finally {
        historyAdmission.completeBootstrap(threadId, historyConsumerId, registrationGeneration, outcome);
      }
    };

    const unregisterHistoryConsumer = historyAdmission.register({
      threadId,
      consumerId: historyConsumerId,
      startBootstrap,
    });

    return () => {
      // Reading state is saved continuously while this surface owns the thread.
      cancelPendingRestore();
      controller.abort();
      unregisterHistoryConsumer();
    };
  }, [
    threadId,
    cancelPendingRestore,
    fetchHistory,
    fetchQueue,
    fetchTaskProgress,
    fetchTasks,
    isStaleThreadRequest,
    queueFetchedControllers,
    replaceThreadMessages,
    historyAdmission,
    historyConsumerId,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bug C safety net: when useAgentMessages detects done(isFinal) with no
  // streaming bubble, or processThreadSeq detects gap/epoch-change, it bumps
  // `streamCatchUpVersionByThread[threadId]`.
  //
  // F183 Phase C cloud P2 fix (2026-05-02): subscribe to per-thread version
  // slot (not the previous single-slot global `streamCatchUpVersion +
  // streamCatchUpThreadId`). Per-thread counter ensures bg gap on thread B
  // can't overwrite active thread A's pending signal — both threads
  // independently trigger their own fetchHistory.
  const catchUpVersion = useChatStore((s) => s.streamCatchUpVersionByThread[threadId] ?? 0);
  const consumedCatchUpVersion = useChatStore((s) => s.lastConsumedCatchUpVersionByThread[threadId] ?? 0);
  useEffect(() => {
    if (catchUpVersion === 0) return; // Skip initial render
    // Cloud R3 P2 fix (2026-05-02): only fire if version has advanced beyond
    // last consumed. Without this, thread-switch re-mounts re-fire fetchHistory
    // on stale catchUpVersion (already-handled trigger) → unnecessary full-history
    // reload + state churn on routine navigation.
    if (catchUpVersion <= consumedCatchUpVersion) return;
    // Cloud R3 P1 fix (2026-05-02): retry on skipped/failed fetch with exponential
    // backoff. Without retry, fetchHistory's `loadingRef.current` early-out (when
    // another fetch is in flight) returns undefined; my `result !== true` guard
    // correctly skips ack, but no retry was scheduled — pending hangs forever
    // if no future event triggers another version bump (e.g. dropped tail packet
    // on quiet thread). 3 retries with 1s/2s/4s backoff cap.
    //
    // Cloud R4 P1 fix (2026-05-02): retry exhaustion does NOT mark consumed.
    // Marking consumed on exhaustion permanently gates the effect on quiet
    // threads (no future events to bump version), so pending gap never retries
    // on remount/thread revisit — must manually F5. Instead: leave consumed
    // unchanged on exhaustion. Next remount (thread switch back / page nav)
    // re-runs effect → version > consumed (consumed didn't move) → fresh
    // retry cycle. Consumed only advances on actual fetch success.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    let retries = 0;
    const MAX_RETRIES = 3;

    const tryFetch = async () => {
      if (cancelled) return;
      // F183 Phase C 砚砚 R6 P1 race fix: capture pending target at fetch start,
      // NOT at ack time. If a newer gap arrives during fetch flight, we only
      // advance lastSeq to capturedTarget and keep newer pending for next ack.
      const targetAtStart = useChatStore.getState().pendingCatchUpTargetSeqByThread[threadId];
      try {
        const result = await fetchHistory(undefined, { replace: true, freshnessToken: catchUpVersion });
        if (cancelled) return;
        if (result === true) {
          // Success: ack catchup target + mark consumed (gates remount re-fire)
          useChatStore.getState().setLastConsumedCatchUpVersion(threadId, catchUpVersion);
          if (typeof targetAtStart === 'number' && targetAtStart > 0) {
            useChatStore.getState().acknowledgeCatchUp(threadId, targetAtStart);
          }
          return;
        }
        // Skipped (loadingRef early-out / !res.ok / stale thread / abort) — retry
        if (retries < MAX_RETRIES) {
          retries++;
          const backoff = 1000 * 2 ** (retries - 1); // 1s, 2s, 4s
          timer = setTimeout(tryFetch, backoff);
        }
        // Cloud R4 P1 fix (2026-05-02): exhausted retries — DO NOT mark consumed.
        // Marking consumed here permanently gates the effect on quiet threads
        // (no future events to bump version), so the pending gap never retries
        // on remount/thread revisit. Leave consumed unchanged — next remount
        // (e.g. thread switch back, page navigation) re-runs the effect with
        // fresh retry cycle. New gap event bumps version → still triggers normally.
      } catch {
        if (cancelled) return;
        if (retries < MAX_RETRIES) {
          retries++;
          const backoff = 1000 * 2 ** (retries - 1);
          timer = setTimeout(tryFetch, backoff);
        }
        // Cloud R4 P1: same — no setLastConsumedCatchUpVersion on exhaustion.
      }
    };

    // Initial 600ms debounce: collapses bursts of catch-up requests (e.g. multiple
    // gap events during a stream) into one fetchHistory call via timer cancel-restart.
    timer = setTimeout(tryFetch, 600);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [catchUpVersion, consumedCatchUpVersion, threadId, fetchHistory]);

  useLayoutEffect(() => {
    if (useChatStore.getState().currentThreadId !== threadId) return;
    const saved = readChatScrollState(threadId);
    if (saved?.anchor !== 'offset' || !saved.messageAnchor) return;
    const resolved = resolveChatReadingAnchor(saved.messageAnchor, messages);
    if (!resolved) return;
    if (
      resolved.messageId === saved.messageAnchor.messageId &&
      resolved.timelineOrderAt === saved.messageAnchor.timelineOrderAt
    )
      return;
    const next = { ...saved, messageAnchor: resolved };
    saveChatScrollState(threadId, next);
    const pending = readingRestoreRef.current;
    if (pending?.threadId === threadId) {
      pending.saved = next;
      scheduleRestore(next);
    } else if (resolved.messageId !== saved.messageAnchor.messageId) {
      scheduleCurrentAnchorCorrection();
    }
  }, [messages, threadId, scheduleRestore, scheduleCurrentAnchorCorrection]);

  // Snapshot scroll height before history load
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (el && isLoadingHistory) {
      scrollSnapshotRef.current = el.scrollHeight;
    }
  }, [isLoadingHistory]);

  const timelineMessageIds = useMemo(() => messages.map((message) => message.id), [messages]);

  // The same messages can change presentation order or rendered height while
  // streaming. Reapply the user's saved anchor before paint; browser-native
  // anchoring is disabled on the container so these two systems cannot fight.
  useLayoutEffect(() => {
    if (previousTimelineThreadRef.current !== threadId) {
      previousTimelineThreadRef.current = threadId;
      previousTimelineIdsRef.current = timelineMessageIds;
      return;
    }
    const previousIds = previousTimelineIdsRef.current;
    previousTimelineIdsRef.current = timelineMessageIds;
    if (previousIds.length === 0) return;

    const el = scrollContainerRef.current;
    const saved = readChatScrollState(threadId);
    if (!el || !saved || useChatStore.getState().currentThreadId !== threadId) return;

    const anchor: TimelineScrollAnchor | undefined =
      saved.anchor === 'bottom'
        ? { kind: 'bottom' }
        : saved.messageAnchor
          ? { kind: 'message', messageAnchor: saved.messageAnchor }
          : undefined;
    if (!anchor || !restoreTimelineScrollAnchor(el, anchor)) return;
    // Admission, prepend, and reorder all use this one correction. Do not
    // apply the older height-delta prepend correction on top of it.
    scrollSnapshotRef.current = null;
    saveChatScrollState(threadId, { ...saved, top: el.scrollTop });
  }, [threadId, timelineMessageIds]);

  // Scroll adjustment after messages change
  // biome-ignore lint/correctness/useExhaustiveDependencies: store sync must retry initial restore even when the scoped message reference is unchanged.
  useEffect(() => {
    const el = scrollContainerRef.current;

    if (messages.length === 0) return;

    // clowder-ai#27: wait for store to sync before acting on scroll.
    // On remount, threadId (prop) updates immediately but store.currentThreadId
    // is still the OLD thread until ChatContainer's useEffect calls setCurrentThread().
    // If we act now, we'd restore scroll on the wrong DOM content, then the store
    // swap re-render would trigger append-case scrollIntoView → position lost.
    // By returning early (without updating tracking refs), we ensure the NEXT
    // effect run (after store sync) still sees prevCount=0 and does the restore.
    const storeThreadId = useChatStore.getState().currentThreadId;
    if (storeThreadId !== threadId) return;

    const prevCount = prevCountRef.current;
    const prevFirstId = prevFirstIdRef.current;
    const currentFirstId = messages[0].id;

    prevCountRef.current = messages.length;
    prevFirstIdRef.current = currentFirstId;

    // Initial load (includes remount after thread switch — prevCountRef resets to 0).
    // clowder-ai#27: check module-level Map for a saved position before scrolling to bottom.
    if (prevCount === 0) {
      // Default scroll-restore. A pending cross-post jump is handled by the dedicated effect
      // below (it runs after this one and cancels this restore on a hit) — kept separate so the
      // jump survives the IDB-snapshot → fresh-API two-phase load (砚砚 R1 P1).
      const saved = readChatScrollState(threadId) ?? { top: 0, anchor: 'bottom' };
      readingRestoreRef.current = { threadId, saved };
      scheduleRestore(saved);
      return;
    }

    // Prepend case - maintain scroll position
    if (prevFirstId && currentFirstId !== prevFirstId && el && scrollSnapshotRef.current !== null) {
      const heightDelta = el.scrollHeight - scrollSnapshotRef.current;
      el.scrollTop += heightDelta;
      scrollSnapshotRef.current = null;
      rememberScrollState(threadId, el, false, true);
      return;
    }

    // Append case: only auto-follow when the user intentionally stayed at bottom.
    if (messages.length > prevCount) {
      const saved = readChatScrollState(threadId);
      if (saved?.anchor === 'bottom') {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        if (el) {
          saveChatScrollState(threadId, {
            top: el.scrollTop,
            anchor: 'bottom',
          });
        }
      }
    }
  }, [messages, scheduleRestore, storeCurrentThreadId, threadId]);

  // F052 + 砚砚 R1 P1: resolve a pending cross-post scroll across BOTH the tentative IDB-snapshot
  // phase and the authoritative fresh-API phase. Kept independent of the scroll-restore effect
  // above so it re-runs when isOfflineSnapshot flips true→false (fresh page replaces the stale
  // snapshot). A hit scrolls + consumes; a miss only gives up once authoritative
  // (isOfflineSnapshot=false), so a stale-snapshot miss keeps the jump alive for the fresh page.
  useEffect(() => {
    if (messages.length === 0) return;
    if (useChatStore.getState().currentThreadId !== threadId) return;
    const targetId = resolveCrossPostScrollTarget(threadId, messages, {
      authoritative: !isOfflineSnapshot && !isLoadingHistory && !loadingRef.current,
    });
    if (targetId) scheduleScrollToMessage(targetId);
  }, [messages, threadId, isOfflineSnapshot, isLoadingHistory, scheduleScrollToMessage]);

  // F227: resolve a pending teleport (from cat_cafe_teleport → Event Memory) the
  // same way as cross-post — across the tentative IDB snapshot + the authoritative
  // fresh page. Takes a real messageId directly (no invocationId lookup).
  // P1-1/P1 (砚砚): resolve a pending teleport — scroll if the target is loaded, else
  // auto-load older pages (full-corpus events can be older than the loaded 50-msg window).
  // Only finalize a miss (consume + give up) when this is the authoritative fresh page AND
  // no older history remains. Reused by the messages-effect (cross-thread nav + the
  // auto-load chain) and an explicit kick (same-thread teleport, where no route changes).
  const resolveTeleport = useCallback(() => {
    if (messages.length === 0) return;
    if (useChatStore.getState().currentThreadId !== threadId) return;
    if (loadingRef.current) return;
    const targetId = resolvePendingTeleport(
      threadId,
      messages.map((m) => m.id),
      { authoritative: !isOfflineSnapshot && !hasMore },
    );
    if (targetId) {
      scheduleScrollToMessage(targetId);
      return;
    }
    if (
      shouldLoadOlderForTeleport({
        hasPending: peekPendingTeleport(threadId) !== null,
        found: false,
        isStale: isOfflineSnapshot,
        hasMore,
        isLoading: isLoadingHistory,
      })
    ) {
      const oldest = findEarliestMessageByCursor(messages);
      if (oldest) void fetchHistory(`${getMessageTimelineCursorTime(oldest)}:${oldest.id}`);
    }
  }, [messages, threadId, isOfflineSnapshot, hasMore, isLoadingHistory, scheduleScrollToMessage, fetchHistory]);

  useEffect(() => {
    resolveTeleport();
  }, [resolveTeleport]);

  // A cold page has only the latest history window. Recover the exact reading
  // message through the existing history owner rather than accepting a pixel
  // offset over different messages. Explicit navigation and input end recovery.
  useEffect(() => {
    const pending = readingRestoreRef.current;
    if (!pending || pending.threadId !== threadId || messages.length === 0) return;
    if (useChatStore.getState().currentThreadId !== threadId || loadingRef.current || isLoadingHistory) return;
    if (
      peekPendingTeleport(threadId) ||
      peekPendingCrossPostScroll(threadId) ||
      restoreFrameKindRef.current === 'navigation'
    )
      return;
    if (isOfflineSnapshot) return;
    const anchor = pending.saved.anchor === 'offset' ? pending.saved.messageAnchor : undefined;
    if (anchor && !resolveChatReadingAnchor(anchor, messages)) {
      const oldest = messages.find((message) => !message.id.startsWith('draft-'));
      const oldestOrderAt = oldest ? getMessageTimelineOrderTime(oldest) : undefined;
      // Match the history owner's (timeline score, id) cursor, including score ties.
      const needsOlder =
        hasMore &&
        oldest &&
        anchor.timelineOrderAt !== undefined &&
        oldestOrderAt !== undefined &&
        (oldestOrderAt > anchor.timelineOrderAt ||
          (oldestOrderAt === anchor.timelineOrderAt && oldest.id > anchor.messageId));
      if (needsOlder) {
        const cursor = `${getMessageTimelineOrderTime(oldest)}:${oldest.id}`;
        if (pending.cursor === cursor) return;
        pending.cursor = cursor;
        void fetchHistory(cursor);
        return;
      }
      // The viewport is newly mounted, so its current top is not a reading
      // location. Use the next surviving timeline point, or default bottom.
      const successor = findChatReadingSuccessor(anchor, messages);
      const next: SavedScrollState = successor
        ? { top: 0, anchor: 'offset', messageAnchor: successor }
        : { top: 0, anchor: 'bottom' };
      pending.saved = next;
      // Retire the invalid identity even when a short/deferred layout cannot
      // yet settle. Restore completion writes the measured top for this intent.
      saveChatScrollState(threadId, next);
      scheduleRestore(next);
      return;
    }
    scheduleRestore(pending.saved);
  }, [
    messages,
    threadId,
    storeCurrentThreadId,
    hasMore,
    isOfflineSnapshot,
    isLoadingHistory,
    fetchHistory,
    scheduleRestore,
  ]);

  // Same-thread teleport doesn't change the route, so the effect above never re-fires;
  // the kick (cat_cafe_teleport / timeline same-thread click) re-runs the SAME resolver.
  useEffect(() => {
    const handler = () => resolveTeleport();
    window.addEventListener(TELEPORT_RESOLVE_EVENT, handler);
    return () => window.removeEventListener(TELEPORT_RESOLVE_EVENT, handler);
  }, [resolveTeleport]);

  useEffect(() => {
    const handler = (event: Event) => {
      const viewportAnchor = readChatLayoutViewportAnchor(event);
      if (!viewportAnchor) {
        scheduleCurrentAnchorCorrection();
        return;
      }

      const currentThread = threadIdRef.current;
      const el = scrollContainerRef.current;
      if (!el || useChatStore.getState().currentThreadId !== currentThread) return;
      cancelPendingRestore();
      readingRestoreRef.current = null;

      if (el.contains(viewportAnchor.element)) {
        el.scrollTop += viewportAnchor.element.getBoundingClientRect().top - viewportAnchor.viewportTop;
      } else {
        el.scrollTop = viewportAnchor.fallbackScrollTop;
      }
      const messageAnchor = captureMessageScrollAnchor(el);
      saveChatScrollState(currentThread, {
        top: el.scrollTop,
        anchor: 'offset',
        messageAnchor: messageAnchor
          ? describeChatReadingAnchor(messageAnchor, useChatStore.getState().getThreadState(currentThread).messages)
          : undefined,
      });
    };
    window.addEventListener(CHAT_LAYOUT_CHANGED_EVENT, handler);
    window.addEventListener(MESSAGE_VIEWPORT_MOUNTED_EVENT, handler);
    return () => {
      window.removeEventListener(CHAT_LAYOUT_CHANGED_EVENT, handler);
      window.removeEventListener(MESSAGE_VIEWPORT_MOUNTED_EVENT, handler);
    };
  }, [cancelPendingRestore, scheduleCurrentAnchorCorrection]);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    let touchY: number | null = null;
    let pointerY: number | null = null;
    const handleWheel = (event: WheelEvent) => {
      markScrollIntent(event.deltaY < 0);
    };
    const handleTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY ?? null;
    };
    const handleTouchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY ?? null;
      if (touchY !== null && nextY !== null && nextY !== touchY) markScrollIntent(nextY > touchY);
      touchY = nextY;
    };
    const handlePointerDown = (event: PointerEvent) => {
      markScrollIntent(false);
      pointerY = event.clientY;
    };
    const handlePointerMove = (event: PointerEvent) => {
      if (pointerY !== null && event.clientY !== pointerY) markScrollIntent(event.clientY < pointerY);
      pointerY = event.clientY;
    };
    const clearPointer = () => {
      pointerY = null;
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        event.defaultPrevented ||
        (target instanceof HTMLElement &&
          (target.isContentEditable || target.matches('input, textarea, select, [role="textbox"]')))
      ) {
        return;
      }
      const upward =
        event.key === 'ArrowUp' ||
        event.key === 'PageUp' ||
        event.key === 'Home' ||
        (event.key === ' ' && event.shiftKey);
      const downward =
        event.key === 'ArrowDown' ||
        event.key === 'PageDown' ||
        event.key === 'End' ||
        (event.key === ' ' && !event.shiftKey);
      if (upward || downward) {
        markScrollIntent(upward);
      }
    };

    el.addEventListener('wheel', handleWheel, { passive: true });
    el.addEventListener('touchstart', handleTouchStart, { passive: true });
    el.addEventListener('touchmove', handleTouchMove, { passive: true });
    el.addEventListener('touchend', clearPointer, { passive: true });
    el.addEventListener('pointerdown', handlePointerDown, { passive: true });
    el.addEventListener('pointermove', handlePointerMove, { passive: true });
    el.addEventListener('pointerup', clearPointer, { passive: true });
    el.addEventListener('pointercancel', clearPointer, { passive: true });
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      el.removeEventListener('wheel', handleWheel);
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchmove', handleTouchMove);
      el.removeEventListener('touchend', clearPointer);
      el.removeEventListener('pointerdown', handlePointerDown);
      el.removeEventListener('pointermove', handlePointerMove);
      el.removeEventListener('pointerup', clearPointer);
      el.removeEventListener('pointercancel', clearPointer);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [markScrollIntent]);

  // Load more when scrolled to top + clowder-ai#27 continuous scroll save
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    // clowder-ai#27: continuously save scroll position for this thread.
    // Guard: don't save during store swap (DOM content may not match threadId,
    // and browser may fire scroll events with scrollTop=0 during content swap).
    if (useChatStore.getState().currentThreadId !== threadIdRef.current) return;
    const restoring = restoreFrameKindRef.current === 'restore' || restoreFrameKindRef.current === 'navigation';
    if (!restoring) {
      rememberScrollState(threadIdRef.current, el, userScrollUpRef.current, !userScrollIntentRef.current);
      userScrollUpRef.current = false;
      userScrollIntentRef.current = false;
    }

    if (!hasMore || isLoadingHistory || restoreFrameKindRef.current === 'navigation') return;
    if (readingRestoreRef.current?.saved.anchor === 'offset') return;
    if (el.scrollTop < 80 && messages.length > 0) {
      // #80 cloud R8 P2: skip draft rows — their synthetic IDs break cursor semantics
      const oldest = findEarliestMessageByCursor(messages);
      if (oldest) {
        void fetchHistory(`${getMessageTimelineCursorTime(oldest)}:${oldest.id}`);
      }
    }
  }, [hasMore, isLoadingHistory, messages, fetchHistory]);

  const handleReadingIntent = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const disclosure = target.closest<HTMLElement>('[data-reading-disclosure]');
      const el = scrollContainerRef.current;
      if (!disclosure || !el || !el.contains(disclosure)) return;
      if (useChatStore.getState().currentThreadId !== threadIdRef.current) return;
      const messageAnchor = captureMessageScrollAnchorForElement(el, disclosure);
      if (!messageAnchor) return;
      cancelPendingRestore();
      saveChatScrollState(threadIdRef.current, { top: el.scrollTop, anchor: 'offset', messageAnchor });
    },
    [cancelPendingRestore],
  );
  const handleScrollRef = useRef(handleScroll);
  handleScrollRef.current = handleScroll;

  // A rail gesture is user input even though its control lives outside <main>.
  // The owner retires this input lifetime on navigation, restore, native input,
  // thread transition or end. Layout-only corrections keep the same gesture.
  const beginUserScroll = useCallback((): ChatUserScrollGesture | null => {
    const el = scrollContainerRef.current;
    if (!el || threadIdRef.current !== threadId) return null;
    const ownsReadingState = useChatStore.getState().currentThreadId === threadId;
    if (ownsReadingState) markScrollIntent(false);
    else cancelPendingRestore();
    const gesture = Symbol('chat-user-scroll');
    userScrollGestureRef.current = gesture;
    return {
      scrollTo(top: number): boolean {
        if (
          !Number.isFinite(top) ||
          userScrollGestureRef.current !== gesture ||
          threadIdRef.current !== threadId ||
          (useChatStore.getState().currentThreadId === threadId) !== ownsReadingState ||
          scrollContainerRef.current !== el
        ) {
          return false;
        }
        const boundedTop = Math.max(0, Math.min(top, Math.max(0, el.scrollHeight - el.clientHeight)));
        cancelPendingRestore(true);
        if (ownsReadingState) {
          userScrollUpRef.current = boundedTop < el.scrollTop;
          userScrollIntentRef.current = true;
        }
        el.scrollTop = boundedTop;
        // Save the resulting geometry even when no browser scroll event fires.
        // Read the current handler so paging during a drag uses the current page.
        if (ownsReadingState) handleScrollRef.current();
        return true;
      },
      end() {
        if (userScrollGestureRef.current !== gesture) return;
        userScrollGestureRef.current = null;
        userScrollUpRef.current = false;
        userScrollIntentRef.current = false;
      },
    };
  }, [threadId, markScrollIntent, cancelPendingRestore]);

  return {
    messages,
    handleScroll,
    handleReadingIntent,
    beginUserScroll,
    jumpToMessage,
    jumpToLatest,
    scrollContainerRef,
    messagesEndRef,
    isLoadingHistory,
    hasMore,
  };
}
