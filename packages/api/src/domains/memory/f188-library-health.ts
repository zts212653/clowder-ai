import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { Marker } from './interfaces.js';

export interface LibraryHealthMetrics {
  staleAnchors: { count: number; items: Array<{ anchor: string; sourcePath: string }> };
  orphanEdges: { count: number };
  searchQuality: {
    totalSearches: number;
    zeroHitCount: number;
    lowHitCount: number;
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

function computeSearchQuality(db: Database.Database) {
  try {
    const rows = db
      .prepare("SELECT payload, created_at FROM f163_logs WHERE log_type = 'search' ORDER BY created_at DESC LIMIT 200")
      .all() as Array<{ payload: string; created_at: string }>;
    let zeroHitCount = 0;
    let lowHitCount = 0;
    const recentMisses: Array<{ query: string; resultCount: number; searchedAt: string }> = [];
    for (const row of rows) {
      try {
        const p = JSON.parse(row.payload) as { query?: string; resultCount?: number };
        const rc = p.resultCount ?? 0;
        if (rc === 0) {
          zeroHitCount++;
          if (recentMisses.length < 10) {
            recentMisses.push({ query: p.query ?? '', resultCount: rc, searchedAt: row.created_at });
          }
        } else if (rc <= 2) {
          lowHitCount++;
        }
      } catch {
        /* skip unparseable */
      }
    }
    return { totalSearches: rows.length, zeroHitCount, lowHitCount, recentMisses };
  } catch {
    return { totalSearches: 0, zeroHitCount: 0, lowHitCount: 0, recentMisses: [] };
  }
}

function computeReplayDrift(db: Database.Database) {
  try {
    const rows = db
      .prepare("SELECT payload FROM f163_logs WHERE log_type = 'search' ORDER BY created_at DESC LIMIT 500")
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
