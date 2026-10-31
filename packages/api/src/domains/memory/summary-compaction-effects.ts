import type Database from 'better-sqlite3';
import type { AbstractiveMessage, DurableCandidate, SummaryGenerationUsage } from './abstractive-summary-types.js';
import { commitCurationState, overviewRevision } from './curation/LunaCurationState.js';
import { buildSearchableMessageContent } from './message-search-content.js';
import type { SummaryCompactionDeps } from './SummaryCompactionTask.js';
import {
  normalizeSummaryReadBatch,
  retainSummaryInputCounters,
  type SummaryInputSettlement,
  summaryBatchAmounts,
} from './summary-input-batch.js';

type GeneratedSummary = NonNullable<Awaited<ReturnType<SummaryCompactionDeps['generateAbstractive']>>>;

export async function reportSummaryAttempt(
  deps: SummaryCompactionDeps,
  usage: SummaryGenerationUsage | undefined,
  success: boolean,
): Promise<void> {
  if (!usage || !deps.onAttempt) return;
  try {
    await deps.onAttempt({ ...usage, success });
  } catch (error) {
    deps.logger.error(`[memory-curation] run record unavailable: ${String(error)}`);
  }
}

export interface RecallSuppressionFence {
  preparedCount: number;
  committedEpoch: string;
}

/** Only a fully covered, contiguous prefix can advance the input watermark. */
export function countCoveredSummaryMessages(
  messages: readonly AbstractiveMessage[],
  result: GeneratedSummary,
): number | null {
  let coveredCount = 0;
  for (const segment of result.segments) {
    const end = messages.findIndex((message) => message.id === segment.toMessageId);
    if (
      segment.fromMessageId !== messages[coveredCount]?.id ||
      end < coveredCount ||
      segment.messageCount !== end - coveredCount + 1
    )
      return null;
    coveredCount = end + 1;
  }
  return coveredCount;
}

interface SummaryProjectionInput {
  threadId: string;
  lastMessageId: string;
  result: GeneratedSummary;
  now: string;
  mergedSummary: string;
  totalTokens: number;
  suppressionFence: RecallSuppressionFence;
  expectedSummary?: string | null;
  processedMessages: readonly AbstractiveMessage[];
  pendingMessages: readonly AbstractiveMessage[];
  settlement?: SummaryInputSettlement;
}

export function readRecallSuppressionFence(db: Database.Database, threadId: string): RecallSuppressionFence {
  const rows = db
    .prepare(
      `SELECT lease_id AS leaseId, state, committed_at AS committedAt
       FROM message_recall_index_suppressions
       WHERE doc_anchor = ?
       ORDER BY passage_id, lease_id`,
    )
    .all(`thread-${threadId}`) as Array<{
    leaseId: string;
    state: 'prepared' | 'committed';
    committedAt: string | null;
  }>;
  return {
    preparedCount: rows.filter((row) => row.state === 'prepared').length,
    committedEpoch: rows
      .filter((row) => row.state === 'committed')
      .map((row) => `${row.leaseId}:${row.committedAt ?? ''}`)
      .join('|'),
  };
}

export function commitSummaryProjection(
  deps: Pick<SummaryCompactionDeps, 'db'>,
  {
    threadId,
    lastMessageId,
    result,
    now,
    mergedSummary,
    totalTokens,
    suppressionFence,
    processedMessages,
    pendingMessages,
    expectedSummary,
    settlement,
  }: SummaryProjectionInput,
): boolean {
  const insertSegment = deps.db.prepare(`
    INSERT INTO summary_segments
    (id, thread_id, level, from_message_id, to_message_id, message_count,
     summary, topic_key, topic_label, boundary_reason, boundary_confidence,
     related_segment_ids, candidates, model_id, prompt_version, generated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = deps.db.transaction(() => {
    if (expectedSummary !== undefined) {
      const live = deps.db.prepare('SELECT summary FROM evidence_docs WHERE anchor=?').get(`thread-${threadId}`) as
        | { summary: string | null }
        | undefined;
      if (overviewRevision(live?.summary ?? null) !== overviewRevision(expectedSummary)) return false;
    }
    const currentFence = readRecallSuppressionFence(deps.db, threadId);
    if (currentFence.preparedCount > 0 || currentFence.committedEpoch !== suppressionFence.committedEpoch) return false;

    const pending = deps.db
      .prepare(
        'SELECT last_summarized_message_id, pending_message_count, pending_token_count, pending_signal_flags FROM summary_state WHERE thread_id = ?',
      )
      .get(threadId) as
      | {
          last_summarized_message_id: string | null;
          pending_message_count: number;
          pending_token_count: number;
          pending_signal_flags: number;
        }
      | undefined;
    if (!pending) return false;
    if (settlement && pending.last_summarized_message_id !== settlement.expectedWatermark) return false;
    const retained = settlement
      ? retainSummaryInputCounters(pending, settlement.processed, settlement.pending)
      : retainUnprocessedCounters(pending, processedMessages, pendingMessages);
    for (const segment of result.segments) {
      insertSegment.run(
        `seg-${threadId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        threadId,
        1,
        segment.fromMessageId,
        segment.toMessageId,
        segment.messageCount,
        segment.summary,
        segment.topicKey,
        segment.topicLabel,
        segment.boundaryReason,
        segment.boundaryConfidence,
        segment.relatedSegmentIds ? JSON.stringify(segment.relatedSegmentIds) : null,
        segment.candidates ? JSON.stringify(segment.candidates) : null,
        result.modelId ?? 'unknown',
        result.promptVersion ?? 'g2-thread-abstract-v2',
        now,
      );
    }
    deps.db
      .prepare('UPDATE evidence_docs SET summary = ?, source_hash = ?, updated_at = ? WHERE anchor = ?')
      .run(
        mergedSummary,
        result.curationState?.summaryRevision ?? `abstractive-${Date.now()}`,
        now,
        `thread-${threadId}`,
      );
    deps.db
      .prepare(
        `UPDATE summary_state SET
          pending_input_revision = pending_input_revision + 1,
          last_summarized_message_id = ?, pending_message_count = ?,
          pending_token_count = ?, pending_signal_flags = ?, carry_over = ?,
          summary_type = 'abstractive', last_abstractive_at = ?, abstractive_token_count = ?
         WHERE thread_id = ?`,
      )
      .run(
        lastMessageId,
        retained.count,
        retained.tokens,
        retained.flags,
        retained.carryOver,
        now,
        Math.round(totalTokens),
        threadId,
      );
    commitCurationState(deps.db, threadId, result);
    return true;
  });
  return tx.immediate();
}

export async function reEmbedSummary(
  deps: SummaryCompactionDeps,
  threadId: string,
  mergedSummary: string,
): Promise<void> {
  if (!deps.reEmbed) return;
  try {
    const row = deps.db.prepare('SELECT title FROM evidence_docs WHERE anchor = ?').get(`thread-${threadId}`) as
      | { title: string }
      | undefined;
    await deps.reEmbed(`thread-${threadId}`, `${row?.title ?? ''} ${mergedSummary}`);
  } catch {
    // fail-open
  }
}

export async function submitSummaryCandidates(
  deps: SummaryCompactionDeps,
  threadId: string,
  result: GeneratedSummary,
): Promise<void> {
  if (!deps.submitCandidate) return;
  for (const segment of result.segments) {
    const candidates = (segment.candidates ?? []) as Array<{
      kind: string;
      title: string;
      claim: string;
      confidence?: string;
      evidence?: DurableCandidate['evidence'];
    }>;
    for (const candidate of candidates) {
      try {
        await deps.submitCandidate({
          kind: candidate.kind,
          title: candidate.title,
          claim: candidate.claim,
          confidence: candidate.confidence ?? 'inferred',
          threadId,
          evidence: candidate.evidence,
        });
        deps.logger.info(`[summary-compaction] submitted candidate: [${candidate.kind}] ${candidate.title}`);
      } catch (error) {
        deps.logger.error(
          `[summary-compaction] submitCandidate failed for [${candidate.kind}] ${candidate.title}: ${error}`,
        );
      }
    }
  }
}

export async function refreshSummaryBacklog(
  deps: SummaryCompactionDeps,
  threadId: string,
  lastMessageId: string,
): Promise<void> {
  try {
    if (deps.curation?.reconcilePendingInput) {
      // Clear the continuation hint only after a successful canonical read and revision CAS.
      await deps.curation.reconcilePendingInput(threadId, lastMessageId);
      return;
    }
    const remainingBatch = normalizeSummaryReadBatch(
      await deps.getMessagesAfterWatermark(threadId, lastMessageId, 200),
    );
    const remaining = summaryBatchAmounts(remainingBatch.scannedMessages);
    if (remaining.count === 0) return;
    const commit = () =>
      deps.db
        .prepare(
          `UPDATE summary_state SET pending_input_revision=pending_input_revision+1,pending_message_count = MAX(pending_message_count, ?),
           pending_token_count = MAX(pending_token_count, ?), carry_over = 1
         WHERE thread_id = ? AND last_summarized_message_id = ?`,
        )
        .run(remaining.count, remaining.tokens, threadId, lastMessageId);
    if (deps.runExclusive) await deps.runExclusive(commit);
    else commit();
    deps.logger.info(
      `[summary-compaction] thread ${threadId}: ${remaining.count} input rows still pending after batch`,
    );
  } catch {
    // The commit already retained known unread input; a failed refresh cannot clear it.
  }
}

function estimateMessageTokens(messages: readonly AbstractiveMessage[]): number {
  return messages.reduce((sum, message) => sum + Math.ceil(buildSearchableMessageContent(message).length / 4), 0);
}

/** Known input is a floor; current counters also retain concurrent appends. */
function retainUnprocessedCounters(
  pending: { pending_message_count: number; pending_token_count: number; pending_signal_flags: number },
  processedMessages: readonly AbstractiveMessage[],
  pendingMessages: readonly AbstractiveMessage[],
): { count: number; tokens: number; flags: number; carryOver: number } {
  const count = Math.max(pendingMessages.length, pending.pending_message_count - processedMessages.length);
  if (count === 0) return { count: 0, tokens: 0, flags: 0, carryOver: 0 };
  return {
    count,
    tokens: Math.max(
      estimateMessageTokens(pendingMessages),
      pending.pending_token_count - estimateMessageTokens(processedMessages),
    ),
    flags: pending.pending_signal_flags,
    carryOver: 1,
  };
}
