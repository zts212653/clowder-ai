/**
 * F322 original-B: the one-row execution/queue surface, as a pure function of facts the app already holds.
 *
 * Nothing here reads a store or calls an endpoint. The adapter hook gathers the facts from the existing
 * authorities (the canonical execution projection, the thread's liveness, the chat store's queue); this module
 * only decides what ONE row says and which controls it offers. The ten states of the design (README §1.11
 * item 4) are the `status` values below; the preservation matrix pins which authority each control calls.
 *
 * Two rules the types make hard to break:
 *  - unknown is never blank: every reason / state has words, including ones this code has never heard of;
 *  - force-reset floats to the row for exactly three abnormal classes (`ForceResetReason`), never "always".
 */
import type { ActiveExecutionNonCancelableReason, ActiveExecutionProjection } from '@cat-cafe/shared';
import { activeExecutionKey } from '@/stores/activeExecutionStore';
import type { QueueEntry } from '@/stores/chat-types';
import { managedCommandActivityLabel } from '../managed-command-activity-label';
import type { QueueWaitInfo } from './queue-view';

/** Why the row offers 强制重置. Exactly the three abnormal classes of the design; the normal reset lives in the title menu. */
export type ForceResetReason = 'silent_turn' | 'unverified_legacy' | 'processing_stuck';

export type RowStatus = 'working' | 'stopping' | 'blocked' | 'silent' | 'unverified' | 'stuck' | 'paused' | 'waiting';

/** What the single ■ slot shows. `none` = nothing to stop here (several runs: each has its own ■ in the panel). */
export type StopSlot =
  | { kind: 'button'; execution: ActiveExecutionProjection }
  | { kind: 'pending' }
  | { kind: 'blocked'; reason: ActiveExecutionNonCancelableReason }
  | { kind: 'none' };

export interface ExecutionRowInput {
  /** Injected clock: the model is deterministic. */
  now: number;
  /** This thread's canonical executions, in start order. */
  executions: readonly ActiveExecutionProjection[];
  /** activeExecutionKey()s whose stop is already in flight. */
  cancelPendingKeys: ReadonlySet<string>;
  /**
   * activeExecutionKey()s of live turns that went quiet (isStreamingTipSuppressed). `since` is the last
   * activity time when the lifecycle knows it, null when only the status says so (do not invent minutes).
   */
  silent: Readonly<Record<string, { since: number | null }>>;
  /** The canonical projection failed its last refresh for this thread. */
  hydrationStale: boolean;
  /** The legacy socket still reports a live turn while the canonical projection has none and is not ready. */
  hasUnverifiedLegacyExecution: boolean;
  queue: {
    /** Raw queue length: a paused flag on an empty queue says nothing (the old panel hid itself too). */
    total: number;
    paused: boolean;
    pauseReason?: 'canceled' | 'failed';
    /** Entries the user is shown (selectVisibleQueueEntries). */
    entries: readonly QueueEntry[];
    canRecoverOrphaned: boolean;
    waitInfo: QueueWaitInfo | null;
  };
}

export interface ExecutionRowModel {
  /** False when there is nothing to say: the row takes no space. */
  visible: boolean;
  status: RowStatus;
  runningCount: number;
  /** Visible entries still waiting. */
  queuedCount: number;
  /** Visible entries whose processing is stuck (a force-reset is projected and no live target holds them). */
  stuckCount: number;
  /** Visible entries in total (paused text counts these). */
  visibleQueueCount: number;
  /** The queue is paused (and non-empty): the row says so whatever else it says. */
  queuePaused: boolean;
  /** The one run the row is about, when exactly one runs. */
  single: ActiveExecutionProjection | null;
  /** How long the single run has been going. */
  elapsedMs: number | null;
  /** Quiet turns right now. */
  silentCount: number;
  /** How long the single quiet turn has been quiet; null when unknown. */
  silentForMs: number | null;
  stop: StopSlot;
  /** Non-empty ⇒ the row floats a 强制重置. */
  forceReset: readonly ForceResetReason[];
  /** 继续 (queue paused) / 恢复 (queue orphaned); null = no resume control. The panel header always offers it. */
  resume: 'continue' | 'recover' | null;
  /**
   * What the ROW itself shows. A floating 强制重置 already asks for the user's attention, so an orphaned queue's 恢复
   * waits in the panel instead of competing with it; a paused queue's 继续 is its own state and stays.
   */
  resumeOnRow: 'continue' | 'recover' | null;
  /** The chevron: there is a panel worth opening. */
  panelToggle: boolean;
  /** "状态暂不可核对" badge. */
  staleNote: boolean;
  pauseReason: 'canceled' | 'failed' | null;
  waitInfo: QueueWaitInfo | null;
}

const ORDER = (left: ActiveExecutionProjection, right: ActiveExecutionProjection) =>
  left.startedAt - right.startedAt || left.executionId.localeCompare(right.executionId);

function stopSlotFor(single: ActiveExecutionProjection | null, pendingKeys: ReadonlySet<string>): StopSlot {
  if (!single) return { kind: 'none' };
  if (pendingKeys.has(activeExecutionKey(single))) return { kind: 'pending' };
  if (single.cancelability.state === 'not_cancelable') return { kind: 'blocked', reason: single.cancelability.reason };
  return { kind: 'button', execution: single };
}

interface Counts {
  running: number;
  silent: number;
  stuck: number;
  unverified: boolean;
  paused: boolean;
}

function statusFor(counts: Counts, stop: StopSlot): RowStatus {
  if (counts.running > 0) {
    if (stop.kind === 'pending') return 'stopping';
    if (counts.silent > 0) return 'silent';
    return stop.kind === 'blocked' ? 'blocked' : 'working';
  }
  if (counts.unverified) return 'unverified';
  if (counts.stuck > 0) return 'stuck';
  return counts.paused ? 'paused' : 'waiting';
}

/** Exactly the three abnormal classes of the design, in a fixed order. */
function forceResetReasons(counts: Counts): ForceResetReason[] {
  const reasons: ForceResetReason[] = [];
  if (counts.silent > 0) reasons.push('silent_turn');
  if (counts.unverified) reasons.push('unverified_legacy');
  if (counts.stuck > 0) reasons.push('processing_stuck');
  return reasons;
}

function silenceOf(single: ActiveExecutionProjection | null, input: ExecutionRowInput): number | null {
  const quiet = single ? input.silent[activeExecutionKey(single)] : undefined;
  return quiet && quiet.since !== null ? Math.max(0, input.now - quiet.since) : null;
}

export function deriveExecutionRow(input: ExecutionRowInput): ExecutionRowModel {
  const executions = [...input.executions].sort(ORDER);
  const { queue } = input;
  const single = executions.length === 1 ? executions[0] : null;
  const visibleQueueCount = queue.entries.length;
  const paused = queue.paused && queue.total > 0;
  const counts: Counts = {
    running: executions.length,
    silent: executions.filter((execution) => input.silent[activeExecutionKey(execution)] !== undefined).length,
    stuck: queue.entries.filter((entry) => entry.status === 'processing').length,
    unverified: executions.length === 0 && input.hasUnverifiedLegacyExecution,
    paused,
  };
  const stop = stopSlotFor(single, input.cancelPendingKeys);
  const status = statusFor(counts, stop);
  const forceReset = forceResetReasons(counts);
  const resume = paused ? 'continue' : queue.canRecoverOrphaned ? 'recover' : null;

  return {
    visible: counts.running > 0 || counts.unverified || counts.stuck > 0 || paused || visibleQueueCount > 0,
    status,
    runningCount: counts.running,
    queuedCount: queue.entries.filter((entry) => entry.status === 'queued').length,
    stuckCount: counts.stuck,
    visibleQueueCount,
    queuePaused: paused,
    single,
    elapsedMs: single ? Math.max(0, input.now - single.startedAt) : null,
    silentCount: counts.silent,
    silentForMs: silenceOf(single, input),
    stop,
    forceReset,
    resume,
    resumeOnRow: resume === 'continue' || forceReset.length === 0 ? resume : null,
    panelToggle: counts.running > 1 || visibleQueueCount > 0 || paused,
    staleNote: input.hydrationStale && counts.running > 0,
    pauseReason: paused ? (queue.pauseReason ?? 'failed') : null,
    waitInfo: queue.waitInfo,
  };
}

/** m:ss, the clock the design shows. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const BLOCKED_COPY: Record<ActiveExecutionNonCancelableReason, string> = {
  control_plane_unavailable: '控制面暂不可用，无法安全停止',
  cancellation_pending: '正在停止',
  terminalizing: '正在收尾，已不可停止',
  // The projection says "another principal started this" (the scheduler is only one example): do not claim more.
  foreign_principal: '不是你发起的，你不能停',
};

/** A reason this code has never heard of still gets words. */
export function blockedReasonCopy(reason: string): string {
  return BLOCKED_COPY[reason as ActiveExecutionNonCancelableReason] ?? '暂时不能停';
}

export const FORCE_RESET_REASON_COPY: Record<ForceResetReason, string> = {
  silent_turn: '这一轮已经一段时间没有动静',
  unverified_legacy: '本轮没有留下可核对的终态，可能已经结束',
  processing_stuck: '有一条消息的处理卡住了，没有猫在接它',
};

export const PAUSE_REASON_COPY = { canceled: '当前调用已取消', failed: '当前调用失败' } as const;

function queueTailOf(model: ExecutionRowModel): string {
  if (model.queuePaused) return ' · 排队已暂停';
  return model.queuedCount > 0 ? ` · 排队 ${model.queuedCount}` : '';
}

function silentText(model: ExecutionRowModel, clock: string, tail: string): string {
  if (!model.single) return `${model.silentCount} 件没动静${tail}`;
  const quiet =
    model.silentForMs !== null ? `${Math.max(1, Math.floor(model.silentForMs / 60_000))} 分钟没有动静` : '没有动静';
  return `${quiet}${clock}${tail}`;
}

function blockedText(model: ExecutionRowModel, who: string, clock: string): string {
  const single = model.single;
  const lead = single?.kind === 'managed_command' ? managedCommandActivityLabel(single.activity) : who;
  const reason = model.stop.kind === 'blocked' ? blockedReasonCopy(model.stop.reason) : '暂时不能停';
  return `${lead} · ${reason}${clock}`;
}

/**
 * The words of the row. `nameOf` resolves a cat id to the name the user knows it by.
 * Never returns an empty string for a visible row.
 */
export function rowStatusText(model: ExecutionRowModel, nameOf: (catId: string) => string): string {
  const tail = queueTailOf(model);
  const who = model.single ? nameOf(model.single.catId) : '';
  const clock = model.elapsedMs !== null ? ` ${formatClock(model.elapsedMs)}` : '';

  switch (model.status) {
    case 'working':
      return model.single ? `${who} 正在工作${clock}${tail}` : `${model.runningCount} 件在跑${tail}`;
    case 'stopping':
      return `正在停止${clock}`;
    case 'blocked':
      return blockedText(model, who, clock);
    case 'silent':
      return silentText(model, clock, tail);
    case 'unverified':
      return '运行状态待确认';
    case 'stuck':
      return `${model.stuckCount} 件处理卡住${tail}`;
    case 'paused':
      return `排队已暂停 · ${model.visibleQueueCount} 条`;
    case 'waiting':
      return `排队 ${model.queuedCount > 0 ? model.queuedCount : model.visibleQueueCount}`;
  }
}
