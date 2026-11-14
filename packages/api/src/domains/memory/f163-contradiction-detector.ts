/**
 * F163 Phase C (AC-C1): Write-time contradiction detector.
 * Compares raw term-frequency vectors with the shared F163 tokenizer and cosine similarity.
 * On upsert, searches existing docs for lexical overlap and flags potential contradictions.
 */

import { cosineSimilarity, termFrequency, tokenize } from './f163-text-similarity.js';
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
