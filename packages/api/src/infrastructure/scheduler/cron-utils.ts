import { CronExpressionParser } from 'cron-parser';

/**
 * Calculate milliseconds until the next occurrence of a cron expression.
 * @param expression - Standard 5-field cron expression (e.g. "0 9 * * *")
 * @param timezone - Optional IANA timezone (default: system local)
 * @returns Positive integer ms until next fire
 * @throws If the expression is invalid
 */
export function getNextCronMs(expression: string, timezone?: string): number {
  const options: Record<string, unknown> = { currentDate: new Date() };
  if (timezone) options.tz = timezone;
  const parsed = CronExpressionParser.parse(expression, options);
  const next = parsed.next().toDate();
  return Math.max(1, next.getTime() - Date.now());
}

/**
 * Compute the absolute epoch-ms timestamp of the next cron occurrence that is
 * strictly later than `lastFiredSlotMs` (when provided).
 *
 * Why this exists — cron boundary race:
 *   TaskRunnerV2 schedules cron ticks via a setTimeout chain whose `.finally`
 *   block reschedules the next tick. Node's `setTimeout` uses a monotonic clock
 *   internally, but `getNextCronMs` computes the delay from wall-clock
 *   `Date.now()`. When the wall clock is adjusted backward during the wait
 *   window (NTP step-back, VM pause/resume, container clock drift), the
 *   callback fires at a wall-clock time **before** the target cron slot.
 *   A plain `parsed.next()` call then returns the **same** slot a second
 *   time — causing a duplicate fire within the same cron window.
 *
 *   By passing the last-fired slot here, we advance past it deterministically
 *   so the next scheduled fire always lands on a future, never-fired slot.
 *
 * @param expression - Standard 5-field cron expression
 * @param timezone - Optional IANA timezone (passed to cron-parser as `tz`)
 * @param now - Current epoch ms (injected for testability)
 * @param lastFiredSlotMs - Epoch ms of the most recent already-fired slot; if
 *   provided, the returned value is guaranteed `> lastFiredSlotMs`.
 * @returns Epoch ms of the next valid cron slot strictly after `lastFiredSlotMs`
 * @throws If the expression is invalid
 */
export function computeNextCronSlot(
  expression: string,
  timezone: string | undefined,
  now: number,
  lastFiredSlotMs: number | undefined,
): number {
  const options: Record<string, unknown> = { currentDate: new Date(now) };
  if (timezone) options.tz = timezone;
  const parsed = CronExpressionParser.parse(expression, options);
  let nextMs = parsed.next().toDate().getTime();
  // Boundary-race guard: advance past any slot already fired.
  // Max-iterations cap prevents runaway loops if lastFiredSlotMs is a dirty
  // far-future value (e.g., clock skew write-back). For per-minute crons,
  // 1440 iterations = 1 day of slots — well beyond any plausible drift.
  const MAX_ADVANCE_ITERATIONS = 1440;
  let iterations = 0;
  while (lastFiredSlotMs !== undefined && nextMs <= lastFiredSlotMs) {
    if (++iterations >= MAX_ADVANCE_ITERATIONS) {
      throw new Error(
        `computeNextCronSlot: exceeded ${MAX_ADVANCE_ITERATIONS} iterations advancing past lastFiredSlotMs=${lastFiredSlotMs} (now=${now}, expression=${expression}). Possible dirty future timestamp.`,
      );
    }
    nextMs = parsed.next().toDate().getTime();
  }
  return nextMs;
}
