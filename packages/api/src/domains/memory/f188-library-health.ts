import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { Marker } from './interfaces.js';

export interface LibraryHealthMetrics {
  staleAnchors: { count: number; items: Array<{ anchor: string; sourcePath: string }> };
  orphanEdges: { count: number };
  verificationDebt: { needsReviewCount: number; escalatedCount: number; trustedLegacyCount: number };
  searchQuality: {
    totalSearches: number;
    observedSearches: number;
    zeroHitCount: number;
    lowHitCount: number;
    /** Zero-hits from identifier probes (thread IDs, session UUIDs, git SHAs, message IDs)
     *  that should use graph_resolve instead of free-text search. Tracked separately so
     *  they don't inflate the content-miss zero-hit count. */
    identifierProbeZeroHitCount: number;
    recentMisses: Array<{ query: string; resultCount: number; searchedAt: string }>;
  };
  replayDrift: { available: boolean; sampleCount: number; avgSimilarity: number | null };
  knowledgeFeed: { pendingCount: number; needsReviewCount: number };
}

const PENDING_STATUSES = new Set(['captured', 'normalized', 'needs_review']);

export function computeLibraryHealth(
  db: Database.Database,
  opts: { docsRoot?: string; repoRoot?: string; markers: Marker[] },
): LibraryHealthMetrics {
  return {
    staleAnchors: computeStaleAnchors(db, opts.repoRoot, opts.docsRoot),
    orphanEdges: computeOrphanEdges(db),
    verificationDebt: computeVerificationDebt(db),
    searchQuality: computeSearchQuality(db),
    replayDrift: computeReplayDrift(db),
    knowledgeFeed: computeKnowledgeFeed(opts.markers),
  };
}

function computeStaleAnchors(db: Database.Database, repoRoot?: string, docsRoot?: string) {
  const rows = db
    .prepare(
      "SELECT anchor, source_path FROM evidence_docs WHERE source_path IS NOT NULL AND kind NOT IN ('thread', 'session')",
    )
    .all() as Array<{ anchor: string; source_path: string }>;
  const items: Array<{ anchor: string; sourcePath: string }> = [];
  for (const row of rows) {
    const found =
      (repoRoot && existsSync(join(repoRoot, row.source_path))) ||
      (docsRoot && existsSync(join(docsRoot, row.source_path)));
    if (!found) {
      items.push({ anchor: row.anchor, sourcePath: row.source_path });
    }
  }
  return { count: items.length, items };
}

function computeOrphanEdges(db: Database.Database) {
  try {
    const r = db
      .prepare(
        `SELECT count(*) AS c FROM edges
         WHERE from_anchor NOT IN (SELECT anchor FROM evidence_docs)
            OR to_anchor NOT IN (SELECT anchor FROM evidence_docs)`,
      )
      .get() as { c: number } | undefined;
    return { count: r?.c ?? 0 };
  } catch {
    return { count: 0 };
  }
}

function computeVerificationDebt(db: Database.Database) {
  try {
    const counts = db
      .prepare(
        `SELECT
           SUM(CASE WHEN review_status = 'needs_review' THEN 1 ELSE 0 END) AS needs_review,
           SUM(CASE WHEN review_status = 'escalated' THEN 1 ELSE 0 END) AS escalated,
           SUM(CASE WHEN review_status = 'trusted_legacy' THEN 1 ELSE 0 END) AS trusted_legacy
         FROM evidence_docs`,
      )
      .get() as { needs_review: number; escalated: number; trusted_legacy: number } | undefined;
    return {
      needsReviewCount: counts?.needs_review ?? 0,
      escalatedCount: counts?.escalated ?? 0,
      trustedLegacyCount: counts?.trusted_legacy ?? 0,
    };
  } catch {
    return { needsReviewCount: 0, escalatedCount: 0, trustedLegacyCount: 0 };
  }
}

/**
 * Detect queries that are identifier probes — structural identifiers passed as free-text
 * search instead of using graph_resolve or specific lookup endpoints.
 *
 * These produce zero-hits not because the content is missing, but because the caller
 * used the wrong retrieval path. Counted separately to avoid inflating the content-miss
 * zero-hit metric.
 *
 * Evidence: 2026-07-15 investigation found 100% of current-window zero-hits were identifier
 * probes (thread IDs, session UUIDs). Historical data shows ~40% identifier probes, ~30% git
 * metadata, ~20% CJK tokenization gaps, ~10% misrouted env/config strings.
 */
function isIdentifierProbe(query: string): boolean {
  const q = query.trim();
  // Thread IDs: thread_xxx
  if (/^thread_[a-z0-9]{8,}$/i.test(q)) return true;
  // Session UUIDs: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q)) return true;
  // Message IDs: 0001784067144578 or 0001784067144578-000061-c5c6bc89
  if (/^0{3}\d{13}(-\d{6}-[0-9a-f]{8})?$/i.test(q)) return true;
  // Full git SHAs: 40-char hex
  if (/^[0-9a-f]{40}$/i.test(q)) return true;
  // Short git SHAs (9-12 char lowercase hex — minimum 9 to avoid false positives
  // on English words like "deadbeef" (8) or "defaced" (7); case-sensitive because
  // git always emits lowercase SHAs)
  if (/^[0-9a-f]{9,12}$/.test(q)) return true;
  return false;
}

function computeSearchQuality(db: Database.Database) {
  try {
    const rows = db
      .prepare(
        "SELECT payload, created_at FROM f163_logs WHERE log_type = 'search' AND (origin IS NULL OR origin = 'user') ORDER BY created_at DESC LIMIT 200",
      )
      .all() as Array<{ payload: string; created_at: string }>;
    let zeroHitCount = 0;
    let identifierProbeZeroHitCount = 0;
    let lowHitCount = 0;
    let observedSearches = 0;
    const recentMisses: Array<{ query: string; resultCount: number; searchedAt: string }> = [];
    for (const row of rows) {
      try {
        const p = JSON.parse(row.payload) as { query?: string; resultCount?: number };
        // HW-7 三態校准: resultCount=null/undefined means "telemetry pipeline didn't write"
        // (not-written), NOT "true zero results". Only count explicit 0 as zero-hit.
        const rc = p.resultCount;
        if (rc != null) observedSearches++;
        if (rc === 0) {
          const probe = isIdentifierProbe(p.query ?? '');
          if (probe) {
            identifierProbeZeroHitCount++;
          } else {
            zeroHitCount++;
          }
          // Only content misses enter recentMisses — probes are routing errors,
          // not recall failures. Prevents probes from filling the 10-slot cap and
          // hiding real content misses from diagnostics.
          if (!probe && recentMisses.length < 10) {
            recentMisses.push({
              query: p.query ?? '',
              resultCount: rc,
              searchedAt: row.created_at,
            });
          }
        } else if (rc != null && rc <= 2) {
          lowHitCount++;
        }
      } catch {
        /* skip unparseable */
      }
    }
    return {
      totalSearches: rows.length,
      observedSearches,
      zeroHitCount,
      identifierProbeZeroHitCount,
      lowHitCount,
      recentMisses,
    };
  } catch {
    return {
      totalSearches: 0,
      observedSearches: 0,
      zeroHitCount: 0,
      identifierProbeZeroHitCount: 0,
      lowHitCount: 0,
      recentMisses: [],
    };
  }
}

function computeReplayDrift(db: Database.Database) {
  try {
    const rows = db
      .prepare(
        "SELECT payload FROM f163_logs WHERE log_type = 'search' AND (origin IS NULL OR origin = 'user') ORDER BY created_at DESC LIMIT 500",
      )
      .all() as Array<{ payload: string }>;
    if (rows.length === 0) return { available: false, sampleCount: 0, avgSimilarity: null };

    const byQuery = new Map<string, Array<Record<string, { anchors?: string[] }>>>();
    for (const row of rows) {
      try {
        const p = JSON.parse(row.payload) as {
          query?: string;
          topKPerCollection?: Record<string, { anchors?: string[] }>;
        };
        if (!p.query || !p.topKPerCollection) continue;
        let list = byQuery.get(p.query);
        if (!list) {
          list = [];
          byQuery.set(p.query, list);
        }
        list.push(p.topKPerCollection);
      } catch {
        /* skip */
      }
    }

    let totalSim = 0;
    let sampleCount = 0;
    for (const [, entries] of byQuery) {
      if (entries.length < 2) continue;
      const oldest = entries[entries.length - 1];
      const newest = entries[0];
      const setA = new Set(Object.values(oldest).flatMap((v) => v.anchors ?? []));
      const setB = new Set(Object.values(newest).flatMap((v) => v.anchors ?? []));
      const union = new Set([...setA, ...setB]);
      const inter = [...setA].filter((a) => setB.has(a));
      totalSim += union.size === 0 ? 1 : inter.length / union.size;
      sampleCount++;
    }
    return {
      available: true,
      sampleCount,
      avgSimilarity: sampleCount > 0 ? Math.round((totalSim / sampleCount) * 1000) / 1000 : null,
    };
  } catch {
    return { available: false, sampleCount: 0, avgSimilarity: null };
  }
}

function computeKnowledgeFeed(markers: Marker[]) {
  let pendingCount = 0;
  let needsReviewCount = 0;
  for (const m of markers) {
    if (PENDING_STATUSES.has(m.status)) {
      pendingCount++;
      if (m.status === 'needs_review') needsReviewCount++;
    }
  }
  return { pendingCount, needsReviewCount };
}
