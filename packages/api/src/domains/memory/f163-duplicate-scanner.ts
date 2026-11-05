/**
 * F163 Phase B (AC-B1): Duplicate scanner using TF-IDF cosine similarity.
 * Reads evidence_docs, computes pairwise similarity on title+summary,
 * returns clusters of suspected duplicates above a configurable threshold.
 */

import type Database from 'better-sqlite3';
import { cosineSimilarity, inverseDocFrequency, termFrequency, tfidfVector, tokenize } from './f163-text-similarity.js';

export interface DuplicateSuggestion {
  anchors: string[];
  similarity: number;
  suggestedTitle: string;
}

export interface ScanOptions {
  threshold?: number;
  kinds?: string[];
}

interface DocRow {
  anchor: string;
  title: string;
  summary: string | null;
}

// ── Single-linkage clustering ─────────────────────────────────────────

/** Cluster indices using single-linkage above threshold */
function singleLinkageClusters(
  similarities: { i: number; j: number; sim: number }[],
  n: number,
  threshold: number,
): number[][] {
  // Union-Find
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  for (const { i, j, sim } of similarities) {
    if (sim >= threshold) union(i, j);
  }

  const clusters = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const arr = clusters.get(root) ?? [];
    arr.push(i);
    clusters.set(root, arr);
  }

  // Only return clusters with 2+ members
  return [...clusters.values()].filter((c) => c.length >= 2);
}

// ── Scanner ───────────────────────────────────────────────────────────

export class DuplicateScanner {
  scan(db: Database.Database, options?: ScanOptions): DuplicateSuggestion[] {
    const threshold = options?.threshold ?? 0.6;
    const kinds = options?.kinds ?? ['lesson', 'decision', 'discussion'];

    const placeholders = kinds.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT anchor, title, COALESCE(summary, '') AS summary FROM evidence_docs
         WHERE kind IN (${placeholders}) AND summary_of_anchor IS NULL`,
      )
      .all(...kinds) as DocRow[];

    if (rows.length < 2) return [];

    // Build TF-IDF vectors
    const tfMaps = rows.map((r) => termFrequency(tokenize(`${r.title} ${r.summary}`)));
    const idf = inverseDocFrequency(tfMaps);
    const vectors = tfMaps.map((tf) => tfidfVector(tf, idf));

    // Compute pairwise similarities
    const pairs: { i: number; j: number; sim: number }[] = [];
    for (let i = 0; i < vectors.length; i++) {
      for (let j = i + 1; j < vectors.length; j++) {
        const sim = cosineSimilarity(vectors[i], vectors[j]);
        if (sim >= threshold) {
          pairs.push({ i, j, sim });
        }
      }
    }

    // Cluster
    const clusters = singleLinkageClusters(pairs, rows.length, threshold);

    // Convert to suggestions
    return clusters.map((indices) => {
      const anchors = indices.map((i) => rows[i].anchor);
      const clusterPairs = pairs.filter((p) => indices.includes(p.i) && indices.includes(p.j));
      const avgSimilarity =
        clusterPairs.length > 0 ? clusterPairs.reduce((sum, p) => sum + p.sim, 0) / clusterPairs.length : threshold;
      // Suggested title: pick the longest title in the cluster
      const titles = indices.map((i) => rows[i].title);
      const suggestedTitle = titles.reduce((a, b) => (a.length >= b.length ? a : b));
      return { anchors, similarity: avgSimilarity, suggestedTitle };
    });
  }
}
