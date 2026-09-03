/*
Architecture cell: dispatch
Canonical Queue liveness also supplies bubble-pipeline presentation state.
*/
import { useChatStore } from '@/stores/chatStore';
import { saveThreadActiveState } from '@/utils/offline-store';
import { hydrateQueueActiveInvocationSlots, type QueueActiveInvocationSlot } from './queue-active-invocation-hydration';

export function hasStaleActiveThreadPresentation(
  state: ReturnType<typeof useChatStore.getState>,
  threadId: string,
): boolean {
  if (state.currentThreadId !== threadId) return false;
  if (state.messages.some((msg) => msg.type === 'assistant' && msg.isStreaming)) return true;
  if (state.intentMode === 'execute' && state.targetCats.length > 0) return true;
  return Object.values(state.catStatuses ?? {}).some((status) =>
    ['spawning', 'pending', 'streaming', 'alive_but_silent', 'suspected_stall'].includes(status),
  );
}

function finalizeStreamingBubblesAbsentFromServerSlots(threadId: string, activeCats: Set<string>): boolean {
  const store = useChatStore.getState();
  const isActiveThread = store.currentThreadId === threadId;
  const messagesToCheck = isActiveThread ? store.messages : store.getThreadState(threadId).messages;
  let finalizedAny = false;

  for (const msg of messagesToCheck) {
    if (msg.type !== 'assistant' || msg.isStreaming !== true) continue;
    if (msg.catId && activeCats.has(msg.catId)) continue;
    store.setThreadMessageStreaming(threadId, msg.id, false);
    finalizedAny = true;
  }

  if (finalizedAny) store.requestStreamCatchUp(threadId);
  return finalizedAny;
}

function persistThreadActiveSnapshot(threadId: string, state: Parameters<typeof saveThreadActiveState>[1]): void {
  void saveThreadActiveState(threadId, state).catch(() => {
    // IndexedDB is a first-paint cache. Canonical in-memory reconciliation
    // remains authoritative when storage is unavailable.
  });
}

function collectTerminalCatStatuses(
  source: Pick<ReturnType<typeof useChatStore.getState>, 'catStatuses' | 'catInvocations'>,
): Map<string, 'done' | 'error'> {
  const terminalStatuses = new Map<string, 'done' | 'error'>();
  for (const [catId, status] of Object.entries(source.catStatuses ?? {})) {
    if (status === 'done' || status === 'error') terminalStatuses.set(catId, status);
  }
  for (const [catId, info] of Object.entries(source.catInvocations ?? {})) {
    switch (info.appServerLifecycle?.stage) {
      case 'failed':
        terminalStatuses.set(catId, 'error');
        break;
      case 'completed':
      case 'interrupted':
      case 'closing':
      case 'closed':
        terminalStatuses.set(catId, 'done');
        break;
    }
  }
  return terminalStatuses;
}

function hydrateQueueActiveProjection(threadId: string, slots: readonly QueueActiveInvocationSlot[], source: string) {
  const serverActiveCats = slots.map((slot) => slot.catId);
  const activeInvocations = hydrateQueueActiveInvocationSlots({ threadId, slots });
  persistThreadActiveSnapshot(threadId, { hasActiveInvocation: true, activeInvocations });
  finalizeStreamingBubblesAbsentFromServerSlots(threadId, new Set(serverActiveCats));
  console.log(`[ws] ${source} reconciliation: re-hydrated active slots from server`, {
    threadId,
    cats: serverActiveCats,
  });
}

function clearQueueActiveProjection(threadId: string, source: string): void {
  const store = useChatStore.getState();
  const isActiveThread = store.currentThreadId === threadId;
  const threadState = store.getThreadState(threadId);
  const shouldClear = isActiveThread
    ? store.hasActiveInvocation || hasStaleActiveThreadPresentation(store, threadId)
    : threadState.hasActiveInvocation;
  persistThreadActiveSnapshot(threadId, { hasActiveInvocation: false, activeInvocations: {} });
  if (!shouldClear) return;

  const terminalStatuses = collectTerminalCatStatuses(isActiveThread ? store : threadState);
  store.clearThreadActiveInvocation(threadId);
  store.setThreadLoading(threadId, false);
  store.setThreadIntentMode(threadId, null);
  store.clearThreadCatStatuses(threadId);
  for (const [catId, status] of terminalStatuses) store.updateThreadCatStatus(threadId, catId, status);

  for (const msg of isActiveThread ? store.messages : threadState.messages) {
    if (msg.type === 'assistant' && msg.isStreaming) store.setThreadMessageStreaming(threadId, msg.id, false);
  }
  if (isActiveThread) store.requestStreamCatchUp(threadId);
  console.log(
    `[ws] ${source} reconciliation: cleared stale ${isActiveThread ? 'active-thread' : 'background-thread'} invocation state`,
    { threadId },
  );
}

/**
 * Apply one authoritative `/queue` liveness projection to the thread store.
 * Reconnect and user-triggered Queue refreshes share this exact writer.
 */
export function reconcileQueueActiveInvocationProjection({
  threadId,
  slots,
  source,
}: {
  threadId: string;
  slots: readonly QueueActiveInvocationSlot[] | undefined;
  source: string;
}): void {
  if (slots && slots.length > 0) {
    hydrateQueueActiveProjection(threadId, slots, source);
    return;
  }
  clearQueueActiveProjection(threadId, source);
}
