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
  /** UTC date string YYYY-MM-DD, derived from `usageRecordedAt` (the same anchor the
   *  aggregator buckets by). Mirrors the live writer's "usage arrived at this time"
   *  semantics — NOT the invocation's createdAt. */
  date: string;
  /** epoch ms — usageRecordedAt override pinned to a stable usage anchor:
   *  existing `invocation.usageRecordedAt`, else a duration-derived message
   *  completion time, else the legacy `invocation.updatedAt` fallback.
   *  Never `invocation.createdAt` (would mis-bucket cross-midnight runs). */
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
  /** Cutoff in ms; invocations with usage anchor < cutoff are ignored. */
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

function fallbackUsageAnchorMs(invocation: InvocationRecord): number {
  return invocation.usageRecordedAt ?? invocation.updatedAt;
}

function messageCompletionAnchorMs(msg: StoredMessage): number | null {
  const durationMs = msg.metadata?.usage?.durationMs;
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return null;
  if (!Number.isFinite(msg.timestamp)) return null;
  return msg.timestamp + durationMs;
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
 * Aggregate the per-cat usage and any stable completion anchor from a non-empty
 * set of contributing messages. Returns `null` when none of them carries usable
 * `metadata.usage` (the orphan is unrecoverable).
 */
function aggregateUsageFromMessages(messages: readonly StoredMessage[]): {
  usageByCat: Record<string, TokenUsage>;
  messageCount: number;
  completionAnchorMs?: number;
} | null {
  const aggregated = new Map<string, TokenUsage>();
  let messageCount = 0;
  let completionAnchorMs: number | undefined;
  for (const msg of messages) {
    if (!msg.catId) continue;
    const usage = msg.metadata?.usage;
    if (!usage) continue;
    aggregated.set(msg.catId, mergeTokenUsage(aggregated.get(msg.catId), usage));
    messageCount += 1;
    const candidate = messageCompletionAnchorMs(msg);
    if (candidate != null && (completionAnchorMs == null || candidate > completionAnchorMs)) {
      completionAnchorMs = candidate;
    }
  }
  if (aggregated.size === 0) return null;
  return {
    usageByCat: Object.fromEntries(aggregated),
    messageCount,
    ...(completionAnchorMs != null ? { completionAnchorMs } : {}),
  };
}

type OrphanOutcome = { kind: 'entry'; entry: BackfillPlanEntry } | { kind: 'unrecoverable' };

/**
 * Decide the outcome for a single orphan candidate (already passed status /
 * usageByCat / window guards in the caller). Splitting this out keeps
 * `planBackfill` flat and lets each rule be reviewed in isolation.
 */
function planOrphan(
  invocation: InvocationRecord,
  messageIndex: ReadonlyMap<string, readonly StoredMessage[]>,
): OrphanOutcome {
  const relatedMessages = messageIndex.get(invocation.id);
  if (!relatedMessages || relatedMessages.length === 0) return { kind: 'unrecoverable' };

  const aggregate = aggregateUsageFromMessages(relatedMessages);
  if (!aggregate) return { kind: 'unrecoverable' };

  // Anchor to the most stable persisted completion signal available. Existing
  // usageRecordedAt wins; otherwise durationMs lets us recover completion from
  // stream-start message timestamps. updatedAt remains a legacy fallback only,
  // because maintenance repairs can move it after the invocation completed.
  const usageRecordedAt = invocation.usageRecordedAt ?? aggregate.completionAnchorMs ?? invocation.updatedAt;
  return {
    kind: 'entry',
    entry: {
      invocationId: invocation.id,
      threadId: invocation.threadId,
      date: toDateString(usageRecordedAt),
      usageRecordedAt,
      source: classifySource(invocation.idempotencyKey),
      usageByCat: aggregate.usageByCat,
      messageCount: aggregate.messageCount,
    },
  };
}

/**
 * Plan the backfill. Pure function — given the full set of invocations and the
 * precomputed message index, returns the list of update plans plus a summary.
 *
 * Decision rules:
 *   1. Only `status === 'succeeded'` records are considered.
 *   2. Records that already have non-empty `usageByCat` are skipped
 *      (idempotent re-run). Empty `{}` is treated as still backfillable.
 *   3. Planned usage anchor before `cutoffMs` is skipped (window guard).
 *   4. Records whose related messages contain no `metadata.usage` are reported
 *      as unrecoverable (not in the entries list) so the operator sees how
 *      many orphans cannot be repaired.
 *   5. `usageRecordedAt` mirrors the invocation completion day as closely as
 *      the historical data allows: existing `usageRecordedAt`, else
 *      `message.timestamp + metadata.usage.durationMs`, else legacy `updatedAt`
 *      fallback when no duration signal exists. We deliberately do NOT use
 *      bare message timestamps, because stream-persisted assistant messages are
 *      stamped at invocation start. We deliberately do NOT use `createdAt`: a
 *      long invocation that started before UTC midnight and finished after
 *      would otherwise backfill onto the wrong day.
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
    if (invocation.usageByCat && Object.keys(invocation.usageByCat).length > 0) continue; // already populated

    const outcome = planOrphan(invocation, messageIndex);
    if (outcome.kind === 'unrecoverable') {
      if (fallbackUsageAnchorMs(invocation) < options.cutoffMs) continue; // outside usage window
      orphanCandidates += 1;
      unrecoverable += 1;
      continue;
    }
    if (outcome.entry.usageRecordedAt < options.cutoffMs) continue; // outside usage window
    orphanCandidates += 1;
    entries.push(outcome.entry);
    byDate[outcome.entry.date] = (byDate[outcome.entry.date] ?? 0) + 1;
    bySource[outcome.entry.source] = (bySource[outcome.entry.source] ?? 0) + 1;
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
 * 砚砚 cloud review P1-B: outcome of the race-safe pre-write check.
 *
 * Between `planBackfill` (built from a SCAN snapshot) and `applyPlan` (a stream
 * of writes), a concurrent writer (the live messages.ts / QueueProcessor path,
 * a second backfill instance, or a manual repair) may have populated
 * `usageByCat` for the same record. Apply MUST NOT overwrite that — the live
 * data is authoritative and `usageRecordedAt` overrides could shift it onto
 * a wrong day if mixed with stale planned data.
 *
 * Outcomes:
 *   apply           — proceed with `store.update(...)`
 *   skip-missing    — record vanished since plan (eviction / hard-delete)
 *   skip-status     — status moved away from 'succeeded' (e.g. reopened)
 *   skip-populated  — `usageByCat` was filled by another writer; do not clobber
 */
export type ApplyOutcomeKind = 'apply' | 'skip-missing' | 'skip-status' | 'skip-populated';

export interface ApplyOutcome {
  kind: ApplyOutcomeKind;
  /** Human-readable reason for the dry-run / failure log. */
  reason?: string;
}

/**
 * Pure predicate over (planned entry, current record) — easy to unit test.
 * Caller is responsible for actually performing the write when this returns
 * `apply`, and for logging the reason on every skip.
 */
export function decideApplyOutcome(entry: BackfillPlanEntry, currentRecord: InvocationRecord | null): ApplyOutcome {
  if (!currentRecord) {
    return { kind: 'skip-missing', reason: 'record disappeared since plan was built' };
  }
  if (currentRecord.status !== 'succeeded') {
    return { kind: 'skip-status', reason: `status=${currentRecord.status} no longer succeeded` };
  }
  if (currentRecord.usageByCat && Object.keys(currentRecord.usageByCat).length > 0) {
    return { kind: 'skip-populated', reason: 'usageByCat populated by a concurrent writer' };
  }
  // entry is unused but accepted so future rules (e.g. catId set mismatch) can
  // grow without changing the call sites.
  void entry;
  return { kind: 'apply' };
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
