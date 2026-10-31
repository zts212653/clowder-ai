import type { SummaryCompactionDeps } from './SummaryCompactionTask.js';
import { readRecallSuppressionFence } from './summary-compaction-effects.js';
import { normalizeSummaryReadBatch, summaryPendingAmounts } from './summary-input-batch.js';

/** Append/transition counts are scheduling hints. Rebase them on the actual canonical unread page. */
export async function reconcileSummaryPendingInput(
  deps: Pick<SummaryCompactionDeps, 'db' | 'runExclusive' | 'getMessagesAfterWatermark'>,
  threadId: string,
  expectedWatermark?: string | null,
  signal?: AbortSignal,
): Promise<boolean> {
  const read = () =>
    deps.db
      .prepare(`SELECT last_summarized_message_id AS watermark,
    pending_input_revision AS revision,pending_signal_flags AS flags FROM summary_state WHERE thread_id=?`)
      .get(threadId) as { watermark: string | null; revision: number; flags: number } | undefined;
  const snapshot = deps.runExclusive ? await deps.runExclusive(read) : read();
  if (!snapshot || (expectedWatermark !== undefined && snapshot.watermark !== expectedWatermark)) return false;
  signal?.throwIfAborted();
  const fence = readRecallSuppressionFence(deps.db, threadId);
  if (fence.preparedCount) return false;
  const batch = normalizeSummaryReadBatch(await deps.getMessagesAfterWatermark(threadId, snapshot.watermark, 200));
  const amounts = summaryPendingAmounts(batch.scannedMessages, batch.scanIncomplete);
  const commit = () =>
    deps.db
      .transaction(() => {
        signal?.throwIfAborted();
        const currentFence = readRecallSuppressionFence(deps.db, threadId);
        if (currentFence.preparedCount || currentFence.committedEpoch !== fence.committedEpoch) return false;
        const result = deps.db
          .prepare(`UPDATE summary_state SET pending_message_count=?,pending_token_count=?,
      pending_signal_flags=?,carry_over=CASE WHEN ?=0 THEN 0 ELSE carry_over END,
      pending_input_revision=pending_input_revision+1
      WHERE thread_id=? AND last_summarized_message_id IS ? AND pending_input_revision=?`)
          .run(
            amounts.count,
            amounts.tokens,
            amounts.count ? snapshot.flags : 0,
            amounts.count,
            threadId,
            snapshot.watermark,
            snapshot.revision,
          );
        return result.changes > 0;
      })
      .immediate();
  return deps.runExclusive ? await deps.runExclusive(commit) : commit();
}
