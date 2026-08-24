import type Database from 'better-sqlite3';
import {
  commitSummaryProjection,
  readRecallSuppressionFence,
  reEmbedSummary,
  refreshSummaryBacklog,
  submitSummaryCandidates,
} from './summary-compaction-effects.js';
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
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  // Full eligibility check (with async lastActivity)
  const lastActivity = await deps.getThreadLastActivity(state.thread_id);
  signal?.throwIfAborted();
  if (!isEligible(state, lastActivity, config)) return false;

  // A prepared true-recall lease means the canonical MessageStore CAS has not
  // settled. Do not send a potentially recalled body to the summary provider.
  const suppressionFence = readRecallSuppressionFence(deps.db, state.thread_id);
  if (suppressionFence.preparedCount > 0) return false;

  // Get messages after watermark
  const messages = await deps.getMessagesAfterWatermark(state.thread_id, state.last_summarized_message_id, 200);
  signal?.throwIfAborted();
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
  signal?.throwIfAborted();

  if (!result) {
    deps.logger.info(`[summary-compaction] thread ${state.thread_id}: Opus returned null (fail-open)`);
    return false;
  }

  const lastMsg = messages.at(-1);
  if (!lastMsg) return false;
  const now = new Date().toISOString();
  const mergedSummary = result.segments.map((s) => s.summary).join('\n\n');
  const totalTokens = mergedSummary.length / 4;
  const committed = commitSummaryProjection(deps, {
    threadId: state.thread_id,
    lastMessageId: lastMsg.id,
    result,
    now,
    mergedSummary,
    totalTokens,
    suppressionFence,
  });
  if (!committed) return false;

  // The watermark is now canonical. Derived embedding, candidates and backlog
  // refresh must settle before terminal truth because the next tick cannot infer
  // which post-commit effects were skipped.
  await reEmbedSummary(deps, state.thread_id, mergedSummary);
  await submitSummaryCandidates(deps, state.thread_id, result);
  await refreshSummaryBacklog(deps, state.thread_id, lastMsg.id);

  deps.logger.info(
    `[summary-compaction] thread ${state.thread_id}: ${result.segments.length} segment(s), watermark → ${lastMsg.id}`,
  );
  return true;
}
