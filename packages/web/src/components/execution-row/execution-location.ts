'use client';

import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import { expandMessageExecutionRecord } from '@/components/message-disclosure-state';
import type { MessageNavigationOptions } from '@/components/thread-chat/MessageNavigationContext';
import { requestExecutionDetail } from '@/components/workspace-home/execution-detail-request';
import { selectThreadMessages } from '@/hooks/useThreadScopedSelectors';
import { activeExecutionKey, useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';

/** An activation rechecks the canonical identity; neither a parent nor a newer reply is a target. */
export function locateExecution(
  execution: ActiveExecutionProjection,
  navigateToMessage: (messageId: string, options?: MessageNavigationOptions) => boolean,
): 'opened' | 'pending' | 'unavailable' {
  const current = useActiveExecutionStore.getState().executionsByKey[activeExecutionKey(execution)];
  if (!current || current.startedAt !== execution.startedAt || current.turnInvocationId !== execution.turnInvocationId)
    return 'unavailable';
  if (current.kind === 'managed_command') {
    if (useChatStore.getState().presentationLock) return 'unavailable';
    requestExecutionDetail(current);
    return 'pending';
  }
  if (!current.turnInvocationId) return 'unavailable';
  const chat = useChatStore.getState();
  const expectedRun = current.inputCapabilities?.append?.expectedRun;
  if (expectedRun && (expectedRun.invocationId !== current.turnInvocationId || expectedRun.targetId !== current.catId))
    return 'unavailable';
  const messages = selectThreadMessages(chat, current.threadId);
  const message = messages.find(
    (item) =>
      item.catId === current.catId &&
      (expectedRun
        ? item.id === expectedRun.responseMessageId
        : item.lifecycle?.kind === 'response'
          ? item.lifecycle.invocationId === current.turnInvocationId
          : item.isStreaming &&
            (item.extra?.stream?.turnInvocationId ?? item.extra?.stream?.invocationId) === current.turnInvocationId),
  );
  if (!message) {
    if (!expectedRun) return 'unavailable';
    // A long turn's durable response can be on an older history page. Its exact
    // server-owned identity lets the existing reader load it, without guessing
    // from the cat's latest callback or substituting the parent invocation.
    const target = { id: expectedRun.responseMessageId, type: 'assistant' as const, catId: current.catId };
    // The original record uses the response id before a draft exists, and the
    // child id once stream metadata is present. Open both keys before hydration.
    expandMessageExecutionRecord(current.threadId, target);
    expandMessageExecutionRecord(current.threadId, {
      ...target,
      extra: { stream: { turnInvocationId: current.turnInvocationId } },
    });
    return navigateToMessage(target.id, { loadIfNeeded: true }) ? 'pending' : 'unavailable';
  }
  expandMessageExecutionRecord(current.threadId, message);
  // The mounted chat owner cancels pending bottom restores and retains this explicit
  // reading target through subsequent output, including deferred/split chat messages.
  return navigateToMessage(message.id) ? 'opened' : 'unavailable';
}
