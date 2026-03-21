/**
 * Phase G: Summary compaction configuration.
 * All thresholds are configurable constants (砚砚 nit: no bare literals).
 */
export const SUMMARY_CONFIG = {
  /** Minimum pending messages to be eligible for L1 abstractive */
  pendingMessageThreshold: 20,
  /** Minimum pending tokens to be eligible (covers "few but heavy" messages) */
  pendingTokenThreshold: 1500,
  /** Minimum hours since last abstractive summary */
  cooldownHours: 2,
  /** Quiet window: thread must be idle for this many minutes */
  quietWindowMinutes: 10,
  /** Max threads to process per scheduler tick */
  perTickBudget: 5,
  /** Delay between threads in backfill mode (ms) */
  backfillIntervalMs: 2000,
  /** Phase 2 drift alert: consecutive L1 abstractive token count above this = warning */
  driftAlertTokenThreshold: 800,
  /** Max topic segments per delta batch (砚砚 R4: bounded topic partition) */
  maxTopicSegments: 3,
  /** Min batch size to allow multi-topic split (砚砚 R4b) */
  minSplitMessageCount: 8,
  /** Min batch tokens to allow multi-topic split */
  minSplitTokenCount: 600,
  /** Scheduler interval (ms) */
  schedulerIntervalMs: 30 * 60 * 1000, // 30 minutes
} as const;

/** Signal flags stored as bitfield in summary_state.pending_signal_flags */
export const SIGNAL_FLAGS = {
  DECISION: 1,
  CODE: 2,
  ERROR_FIX: 4,
} as const;

/** Check if any high-value signal is present */
export function hasHighValueSignal(flags: number): boolean {
  return (flags & (SIGNAL_FLAGS.DECISION | SIGNAL_FLAGS.CODE | SIGNAL_FLAGS.ERROR_FIX)) !== 0;
}
