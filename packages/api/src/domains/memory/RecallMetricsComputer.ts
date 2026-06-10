import type Database from 'better-sqlite3';
import type { ConsumedEntry, RecallCandidate } from './f200-types.js';

export interface RecallMetricsReport {
  period: { fromMs: number; toMs: number; days: number };
  filters: { catId?: string; toolName?: string };
  totalEvents: number;
  core: {
    consumedAt3: number;
    consumedMRR: number;
    reformulationRate: number;
    searchAbandonRate: number;
  };
  extended: {
    readthroughAt3: number;
    firstConsumedRankMedian: number;
    reformulationsBeforeConsumption: number;
    reformulateAfterExposure: number;
    grepFallbackRate: number;
    tokenCostPerHit: number;
    consumedAnchorNotInPoolRate: number;
    shadowConsumedMRR: number | null;
    /**
     * Live MRR computed on the SAME subset as `shadowConsumedMRR`
     * (i.e. rows where `shadowRanking !== null && consumed.length > 0`).
     *
     * Why: `shadowConsumedMRR` divides by the shadow-subset size while
     * `core.consumedMRR` divides by the full row count, so comparing the two
     * collapses to ~1/c (consumed-rate). Use `shadowConsumedMRR /
     * liveOnShadowSubsetMRR` for an apples-to-apples shadow-vs-live ratio.
     * (F200 B' — 6.7× false-alarm root cause.)
     */
    liveOnShadowSubsetMRR: number | null;
  };
  graph: {
    nonFirstSelectionRate: number;
    traversalCompletion: number;
  };
}

export interface AnchorMetric {
  anchor: string;
  consumedCount30d: number;
  exposureCount30d: number;
  lastConsumedAt: string | null;
  dormancyDays: number | null;
}

interface RawRow {
  recall_id: string;
  cat_id: string;
  invocation_id: string;
  tool_name: string;
  query: string;
  candidates_json: string;
  consumed_json: string;
  reformulated: number;
  fell_back_to_grep: number;
  abandoned: number;
  next_graph_resolve_after_read: number;
  token_cost: number;
  timestamp: number;
  shadow_ranking_json: string | null;
}

type ParsedRow = RawRow & {
  candidates: RecallCandidate[];
  consumed: ConsumedEntry[];
  shadowRanking: Array<{ anchor: string; shadowRank: number }> | null;
};

function toAnchorMetric(row: Record<string, unknown>): AnchorMetric {
  return {
    anchor: row.anchor as string,
    consumedCount30d: row.consumed_count_30d as number,
    exposureCount30d: row.exposure_count_30d as number,
    lastConsumedAt: (row.last_consumed_at as string) ?? null,
    dormancyDays: (row.dormancy_days as number) ?? null,
  };
}

export class RecallMetricsComputer {
  constructor(private readonly db: Database.Database) {}

  computeMetrics(opts: { days?: number; catId?: string; toolName?: string } = {}): RecallMetricsReport {
    const days = opts.days ?? 30;
    const toMs = Date.now();
    const fromMs = toMs - days * 86_400_000;

    const rows = this.fetchRows(fromMs, opts.catId, opts.toolName);
    if (rows.length === 0) return this.emptyReport(fromMs, toMs, days, opts);

    const parsed = rows.map((r) => ({
      ...r,
      candidates: JSON.parse(r.candidates_json) as RecallCandidate[],
      consumed: JSON.parse(r.consumed_json) as ConsumedEntry[],
      shadowRanking: r.shadow_ranking_json
        ? (JSON.parse(r.shadow_ranking_json) as Array<{ anchor: string; shadowRank: number }>)
        : null,
    }));

    return {
      period: { fromMs, toMs, days },
      filters: { catId: opts.catId, toolName: opts.toolName },
      totalEvents: parsed.length,
      core: this.computeCore(parsed),
      extended: this.computeExtended(parsed),
      graph: this.computeGraph(parsed),
    };
  }

  refreshAnchorMetrics(): void {
    const cutoff = Date.now() - 30 * 86_400_000;
    const rows30d = this.db
      .prepare('SELECT candidates_json, consumed_json, timestamp FROM recall_events WHERE timestamp >= ?')
      .all(cutoff) as Array<{ candidates_json: string; consumed_json: string; timestamp: number }>;

    const anchors30d = new Map<string, { exposed: number; consumed: number }>();
    for (const row of rows30d) {
      const candidates = JSON.parse(row.candidates_json) as RecallCandidate[];
      const consumed = JSON.parse(row.consumed_json) as ConsumedEntry[];
      const consumedSet = new Set(consumed.map((c) => c.anchor));
      for (const cand of candidates) {
        const entry = anchors30d.get(cand.anchor) ?? { exposed: 0, consumed: 0 };
        entry.exposed++;
        if (consumedSet.has(cand.anchor)) entry.consumed++;
        anchors30d.set(cand.anchor, entry);
      }
    }

    const allTimeRows = this.db
      .prepare("SELECT consumed_json, timestamp FROM recall_events WHERE consumed_json != '[]'")
      .all() as Array<{ consumed_json: string; timestamp: number }>;

    const lastConsumedAllTime = new Map<string, number>();
    for (const row of allTimeRows) {
      const consumed = JSON.parse(row.consumed_json) as ConsumedEntry[];
      for (const c of consumed) {
        const prev = lastConsumedAllTime.get(c.anchor);
        if (!prev || row.timestamp > prev) lastConsumedAllTime.set(c.anchor, row.timestamp);
      }
    }

    const allAnchors = new Set([...anchors30d.keys(), ...lastConsumedAllTime.keys()]);

    const upsert = this.db.prepare(`
      INSERT INTO anchor_recall_metrics (anchor, consumed_count_30d, exposure_count_30d, last_consumed_at, dormancy_days, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(anchor) DO UPDATE SET
        consumed_count_30d = excluded.consumed_count_30d,
        exposure_count_30d = excluded.exposure_count_30d,
        last_consumed_at = excluded.last_consumed_at,
        dormancy_days = excluded.dormancy_days,
        updated_at = excluded.updated_at
    `);

    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db.exec('DELETE FROM anchor_recall_metrics');
      for (const anchor of allAnchors) {
        const stats = anchors30d.get(anchor) ?? { exposed: 0, consumed: 0 };
        const lastConsumed = lastConsumedAllTime.get(anchor) ?? null;
        const lastAt = lastConsumed ? new Date(lastConsumed).toISOString() : null;
        const dormancy = lastConsumed !== null ? Math.floor((now - lastConsumed) / 86_400_000) : null;
        upsert.run(anchor, stats.consumed, stats.exposed, lastAt, dormancy, new Date().toISOString());
      }
    });
    tx();
  }

  refreshGlobalCtrBaseline(): void {
    const rows = this.db
      .prepare(`
        SELECT ed.kind AS doc_kind,
               arm.consumed_count_30d AS consumed,
               arm.exposure_count_30d AS exposure
        FROM anchor_recall_metrics arm
        JOIN evidence_docs ed ON ed.anchor = arm.anchor
        WHERE arm.exposure_count_30d > 0
      `)
      .all() as Array<{ doc_kind: string; consumed: number; exposure: number }>;

    const byKind = new Map<string, { sum: number; count: number }>();
    for (const r of rows) {
      const entry = byKind.get(r.doc_kind) ?? { sum: 0, count: 0 };
      entry.sum += r.consumed / Math.max(r.exposure, 1);
      entry.count++;
      byKind.set(r.doc_kind, entry);
    }

    const upsert = this.db.prepare(`
      INSERT INTO global_ctr_baseline (doc_kind, mean_ctr, sample_count, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(doc_kind) DO UPDATE SET mean_ctr = excluded.mean_ctr, sample_count = excluded.sample_count, updated_at = excluded.updated_at
    `);

    const now = Date.now();
    const tx = this.db.transaction(() => {
      for (const [kind, stats] of byKind) {
        upsert.run(kind, stats.sum / stats.count, stats.count, now);
      }
    });
    tx();
  }

  getPopularAnchors(limit = 20): AnchorMetric[] {
    return (
      this.db
        .prepare('SELECT * FROM anchor_recall_metrics ORDER BY consumed_count_30d DESC LIMIT ?')
        .all(limit) as Array<Record<string, unknown>>
    ).map(toAnchorMetric);
  }

  getDormantAnchors(thresholdDays = 30, limit = 20): AnchorMetric[] {
    return (
      this.db
        .prepare('SELECT * FROM anchor_recall_metrics WHERE dormancy_days >= ? ORDER BY dormancy_days DESC LIMIT ?')
        .all(thresholdDays, limit) as Array<Record<string, unknown>>
    ).map(toAnchorMetric);
  }

  private fetchRows(fromMs: number, catId?: string, toolName?: string): RawRow[] {
    let sql = 'SELECT * FROM recall_events WHERE timestamp >= ?';
    const params: unknown[] = [fromMs];
    if (catId) {
      sql += ' AND cat_id = ?';
      params.push(catId);
    }
    if (toolName) {
      sql += ' AND tool_name = ?';
      params.push(toolName);
    }
    return this.db.prepare(sql).all(...params) as RawRow[];
  }

  private computeCore(rows: ParsedRow[]): RecallMetricsReport['core'] {
    let consumedAt3Count = 0;
    const reciprocalRanks: number[] = [];
    let reformulatedCount = 0;
    let abandonedCount = 0;

    for (const r of rows) {
      if (r.consumed.some((c) => c.rank < 3)) consumedAt3Count++;
      if (r.consumed.length > 0) {
        const firstRank = Math.min(...r.consumed.map((c) => c.rank));
        reciprocalRanks.push(1 / (firstRank + 1));
      }
      if (r.reformulated) reformulatedCount++;
      if (r.abandoned) abandonedCount++;
    }

    return {
      consumedAt3: consumedAt3Count / rows.length,
      consumedMRR: reciprocalRanks.length > 0 ? reciprocalRanks.reduce((a, b) => a + b, 0) / rows.length : 0,
      reformulationRate: reformulatedCount / rows.length,
      searchAbandonRate: abandonedCount / rows.length,
    };
  }

  private computeExtended(rows: ParsedRow[]): RecallMetricsReport['extended'] {
    let readthroughSum = 0;
    let readthroughDenom = 0;
    const firstConsumedRanks: number[] = [];
    let totalTokens = 0;
    let totalConsumed = 0;

    for (const r of rows) {
      if (r.candidates.length > 0) {
        const topK = Math.min(3, r.candidates.length);
        const consumedInTopK = r.consumed.filter((c) => c.rank < 3).length;
        readthroughSum += consumedInTopK / topK;
        readthroughDenom++;
      }
      if (r.consumed.length > 0) {
        firstConsumedRanks.push(Math.min(...r.consumed.map((c) => c.rank)) + 1);
        totalConsumed += r.consumed.length;
      }
      totalTokens += r.token_cost;
    }

    firstConsumedRanks.sort((a, b) => a - b);
    const mid = Math.floor(firstConsumedRanks.length / 2);
    const median =
      firstConsumedRanks.length === 0
        ? 0
        : firstConsumedRanks.length % 2 === 1
          ? firstConsumedRanks[mid]!
          : (firstConsumedRanks[mid - 1]! + firstConsumedRanks[mid]!) / 2;

    const byInvocation = new Map<string, ParsedRow[]>();
    for (const r of rows) {
      const arr = byInvocation.get(r.invocation_id) ?? [];
      arr.push(r);
      byInvocation.set(r.invocation_id, arr);
    }
    let reformBeforeSum = 0;
    let reformBeforeCount = 0;
    for (const group of byInvocation.values()) {
      group.sort((a, b) => a.timestamp - b.timestamp);
      let searches = 0;
      for (const r of group) {
        if (r.consumed.length > 0) {
          reformBeforeSum += searches;
          reformBeforeCount++;
          break;
        }
        searches++;
      }
    }

    const reformAfterExposure = rows.filter(
      (r) => r.reformulated && r.candidates.length > 0 && r.consumed.length === 0 && !r.fell_back_to_grep,
    ).length;

    const withCandidates = rows.filter((r) => r.candidates.length > 0);
    const fallbackAfterHigh = withCandidates.filter((r) => r.fell_back_to_grep).length;

    let consumedNotInPool = 0;
    let totalConsumedEntries = 0;
    for (const r of rows) {
      if (r.consumed.length === 0) continue;
      const candidateAnchors = new Set(r.candidates.map((c) => c.anchor));
      for (const c of r.consumed) {
        totalConsumedEntries++;
        if (!candidateAnchors.has(c.anchor)) consumedNotInPool++;
      }
    }

    const shadow = this.computeShadowComparison(rows);
    return {
      readthroughAt3: readthroughDenom > 0 ? readthroughSum / readthroughDenom : 0,
      firstConsumedRankMedian: median,
      reformulationsBeforeConsumption: reformBeforeCount > 0 ? reformBeforeSum / reformBeforeCount : 0,
      reformulateAfterExposure: rows.length > 0 ? reformAfterExposure / rows.length : 0,
      grepFallbackRate: withCandidates.length > 0 ? fallbackAfterHigh / withCandidates.length : 0,
      tokenCostPerHit: totalConsumed > 0 ? totalTokens / totalConsumed : 0,
      consumedAnchorNotInPoolRate: totalConsumedEntries > 0 ? consumedNotInPool / totalConsumedEntries : 0,
      shadowConsumedMRR: shadow.shadowConsumedMRR,
      liveOnShadowSubsetMRR: shadow.liveOnShadowSubsetMRR,
    };
  }

  /**
   * Compute shadow MRR and a denominator-matched live MRR mirror on the same
   * shadow subset (`shadowRanking !== null && consumed.length > 0`).
   *
   * Both metrics share the same denominator (`shadowRows.length`). The two
   * numerators are INDEPENDENT (each side's "miss" only affects its own sum):
   *   - `shadowConsumedMRR`: 1/(rank+1) on rows where shadow can rank a
   *     consumed anchor; 0 contribution when shadow ranking omits the
   *     consumed anchor (penalise shadow recall miss).
   *   - `liveOnShadowSubsetMRR`: 1/(rank+1) on the same row using the LIVE
   *     consumed rank (`c.rank`); 0 contribution when `c.rank < 0` (anchor
   *     not in live candidate pool, see `consumedAnchorNotInPoolRate` /
   *     AC-C6); otherwise always contributes regardless of shadow.
   *
   * Independent numerators ensure a shadow miss does not mute the live
   * mirror signal on the same row (PR #2108 codex review blocker). The
   * shared denominator keeps `shadowConsumedMRR / liveOnShadowSubsetMRR`
   * apples-to-apples and free of the 1/c dilution that
   * `shadowConsumedMRR / core.consumedMRR` suffers from.
   */
  private computeShadowComparison(rows: ParsedRow[]): {
    shadowConsumedMRR: number | null;
    liveOnShadowSubsetMRR: number | null;
  } {
    const shadowRows = rows.filter((r) => r.shadowRanking !== null && r.consumed.length > 0);
    if (shadowRows.length === 0) {
      return { shadowConsumedMRR: null, liveOnShadowSubsetMRR: null };
    }
    let shadowSum = 0;
    let liveSum = 0;
    for (const r of shadowRows) {
      // Shadow contribution: gated on shadow being able to rank a consumed anchor.
      const rankMap = new Map(r.shadowRanking!.map((s) => [s.anchor, s.shadowRank]));
      const firstShadowRank = Math.min(...r.consumed.map((c) => rankMap.get(c.anchor) ?? Infinity));
      if (Number.isFinite(firstShadowRank)) {
        shadowSum += 1 / (firstShadowRank + 1);
      }
      // Live mirror contribution: INDEPENDENT of shadow (PR #2108 codex review).
      // Min over NON-NEGATIVE ranks only — `c.rank = -1` signals "anchor not in
      // live candidate pool" (AC-C6). On rows with mixed `[{rank:-1}, {rank:0}]`
      // entries, the user's top-pool consumption (rank 0) should still count —
      // taking `Math.min` blindly would let `-1` swallow the valid rank. Skip
      // the row entirely if all consumed entries are -1 (avoids 1/0 = Infinity
      // and mirrors how shadow treats its own miss). Same semantics as shadow's
      // `Math.min(..., Infinity)` which naturally picks the smallest finite rank.
      const liveRanks = r.consumed.map((c) => c.rank).filter((rank) => rank >= 0);
      if (liveRanks.length > 0) {
        const firstLiveRank = Math.min(...liveRanks);
        liveSum += 1 / (firstLiveRank + 1);
      }
    }
    return {
      shadowConsumedMRR: shadowSum / shadowRows.length,
      liveOnShadowSubsetMRR: liveSum / shadowRows.length,
    };
  }

  private computeGraph(rows: ParsedRow[]): RecallMetricsReport['graph'] {
    const graphRows = rows.filter((r) => r.tool_name === 'graph_resolve');
    const graphWithConsumed = graphRows.filter((r) => r.consumed.length > 0);

    const nonFirst = graphWithConsumed.filter((r) => r.consumed.some((c) => c.rank > 0)).length;

    const traversalComplete = graphRows.filter((r) => r.next_graph_resolve_after_read).length;

    return {
      nonFirstSelectionRate: graphWithConsumed.length > 0 ? nonFirst / graphWithConsumed.length : 0,
      traversalCompletion: graphRows.length > 0 ? traversalComplete / graphRows.length : 0,
    };
  }

  private emptyReport(
    fromMs: number,
    toMs: number,
    days: number,
    opts: { catId?: string; toolName?: string },
  ): RecallMetricsReport {
    return {
      period: { fromMs, toMs, days },
      filters: { catId: opts.catId, toolName: opts.toolName },
      totalEvents: 0,
      core: { consumedAt3: 0, consumedMRR: 0, reformulationRate: 0, searchAbandonRate: 0 },
      extended: {
        readthroughAt3: 0,
        firstConsumedRankMedian: 0,
        reformulationsBeforeConsumption: 0,
        reformulateAfterExposure: 0,
        grepFallbackRate: 0,
        tokenCostPerHit: 0,
        consumedAnchorNotInPoolRate: 0,
        shadowConsumedMRR: null,
        liveOnShadowSubsetMRR: null,
      },
      graph: { nonFirstSelectionRate: 0, traversalCompletion: 0 },
    };
  }
}
