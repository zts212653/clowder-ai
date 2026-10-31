/**
 * F163 Phase C (AC-C1): Write-time contradiction detector.
 * Reuses TF-IDF cosine similarity from DuplicateScanner's tokenizer.
 * On upsert, searches existing docs for lexical overlap and flags potential contradictions.
 */

import { freezeFlags } from './f163-types.js';
import type { EvidenceItem, SearchOptions } from './interfaces.js';

export interface ContradictionHit {
  anchor: string;
  title: string;
  similarity: number;
  reason: string;
}

interface Searchable {
  search(query: string, options?: SearchOptions): Promise<EvidenceItem[]>;
}

const SIMILARITY_THRESHOLD = 0.3;

// ── TF-IDF helpers (shared pattern with DuplicateScanner) ────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter((t) => t.length > 1);
}

function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [term, val] of a) {
    normA += val * val;
    const bVal = b.get(term);
    if (bVal !== undefined) dot += val * bVal;
  }
  for (const val of b.values()) normB += val * val;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class ContradictionDetector {
  constructor(private store: Searchable) {}

  async check(incoming: { title: string; summary?: string; kind: string }): Promise<ContradictionHit[]> {
    const flags = freezeFlags();
    if (flags.contradictionDetection === 'off') return [];

    const incomingText = `${incoming.title} ${incoming.summary ?? ''}`.trim();
    const candidates = await this.store.search(incomingText, {
      limit: 10,
      kind: incoming.kind as SearchOptions['kind'],
    });

    const incomingTf = termFrequency(tokenize(incomingText));

    return candidates
      .map((c) => {
        const candidateText = `${c.title} ${c.summary ?? ''}`.trim();
        const candidateTf = termFrequency(tokenize(candidateText));
        const sim = cosineSimilarity(incomingTf, candidateTf);
        return { anchor: c.anchor, title: c.title, similarity: sim, reason: 'lexical_overlap' };
      })
      .filter((h) => h.similarity > SIMILARITY_THRESHOLD)
      .sort((a, b) => b.similarity - a.similarity);
  }
}
