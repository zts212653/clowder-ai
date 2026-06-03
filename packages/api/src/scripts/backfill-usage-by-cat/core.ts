/**
 * Issue #845 — Pure planning core for the usage-by-cat backfill.
 *
 * Splits IO (Redis scan + writes) from the deterministic planning step so the latter is
 * fully unit-testable without a live Redis. Inputs are the records and messages already
 * fetched by the CLI driver; the output is the list of update plans plus an aggregate
 * summary suitable for dry-run preview.
 */

import type { InvocationRecord } from '../../domains/cats/services/stores/ports/InvocationRecordStore.js';
import type { StoredMessage } from '../../domains/cats/services/stores/ports/MessageStore.js';
import { mergeTokenUsage, type TokenUsage } from '../../domains/cats/services/types.js';

/** One planned write: which invocation gets which usageByCat, anchored to which day. */
export interface BackfillPlanEntry {
  invocationId: string;
  threadId: string;
  /** UTC date string YYYY-MM-DD, derived from invocation.createdAt. Used by aggregator. */
  date: string;
  /** epoch ms — usageRecordedAt override pinned to original invocation day */
  usageRecordedAt: number;
  /** queue-* / connector-* / mm-* / other — classification by idempotency prefix */
  source: string;
  /** Recovered usageByCat map (catId → TokenUsage), aggregated from related messages */
  usageByCat: Record<string, TokenUsage>;
  /** Number of source messages that contributed */
  messageCount: number;
}

/** Aggregate counters for the dry-run summary. */
export interface BackfillSummary {
  totalInvocations: number;
  succeededTotal: number;
  orphanCandidates: number;
  recoverable: number;
  /** Orphans that had no related messages with metadata.usage — cannot recover. */
  unrecoverable: number;
  byDate: Record<string, number>;
  bySource: Record<string, number>;
}

export interface BackfillPlan {
  entries: BackfillPlanEntry[];
  summary: BackfillSummary;
}

export interface BackfillPlanOptions {
  /** Cutoff in ms; invocations with createdAt < cutoff are ignored. */
  cutoffMs: number;
  /** Current time for the daily-window guard (defaults to Date.now()). */
  nowMs?: number;
}

/** Classify an idempotency key into a high-level source bucket. */
function classifySource(idempotencyKey: string | undefined): string {
  if (!idempotencyKey) return 'unknown';
  if (idempotencyKey.startsWith('queue-')) return 'queue';
  if (idempotencyKey.startsWith('connector-')) return 'connector';
  if (idempotencyKey.startsWith('connector:')) return 'connector';
  if (idempotencyKey.startsWith('mm-')) return 'multi-mention';
  if (idempotencyKey.startsWith('history-import:')) return 'history-import';
  if (idempotencyKey.startsWith('proposal-initial:')) return 'proposal';
  if (idempotencyKey.startsWith('kickoff:')) return 'kickoff';
  return 'other';
}

function toDateString(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Build a parent-invocation → messages-with-usage index from the message stream.
 *
 * Only messages with a known parent invocationId AND a populated `metadata.usage`
 * count. `extra.stream.invocationId` is the canonical parent-chain id (F081 / Z3).
 */
export function indexMessagesByInvocation(messages: readonly StoredMessage[]): Map<string, StoredMessage[]> {
  const index = new Map<string, StoredMessage[]>();
  for (const msg of messages) {
    const invocationId = msg.extra?.stream?.invocationId;
    if (!invocationId) continue;
    if (!msg.metadata?.usage) continue;
    const list = index.get(invocationId);
    if (list) {
      list.push(msg);
    } else {
      index.set(invocationId, [msg]);
    }
  }
  return index;
}

/**
 * Plan the backfill. Pure function — given the full set of invocations and the
 * precomputed message index, returns the list of update plans plus a summary.
 *
 * Decision rules:
 *   1. Only `status === 'succeeded'` records are considered.
 *   2. Records that already have `usageByCat` are skipped (idempotent re-run).
 *   3. `createdAt < cutoffMs` is skipped (window guard).
 *   4. Records whose related messages contain no `metadata.usage` are reported
 *      as unrecoverable (not in the entries list) so the operator sees how
 *      many orphans cannot be repaired.
 *   5. `usageRecordedAt` mirrors the *live writer* semantics: the moment usage
 *      actually arrived. For the live path this is roughly the succeeded-update
 *      time, so we use `max(message.timestamp)` over the contributing messages
 *      (the timestamp on the `done` event), falling back to
 *      `invocation.updatedAt` if no message timestamp is available.
 *      We deliberately do NOT use `invocation.createdAt`: a long invocation
 *      that started before UTC midnight and finished after would otherwise
 *      backfill onto the wrong day relative to the live writer's behavior.
 */
export function planBackfill(
  invocations: readonly InvocationRecord[],
  messageIndex: ReadonlyMap<string, readonly StoredMessage[]>,
  options: BackfillPlanOptions,
): BackfillPlan {
  const entries: BackfillPlanEntry[] = [];
  const byDate: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  let succeededTotal = 0;
  let orphanCandidates = 0;
  let unrecoverable = 0;

  for (const invocation of invocations) {
    if (invocation.status !== 'succeeded') continue;
    succeededTotal += 1;
    if (invocation.usageByCat) continue; // already populated
    if (invocation.createdAt < options.cutoffMs) continue; // outside window
    orphanCandidates += 1;

    const relatedMessages = messageIndex.get(invocation.id);
    if (!relatedMessages || relatedMessages.length === 0) {
      unrecoverable += 1;
      continue;
    }

    const aggregated = new Map<string, TokenUsage>();
    let usableCount = 0;
    let maxMessageTimestamp = 0;
    for (const msg of relatedMessages) {
      if (!msg.catId) continue;
      const usage = msg.metadata?.usage;
      if (!usage) continue;
      aggregated.set(msg.catId, mergeTokenUsage(aggregated.get(msg.catId), usage));
      usableCount += 1;
      if (typeof msg.timestamp === 'number' && msg.timestamp > maxMessageTimestamp) {
        maxMessageTimestamp = msg.timestamp;
      }
    }

    if (aggregated.size === 0) {
      unrecoverable += 1;
      continue;
    }

    // Anchor to live-writer semantics: usage arrived around the done event time,
    // which is captured by the contributing message's timestamp. Fall back to
    // invocation.updatedAt (≈ succeeded-update time) if no message carried a
    // usable timestamp. We never use createdAt — that would mis-bucket
    // cross-midnight invocations relative to the live writer's behavior.
    const usageRecordedAt = maxMessageTimestamp > 0 ? maxMessageTimestamp : invocation.updatedAt;
    const date = toDateString(usageRecordedAt);
    const source = classifySource(invocation.idempotencyKey);
    entries.push({
      invocationId: invocation.id,
      threadId: invocation.threadId,
      date,
      usageRecordedAt,
      source,
      usageByCat: Object.fromEntries(aggregated),
      messageCount: usableCount,
    });
    byDate[date] = (byDate[date] ?? 0) + 1;
    bySource[source] = (bySource[source] ?? 0) + 1;
  }

  return {
    entries,
    summary: {
      totalInvocations: invocations.length,
      succeededTotal,
      orphanCandidates,
      recoverable: entries.length,
      unrecoverable,
      byDate,
      bySource,
    },
  };
}

/**
 * Format a human-readable preview of the plan for stdout. Stable ordering so the
 * operator can diff two dry-runs (e.g. before / after a fix on the writer path).
 */
export function formatBackfillPreview(plan: BackfillPlan, opts: { dryRun: boolean }): string {
  const { summary } = plan;
  const lines: string[] = [];
  lines.push(`[backfill-usage] mode = ${opts.dryRun ? 'DRY-RUN' : 'APPLY'}`);
  lines.push(`[backfill-usage] scanned invocations: ${summary.totalInvocations}`);
  lines.push(`[backfill-usage] succeeded total:     ${summary.succeededTotal}`);
  lines.push(`[backfill-usage] orphan candidates:   ${summary.orphanCandidates}`);
  lines.push(`[backfill-usage] recoverable:         ${summary.recoverable}`);
  lines.push(`[backfill-usage] unrecoverable:       ${summary.unrecoverable}`);
  if (Object.keys(summary.byDate).length > 0) {
    lines.push('[backfill-usage] by date (recoverable):');
    for (const date of Object.keys(summary.byDate).sort()) {
      lines.push(`  ${date}: ${summary.byDate[date]}`);
    }
  }
  if (Object.keys(summary.bySource).length > 0) {
    lines.push('[backfill-usage] by source (recoverable):');
    for (const source of Object.keys(summary.bySource).sort()) {
      lines.push(`  ${source}: ${summary.bySource[source]}`);
    }
  }
  return lines.join('\n');
}
