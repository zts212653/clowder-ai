/**
 * F337: after a sleep cut a cat off, wake it again once the lid is really open.
 *
 * The failure usually surfaces during a short maintenance dark wake, and a continuation sent then
 * would be cut by the next sleep. So each interrupted turn waits here until the power log shows a
 * full wake after its sleep, then gets the same continuation F048 sends after a restart.
 *
 * The promise is durable: writing the `host_sleep` terminal also records the turn as owed (same
 * atomic write), and it stays owed until a delivery settles it or the member runs again in that
 * thread. `recoverSleepContinuations` re-registers every owed one at startup. There is no expiry — an
 * overnight sleep still continues in the morning; the delivery skips a cat that already ran again or
 * was stopped in that thread, and its idempotency key prevents a second message.
 */

import type { ITurnExecutionStore } from '../../../stores/ports/TurnExecutionStore.js';
import {
  concludedContinuationIds,
  type RestartContinuationResult,
} from '../restart-continuation/RestartContinuation.js';
import { type HostSleepEvidenceReader, isInFullWakeSince } from './HostSleepEvidence.js';

interface TimerHandle {
  unref?(): void;
}

export interface HostSleepContinuationSchedulerDeps {
  readonly readEvidence: HostSleepEvidenceReader;
  /** Delivers the continuation for these interrupted invocations (F048 delivery, host_sleep wording). */
  readonly continueCats: (invocationIds: readonly string[]) => Promise<unknown>;
  /** Clears the owed record of continuations no longer owed (delivered, or the member ran again). */
  readonly settleOwed?: (invocationIds: readonly string[]) => Promise<void> | void;
  readonly log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
  readonly now?: () => number;
  readonly setTimer?: (fn: () => Promise<void>, ms: number) => TimerHandle;
  readonly pollMs?: number;
  readonly maxRetryDelayMs?: number;
}

interface PendingContinuation {
  readonly sleptAt: number;
  readonly failures: number;
  readonly notBefore: number;
}

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

  schedule(input: { readonly invocationId: string; readonly sleptAt: number }): void {
    if (this.pending.has(input.invocationId)) return;
    this.pending.set(input.invocationId, { sleptAt: input.sleptAt, failures: 0, notBefore: 0 });
    this.arm();
  }

  private arm(): void {
    if (this.armed || this.pending.size === 0) return;
    this.armed = true;
    this.setTimer(() => this.tick(), this.pollMs).unref?.();
  }

  private async tick(): Promise<void> {
    this.armed = false;
    try {
      const now = this.now();
      const due = [...this.pending].filter(([, entry]) => entry.notBefore <= now);
      if (due.length === 0) return;
      const from = Math.min(...due.map(([, entry]) => entry.sleptAt));
      const evidence = await this.deps.readEvidence({ from, to: now });
      const ready = due.filter(([, entry]) => isInFullWakeSince(evidence, entry.sleptAt) === true);
      if (ready.length === 0) return;
      const invocationIds = ready.map(([invocationId]) => invocationId);
      const previous = new Map(ready);
      for (const invocationId of invocationIds) this.pending.delete(invocationId);
      this.deps.log.info({ invocationIds }, '[F337] full wake seen; delivering sleep continuations');
      let concluded = new Set<string>();
      try {
        concluded = concludedIds(await this.deps.continueCats(invocationIds));
      } catch (error) {
        this.deps.log.warn({ error: String(error) }, '[F337] sleep continuation delivery threw');
      }
      // Clear only what the receipt positively concluded; failed, unreadable or unaccounted ids stay owed.
      const settled = invocationIds.filter((invocationId) => concluded.has(invocationId));
      const open = invocationIds.filter((invocationId) => !concluded.has(invocationId));
      if (settled.length > 0 && this.deps.settleOwed) {
        try {
          await this.deps.settleOwed(settled);
        } catch (error) {
          // Still owed on record: the next startup re-registers it and the delivery replays idempotently.
          this.deps.log.warn({ error: String(error), settled }, '[F337] owed sleep continuations not cleared');
        }
      }
      for (const invocationId of open) {
        const entry = previous.get(invocationId);
        if (!entry) continue;
        const failures = entry.failures + 1;
        const delay = Math.min(this.maxRetryDelayMs, this.pollMs * 2 ** failures);
        this.pending.set(invocationId, { sleptAt: entry.sleptAt, failures, notBefore: this.now() + delay });
      }
    } catch (error) {
      this.deps.log.warn({ error: String(error) }, '[F337] sleep continuation check failed');
    } finally {
      this.arm();
    }
  }
}

/**
 * Startup: re-register every sleep continuation still owed. The owed set is exact (written with the
 * terminal), so nothing depends on how much history exists; entries whose member already ran again in
 * that thread are cleared instead of scheduled.
 */
export async function recoverSleepContinuations(input: {
  readonly turns: Pick<
    ITurnExecutionStore,
    'listOwedSleepContinuations' | 'hasMemberTurnStartedAfter' | 'settleOwedSleepContinuations'
  >;
  readonly scheduler: Pick<HostSleepContinuationScheduler, 'schedule'>;
  readonly log: { info(obj: object, msg: string): void };
}): Promise<{ readonly owed: number; readonly scheduled: number; readonly cleared: number }> {
  const owed = await input.turns.listOwedSleepContinuations();
  const cleared: string[] = [];
  let scheduled = 0;
  for (const record of owed) {
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
    // The original sleep start is not on the record; the turn start is a safe lower bound.
    input.scheduler.schedule({ invocationId: record.invocationId, sleptAt: record.startedAt });
    scheduled += 1;
  }
  if (cleared.length > 0) await input.turns.settleOwedSleepContinuations(cleared);
  const summary = { owed: owed.length, scheduled, cleared: cleared.length };
  input.log.info(summary, '[F337] sleep continuations recovered at startup');
  return summary;
}
