// F263 Phase C: Lifecycle trace store — append-only, shadow.
//
// All records are storable:false / indexable:false.
// This store MUST NOT be wired into evidence search, ranking, or indexing.

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  LifecycleTrace,
  LifecycleTraceKind,
  MaturityLevel,
  SourceFamily,
  ThreeAxisSnapshot,
  VerificationEvent,
  VerificationVerdict,
} from './f263-lifecycle-types.js';

// ── Insert input (traceId and createdAt auto-generated) ─────────────

export interface AppendTraceInput {
  kind: LifecycleTraceKind;
  category?: string | null;
  sourceFamily: SourceFamily;
  recallId?: string | null;
  /** Stable idempotency key derived from source event identity.
   * Format: `${invocationId}:${toolName}:${timestamp}`.
   * Used for UNIQUE constraint dedup — unlike recallId, this is deterministic
   * across retries (RecallEventCorrelator generates new recallIds each call). */
  sourceEventId?: string | null;
  threadId?: string | null;
  targetAnchor?: string | null;
  queryText?: string | null;
  claimKind?: string | null;
  checkSource?: string | null;
  verdict?: VerificationVerdict | null;
  payload?: Record<string, unknown>;
  observedAt: number;
}

// ── Query options ───────────────────────────────────────────────────

export interface TraceQueryOptions {
  kind?: LifecycleTraceKind;
  category?: string;
  sourceFamily?: SourceFamily;
  recallId?: string;
  targetAnchor?: string;
  threadIds?: string[];
  from?: number; // epoch ms inclusive
  to?: number; // epoch ms exclusive
  limit?: number;
}

// ── Store ────────────────────────────────────────────────────────────

export class LifecycleTraceStore {
  private readonly insertStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    // INSERT OR IGNORE: idempotency via UNIQUE(source_event_id, kind) partial index.
    // source_event_id is derived from (invocationId:toolName:timestamp) — stable
    // across retries. Unlike recall_id (randomUUID() per correlateWindow() call),
    // source_event_id deterministically identifies the source event.
    this.insertStmt = db.prepare(`
      INSERT OR IGNORE INTO lifecycle_traces
        (trace_id, kind, category, source_family, recall_id, source_event_id,
         thread_id, target_anchor, query_text, claim_kind, check_source, verdict,
         payload_json, observed_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  /**
   * Append a lifecycle trace. Returns the generated trace_id.
   * If a trace with the same (source_event_id, kind) already exists, the insert
   * is silently skipped (idempotency via partial unique index).
   */
  append(input: AppendTraceInput): string {
    const traceId = randomUUID();
    const now = new Date().toISOString();
    this.insertStmt.run(
      traceId,
      input.kind,
      input.category ?? null,
      input.sourceFamily,
      input.recallId ?? null,
      input.sourceEventId ?? null,
      input.threadId ?? null,
      input.targetAnchor ?? null,
      input.queryText ?? null,
      input.claimKind ?? null,
      input.checkSource ?? null,
      input.verdict ?? null,
      JSON.stringify(input.payload ?? {}),
      input.observedAt,
      now,
    );
    return traceId;
  }

  /** Query traces with optional filters. */
  query(opts: TraceQueryOptions = {}): LifecycleTrace[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.kind) {
      conditions.push('kind = ?');
      params.push(opts.kind);
    }
    if (opts.category) {
      conditions.push('category = ?');
      params.push(opts.category);
    }
    if (opts.sourceFamily) {
      conditions.push('source_family = ?');
      params.push(opts.sourceFamily);
    }
    if (opts.recallId) {
      conditions.push('recall_id = ?');
      params.push(opts.recallId);
    }
    if (opts.targetAnchor) {
      conditions.push('target_anchor = ?');
      params.push(opts.targetAnchor);
    }
    if (opts.threadIds && opts.threadIds.length > 0) {
      conditions.push(`thread_id IN (${opts.threadIds.map(() => '?').join(', ')})`);
      params.push(...opts.threadIds);
    }
    if (opts.from != null) {
      conditions.push('observed_at >= ?');
      params.push(opts.from);
    }
    if (opts.to != null) {
      conditions.push('observed_at < ?');
      params.push(opts.to);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(Math.max(1, opts.limit ?? 100), 1000);

    const rows = this.db
      .prepare(`SELECT * FROM lifecycle_traces ${where} ORDER BY observed_at DESC LIMIT ?`)
      .all(...params, limit) as TraceRow[];

    return rows.map(rowToTrace);
  }

  /** Get verification events for a target anchor within a time window. */
  getVerificationEvents(opts: {
    targetAnchor?: string;
    threadIds?: string[];
    from?: number;
    to?: number;
    limit?: number;
  }): VerificationEvent[] {
    const conditions = ["kind = 'verification'"];
    const params: unknown[] = [];

    if (opts.targetAnchor) {
      conditions.push('target_anchor = ?');
      params.push(opts.targetAnchor);
    }
    if (opts.threadIds && opts.threadIds.length > 0) {
      conditions.push(`thread_id IN (${opts.threadIds.map(() => '?').join(', ')})`);
      params.push(...opts.threadIds);
    }
    if (opts.from != null) {
      conditions.push('observed_at >= ?');
      params.push(opts.from);
    }
    if (opts.to != null) {
      conditions.push('observed_at < ?');
      params.push(opts.to);
    }

    const limit = Math.min(Math.max(1, opts.limit ?? 50), 500);
    const rows = this.db
      .prepare(
        `SELECT trace_id, target_anchor, claim_kind, check_source,
                observed_at, verdict, payload_json
         FROM lifecycle_traces
         WHERE ${conditions.join(' AND ')}
         ORDER BY observed_at DESC LIMIT ?`,
      )
      .all(...params, limit) as Array<{
      trace_id: string;
      target_anchor: string;
      claim_kind: string;
      check_source: string;
      observed_at: number;
      verdict: string;
      payload_json: string;
    }>;

    return rows.map((r) => ({
      eventId: r.trace_id,
      target: r.target_anchor,
      claimKind: r.claim_kind,
      checkSource: r.check_source,
      observedAt: r.observed_at,
      verdict: r.verdict as VerificationVerdict,
      ...(r.payload_json !== '{}' ? { evidence: JSON.parse(r.payload_json) } : {}),
    }));
  }

  /**
   * Compute three-axis snapshot for a time window.
   *
   * Axis 1: Harmful consumption count (stale-pointer + identity-misbinding)
   * Axis 2: Unmet demand lower-bound (true_zero count)
   * Axis 3: Attention cost (total presented - used from recall_events)
   *
   * Each axis carries a maturity label:
   * - measured: real observation with evidence
   * - estimated: computed from partial data
   * - lower-bound: known to be an undercount
   * - no-data: no observations available
   */
  computeThreeAxis(days: number, threadIds?: string[]): ThreeAxisSnapshot {
    const now = Date.now();
    const from = now - days * 24 * 60 * 60 * 1000;

    // Thread scoping clause — fail-closed: if threadIds is provided but empty,
    // all counts return 0 (no data for user with no threads).
    const threadFilter =
      threadIds && threadIds.length > 0
        ? `AND thread_id IN (${threadIds.map(() => '?').join(', ')})`
        : threadIds
          ? 'AND 0' // empty threadIds = no access
          : ''; // undefined = no scoping (test/internal use)
    const threadParams = threadIds && threadIds.length > 0 ? threadIds : [];

    // Axis 1: Harmful consumption
    const harmfulRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM lifecycle_traces
         WHERE kind = 'harmful_consumption' AND observed_at >= ? AND observed_at < ? ${threadFilter}`,
      )
      .get(from, now, ...threadParams) as { count: number };

    const harmfulCount = harmfulRow.count;
    const harmfulMaturity: MaturityLevel = harmfulCount > 0 ? 'measured' : 'no-data';
    const harmfulReason =
      harmfulCount === 0 ? 'Phase C 刚落地，尚无有害消费观测事件。不代表没有有害消费——只代表检测器还没有上报。' : null;

    // Axis 2: Unmet demand (true_zero only — C4 contract)
    const unmetRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM lifecycle_traces
         WHERE kind = 'unmet_demand' AND category = 'true_zero'
         AND observed_at >= ? AND observed_at < ? ${threadFilter}`,
      )
      .get(from, now, ...threadParams) as { count: number };

    const unmetCount = unmetRow.count;
    const unmetMaturity: MaturityLevel = unmetCount > 0 ? 'lower-bound' : 'no-data';
    const unmetReason =
      unmetCount === 0
        ? '该窗口无 true-zero 观测。不代表没有错失需求——仅代表观测到的零结果查询为零。'
        : '该读数是下界：仅计 F200 观测到的 resultCount=0 事件，不含猫未发起的查询。';

    // Axis 3: Attention cost — from recall_events (not lifecycle_traces)
    // Thread scoping uses recall_events.thread_id
    const recallThreadFilter =
      threadIds && threadIds.length > 0
        ? `AND thread_id IN (${threadIds.map(() => '?').join(', ')})`
        : threadIds
          ? 'AND 0'
          : '';

    const attentionRow = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN outcome = 'ignored' THEN 1 ELSE 0 END), 0) AS ignored,
           COUNT(*) AS total
         FROM recall_events
         WHERE timestamp >= ? AND timestamp < ? ${recallThreadFilter}`,
      )
      .get(from, now, ...threadParams) as { ignored: number; total: number };

    const attentionCount = attentionRow.ignored;
    const attentionTotal = attentionRow.total;
    const attentionMaturity: MaturityLevel = attentionTotal > 0 ? 'measured' : 'no-data';
    const attentionReason = attentionTotal === 0 ? '该窗口无 recall 事件记录。' : null;

    return {
      harmfulConsumption: {
        value: harmfulCount,
        maturity: harmfulMaturity,
        reason: harmfulReason,
      },
      unmetDemandLowerBound: {
        value: unmetCount,
        maturity: unmetMaturity,
        reason: unmetReason,
      },
      attentionCost: {
        value: attentionCount,
        maturity: attentionMaturity,
        reason: attentionReason,
      },
      days,
      from,
      to: now,
    };
  }

  /** Count traces by kind in a time window. */
  countByKind(from: number, to: number): Record<LifecycleTraceKind, number> {
    const rows = this.db
      .prepare(
        `SELECT kind, COUNT(*) AS count FROM lifecycle_traces
         WHERE observed_at >= ? AND observed_at < ?
         GROUP BY kind`,
      )
      .all(from, to) as Array<{ kind: string; count: number }>;

    const result: Record<string, number> = {
      harmful_consumption: 0,
      unmet_demand: 0,
      verification: 0,
      attention_cost: 0,
    };
    for (const row of rows) {
      result[row.kind] = row.count;
    }
    return result as Record<LifecycleTraceKind, number>;
  }
}

// ── Row mapping ─────────────────────────────────────────────────────

interface TraceRow {
  trace_id: string;
  kind: string;
  category: string | null;
  source_family: string;
  recall_id: string | null;
  source_event_id: string | null;
  thread_id: string | null;
  target_anchor: string | null;
  query_text: string | null;
  claim_kind: string | null;
  check_source: string | null;
  verdict: string | null;
  payload_json: string;
  observed_at: number;
  created_at: string;
}

function rowToTrace(row: TraceRow): LifecycleTrace {
  return {
    traceId: row.trace_id,
    kind: row.kind as LifecycleTraceKind,
    category: row.category,
    sourceFamily: row.source_family as SourceFamily,
    recallId: row.recall_id,
    sourceEventId: row.source_event_id,
    threadId: row.thread_id,
    targetAnchor: row.target_anchor,
    queryText: row.query_text,
    claimKind: row.claim_kind,
    checkSource: row.check_source,
    verdict: row.verdict as VerificationVerdict | null,
    payload: JSON.parse(row.payload_json),
    observedAt: row.observed_at,
    createdAt: row.created_at,
  };
}
