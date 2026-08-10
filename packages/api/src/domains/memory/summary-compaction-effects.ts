import type Database from 'better-sqlite3';
import type { SummaryCompactionDeps } from './SummaryCompactionTask.js';

type GeneratedSummary = NonNullable<Awaited<ReturnType<SummaryCompactionDeps['generateAbstractive']>>>;

export interface RecallSuppressionFence {
  preparedCount: number;
  committedEpoch: string;
}

interface SummaryProjectionInput {
  threadId: string;
  lastMessageId: string;
  result: GeneratedSummary;
  now: string;
  mergedSummary: string;
  totalTokens: number;
  suppressionFence: RecallSuppressionFence;
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
  deps: SummaryCompactionDeps,
  { threadId, lastMessageId, result, now, mergedSummary, totalTokens, suppressionFence }: SummaryProjectionInput,
): boolean {
  const insertSegment = deps.db.prepare(`
    INSERT INTO summary_segments
    (id, thread_id, level, from_message_id, to_message_id, message_count,
     summary, topic_key, topic_label, boundary_reason, boundary_confidence,
     related_segment_ids, candidates, model_id, prompt_version, generated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = deps.db.transaction(() => {
    const currentFence = readRecallSuppressionFence(deps.db, threadId);
    if (currentFence.preparedCount > 0 || currentFence.committedEpoch !== suppressionFence.committedEpoch) return false;

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
        'claude-opus-4-6',
        'g2-thread-abstract-v1',
        now,
      );
    }
    deps.db
      .prepare('UPDATE evidence_docs SET summary = ?, source_hash = ?, updated_at = ? WHERE anchor = ?')
      .run(mergedSummary, `abstractive-${Date.now()}`, now, `thread-${threadId}`);
    deps.db
      .prepare(
        `UPDATE summary_state SET
          last_summarized_message_id = ?, pending_message_count = 0,
          pending_token_count = 0, pending_signal_flags = 0, carry_over = 0,
          summary_type = 'abstractive', last_abstractive_at = ?, abstractive_token_count = ?
         WHERE thread_id = ?`,
      )
      .run(lastMessageId, now, Math.round(totalTokens), threadId);
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
    }>;
    for (const candidate of candidates) {
      try {
        await deps.submitCandidate({
          kind: candidate.kind,
          title: candidate.title,
          claim: candidate.claim,
          confidence: candidate.confidence ?? 'inferred',
          threadId,
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
    const remaining = await deps.getMessagesAfterWatermark(threadId, lastMessageId, 1);
    if (remaining.length === 0) return;
    const remainingBatch = await deps.getMessagesAfterWatermark(threadId, lastMessageId, 200);
    const estimatedTokens = remainingBatch.reduce((sum, message) => sum + Math.ceil(message.content.length / 4), 0);
    deps.db
      .prepare(
        `UPDATE summary_state SET pending_message_count = ?, pending_token_count = ?, carry_over = 1
         WHERE thread_id = ?`,
      )
      .run(remainingBatch.length, estimatedTokens, threadId);
    deps.logger.info(
      `[summary-compaction] thread ${threadId}: ${remainingBatch.length} messages still pending after batch`,
    );
  } catch {
    // fail-open: worst case is one missed tick, next append will re-trigger
  }
}
