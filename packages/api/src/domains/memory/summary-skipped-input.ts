import type Database from 'better-sqlite3';
import { type RecallSuppressionFence, readRecallSuppressionFence } from './summary-compaction-effects.js';
import { retainSummaryInputCounters, type SummaryInputSettlement } from './summary-input-batch.js';

/** A skipped-only page advances input accounting, without claiming a generated overview. */
export function settleSkippedSummaryInput(
  db: Database.Database,
  threadId: string,
  settlement: SummaryInputSettlement,
  fence: RecallSuppressionFence,
): boolean {
  return db
    .transaction(() => {
      const currentFence = readRecallSuppressionFence(db, threadId);
      if (currentFence.preparedCount || currentFence.committedEpoch !== fence.committedEpoch) return false;
      const current = db
        .prepare(
          'SELECT last_summarized_message_id,pending_message_count,pending_token_count,pending_signal_flags FROM summary_state WHERE thread_id=?',
        )
        .get(threadId) as
        | {
            last_summarized_message_id: string | null;
            pending_message_count: number;
            pending_token_count: number;
            pending_signal_flags: number;
          }
        | undefined;
      if (!current || current.last_summarized_message_id !== settlement.expectedWatermark) return false;
      const retained = retainSummaryInputCounters(current, settlement.processed, settlement.pending);
      db.prepare(`UPDATE summary_state SET pending_input_revision=pending_input_revision+1,last_summarized_message_id=?,pending_message_count=?,pending_token_count=?,pending_signal_flags=?,carry_over=?
      WHERE thread_id=?`).run(
        settlement.lastMessageId,
        retained.count,
        retained.tokens,
        retained.flags,
        retained.carryOver,
        threadId,
      );
      return true;
    })
    .immediate();
}
