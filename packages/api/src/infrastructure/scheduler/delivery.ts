/**
 * Phase 4 (AC-H1): Delivery function factory for scheduled task execution.
 * Templates call deliver() to post messages to threads without going through MCP callbacks.
 */
import { randomUUID } from 'node:crypto';
import type { DeliverOpts, ScheduleLifecycleNotice } from './types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

export interface DeliveryDeps {
  messageStore: { append: AnyFn };
  socketManager: { broadcastToRoom: AnyFn; emitToUser: AnyFn };
}

export const SCHEDULER_SOURCE = {
  connector: 'scheduler',
  label: '定时任务',
  icon: 'scheduler',
} as const;

export function createDeliverFn(deps: DeliveryDeps): (opts: DeliverOpts) => Promise<string> {
  return async (opts: DeliverOpts): Promise<string> => {
    const stored = await deps.messageStore.append({
      userId: opts.userId,
      catId: null,
      content: opts.content,
      mentions: [],
      origin: 'callback',
      timestamp: Date.now(),
      threadId: opts.threadId,
      source: SCHEDULER_SOURCE,
      ...(opts.extra ? { extra: opts.extra } : {}),
    });
    const schedulerExtra = stored.extra?.scheduler ?? opts.extra?.scheduler;
    deps.socketManager.broadcastToRoom(`thread:${opts.threadId}`, 'connector_message', {
      threadId: opts.threadId,
      message: {
        id: stored.id,
        type: 'connector',
        content: opts.content,
        source: SCHEDULER_SOURCE,
        ...(schedulerExtra ? { extra: { scheduler: schedulerExtra } } : {}),
        timestamp: stored.timestamp,
      },
    });
    return stored.id;
  };
}

export function createLifecycleToastFn(
  deps: Pick<DeliveryDeps, 'socketManager'>,
): (notice: ScheduleLifecycleNotice) => void {
  return (notice: ScheduleLifecycleNotice): void => {
    deps.socketManager.emitToUser(notice.userId, 'connector_message', {
      threadId: notice.threadId,
      message: {
        id: `scheduler-toast-${Date.now()}-${randomUUID().slice(0, 8)}`,
        type: 'connector',
        content: notice.toast.message,
        source: SCHEDULER_SOURCE,
        extra: { scheduler: { toast: notice.toast } },
        timestamp: Date.now(),
      },
    });
  };
}
