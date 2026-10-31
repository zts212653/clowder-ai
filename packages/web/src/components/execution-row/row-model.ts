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
 *  - force-reset belongs to the thread's abnormal execution, never a delivered Queue entry.
 */
import type { ActiveExecutionNonCancelableReason, ActiveExecutionProjection } from '@cat-cafe/shared';
import { activeExecutionKey } from '@/stores/activeExecutionStore';
import type { QueueEntry } from '@/stores/chat-types';
import { type ExecutionRowWords, executionRowCopy } from './execution-row.shell-copy';
import type { QueueWaitInfo } from './queue-view';

/** Why the row offers thread recovery; normal reset lives in the title menu. */
export type ForceResetReason = 'silent_turn' | 'unverified_legacy';

export type RowStatus = 'working' | 'stopping' | 'blocked' | 'silent' | 'confirming' | 'unverified' | 'waiting';

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
  /** An initial read is still inside its bounded confirmation window. */
  hydrationLoading?: boolean;
  /** The legacy socket still reports a live turn while the canonical projection has none and is not ready. */
  hasUnverifiedLegacyExecution: boolean;
  queue: {
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
  /** Total entries in the visible Queue. */
  visibleQueueCount: number;
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
  /** Orphaned Queue recovery; null means no recovery control. */
  resume: 'recover' | null;
  /**
   * What the ROW itself shows. A floating 强制重置 already asks for the user's attention, so an orphaned queue's 恢复
   * waits in the panel instead of competing with it.
   */
  resumeOnRow: 'recover' | null;
  /** The chevron: there is a panel worth opening. */
  panelToggle: boolean;
  /** "状态暂不可核对" badge. */
  staleNote: boolean;
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
  unverified: boolean;
  confirming: boolean;
}

function statusFor(counts: Counts, stop: StopSlot): RowStatus {
  if (counts.running > 0) {
    if (stop.kind === 'pending') return 'stopping';
    if (counts.silent > 0) return 'silent';
    return stop.kind === 'blocked' ? 'blocked' : 'working';
  }
  if (counts.unverified) return 'unverified';
  if (counts.confirming) return 'confirming';
  return 'waiting';
}

/** Execution recovery reasons, in a fixed order. */
function forceResetReasons(counts: Counts): ForceResetReason[] {
  const reasons: ForceResetReason[] = [];
  if (counts.silent > 0) reasons.push('silent_turn');
  if (counts.unverified) reasons.push('unverified_legacy');
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
  const counts: Counts = {
    running: executions.length,
    silent: executions.filter((execution) => input.silent[activeExecutionKey(execution)] !== undefined).length,
    unverified: executions.length === 0 && input.hasUnverifiedLegacyExecution && !input.hydrationLoading,
    confirming: executions.length === 0 && input.hasUnverifiedLegacyExecution && Boolean(input.hydrationLoading),
  };
  const stop = stopSlotFor(single, input.cancelPendingKeys);
  const status = statusFor(counts, stop);
  const forceReset = forceResetReasons(counts);
  const resume = queue.canRecoverOrphaned ? 'recover' : null;

  return {
    visible: counts.running > 0 || counts.unverified || counts.confirming || visibleQueueCount > 0,
    status,
    runningCount: counts.running,
    queuedCount: queue.entries.filter((entry) => entry.status === 'queued').length,
    visibleQueueCount,
    single,
    elapsedMs: single ? Math.max(0, input.now - single.startedAt) : null,
    silentCount: counts.silent,
    silentForMs: silenceOf(single, input),
    stop,
    forceReset,
    resume,
    resumeOnRow: forceReset.length === 0 ? resume : null,
    panelToggle: counts.running > 1 || visibleQueueCount > 0,
    staleNote: input.hydrationStale && counts.running > 0,
    waitInfo: queue.waitInfo,
  };
}

/** m:ss, the clock the design shows. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** A reason this code has never heard of still gets words. */
export function blockedReasonCopy(reason: string, copy: ExecutionRowWords = executionRowCopy.zh): string {
  return copy.blockedReason[reason as ActiveExecutionNonCancelableReason] ?? copy.blockedReason.unknown;
}

export const FORCE_RESET_REASON_COPY: Record<ForceResetReason, string> = executionRowCopy.zh.forceResetReason;

function queueTailOf(model: ExecutionRowModel, copy: ExecutionRowWords): string {
  return model.queuedCount > 0 ? copy.status.queueTail(model.queuedCount) : '';
}

function silentText(model: ExecutionRowModel, clock: string, tail: string, copy: ExecutionRowWords): string {
  if (!model.single) return copy.status.silentMany(model.silentCount, tail);
  const quiet =
    model.silentForMs !== null
      ? copy.status.quietMinutes(Math.max(1, Math.floor(model.silentForMs / 60_000)))
      : copy.status.quietUnknown;
  return copy.status.silentOne(quiet, clock, tail);
}

function blockedText(model: ExecutionRowModel, who: string, clock: string, copy: ExecutionRowWords): string {
  const single = model.single;
  const lead = single?.kind === 'managed_command' ? copy.activity[single.activity ?? 'command'] : who;
  const reason =
    model.stop.kind === 'blocked' ? blockedReasonCopy(model.stop.reason, copy) : copy.blockedReason.unknown;
  return copy.status.blocked(lead, reason, clock);
}

/**
 * The words of the row. `nameOf` resolves a cat id to the name the user knows it by.
 * Never returns an empty string for a visible row.
 */
export function rowStatusText(
  model: ExecutionRowModel,
  nameOf: (catId: string) => string,
  copy: ExecutionRowWords = executionRowCopy.zh,
): string {
  const tail = queueTailOf(model, copy);
  const who = model.single ? nameOf(model.single.catId) : '';
  const clock = model.elapsedMs !== null ? ` ${formatClock(model.elapsedMs)}` : '';

  switch (model.status) {
    case 'working':
      return model.single?.kind === 'managed_command'
        ? copy.status.managed(who, copy.activity[model.single.activity ?? 'command'], clock, tail)
        : model.single
          ? copy.status.working(who, clock, tail)
          : copy.status.running(model.runningCount, tail);
    case 'stopping':
      return copy.status.stopping(clock);
    case 'blocked':
      return blockedText(model, who, clock, copy);
    case 'silent':
      return silentText(model, clock, tail, copy);
    case 'unverified':
      return copy.status.unverified;
    case 'confirming':
      return copy.status.confirming;
    case 'waiting':
      return copy.status.waiting(model.queuedCount > 0 ? model.queuedCount : model.visibleQueueCount);
  }
}

/** The narrow row keeps a whole, useful state after action labels yield. */
export function rowCompactStatusText(model: ExecutionRowModel, copy: ExecutionRowWords = executionRowCopy.zh): string {
  switch (model.status) {
    case 'working':
    case 'blocked':
      return model.single?.kind === 'managed_command'
        ? copy.status.managed('', copy.activity[model.single.activity ?? 'command'], '', '').trim()
        : copy.compact.working;
    case 'stopping':
      return copy.compact.stopping;
    case 'silent':
      return copy.compact.silent;
    case 'unverified':
      return copy.compact.unverified;
    case 'confirming':
      return copy.compact.confirming;
    case 'waiting':
      return copy.compact.waiting(model.queuedCount > 0 ? model.queuedCount : model.visibleQueueCount);
  }
}
