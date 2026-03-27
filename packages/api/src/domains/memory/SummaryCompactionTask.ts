import type Database from 'better-sqlite3';
import { hasHighValueSignal, SUMMARY_CONFIG } from './summary-config.js';

interface SummaryStateRow {
  thread_id: string;
  last_summarized_message_id: string | null;
  pending_message_count: number;
  pending_token_count: number;
  pending_signal_flags: number;
  summary_type: string;
  last_abstractive_at: string | null;
  abstractive_token_count: number | null;
  carry_over: number; // 1 = has backlog from previous batch, bypasses cooldown
}

interface ThreadLastActivity {
  threadId: string;
  lastMessageAt: number; // epoch ms
}

export interface SummaryCompactionDeps {
  /** SQLite database (evidence.sqlite) */
  db: Database.Database;
  /** Feature flag check */
  enabled: () => boolean;
  /** Get last message timestamp for a thread (for quiet window check) */
  getThreadLastActivity: (threadId: string) => Promise<ThreadLastActivity | null>;
  /** Get messages after watermark for a thread */
  getMessagesAfterWatermark: (
    threadId: string,
    afterMessageId: string | null,
    limit: number,
  ) => Promise<Array<{ id: string; content: string; catId?: string; timestamp: number }>>;
  /** Call Opus API to generate abstractive summary + candidates */
  generateAbstractive: (input: {
    previousSummary: string | null;
    messages: Array<{ id: string; content: string; catId?: string; timestamp: number }>;
    threadId: string;
  }) => Promise<{
    segments: Array<{
      summary: string;
      topicKey: string;
      topicLabel: string;
      boundaryReason: string;
      boundaryConfidence: 'high' | 'medium' | 'low';
      fromMessageId: string;
      toMessageId: string;
      messageCount: number;
      relatedSegmentIds?: string[];
      candidates?: unknown[];
    }>;
  } | null>;
  /** Re-embed a thread after summary update (for semantic search). Optional — fail-open. */
  reEmbed?: (anchor: string, text: string) => Promise<void>;
  /** H-3: Submit durable candidate to MarkerQueue for knowledge emergence pipeline. Optional — fail-open. */
  submitCandidate?: (candidate: {
    kind: string;
    title: string;
    claim: string;
    confidence: string;
    threadId: string;
  }) => Promise<void>;
  /** Logger */
  logger: { info: (msg: string) => void; error: (msg: string, err?: unknown) => void };
}

/** Check eligibility rule (KD-43 unified): quietWindow AND (count OR tokens OR signal) AND (cooldown OR signal-bypass) */
function isEligible(
  state: SummaryStateRow,
  lastActivity: ThreadLastActivity | null,
  config: typeof SUMMARY_CONFIG,
): boolean {
  const now = Date.now();

  // Quiet window check: thread must be idle
  if (lastActivity) {
    const quietMs = now - lastActivity.lastMessageAt;
    if (quietMs < config.quietWindowMinutes * 60 * 1000) return false;
  }

  const highSignal = hasHighValueSignal(state.pending_signal_flags);

  // P1 R4 fix (砚砚 review): carry_over is a "backlog continuation" total bypass —
  // skips BOTH volume gate AND cooldown. A tail of 5 messages from a 205-message
  // batch should not be blocked by the 20-message threshold.
  const isCarryOver = state.carry_over === 1;

  // Volume or signal check (carry-over bypasses)
  const volumeOk =
    isCarryOver ||
    state.pending_message_count >= config.pendingMessageThreshold ||
    state.pending_token_count >= config.pendingTokenThreshold ||
    highSignal;
  if (!volumeOk) return false;

  // Cooldown check (high-signal OR carry-over bypasses)
  const bypassCooldown = highSignal || isCarryOver;
  if (!bypassCooldown && state.last_abstractive_at) {
    const hoursSince = (now - new Date(state.last_abstractive_at).getTime()) / (1000 * 60 * 60);
    if (hoursSince < config.cooldownHours) return false;
  }

  return true;
}

/** Exported for F139 SummaryCompactionTaskSpec to reuse per-thread processing */
export async function processThread(
  state: SummaryStateRow,
  deps: SummaryCompactionDeps,
  config: typeof SUMMARY_CONFIG,
): Promise<boolean> {
  // Full eligibility check (with async lastActivity)
  const lastActivity = await deps.getThreadLastActivity(state.thread_id);
  if (!isEligible(state, lastActivity, config)) return false;

  // Get messages after watermark
  const messages = await deps.getMessagesAfterWatermark(state.thread_id, state.last_summarized_message_id, 200);
  if (messages.length === 0) return false;

  // Get current summary from evidence_docs (read model)
  const evidenceRow = deps.db
    .prepare('SELECT summary FROM evidence_docs WHERE anchor = ?')
    .get(`thread-${state.thread_id}`) as { summary: string | null } | undefined;

  // Call Opus API
  const result = await deps.generateAbstractive({
    previousSummary: evidenceRow?.summary ?? null,
    messages,
    threadId: state.thread_id,
  });

  if (!result) {
    deps.logger.info(`[summary-compaction] thread ${state.thread_id}: Opus returned null (fail-open)`);
    return false;
  }

  // Dual-write: INSERT segments + UPDATE evidence_docs
  const lastMsg = messages[messages.length - 1]!;
  const now = new Date().toISOString();
  const mergedSummary = result.segments.map((s) => s.summary).join('\n\n');
  const totalTokens = mergedSummary.length / 4;

  const insertSegment = deps.db.prepare(`
    INSERT INTO summary_segments
    (id, thread_id, level, from_message_id, to_message_id, message_count,
     summary, topic_key, topic_label, boundary_reason, boundary_confidence,
     related_segment_ids, candidates, model_id, prompt_version, generated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = deps.db.transaction(() => {
    // 1. INSERT summary_segments (append-only)
    for (const seg of result.segments) {
      const segId = `seg-${state.thread_id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      insertSegment.run(
        segId,
        state.thread_id,
        1, // L1
        seg.fromMessageId,
        seg.toMessageId,
        seg.messageCount,
        seg.summary,
        seg.topicKey,
        seg.topicLabel,
        seg.boundaryReason,
        seg.boundaryConfidence,
        seg.relatedSegmentIds ? JSON.stringify(seg.relatedSegmentIds) : null,
        seg.candidates ? JSON.stringify(seg.candidates) : null,
        'claude-opus-4-6',
        'g2-thread-abstract-v1',
        now,
      );
    }

    // 2. UPDATE evidence_docs.summary (read model)
    deps.db
      .prepare(
        `UPDATE evidence_docs SET summary = ?, source_hash = ?, updated_at = ?
       WHERE anchor = ?`,
      )
      .run(mergedSummary, `abstractive-${Date.now()}`, now, `thread-${state.thread_id}`);

    // 3. UPDATE summary_state watermark (carry_over = 0, will be set to 1 below if backlog remains)
    deps.db
      .prepare(
        `UPDATE summary_state SET
        last_summarized_message_id = ?,
        pending_message_count = 0,
        pending_token_count = 0,
        pending_signal_flags = 0,
        carry_over = 0,
        summary_type = 'abstractive',
        last_abstractive_at = ?,
        abstractive_token_count = ?
       WHERE thread_id = ?`,
      )
      .run(lastMsg.id, now, Math.round(totalTokens), state.thread_id);
  });

  tx();

  // Re-embed this thread with new abstractive summary (for semantic search)
  if (deps.reEmbed) {
    try {
      const title =
        (
          deps.db.prepare('SELECT title FROM evidence_docs WHERE anchor = ?').get(`thread-${state.thread_id}`) as
            | { title: string }
            | undefined
        )?.title ?? '';
      await deps.reEmbed(`thread-${state.thread_id}`, `${title} ${mergedSummary}`);
    } catch {
      // fail-open
    }
  }

  // H-3: Submit durable candidates to MarkerQueue for knowledge emergence pipeline
  if (deps.submitCandidate) {
    for (const seg of result.segments) {
      const candidates = (seg.candidates ?? []) as Array<{
        kind: string;
        title: string;
        claim: string;
        confidence?: string;
      }>;
      for (const c of candidates) {
        try {
          await deps.submitCandidate({
            kind: c.kind,
            title: c.title,
            claim: c.claim,
            confidence: c.confidence ?? 'inferred',
            threadId: state.thread_id,
          });
          deps.logger.info(`[summary-compaction] submitted candidate: [${c.kind}] ${c.title}`);
        } catch (err) {
          // fail-open: candidate submission failure doesn't block compaction
          deps.logger.error(`[summary-compaction] submitCandidate failed for [${c.kind}] ${c.title}: ${err}`);
        }
      }
    }
  }

  // P1 R2 fix (砚砚 review): after compaction, check if there are STILL more messages
  // beyond the new watermark. If so, re-populate pending signal so the thread stays
  // in the scheduling pool. Otherwise a delta > 200 messages would silently stall.
  try {
    const remaining = await deps.getMessagesAfterWatermark(state.thread_id, lastMsg.id, 1);
    if (remaining.length > 0) {
      // Re-count actual remaining (up to 200 to avoid scanning everything)
      const remainingBatch = await deps.getMessagesAfterWatermark(state.thread_id, lastMsg.id, 200);
      const estimatedTokens = remainingBatch.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
      // P1 R3 fix: set carry_over=1 so next tick bypasses cooldown for this backlog
      deps.db
        .prepare(
          `UPDATE summary_state SET pending_message_count = ?, pending_token_count = ?, carry_over = 1
           WHERE thread_id = ?`,
        )
        .run(remainingBatch.length, estimatedTokens, state.thread_id);
      deps.logger.info(
        `[summary-compaction] thread ${state.thread_id}: ${remainingBatch.length} messages still pending after batch`,
      );
    }
  } catch {
    // fail-open: worst case is one missed tick, next append will re-trigger
  }

  deps.logger.info(
    `[summary-compaction] thread ${state.thread_id}: ${result.segments.length} segment(s), watermark → ${lastMsg.id}`,
  );
  return true;
}
