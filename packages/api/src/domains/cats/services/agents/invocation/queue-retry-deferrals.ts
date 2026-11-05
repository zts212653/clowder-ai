/**
 * F117 soak: a transient backend/admission failure can leave its entry in the Queue.
 * Retrying immediately would loop on the same failure, so the bounded backoff doubles with each
 * consecutive failed attempt. Only that entry waits; the drain passes over it, and a timer drains
 * its thread when the wait ends. F293 policy refusals instead persist an exact target hold in Queue
 * and need an explicit owner attempt; this process-local timer cannot release those holds.
 *
 * Process-local by design: a restart retries every queued entry at its startup drain.
 */

export interface QueueRetryDeferralOptions {
  /** The wait after a first failed attempt; each consecutive failure doubles it. */
  readonly baseDelayMs?: number;
  /** The longest wait, which also bounds how far ahead a target's own retry time is honored. */
  readonly maxDelayMs?: number;
}

/** Upstream #595 recovered a failed slot after 10 seconds. */
const DEFAULT_BASE_DELAY_MS = 10_000;
const DEFAULT_MAX_DELAY_MS = 60 * 60_000;

interface RetryDeferral {
  failures: number;
  until: number;
  /** Set while the entry waits; cleared when the wait ends. */
  timer?: ReturnType<typeof setTimeout>;
}

export class QueueRetryDeferrals {
  private readonly deferrals = new Map<string, RetryDeferral>();
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(
    private readonly onElapsed: (threadId: string) => void,
    options: QueueRetryDeferralOptions = {},
    private readonly now: () => number = Date.now,
  ) {
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  }

  /**
   * Makes an entry whose attempt failed wait, and returns when it may be tried again: the later of
   * its backoff and `targetRetryAt`, never further out than the longest wait.
   */
  defer(threadId: string, entryId: string, targetRetryAt?: number): number {
    this.pruneSettled();
    const now = this.now();
    const previous = this.deferrals.get(entryId);
    if (previous?.timer) clearTimeout(previous.timer);
    const failures = (previous?.failures ?? 0) + 1;
    const backoff = Math.min(this.baseDelayMs * 2 ** (failures - 1), this.maxDelayMs);
    const targetWait = targetRetryAt !== undefined && Number.isFinite(targetRetryAt) ? targetRetryAt : 0;
    const wanted = Math.max(now + backoff, targetWait);
    const until = Math.min(wanted, now + this.maxDelayMs);
    const deferral: RetryDeferral = { failures, until };
    deferral.timer = setTimeout(() => {
      deferral.timer = undefined;
      this.onElapsed(threadId);
    }, until - now);
    deferral.timer.unref?.();
    this.deferrals.set(entryId, deferral);
    return until;
  }

  /** Whether the entry is still waiting for its retry time. */
  isDeferred(entryId: string): boolean {
    return this.deferrals.get(entryId)?.timer !== undefined;
  }

  /** The entry was handed off: a later failure starts again from the shortest wait. */
  forget(entryId: string): void {
    const deferral = this.deferrals.get(entryId);
    if (deferral?.timer) clearTimeout(deferral.timer);
    this.deferrals.delete(entryId);
  }

  /** A finished wait keeps its failure count for the backoff only as long as a wait can last. */
  private pruneSettled(): void {
    const staleBefore = this.now() - this.maxDelayMs;
    for (const [entryId, deferral] of this.deferrals) {
      if (deferral.timer === undefined && deferral.until < staleBefore) this.deferrals.delete(entryId);
    }
  }
}
