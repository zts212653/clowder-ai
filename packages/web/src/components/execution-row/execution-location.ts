'use client';

import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import { expandMessageExecutionRecord } from '@/components/message-disclosure-state';
import { requestExecutionDetail } from '@/components/workspace-home/execution-detail-request';
import { selectThreadMessages } from '@/hooks/useThreadScopedSelectors';
import { activeExecutionKey, useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';

/** An activation rechecks the canonical identity; neither a parent nor a newer reply is a target. */
export function locateExecution(
  execution: ActiveExecutionProjection,
  navigateToMessage: (messageId: string) => boolean,
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
  const message = selectThreadMessages(chat, current.threadId).find(
    (item) =>
      item.catId === current.catId &&
      item.isStreaming &&
      (item.lifecycle?.kind === 'response'
        ? item.lifecycle.invocationId
        : (item.extra?.stream?.turnInvocationId ?? item.extra?.stream?.invocationId)) === current.turnInvocationId,
  );
  if (!message) return 'unavailable';
  expandMessageExecutionRecord(current.threadId, message);
  // The mounted chat owner cancels pending bottom restores and retains this explicit
  // reading target through subsequent output, including deferred/split chat messages.
  return navigateToMessage(message.id) ? 'opened' : 'unavailable';
}
