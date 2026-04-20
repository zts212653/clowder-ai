/**
 * F163 Phase B (AC-B1): Duplicate scanner using TF-IDF cosine similarity.
 * Reads evidence_docs, computes pairwise similarity on title+summary,
 * returns clusters of suspected duplicates above a configurable threshold.
 */

import type Database from 'better-sqlite3';

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

// ── TF-IDF helpers ────────────────────────────────────────────────────

/** Tokenize: lowercase, split on non-word chars, filter short tokens */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter((t) => t.length > 1);
}

/** Build a term-frequency map for a single document */
function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }
  return tf;
}

/** Build inverse-document-frequency map across all docs */
function inverseDocFrequency(docs: Map<string, number>[]): Map<string, number> {
  const n = docs.length;
  const df = new Map<string, number>();
  for (const tf of docs) {
    for (const term of tf.keys()) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  for (const [term, count] of df) {
    idf.set(term, Math.log((n + 1) / (count + 1)) + 1);
  }
  return idf;
}

/** Compute TF-IDF vector (sparse, as Map) */
function tfidfVector(tf: Map<string, number>, idf: Map<string, number>): Map<string, number> {
  const vec = new Map<string, number>();
  for (const [term, freq] of tf) {
    vec.set(term, freq * (idf.get(term) ?? 1));
  }
  return vec;
}

/** Cosine similarity between two sparse vectors */
function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [term, val] of a) {
    normA += val * val;
    const bVal = b.get(term);
    if (bVal !== undefined) dot += val * bVal;
  }
  for (const val of b.values()) {
    normB += val * val;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
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
