/**
 * F192 Day-36 verdict build — cluster-aware A2 rollup metrics.
 *
 * Raw A2 event counts can't distinguish repeated independent friction
 * from clustered interventions. This module groups A2 signals by their
 * source context:
 *
 * - magic_word_ref: grouped by (threadId:messageId) composite key from
 *   event-memory. One operator message with 4 magic words = 1 source message,
 *   not 4 independent interventions. ThreadId is included because messageId
 *   alone is not globally unique (Event Memory identity = ownerUserId + threadId + messageId + type).
 *
 * - proposal_reject: grouped by episodeId + proposalId. Two rejects in
 *   the same episode for different proposals = 1 episode with 2 proposals,
 *   not 2 independent rejection events.
 *
 * [宪宪/Opus-46🐾]
 */
import type { ResolvedTaskOutcomeWindow } from './task-outcome-source-resolver.js';
import type { StoredSignal } from './task-outcome-store.js';

export interface ClusterMetrics {
  /** Distinct operator messages that triggered magic words (keyed by threadId:messageId). */
  magicWordSourceMessages: number;
  /** Maximum magic words from a single source message. */
  maxMagicWordsPerMessage: number;
  /** Number of distinct episodes containing proposal_reject signals. */
  proposalRejectEpisodes: number;
  /** Number of distinct proposalIds across all proposal_reject signals. */
  proposalRejectDistinctProposalIds: number;
  /**
   * Cluster-adjusted A2 total — replaces raw a2_signals_total with intervention count.
   * = magicWordSourceMessages + proposalRejectEpisodes + permissionCancelCount.
   */
  clusterAdjustedA2Total: number;
}

export function buildClusterMetrics(
  sourceWindow: ResolvedTaskOutcomeWindow,
  magicWordRefSignals: StoredSignal[],
): ClusterMetrics {
  // --- magic_word_ref cluster: group by (threadId:messageId) composite key ---
  // P1-1 fix: messageId alone is not globally unique in Event Memory
  // (identity contract = ownerUserId + threadId + messageId + type).
  // Build eventId → composite key lookup from event-memory rows.
  const eventIdToSourceKey = new Map<string, string>();
  for (const row of sourceWindow.eventRows) {
    if (row.messageId) {
      eventIdToSourceKey.set(row.eventId, `${row.threadId}:${row.messageId}`);
    }
  }

  // Group magic word eventIds by their composite source key
  const sourceKeyCounts = new Map<string, number>();
  for (const signal of magicWordRefSignals) {
    const eventId = signal.record.eventId as string;
    const sourceKey = eventIdToSourceKey.get(eventId);
    if (sourceKey) {
      sourceKeyCounts.set(sourceKey, (sourceKeyCounts.get(sourceKey) ?? 0) + 1);
    }
  }

  const magicWordSourceMessages = sourceKeyCounts.size;
  const maxMagicWordsPerMessage = sourceKeyCounts.size > 0 ? Math.max(...sourceKeyCounts.values()) : 0;

  // --- proposal_reject cluster: group by episodeId + proposalId ---
  const proposalRejectSignals = sourceWindow.signals.filter((s) => s.record.type === 'proposal_reject');

  const proposalRejectEpisodeIds = new Set<string>();
  const proposalRejectProposalIds = new Set<string>();
  for (const signal of proposalRejectSignals) {
    proposalRejectEpisodeIds.add(signal.episodeId);
    if (typeof signal.record.proposalId === 'string') {
      proposalRejectProposalIds.add(signal.record.proposalId);
    }
  }

  // --- cluster-adjusted A2 total (P1-2) ---
  // permission_cancel is already 1:1 with interventions (no clustering needed),
  // so it's counted raw; magic_word_ref and proposal_reject use clustered counts.
  const permissionCancelCount = sourceWindow.signals.filter((s) => s.record.type === 'permission_cancel').length;
  const proposalRejectEpisodes = proposalRejectEpisodeIds.size;
  const clusterAdjustedA2Total = magicWordSourceMessages + proposalRejectEpisodes + permissionCancelCount;

  return {
    magicWordSourceMessages,
    maxMagicWordsPerMessage,
    proposalRejectEpisodes,
    proposalRejectDistinctProposalIds: proposalRejectProposalIds.size,
    clusterAdjustedA2Total,
  };
}
