import type Database from 'better-sqlite3';
import type {
  AbstractiveMessage,
  DurableCandidate,
  SummaryAttempt,
  SummaryGenerationUsage,
} from './abstractive-summary-types.js';
import {
  commitSummaryProjection,
  countCoveredSummaryMessages,
  readRecallSuppressionFence,
  reEmbedSummary,
  refreshSummaryBacklog,
  reportSummaryAttempt,
  submitSummaryCandidates,
} from './summary-compaction-effects.js';
import { SUMMARY_CONFIG } from './summary-config.js';
import { isSummaryEligible } from './summary-eligibility.js';
import { normalizeSummaryReadBatch, planSummaryInputSettlement, type SummaryReadBatch } from './summary-input-batch.js';
import { settleSkippedSummaryInput } from './summary-skipped-input.js';

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
  daily?: boolean;
}

interface ThreadLastActivity {
  threadId: string;
  lastMessageAt: number; // epoch ms
}

export interface SummaryCompactionDeps {
  /** SQLite database (evidence.sqlite) */
  db: Database.Database;
  /** Share the append delta writer's queue; never hold it while calling the model. */
  runExclusive?: <T>(fn: () => T) => Promise<T>;
  /** Feature flag check */
  enabled: () => boolean;
  /** Get last message timestamp for a thread (for quiet window check) */
  getThreadLastActivity: (threadId: string) => Promise<ThreadLastActivity | null>;
  /** Get messages after watermark for a thread */
  getMessagesAfterWatermark: (
    threadId: string,
    afterMessageId: string | null,
    limit: number,
  ) => Promise<AbstractiveMessage[] | SummaryReadBatch>;
  /** Generate a summary from the exact attributed input. */
  generateAbstractive: (
    input: {
      previousSummary: string | null;
      messages: AbstractiveMessage[];
      threadId: string;
    },
    signal?: AbortSignal,
    onUsage?: (usage: SummaryGenerationUsage) => void,
  ) => Promise<{
    curationState?: import('./curation/LunaCurationState.js').LunaCurationState;
    modelId?: string;
    promptVersion?: string;
    usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
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
  /** User-visible outcome follows final persistence; record failure remains fail-open. */
  onAttempt?: (attempt: SummaryAttempt) => Promise<void> | void;
  /** Re-embed a thread after summary update (for semantic search). Optional — fail-open. */
  reEmbed?: (anchor: string, text: string) => Promise<void>;
  /** H-3: Submit durable candidate to MarkerQueue for knowledge emergence pipeline. Optional — fail-open. */
  submitCandidate?: (candidate: {
    kind: string;
    title: string;
    claim: string;
    confidence: string;
    threadId: string;
    evidence?: DurableCandidate['evidence'];
  }) => Promise<void>;
  /** Logger */
  logger: { info: (msg: string) => void; error: (msg: string, err?: unknown) => void };
  curation?: {
    timezone: string;
    now?: () => number;
    startedAt?: () => number | null;
    shouldProcessThread?: (threadId: string) => Promise<boolean>;
    reconcilePendingInput?: (
      threadId: string,
      expectedWatermark?: string | null,
      signal?: AbortSignal,
    ) => Promise<boolean>;
  };
}

/** Check eligibility rule (KD-43 unified): quietWindow AND (count OR tokens OR signal) AND (cooldown OR signal-bypass) */
/** Exported for F139 SummaryCompactionTaskSpec to reuse per-thread processing */
export async function processThread(
  state: SummaryStateRow,
  deps: SummaryCompactionDeps,
  config: typeof SUMMARY_CONFIG,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  if (deps.curation?.reconcilePendingInput) {
    if (!(await deps.curation.reconcilePendingInput(state.thread_id, state.last_summarized_message_id, signal)))
      return false;
    state = {
      ...(deps.db.prepare('SELECT * FROM summary_state WHERE thread_id=?').get(state.thread_id) as SummaryStateRow),
      daily: state.daily,
    };
  }
  // Full eligibility check (with async lastActivity)
  const lastActivity = await deps.getThreadLastActivity(state.thread_id);
  signal?.throwIfAborted();
  if (!deps.enabled() || !isSummaryEligible(state, lastActivity, config, { daily: state.daily, ...deps.curation }))
    return false;

  // A prepared true-recall lease means the canonical MessageStore CAS has not
  // settled. Do not send a potentially recalled body to the summary provider.
  const suppressionFence = readRecallSuppressionFence(deps.db, state.thread_id);
  if (suppressionFence.preparedCount > 0) return false;

  // Get messages after watermark
  const batch = normalizeSummaryReadBatch(
    await deps.getMessagesAfterWatermark(state.thread_id, state.last_summarized_message_id, 200),
  );
  const messages = batch.messages;
  signal?.throwIfAborted();
  if (messages.length === 0) {
    const settlement = planSummaryInputSettlement(batch, 0, state.last_summarized_message_id);
    if (!settlement) return false;
    const commit = () => {
      signal?.throwIfAborted();
      return settleSkippedSummaryInput(deps.db, state.thread_id, settlement, suppressionFence);
    };
    if (!(deps.runExclusive ? await deps.runExclusive(commit) : commit())) return false;
    await refreshSummaryBacklog(deps, state.thread_id, settlement.lastMessageId);
    return true;
  }

  // Get current summary from evidence_docs (read model)
  const evidenceRow = deps.db
    .prepare('SELECT summary FROM evidence_docs WHERE anchor = ?')
    .get(`thread-${state.thread_id}`) as { summary: string | null } | undefined;

  // Call the selected existing model carrier.
  const previousSummary = evidenceRow?.summary ?? null;
  let usage: SummaryGenerationUsage | undefined;
  let committed = false;
  try {
    const result = await deps.generateAbstractive(
      {
        previousSummary,
        messages,
        threadId: state.thread_id,
      },
      signal,
      (generationUsage) => {
        usage = generationUsage;
      },
    );
    signal?.throwIfAborted();

    if (!result) {
      deps.logger.info(`[summary-compaction] thread ${state.thread_id}: model returned null (fail-open)`);
      return false;
    }

    // Validate a contiguous, fully processed prefix of the exact fetched input.
    // A bounded provider request must not acknowledge the unread batch tail.
    const coveredCount = countCoveredSummaryMessages(messages, result);
    if (coveredCount === null) {
      deps.logger.error('[summary-compaction] invalid input coverage; keeping watermark unchanged');
      return false;
    }
    const lastMsg = messages[coveredCount - 1];
    if (!lastMsg) return false;
    const settlement = planSummaryInputSettlement(batch, coveredCount, state.last_summarized_message_id);
    if (!settlement) return false;
    const now = new Date().toISOString();
    const mergedSummary = result.segments.map((s) => s.summary).join('\n\n');
    const totalTokens = mergedSummary.length / 4;
    const commit = () => {
      signal?.throwIfAborted();
      return commitSummaryProjection(deps, {
        threadId: state.thread_id,
        lastMessageId: settlement.lastMessageId,
        settlement,
        result,
        now,
        mergedSummary,
        totalTokens,
        suppressionFence,
        expectedSummary: evidenceRow?.summary ?? null,
        processedMessages: messages.slice(0, coveredCount),
        pendingMessages: messages.slice(coveredCount),
      });
    };
    committed = deps.runExclusive ? await deps.runExclusive(commit) : commit();
    if (!committed) return false;

    // The watermark is now canonical. Derived embedding, candidates and backlog
    // refresh must settle before terminal truth because the next tick cannot infer
    // which post-commit effects were skipped.
    await reEmbedSummary(deps, state.thread_id, mergedSummary);
    await submitSummaryCandidates(deps, state.thread_id, result);
    await refreshSummaryBacklog(deps, state.thread_id, settlement.lastMessageId);

    deps.logger.info(
      `[summary-compaction] thread ${state.thread_id}: ${result.segments.length} segment(s), watermark → ${settlement.lastMessageId}`,
    );
    return true;
  } finally {
    await reportSummaryAttempt(deps, usage, committed);
  }
}
