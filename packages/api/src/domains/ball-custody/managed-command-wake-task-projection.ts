/**
 * F297 (PR #3748 R6 P1-1) — managed command wake task 的 **read-model / 判别层**。
 *
 * 从 `managed-command-wake-lifecycle.ts` 拆出：那边是 recovery / terminal / trigger 的
 * 写入侧生命周期，这边是"给定一个 DynamicTaskDef，它是什么"的只读判读。R4/R5 把 task
 * identity、hold lifecycle projection、active/retired predicates 陆续收口到 ball-custody
 * 之后，判别层已经长成独立职责，继续堆在 recovery owner 里只是把硬线压力换个地方。
 *
 * **依赖方向**：本模块**不得** import `managed-command-wake-lifecycle.js`（会成环）。
 * 判别层是底座，lifecycle 从这里 import 并对外 re-export，既有 consumer 的 import 路径不变。
 *
 * 判别为什么必须只有一份（R4 P2-1 / R5 P1-1 的教训）：投影侧与取消侧是两条独立代码路径，
 * 判别一旦漂移，后果不是"少显示"，而是 active-execution 列表标了 `cancelable`、
 * DELETE 路径却拒绝 —— **用户点了取消却取消不掉**。
 */

import type { DynamicTaskDef } from '../../infrastructure/scheduler/DynamicTaskStore.js';

export type ManagedCommandWakeState =
  | 'command_running'
  | 'condition_met'
  | 'message_written'
  | 'dispatch_pending'
  | 'dispatched'
  | 'enqueued'
  | 'cancelled'
  | 'escalated'
  | 'consumed';

export type ManagedCommandWakeCarrierTerminalReason = 'withdrawn' | 'canceled' | 'terminal' | 'force_reset';

export interface ManagedCommandTerminalResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly cancelled?: boolean;
  readonly durationMs: number;
  readonly tailOutput?: string;
}

export interface ManagedCommandWakeProjection {
  readonly state: ManagedCommandWakeState;
  readonly command: string;
  readonly startedAt: number;
  readonly conditionMetAt?: number;
  readonly wakeContent?: string;
  readonly wakeSource?: 'command_completion' | 'fallback_timer';
  readonly result?: ManagedCommandTerminalResult;
  readonly messageClaimGeneration?: number;
  readonly messageClaimedAt?: number;
  readonly pendingCompletionContent?: string;
  readonly messageId?: string;
  readonly messageWrittenAt?: number;
  readonly dispatchAttemptCount?: number;
  readonly lastDispatchAt?: number;
  readonly lastDispatchOutcome?: 'dispatched' | 'enqueued' | 'full' | 'failed' | 'unavailable';
  readonly invocationId?: string;
  readonly carrierTerminalReason?: ManagedCommandWakeCarrierTerminalReason;
  readonly consumedAt?: number;
  readonly slaBreachObservedAt?: number;
  /** Number of exact failed Queue attempts redelivered for a missing invocation-bound disposition. */
  readonly dispositionRetryCount?: number;
  /** Idempotency fence for the failed attempt that authorized the latest redelivery. */
  readonly lastDispositionFailedAttemptId?: string;
  readonly dispositionEscalationReason?: 'managed_hold_disposition_missing';
  readonly dispositionEscalatedAttemptId?: string;
  readonly dispositionEscalatedAt?: number;
}

export interface ParsedManagedCommandWakeTask {
  readonly task: DynamicTaskDef;
  readonly lifecycle: Record<string, unknown>;
  readonly command: ManagedCommandWakeProjection;
  readonly threadId: string;
  readonly catId: string;
  readonly userId: string;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isManagedCommandWakeState(value: unknown): value is ManagedCommandWakeState {
  return (
    value === 'command_running' ||
    value === 'condition_met' ||
    value === 'message_written' ||
    value === 'dispatch_pending' ||
    value === 'dispatched' ||
    value === 'enqueued' ||
    value === 'cancelled' ||
    value === 'escalated' ||
    value === 'consumed'
  );
}

export function readManagedCommandWakeProjection(task: DynamicTaskDef): ManagedCommandWakeProjection | null {
  const lifecycle = task.params.holdLifecycle;
  if (!isPlainRecord(lifecycle) || lifecycle.mode !== 'wake_when') return null;
  const command = lifecycle.managedCommand;
  if (!isPlainRecord(command) || !isManagedCommandWakeState(command.state)) return null;
  if (typeof command.command !== 'string' || command.command.length === 0) return null;
  if (typeof command.startedAt !== 'number') return null;
  return command as unknown as ManagedCommandWakeProjection;
}

/** hold-ball wake carrier 的任务身份前缀。判别归 ball-custody domain 所有。 */
export const HOLD_BALL_TASK_ID_PREFIX = 'hold-ball-';

/**
 * hold-ball wake carrier 的**任务身份**判别 —— 单一 owner（PR #3748 R4 P2-1）。
 *
 * 以前这份判别只长在 `routes/hold-ball-cancel.ts::isHoldBallTask` 里，而 domain 侧的
 * `parseRetiredManagedCommandWakeTask` 只看 `createdBy` 前缀。两者不等价：一个
 * `id='dyn-not-hold' / templateId='other'` 的 disabled tombstone 会被 domain parser 认领、
 * 却被 route predicate 拒绝，于是 active-execution 把非 hold task 宣称成 cancelable
 * managed command，而 DELETE cancel path 仍然拒绝它。判别必须只有一份。
 */
export function isHoldBallWakeTask(task: DynamicTaskDef): boolean {
  return (
    task.id.startsWith(HOLD_BALL_TASK_ID_PREFIX) &&
    task.templateId === 'reminder' &&
    typeof task.createdBy === 'string' &&
    task.createdBy.startsWith('hold-ball:')
  );
}

/**
 * hold lifecycle 的合法性判读 —— **单一 owner**（R5 P1-1）。
 *
 * 与 `routes/hold-ball-cancel.ts::readHoldLifecycle` 同构（该处已改为 delegate）。
 * 缺 `createdBy` 的 lifecycle 不是合法 projection：取消路径据此拒绝任务，
 * 投影侧若不同样判读，就会宣称一个取消不掉的执行。
 */
export function readHoldLifecycleProjection(task: DynamicTaskDef): Record<string, unknown> | null {
  const lifecycle = task.params.holdLifecycle;
  if (!isPlainRecord(lifecycle)) return null;
  if (lifecycle.mode !== 'timer' && lifecycle.mode !== 'wake_when') return null;
  if (
    lifecycle.status !== 'active' &&
    lifecycle.status !== 'retired_by_event' &&
    lifecycle.status !== 'cancelled_by_user' &&
    lifecycle.status !== 'escalated' &&
    lifecycle.status !== 'fired'
  ) {
    return null;
  }
  if (typeof lifecycle.createdBy !== 'string') return null;
  return lifecycle;
}

/**
 * "wake carrier 仍在等" —— **判别的单一 owner**（R5 P1-1）。
 *
 * 投影侧的 active 分支必须过这道判别。R4 P2-1 只补了 retired 分支，因为当时把
 * "与旧 predicate 等价"当成目标；但旧代码的 active 分支本来就不校验身份，
 * 而 active-execution 列表会无条件把枚举结果标成 `cancelable`。判据是**取消路径认不认**。
 */
export function isPendingHoldBallWakeTask(task: DynamicTaskDef): boolean {
  if (!isHoldBallWakeTask(task) || !task.enabled) return false;
  if (!Object.hasOwn(task.params, 'holdLifecycle')) return true;
  return readHoldLifecycleProjection(task)?.status === 'active';
}

/**
 * "用户撤了 wake carrier，但被托管的命令还在跑" —— **判别的单一 owner**（R4 P2-1）。
 *
 * 这份判别以前只长在 `routes/hold-ball-cancel.ts`，而 active-execution 侧改用
 * `parseRetiredManagedCommandWakeTask` 顶替。两者不等价，且都是**投影比 cancel path 宽**：
 *   1. parser 不校验任务身份（`id` 前缀 / `templateId`）——探针：`id='dyn-not-hold'`
 *      `templateId='other'` 的 tombstone → legacy=false、projection=1。
 *   2. parser 不要求 `holdLifecycle.createdBy`（cancel path 经 `readHoldLifecycle` 要求）
 *      ——探针：删掉该字段 → legacy=false、projection=1。
 * 后果是 active-execution 把非 hold task 宣称成 cancelable managed command，
 * 而 DELETE cancel path 仍然拒绝它：用户点了取消却取消不掉。
 *
 * 刻意**不**去收紧 `parseRetiredManagedCommandWakeTask` 本身——它还有
 * `RetiredManagedCommandTerminalRecovery` 等 consumer，改其通用语义会外溢到终态恢复路径。
 * 投影侧改为先过本 predicate，再用 parser 取 threadId/catId/userId。
 */
export function isRetiredWakeWithRunningManagedCommand(task: DynamicTaskDef): boolean {
  if (!isHoldBallWakeTask(task) || task.enabled) return false;
  const lifecycle = readHoldLifecycleProjection(task);
  if (lifecycle?.mode !== 'wake_when' || lifecycle.status !== 'cancelled_by_user') return false;
  return readManagedCommandWakeProjection(task)?.state === 'command_running';
}

export function parseManagedCommandWakeTask(task: DynamicTaskDef | null): ParsedManagedCommandWakeTask | null {
  if (!task || !task.enabled || task.deliveryThreadId === null) return null;
  const lifecycle = task.params.holdLifecycle;
  const command = readManagedCommandWakeProjection(task);
  if (!isPlainRecord(lifecycle) || lifecycle.status !== 'active' || !command) return null;
  const catId = task.createdBy.startsWith('hold-ball:') ? task.createdBy.slice('hold-ball:'.length) : '';
  const userId = task.params.triggerUserId;
  if (!catId || typeof userId !== 'string' || !userId) return null;
  return { task, lifecycle, command, threadId: task.deliveryThreadId, catId, userId };
}

/** Parse the disabled tombstone left when user activity retires only the wake carrier. */
export function parseRetiredManagedCommandWakeTask(task: DynamicTaskDef | null): ParsedManagedCommandWakeTask | null {
  if (!task || task.enabled || task.deliveryThreadId === null) return null;
  const lifecycle = task.params.holdLifecycle;
  const command = readManagedCommandWakeProjection(task);
  if (!isPlainRecord(lifecycle) || lifecycle.status !== 'cancelled_by_user' || !command) return null;
  const catId = task.createdBy.startsWith('hold-ball:') ? task.createdBy.slice('hold-ball:'.length) : '';
  const userId = task.params.triggerUserId;
  if (!catId || typeof userId !== 'string' || !userId) return null;
  return { task, lifecycle, command, threadId: task.deliveryThreadId, catId, userId };
}

export function createInitialManagedCommandWakeProjection(
  command: string,
  startedAt: number,
): ManagedCommandWakeProjection {
  return { state: 'command_running', command, startedAt };
}
