/**
 * F337: after a sleep cut a cat off, wake it again once the lid is really open.
 *
 * The failure usually surfaces during a short maintenance dark wake, and a continuation sent then
 * would be cut by the next sleep. So each interrupted turn waits here until the power log shows a
 * full wake after its sleep, then gets the same continuation F048 sends after a restart.
 *
 * The promise is durable: writing the `host_sleep` terminal also records the turn as owed (same
 * atomic write), and it stays owed until a delivery settles it or the member runs again in that
 * thread. `recoverOwedContinuations` re-registers every owed one at startup. There is no expiry — an
 * overnight sleep still continues in the morning; the delivery skips a cat that already ran again or
 * was stopped in that thread, and its idempotency key prevents a second message.
 *
 * A turn the runtime's own stop cut off (`restart_shutdown`) is owed the same way and recovered here
 * after the next boot as a restart continuation; nothing to wait for, so it is checked right away.
 */

import {
  type ITurnExecutionStore,
  RESTART_SHUTDOWN_TERMINAL_REASON,
} from '../../../stores/ports/TurnExecutionStore.js';
import {
  type ContinuationKind,
  concludedContinuationIds,
  type RestartContinuationResult,
} from '../restart-continuation/RestartContinuation.js';
import { type HostSleepEvidenceReader, isInFullWakeSince } from './HostSleepEvidence.js';

interface TimerHandle {
  unref?(): void;
}

export interface HostSleepContinuationSchedulerDeps {
  readonly readEvidence: HostSleepEvidenceReader;
  /** Delivers the continuation for these interrupted invocations (F048 delivery, wording by kind). */
  readonly continueCats: (invocationIds: readonly string[], kind: ContinuationKind) => Promise<unknown>;
  /** Clears the owed record of continuations no longer owed (delivered, or the member ran again). */
  readonly settleOwed?: (invocationIds: readonly string[]) => Promise<void> | void;
  readonly log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
  readonly now?: () => number;
  readonly setTimer?: (fn: () => Promise<void>, ms: number) => TimerHandle;
  readonly pollMs?: number;
  readonly maxRetryDelayMs?: number;
}

/** A sleep continuation waits for a full wake after `sleptAt`; a restart one is due as soon as it is registered. */
export type ScheduledContinuation =
  | { readonly invocationId: string; readonly kind?: 'host_sleep'; readonly sleptAt: number }
  | { readonly invocationId: string; readonly kind: 'process_restart' };

type PendingContinuation = (
  | { readonly kind: 'host_sleep'; readonly sleptAt: number }
  | { readonly kind: 'process_restart' }
) & { readonly failures: number; readonly notBefore: number };

const DEFAULT_POLL_MS = 60_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 30 * 60_000;

/** Only a well-formed receipt concludes anything; an unexpected return leaves every id open. */
function concludedIds(result: unknown): Set<string> {
  const receipt = result as Partial<RestartContinuationResult> | undefined;
  if (
    !receipt ||
    !Array.isArray(receipt.delivered) ||
    !Array.isArray(receipt.skipped) ||
    !Array.isArray(receipt.coalesced) ||
    !Array.isArray(receipt.missing)
  )
    return new Set();
  return concludedContinuationIds(receipt as RestartContinuationResult);
}

export class HostSleepContinuationScheduler {
  private readonly pending = new Map<string, PendingContinuation>();
  private armed = false;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => Promise<void>, ms: number) => TimerHandle;
  private readonly pollMs: number;
  private readonly maxRetryDelayMs: number;

  constructor(private readonly deps: HostSleepContinuationSchedulerDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) =>
        setTimeout(() => {
          void fn();
        }, ms));
    this.pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
    this.maxRetryDelayMs = deps.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  }

  schedule(input: ScheduledContinuation): void {
    if (this.pending.has(input.invocationId)) return;
    const waiting =
      input.kind === 'process_restart'
        ? { kind: 'process_restart' as const }
        : { kind: 'host_sleep' as const, sleptAt: input.sleptAt };
    this.pending.set(input.invocationId, { ...waiting, failures: 0, notBefore: 0 });
    this.arm(waiting.kind === 'process_restart' ? 0 : this.pollMs);
  }

  private arm(delayMs = this.pollMs): void {
    if (this.armed || this.pending.size === 0) return;
    this.armed = true;
    this.setTimer(() => this.tick(), delayMs).unref?.();
  }

  private async tick(): Promise<void> {
    this.armed = false;
    try {
      const now = this.now();
      const due = [...this.pending].filter(([, entry]) => entry.notBefore <= now);
      if (due.length === 0) return;
      // Restart continuations wait for nothing: deliver them before the power log is even asked.
      const restarts = due.filter(([, entry]) => entry.kind === 'process_restart');
      if (restarts.length > 0) await this.deliver('process_restart', restarts);
      const awake = await this.awakeAmong(due, now);
      if (awake.length > 0) await this.deliver('host_sleep', awake);
    } catch (error) {
      this.deps.log.warn({ error: String(error) }, '[F337] continuation check failed');
    } finally {
      this.arm();
    }
  }

  /** The sleep continuations among `due` whose sleep the power log shows a full wake after. */
  private async awakeAmong(
    due: ReadonlyArray<[string, PendingContinuation]>,
    now: number,
  ): Promise<Array<[string, PendingContinuation]>> {
    const ready: Array<[string, PendingContinuation]> = [];
    const sleptAt = due.flatMap(([, entry]) => (entry.kind === 'host_sleep' ? [entry.sleptAt] : []));
    if (sleptAt.length === 0) return ready;
    try {
      const evidence = await this.deps.readEvidence({ from: Math.min(...sleptAt), to: now });
      for (const item of due) {
        const entry = item[1];
        if (entry.kind === 'host_sleep' && isInFullWakeSince(evidence, entry.sleptAt) === true) ready.push(item);
      }
    } catch (error) {
      // Not knowing whether the lid is open only delays the sleep ones.
      this.deps.log.warn({ error: String(error) }, '[F337] power log unreadable; sleep continuations wait');
    }
    return ready;
  }

  private async deliver(kind: ContinuationKind, batch: ReadonlyArray<[string, PendingContinuation]>): Promise<void> {
    // Claim before the first await: a restart registered mid-tick starts a second tick, and an id is
    // delivered only by the tick that still finds it pending.
    const claimed = batch.filter(([invocationId]) => this.pending.delete(invocationId));
    if (claimed.length === 0) return;
    const invocationIds = claimed.map(([invocationId]) => invocationId);
    const previous = new Map(claimed);
    this.deps.log.info({ invocationIds, kind }, '[F337] delivering continuations');
    let concluded = new Set<string>();
    try {
      concluded = concludedIds(await this.deps.continueCats(invocationIds, kind));
    } catch (error) {
      this.deps.log.warn({ error: String(error), kind }, '[F337] continuation delivery threw');
    }
    // Clear only what the receipt positively concluded; failed, unreadable or unaccounted ids stay owed.
    const settled = invocationIds.filter((invocationId) => concluded.has(invocationId));
    const open = invocationIds.filter((invocationId) => !concluded.has(invocationId));
    if (settled.length > 0 && this.deps.settleOwed) {
      try {
        await this.deps.settleOwed(settled);
      } catch (error) {
        // Still owed on record: the next startup re-registers it and the delivery replays idempotently.
        this.deps.log.warn({ error: String(error), settled }, '[F337] owed continuations not cleared');
      }
    }
    for (const invocationId of open) {
      const entry = previous.get(invocationId);
      if (!entry) continue;
      const failures = entry.failures + 1;
      const delay = Math.min(this.maxRetryDelayMs, this.pollMs * 2 ** failures);
      this.pending.set(invocationId, { ...entry, failures, notBefore: this.now() + delay });
    }
  }
}

/**
 * Startup: re-register every continuation still owed — sleeps not yet continued, and turns the previous
 * process's stop cut off. The owed set is exact (written with the terminal), so nothing depends on how
 * much history exists; entries whose member already ran again in that thread are cleared instead.
 */
export async function recoverOwedContinuations(input: {
  readonly turns: Pick<
    ITurnExecutionStore,
    'listOwedContinuations' | 'hasMemberTurnStartedAfter' | 'settleOwedContinuations'
  >;
  readonly scheduler: Pick<HostSleepContinuationScheduler, 'schedule'>;
  readonly log: { info(obj: object, msg: string): void };
}): Promise<{ readonly owed: number; readonly scheduled: number; readonly cleared: number }> {
  const owed = await input.turns.listOwedContinuations();
  // Restart ones first: the first registration arms the check, and theirs is immediate.
  const restartFirst = [...owed].sort(
    (a, b) =>
      Number(b.terminalReason === RESTART_SHUTDOWN_TERMINAL_REASON) -
      Number(a.terminalReason === RESTART_SHUTDOWN_TERMINAL_REASON),
  );
  const cleared: string[] = [];
  let scheduled = 0;
  for (const record of restartFirst) {
    const superseded = await input.turns.hasMemberTurnStartedAfter({
      userId: record.userId,
      threadId: record.threadId,
      catId: record.catId,
      startedAfter: record.startedAt,
    });
    if (superseded) {
      cleared.push(record.invocationId);
      continue;
    }
    if (record.terminalReason === RESTART_SHUTDOWN_TERMINAL_REASON) {
      input.scheduler.schedule({ invocationId: record.invocationId, kind: 'process_restart' });
    } else {
      // The original sleep start is not on the record; the turn start is a safe lower bound.
      input.scheduler.schedule({ invocationId: record.invocationId, sleptAt: record.startedAt });
    }
    scheduled += 1;
  }
  if (cleared.length > 0) await input.turns.settleOwedContinuations(cleared);
  const summary = { owed: owed.length, scheduled, cleared: cleared.length };
  input.log.info(summary, '[F337] owed continuations recovered at startup');
  return summary;
}
