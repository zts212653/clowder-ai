'use client';

import { useCallback, useEffect, useRef } from 'react';
import { getBubbleInvocationId, shouldForceReplaceHydrationForCachedMessages } from '@/debug/bubbleIdentity';
import { recordDebugEvent } from '@/debug/invocationEventDebug';
import type { QueueEntry, TaskProgressItem } from '@/stores/chat-types';
import { type CatInvocationInfo, type ChatMessage as ChatMessageData, useChatStore } from '@/stores/chatStore';
import { useTaskStore } from '@/stores/taskStore';
import { apiFetch } from '@/utils/api-client';

type SavedScrollState = {
  top: number;
  anchor: 'bottom' | 'offset';
};

// clowder-ai#27: route navigation remounts the page, so scroll memory must live
// outside React refs to survive /thread/A → /thread/B → /thread/A.
const scrollPositionsByThread = new Map<string, SavedScrollState>();
const SCROLL_BOTTOM_THRESHOLD_PX = 24;
const MAX_RESTORE_FRAMES = 90;

function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.clientHeight - el.scrollTop <= SCROLL_BOTTOM_THRESHOLD_PX;
}

function rememberScrollState(threadId: string, el: HTMLElement) {
  scrollPositionsByThread.set(threadId, {
    top: el.scrollTop,
    anchor: isNearBottom(el) ? 'bottom' : 'offset',
  });
}

const HISTORY_PAGE_SIZE = 50;
// In export mode (?export=true), load all messages in one request for screenshot capture.
// Normal browsing still uses 50-per-page pagination.
const EXPORT_LIMIT = 10000;
// Keep first-screen message priority, but don't let secondary hydration stall indefinitely.
const SECONDARY_HYDRATION_FALLBACK_MS = 300;

function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && (err as { name?: string }).name === 'AbortError';
}

type ReplaceHydrationMergeStats = {
  preservedLocalCount: number;
  reconciledToHistoryCount: number;
  replacedHistoryCount: number;
};

type ReplaceHydrationMergeResult = {
  messages: ChatMessageData[];
  stats: ReplaceHydrationMergeStats;
};

function getHistoryInvocationId(msg: ChatMessageData): string | undefined {
  return getBubbleInvocationId(msg);
}

function getLocalPlaceholderInvocationId(
  msg: ChatMessageData,
  currentCatInvocations: Record<string, CatInvocationInfo>,
): string | undefined {
  if (msg.extra?.stream?.invocationId) return msg.extra.stream.invocationId;
  // Fallback: draft messages have id = 'draft-{invocationId}' — extract even after
  // isStreaming is cleared by the done handler (prevents duplicate bubbles).
  if (msg.id.startsWith('draft-')) return msg.id.slice('draft-'.length);
  if (msg.type !== 'assistant' || msg.origin !== 'stream' || !msg.isStreaming || !msg.catId) return undefined;
  return currentCatInvocations[msg.catId]?.invocationId;
}

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

function getMessageOrderTimestamp(msg: ChatMessageData): number {
  return msg.deliveredAt ?? msg.timestamp;
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

function mergeReplaceHydrationMessages(
  historyMsgs: ChatMessageData[],
  currentMsgs: ChatMessageData[],
  currentCatInvocations: Record<string, CatInvocationInfo>,
): ReplaceHydrationMergeResult {
  if (currentMsgs.length === 0) {
    return {
      messages: historyMsgs,
      stats: { preservedLocalCount: 0, reconciledToHistoryCount: 0, replacedHistoryCount: 0 },
    };
  }

  const historyIds = new Set(historyMsgs.map((msg) => msg.id));
  const mergedMsgs = [...historyMsgs];
  const historyIndexByStreamKey = new Map<string, number>();

  for (let i = 0; i < historyMsgs.length; i++) {
    const msg = historyMsgs[i]!;
    const invocationId = msg.catId ? getHistoryInvocationId(msg) : undefined;
    if (!msg.catId || !invocationId) continue;
    historyIndexByStreamKey.set(`${msg.catId}:${invocationId}`, i);
  }

  let preservedLocalCount = 0;
  let reconciledToHistoryCount = 0;
  let replacedHistoryCount = 0;

  for (const msg of currentMsgs) {
    if (historyIds.has(msg.id)) continue;

    const invocationId = msg.catId ? getLocalPlaceholderInvocationId(msg, currentCatInvocations) : undefined;
    const streamKey = msg.catId && invocationId ? `${msg.catId}:${invocationId}` : undefined;

    if (streamKey) {
      const historyIndex = historyIndexByStreamKey.get(streamKey);
      if (historyIndex !== undefined) {
        const historyMsg = mergedMsgs[historyIndex]!;
        if (shouldPreferCurrentMessage(msg, historyMsg)) {
          mergedMsgs[historyIndex] = msg;
          replacedHistoryCount++;
        } else {
          reconciledToHistoryCount++;
        }
        continue;
      }
    }

    mergedMsgs.push(msg);
    preservedLocalCount++;
  }

  return {
    messages: mergedMsgs.sort((a, b) => {
      const ta = a.deliveredAt ?? a.timestamp;
      const tb = b.deliveredAt ?? b.timestamp;
      if (ta !== tb) return ta - tb;
      return a.id.localeCompare(b.id);
    }),
    stats: {
      preservedLocalCount,
      reconciledToHistoryCount,
      replacedHistoryCount,
    },
  };
}

/**
 * Hook for managing chat history: fetching, pagination, scroll handling.
 * Extracted from ChatContainer to reduce component size.
 *
 * @param threadId - The active thread ID (from URL route param).
 */
export function useChatHistory(threadId: string) {
  const {
    messages,
    isLoadingHistory,
    hasMore,
    prependHistory,
    replaceMessages,
    setLoadingHistory,
    clearMessages,
    setCatInvocation,
    replaceThreadTargetCats,
    updateThreadCatStatus,
    setQueue,
    setQueuePaused,
  } = useChatStore();
  const { setTasks } = useTaskStore();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Scroll state for prepend handling
  const prevFirstIdRef = useRef<string | null>(null);
  const prevCountRef = useRef(0);
  const scrollSnapshotRef = useRef<number | null>(null);
  const restoreFrameRef = useRef<number | null>(null);

  // Track loading guard per-thread to prevent double-fetch
  const loadingRef = useRef(false);

  // P1 fix: AbortController to cancel in-flight requests on thread switch
  const abortRef = useRef<AbortController | null>(null);
  // Always-current threadId for stale response checks
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;

  const cancelPendingRestore = useCallback(() => {
    if (restoreFrameRef.current !== null) {
      cancelAnimationFrame(restoreFrameRef.current);
      restoreFrameRef.current = null;
    }
  }, []);

  const scheduleRestore = useCallback(
    (saved: SavedScrollState) => {
      cancelPendingRestore();
      let framesRemaining = MAX_RESTORE_FRAMES;
      // Capture threadId at schedule time so a stale callback can't mutate
      // the next thread's scroll state if it fires before effect cleanup.
      const scheduledForThread = threadIdRef.current;

      const apply = () => {
        // Stale guard: if thread switched before cleanup cancelled us, no-op.
        if (threadIdRef.current !== scheduledForThread) {
          restoreFrameRef.current = null;
          return;
        }

        const el = scrollContainerRef.current;
        if (!el) {
          restoreFrameRef.current = null;
          return;
        }

        const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
        const targetTop = saved.anchor === 'bottom' ? maxTop : Math.min(saved.top, maxTop);
        el.scrollTop = targetTop;

        const canSettle = saved.anchor === 'bottom' ? maxTop > 0 : maxTop >= saved.top;
        const reachedTarget = Math.abs(el.scrollTop - targetTop) <= 1;

        if ((canSettle && reachedTarget) || framesRemaining <= 0) {
          rememberScrollState(scheduledForThread, el);
          restoreFrameRef.current = null;
          return;
        }

        framesRemaining -= 1;
        restoreFrameRef.current = requestAnimationFrame(apply);
      };

      restoreFrameRef.current = requestAnimationFrame(apply);
    },
    [cancelPendingRestore],
  );

  // Fetch history page from API
  // When replace=true, clears existing messages before setting (used for force-refresh).
  const fetchHistory = useCallback(
    async (cursor?: string, options?: { replace?: boolean }) => {
      if (loadingRef.current) return;
      const controller = abortRef.current;
      if (!controller) return;

      loadingRef.current = true;
      setLoadingHistory(true);
      const fetchForThread = threadId; // capture at call time
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
        // Stale check: discard if thread changed during fetch
        if (threadIdRef.current !== fetchForThread) return;
        const data = await res.json();
        const historyMsgs = (data.messages ?? []).map(
          (m: {
            id: string;
            type: string;
            catId?: string;
            content: string;
            contentBlocks?: unknown[];
            toolEvents?: unknown[];
            metadata?: { provider: string; model: string; sessionId?: string };
            origin?: 'stream' | 'callback';
            thinking?: string;
            extra?: {
              rich?: { v: number; blocks: unknown[] };
              crossPost?: { sourceThreadId: string; sourceInvocationId?: string };
              stream?: { invocationId?: string };
            };
            timestamp: number;
            summary?: { id: string; topic: string; conclusions: string[]; openQuestions: string[]; createdBy: string };
            visibility?: 'public' | 'whisper';
            whisperTo?: string[];
            revealedAt?: number;
            isDraft?: boolean;
            source?: { connector: string; label: string; icon: string; url?: string };
            mentionsUser?: boolean;
            deliveredAt?: number;
            replyTo?: string;
            replyPreview?: { senderCatId: string | null; content: string; deleted?: true };
          }) =>
            ({
              id: m.id,
              type: (m.type === 'system'
                ? 'system'
                : m.summary
                  ? 'summary'
                  : m.source
                    ? 'connector'
                    : m.catId
                      ? 'assistant'
                      : 'user') as 'user' | 'assistant' | 'system' | 'summary' | 'connector',
              catId: m.catId,
              content: m.content,
              ...(m.contentBlocks ? { contentBlocks: m.contentBlocks } : {}),
              ...(m.toolEvents ? { toolEvents: m.toolEvents as import('../stores/chat-types').ToolEvent[] } : {}),
              ...(m.metadata ? { metadata: m.metadata } : {}),
              ...(m.origin ? { origin: m.origin } : {}),
              ...(m.thinking ? { thinking: m.thinking } : {}),
              ...(m.extra?.rich || m.extra?.crossPost || m.extra?.stream
                ? {
                    extra: {
                      ...(m.extra.rich ? { rich: m.extra.rich } : {}),
                      ...(m.extra.crossPost ? { crossPost: m.extra.crossPost } : {}),
                      ...(m.extra.stream ? { stream: m.extra.stream } : {}),
                    },
                  }
                : {}),
              ...(m.summary ? { summary: m.summary } : {}),
              ...(m.visibility ? { visibility: m.visibility } : {}),
              ...(m.whisperTo ? { whisperTo: m.whisperTo } : {}),
              ...(m.revealedAt ? { revealedAt: m.revealedAt } : {}),
              ...(m.deliveredAt ? { deliveredAt: m.deliveredAt } : {}),
              ...(m.source ? { source: m.source } : {}),
              ...(m.mentionsUser ? { mentionsUser: true } : {}),
              ...(m.replyTo ? { replyTo: m.replyTo } : {}),
              ...(m.replyPreview ? { replyPreview: m.replyPreview } : {}),
              // #80: Restore streaming indicator for draft messages recovered from Redis
              ...(m.isDraft ? { isStreaming: true } : {}),
              timestamp: m.timestamp,
            }) as ChatMessageData,
        );
        if (options?.replace) {
          // Replace mode now does a non-destructive merge first, then resets the thread
          // snapshot to the merged result in one step. The clear is no longer "drop
          // everything and trust history", it is "replace the stale cache with the
          // merged timeline we just computed". By the time this async callback runs,
          // setCurrentThread has already executed, so clearMessages targets the
          // correct thread.
          const currentState = useChatStore.getState();
          const mergeResult = mergeReplaceHydrationMessages(
            historyMsgs,
            currentState.messages,
            currentState.catInvocations,
          );
          const mergedMsgs = mergeResult.messages;
          recordDebugEvent({
            event: 'history_replace',
            threadId: fetchForThread,
            action:
              mergeResult.stats.preservedLocalCount > 0 || mergeResult.stats.replacedHistoryCount > 0
                ? 'merge_local'
                : mergeResult.stats.reconciledToHistoryCount > 0
                  ? 'reconcile_history'
                  : 'replace_exact',
            queueLength: mergedMsgs.length,
            reason: [
              `history=${historyMsgs.length}`,
              `current=${currentState.messages.length}`,
              `preservedLocal=${mergeResult.stats.preservedLocalCount}`,
              `reconciledToHistory=${mergeResult.stats.reconciledToHistoryCount}`,
              `replacedHistory=${mergeResult.stats.replacedHistoryCount}`,
            ].join(','),
          });
          replaceMessages(mergedMsgs, data.hasMore ?? false);
          return;
        }
        prependHistory(historyMsgs, data.hasMore ?? false);
      } catch (err) {
        // AbortError is expected during thread switch — ignore silently
        if (isAbortError(err)) return;
      } finally {
        // Do not let stale/aborted request clear loading state for a newer thread request.
        if (abortRef.current === controller && threadIdRef.current === fetchForThread) {
          loadingRef.current = false;
          setLoadingHistory(false);
        }
      }
    },
    [setLoadingHistory, prependHistory, replaceMessages, threadId],
  );

  const fetchTasks = useCallback(async () => {
    const fetchForThread = threadId;
    const controller = abortRef.current;
    if (!controller) return;

    try {
      const res = await apiFetch(`/api/tasks?threadId=${encodeURIComponent(fetchForThread)}`, {
        signal: controller.signal,
      });
      if (!res.ok) return;
      if (abortRef.current !== controller) return;
      if (threadIdRef.current !== fetchForThread) return;
      const data = await res.json();
      setTasks(data.tasks ?? []);
    } catch (err) {
      if (isAbortError(err)) return;
    }
  }, [threadId, setTasks]);

  // F045: Fetch cached task progress on mount to restore Plan Checklist after page refresh
  const fetchTaskProgress = useCallback(async () => {
    const fetchForThread = threadId;
    const controller = abortRef.current;
    if (!controller) return;

    try {
      const res = await apiFetch(`/api/threads/${encodeURIComponent(fetchForThread)}/task-progress`, {
        signal: controller.signal,
      });
      if (!res.ok) return;
      if (abortRef.current !== controller) return;
      if (threadIdRef.current !== fetchForThread) return;
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
    } catch (err) {
      if (isAbortError(err)) return;
    }
  }, [threadId, setCatInvocation, replaceThreadTargetCats]);

  // F39 Bug 1: Fetch queue state on mount/thread-switch to survive F5 refresh
  const fetchQueue = useCallback(async () => {
    const fetchForThread = threadId;
    const controller = abortRef.current;
    if (!controller) return;

    try {
      const res = await apiFetch(`/api/threads/${encodeURIComponent(fetchForThread)}/queue`, {
        signal: controller.signal,
      });
      if (!res.ok) return;
      if (abortRef.current !== controller) return;
      if (threadIdRef.current !== fetchForThread) return;
      const data = (await res.json()) as {
        queue: QueueEntry[];
        paused: boolean;
        pauseReason?: 'canceled' | 'failed';
        activeInvocations?: string[];
      };
      // Always sync server state — clears stale local data when server queue is empty
      setQueue(fetchForThread, data.queue);
      setQueuePaused(fetchForThread, data.paused, data.pauseReason);
      // Issue #83: Reconcile processing state from server-side InvocationTracker.
      // Uses thread-scoped APIs so it works correctly for both active and background threads,
      // and always overwrites stale snapshots restored by setCurrentThread().
      const store = useChatStore.getState();
      if (data.activeInvocations && data.activeInvocations.length > 0) {
        replaceThreadTargetCats(fetchForThread, data.activeInvocations);
        for (const catId of data.activeInvocations) {
          updateThreadCatStatus(fetchForThread, catId, 'streaming');
        }
        store.setThreadHasActiveInvocation(fetchForThread, true);
      } else {
        // Server says no active invocations — clear any stale processing state
        // that may have been restored from a threadStates snapshot.
        // clearThreadActiveInvocation clears BOTH hasActiveInvocation boolean
        // AND the activeInvocations slot map, preventing re-derivation bugs.
        store.clearThreadActiveInvocation(fetchForThread);
        replaceThreadTargetCats(fetchForThread, []);
      }
    } catch (err) {
      if (isAbortError(err)) return;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, setQueue, setQueuePaused, updateThreadCatStatus]);

  // Load history + tasks when threadId changes (handles initial mount and navigation)
  useEffect(() => {
    // Abort any in-flight requests from previous thread
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    loadingRef.current = false;
    const controller = abortRef.current;

    // Check if this thread has cached messages in the threadStates map.
    // If so, the store's setCurrentThread already restored them — skip API fetch.
    const state = useChatStore.getState();
    const cached = state.threadStates[threadId];
    const hasCachedMessages = cached && cached.messages.length > 0;
    const isThreadSynced = state.currentThreadId === threadId;

    // #80 fix-A: If the thread has an active invocation, force-refresh from API
    // so that DraftStore drafts are merged into the response. Without this,
    // switching away and back shows stale cached messages (no streaming draft).
    const hasActiveInvocation = cached?.hasActiveInvocation === true;
    const hasUnstableBubbleIdentity = cached ? shouldForceReplaceHydrationForCachedMessages(cached.messages) : false;
    let secondaryHydrationStarted = false;
    const hydrateSecondaryPanels = () => {
      if (secondaryHydrationStarted) return;
      secondaryHydrationStarted = true;
      if (abortRef.current !== controller || threadIdRef.current !== threadId) return;
      if (controller.signal.aborted) return;
      void fetchTasks();
      void fetchTaskProgress();
      void fetchQueue();
    };

    const secondaryFallbackTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
      hydrateSecondaryPanels();
    }, SECONDARY_HYDRATION_FALLBACK_MS);

    const bootstrap = async () => {
      try {
        if (!hasCachedMessages) {
          // During route thread switches, this effect can run before setCurrentThread.
          // Clearing too early would wipe the previous thread snapshot in the store.
          if (isThreadSynced) {
            clearMessages();
          }
          await fetchHistory();
        } else if (hasActiveInvocation || (cached && cached.unreadCount > 0) || hasUnstableBubbleIdentity) {
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
          await fetchHistory(undefined, { replace: true });
        }
      } finally {
        // Prioritize first-screen messages, then hydrate secondary panels.
        hydrateSecondaryPanels();
      }
    };

    void bootstrap();

    return () => {
      // Scroll save is now done during render (before DOM commit), not here.
      clearTimeout(secondaryFallbackTimer);
      cancelPendingRestore();
      abortRef.current?.abort();
    };
  }, [threadId, cancelPendingRestore, clearMessages, fetchHistory, fetchQueue, fetchTaskProgress, fetchTasks]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bug C safety net: when useAgentMessages detects done(isFinal) with no
  // streaming bubble, it bumps streamCatchUpVersion with a target threadId.
  // Only fetch if this hook's threadId matches the request (P1: thread-scoped).
  const catchUpVersion = useChatStore((s) => s.streamCatchUpVersion);
  const catchUpThreadId = useChatStore((s) => s.streamCatchUpThreadId);
  useEffect(() => {
    if (catchUpVersion === 0) return; // Skip initial render
    if (catchUpThreadId !== threadId) return; // P1: only act for matching thread
    // Small delay: backend may still be persisting the final message
    const timer = setTimeout(() => {
      void fetchHistory(undefined, { replace: true });
    }, 600);
    return () => clearTimeout(timer);
  }, [catchUpVersion, catchUpThreadId, threadId, fetchHistory]);

  // Snapshot scroll height before history load
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (el && isLoadingHistory) {
      scrollSnapshotRef.current = el.scrollHeight;
    }
  }, [isLoadingHistory]);

  // Scroll adjustment after messages change
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
      scheduleRestore(scrollPositionsByThread.get(threadId) ?? { top: 0, anchor: 'bottom' });
      return;
    }

    // Prepend case - maintain scroll position
    if (prevFirstId && currentFirstId !== prevFirstId && el && scrollSnapshotRef.current !== null) {
      const heightDelta = el.scrollHeight - scrollSnapshotRef.current;
      el.scrollTop += heightDelta;
      scrollSnapshotRef.current = null;
      rememberScrollState(threadId, el);
      return;
    }

    // Append case: only auto-follow when the user intentionally stayed at bottom.
    if (messages.length > prevCount) {
      const saved = scrollPositionsByThread.get(threadId);
      if (saved?.anchor === 'bottom') {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        if (el) {
          scrollPositionsByThread.set(threadId, {
            top: el.scrollTop,
            anchor: 'bottom',
          });
        }
      }
    }
  }, [messages, scheduleRestore, threadId]);

  // Load more when scrolled to top + clowder-ai#27 continuous scroll save
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    // clowder-ai#27: continuously save scroll position for this thread.
    // Guard: don't save during store swap (DOM content may not match threadId,
    // and browser may fire scroll events with scrollTop=0 during content swap).
    if (useChatStore.getState().currentThreadId === threadIdRef.current) {
      rememberScrollState(threadIdRef.current, el);
    }

    if (!hasMore || isLoadingHistory) return;
    if (el.scrollTop < 80 && messages.length > 0) {
      // #80 cloud R8 P2: skip draft rows — their synthetic IDs break cursor semantics
      const oldest = messages.find((m) => !m.id.startsWith('draft-'));
      if (oldest) {
        void fetchHistory(`${oldest.deliveredAt ?? oldest.timestamp}:${oldest.id}`);
      }
    }
  }, [hasMore, isLoadingHistory, messages, fetchHistory]);

  return {
    handleScroll,
    scrollContainerRef,
    messagesEndRef,
    isLoadingHistory,
    hasMore,
  };
}
