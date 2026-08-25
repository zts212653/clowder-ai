/**
 * F167 Phase J — Hold ball cancel + auto-cancel lifecycle.
 *
 * Extracted from callback-hold-ball-routes.ts for reuse by:
 * - DELETE /api/callbacks/hold-ball/:taskId (user-initiated cancel)
 * - POST /api/messages auto-cancel (user message invalidates pending holds)
 */

import type { SchedulerAwaitStateV1 } from '@cat-cafe/shared';
import { readManagedCommandWakeProjection } from '../domains/ball-custody/ManagedCommandWakeRecoverySweep.js';
import {
  isHoldBallWakeTask,
  isPendingHoldBallWakeTask,
  isRetiredWakeWithRunningManagedCommand as isRetiredWakeWithRunningManagedCommandTask,
  readHoldLifecycleProjection,
} from '../domains/ball-custody/managed-command-wake-lifecycle.js';
import type { DynamicTaskDef } from '../infrastructure/scheduler/DynamicTaskStore.js';
import {
  c1HoldCancelCount,
  holdEventRetiredTotal,
  userPingBeforeHolderTerminalTotal,
} from '../infrastructure/telemetry/instruments.js';

export type HoldExpectedSignalKey =
  | 'assignment'
  | 'review_posted'
  | 'ci_complete'
  | 'comment_posted'
  | 'managed_command_complete'
  | 'user_message';

export type HoldLifecycleStatus = 'active' | 'retired_by_event' | 'cancelled_by_user' | 'escalated' | 'fired';

export interface HoldLifecycleProjection {
  readonly mode: 'timer' | 'wake_when';
  readonly status: HoldLifecycleStatus;
  /** F280 Phase D: typed logical wait projection; absent only on legacy records. */
  readonly await?: SchedulerAwaitStateV1;
  readonly waitSourceRef?: Record<string, unknown>;
  readonly subjectKey?: string;
  readonly expectedSignalKey?: HoldExpectedSignalKey;
  readonly wakeAt?: number;
  readonly createdBy: string;
  readonly resolvedBy?: {
    readonly sourceKind: string;
    readonly sourceMessageId?: string;
    readonly subjectKey: string;
    readonly expectedSignalKey: HoldExpectedSignalKey;
    readonly at: number;
  };
}

export interface SatisfiedWaitEvent {
  readonly threadId: string;
  readonly subjectKey: string;
  readonly expectedSignalKey: string;
  readonly sourceKind: string;
  readonly sourceMessageId?: string;
}

export interface HoldBallCancelDeps {
  readonly dynamicTaskStore: {
    getById(id: string): DynamicTaskDef | null;
    getAll(): DynamicTaskDef[];
    remove(id: string): boolean;
    setEnabled?(id: string, enabled: boolean): boolean;
    updateParams?(id: string, params: Record<string, unknown>): boolean;
  };
  readonly taskRunner: {
    unregister(id: string): void;
  };
}

const STRUCTURED_SIGNAL_KEYS = new Set<HoldExpectedSignalKey>([
  'assignment',
  'review_posted',
  'ci_complete',
  'comment_posted',
  'managed_command_complete',
  'user_message',
]);

/** 判别 owner 在 ball-custody domain（R4 P2-1）；此处只保留既有 import 路径。 */
export const isHoldBallTask = isHoldBallWakeTask;

/** 判别 owner 在 ball-custody domain（R5 P1-1）；此处只保留既有 import 路径。 */
export const isPendingHoldBallTask = isPendingHoldBallWakeTask;

/**
 * An ordinary user message retires the obsolete wake carrier, not the
 * independently running managed command. Keep that execution discoverable and
 * explicitly cancelable until its exact runner reaches terminal.
 */
/** 判别 owner 在 ball-custody domain（R4 P2-1）；此处只保留既有 import 路径。 */
export const isRetiredWakeWithRunningManagedCommand = isRetiredWakeWithRunningManagedCommandTask;

export function isCancelableHoldBallTask(task: DynamicTaskDef): boolean {
  return isPendingHoldBallTask(task) || isRetiredWakeWithRunningManagedCommand(task);
}

export function isRetiredHoldBallTombstone(task: DynamicTaskDef): boolean {
  return isHoldBallTask(task) && readHoldLifecycle(task)?.status === 'retired_by_event';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeHoldExpectedSignalKey(value: unknown): HoldExpectedSignalKey | null {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return STRUCTURED_SIGNAL_KEYS.has(key as HoldExpectedSignalKey) ? (key as HoldExpectedSignalKey) : null;
}

export function normalizeHoldSubjectKey(subjectKey: unknown): string | null {
  if (typeof subjectKey !== 'string') return null;
  const trimmed = subjectKey.trim().toLowerCase();
  if (!trimmed) return null;

  const withoutPrefix = trimmed.startsWith('pr:')
    ? trimmed.slice(3)
    : trimmed.startsWith('issue:')
      ? trimmed.slice(6)
      : trimmed.startsWith('pr-')
        ? trimmed.slice(3)
        : trimmed;

  const direct = withoutPrefix.match(/^([a-z0-9_.-]+\/[a-z0-9_.-]+)#(\d+)$/i);
  if (direct) return `${direct[1].toLowerCase()}#${direct[2]}`;

  const url = trimmed.match(/github\.com\/([^/\s#]+)\/([^/\s#]+)\/(?:pull|issues)\/(\d+)/i);
  if (url) return `${url[1].toLowerCase()}/${url[2].toLowerCase()}#${url[3]}`;

  return null;
}

export function deriveHoldSubjectKeyFromWaitSourceRef(waitSourceRef: unknown): string | null {
  if (!isPlainRecord(waitSourceRef)) return null;
  const kind = waitSourceRef.kind;
  if (kind !== 'github_issue' && kind !== 'github_comment') return null;
  return normalizeHoldSubjectKey(waitSourceRef.value);
}

/** 判读 owner 在 ball-custody domain（R5 P1-1）；此处只做类型收窄。 */
export function readHoldLifecycle(task: DynamicTaskDef): HoldLifecycleProjection | null {
  return readHoldLifecycleProjection(task) as HoldLifecycleProjection | null;
}

function matchesSatisfiedWait(task: DynamicTaskDef, event: SatisfiedWaitEvent): boolean {
  if (!task.enabled) return false;
  if (task.deliveryThreadId !== event.threadId) return false;

  const lifecycle = readHoldLifecycle(task);
  if (!lifecycle || lifecycle.status !== 'active') return false;

  const taskSubject = normalizeHoldSubjectKey(lifecycle.subjectKey);
  const eventSubject = normalizeHoldSubjectKey(event.subjectKey);
  if (!taskSubject || !eventSubject || taskSubject !== eventSubject) return false;

  const taskSignal = normalizeHoldExpectedSignalKey(lifecycle.expectedSignalKey);
  const eventSignal = normalizeHoldExpectedSignalKey(event.expectedSignalKey);
  return !!taskSignal && !!eventSignal && taskSignal === eventSignal;
}

export function findHoldBallTask(
  taskId: string,
  store: Pick<HoldBallCancelDeps['dynamicTaskStore'], 'getById'>,
): DynamicTaskDef | null {
  const task = store.getById(taskId);
  if (!task || !isHoldBallTask(task)) return null;
  return task;
}

export function findPendingHoldBallTask(
  taskId: string,
  store: Pick<HoldBallCancelDeps['dynamicTaskStore'], 'getById'>,
): DynamicTaskDef | null {
  const task = store.getById(taskId);
  if (!task || !isPendingHoldBallTask(task)) return null;
  return task;
}

export function findCancelableHoldBallTask(
  taskId: string,
  store: Pick<HoldBallCancelDeps['dynamicTaskStore'], 'getById'>,
): DynamicTaskDef | null {
  const task = store.getById(taskId);
  if (!task || !isCancelableHoldBallTask(task)) return null;
  return task;
}

export function executeHoldCancel(task: DynamicTaskDef, deps: HoldBallCancelDeps): void {
  deps.taskRunner.unregister(task.id);
  deps.dynamicTaskStore.remove(task.id);
}

export function cancelHoldTaskById(taskId: string, deps: HoldBallCancelDeps): DynamicTaskDef | null {
  const task = findPendingHoldBallTask(taskId, deps.dynamicTaskStore);
  if (!task) return null;
  executeHoldCancel(task, deps);
  return task;
}

export function cancelPendingHoldsForThread(threadId: string, deps: HoldBallCancelDeps): DynamicTaskDef[] {
  const pending = deps.dynamicTaskStore
    .getAll()
    .filter((t) => isPendingHoldBallTask(t) && t.deliveryThreadId === threadId);
  const cancelled: DynamicTaskDef[] = [];

  for (const task of pending) {
    const command = readManagedCommandWakeProjection(task);
    // Managed commands use an invocation-bound terminal disposition. Ordinary
    // prose is never authorized to supersede that typed custody, regardless of
    // whether the command is still running, publishing its receipt, queued, or
    // already dispatched to its holder.
    if (command) {
      userPingBeforeHolderTerminalTotal.add(1);
      continue;
    }

    deps.taskRunner.unregister(task.id);
    cancelled.push(task);
    deps.dynamicTaskStore.remove(task.id);
  }
  if (cancelled.length > 0) c1HoldCancelCount.add(cancelled.length);
  return cancelled;
}

export function retirePendingHoldsForSatisfiedWait(
  event: SatisfiedWaitEvent,
  deps: HoldBallCancelDeps,
): DynamicTaskDef[] {
  if (!normalizeHoldSubjectKey(event.subjectKey) || !normalizeHoldExpectedSignalKey(event.expectedSignalKey)) {
    return [];
  }

  const pending = deps.dynamicTaskStore
    .getAll()
    .filter((t) => isPendingHoldBallTask(t) && matchesSatisfiedWait(t, event));

  for (const task of pending) {
    deps.taskRunner.unregister(task.id);
    const lifecycle = readHoldLifecycle(task);
    const signalKey = normalizeHoldExpectedSignalKey(event.expectedSignalKey);
    if (lifecycle && signalKey && deps.dynamicTaskStore.updateParams && deps.dynamicTaskStore.setEnabled) {
      deps.dynamicTaskStore.updateParams(task.id, {
        ...task.params,
        holdLifecycle: {
          ...lifecycle,
          status: 'retired_by_event',
          resolvedBy: {
            sourceKind: event.sourceKind,
            ...(event.sourceMessageId ? { sourceMessageId: event.sourceMessageId } : {}),
            subjectKey: event.subjectKey,
            expectedSignalKey: signalKey,
            at: Date.now(),
          },
        },
      });
      deps.dynamicTaskStore.setEnabled(task.id, false);
    } else {
      deps.dynamicTaskStore.remove(task.id);
    }
  }

  if (pending.length > 0) holdEventRetiredTotal.add(pending.length);
  return pending;
}
