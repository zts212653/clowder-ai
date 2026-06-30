// F256 Phase B: Expansion hints for default topk search
//
// Projects the expansion provenance from intent=coverage into intent=topk output.
// Design: docs/discussions/2026-06-24-memory-search-strategy-evolution.md §6.4
//
// Constraints:
//   - Only top-3 hits expanded (budget: §6.4 取舍 A)
//   - Each expansion type ≤ 3 hints
//   - Max 5 terms probed per type (query budget — scanner keywords have no upper bound)
//   - No convention-edge expansion (graphTraversal=0%, §7.5)
//   - Provenance visible per hint (AC-B2)

import type { ExpansionProvenance, ExpansionSourceType } from './coverage-search-types.js';
import type { EvidenceItem, IEvidenceStore, SearchOptions } from './interfaces.js';

// ── Output types ─────────────────────────────────────────────────────

export interface ExpansionHint {
  anchor: string;
  title: string;
  kind: string;
  sourcePath?: string;
  provenance: ExpansionProvenance;
}

export interface TopkExpansionOptions {
  /** Max number of top results to expand (default 3) */
  maxHitsToExpand?: number;
  /** Max hints per expansion type (default 3) */
  maxHintsPerType?: number;
}

// Scanner-generated keywords (section headings, wikilinks, frontmatter topics)
// have no upper bound. Cap internal searchWithMeta calls to avoid amplifying
// every default topk search into many sub-queries. (砚砚 review P1-2)
const MAX_TERMS_PER_TYPE = 5;

// ── Service ──────────────────────────────────────────────────────────

export class TopkExpansionService {
  private readonly store: Pick<IEvidenceStore, 'searchWithMeta'>;

  constructor(store: Pick<IEvidenceStore, 'searchWithMeta'>) {
    this.store = store;
  }

  async expand(topResults: EvidenceItem[], _query: string, options?: TopkExpansionOptions): Promise<ExpansionHint[]> {
    if (topResults.length === 0) return [];

    const maxHits = options?.maxHitsToExpand ?? 3;
    const maxPerType = options?.maxHintsPerType ?? 3;

    // Seed the seen set with existing result anchors (dedup)
    const seen = new Set<string>(topResults.map((r) => r.anchor.toLowerCase()));
    const hints: ExpansionHint[] = [];

    const hitsToExpand = topResults.slice(0, maxHits);

    // ── Frontmatter-alias expansion ──────────────────────────────────
    await this.expandViaKeywords(hitsToExpand, seen, hints, maxPerType);

    // ── Source-thread expansion ──────────────────────────────────────
    await this.expandViaSourceThreads(hitsToExpand, seen, hints, maxPerType);

    // NOTE: convention-edge expansion intentionally excluded in Phase B
    // (graphTraversal=0%, §7.5). Will be added in Phase C after F242 extractor fix.

    return hints;
  }

  // ── Private helpers ────────────────────────────────────────────────

  private async expandViaKeywords(
    hits: EvidenceItem[],
    seen: Set<string>,
    hints: ExpansionHint[],
    maxPerType: number,
  ): Promise<void> {
    const expandTerms = new Set<string>();
    for (const item of hits) {
      if (item.keywords) {
        for (const kw of item.keywords) {
          expandTerms.add(kw);
        }
      }
    }

    let added = 0;
    let probed = 0;
    for (const term of expandTerms) {
      if (added >= maxPerType || probed >= MAX_TERMS_PER_TYPE) break;
      probed++;
      const result = await this.store.searchWithMeta!(term, {
        scope: 'docs',
        mode: 'hybrid',
        limit: 3,
      } as SearchOptions);
      for (const item of result.items) {
        if (added >= maxPerType) break;
        const key = item.anchor.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        hints.push({
          anchor: item.anchor,
          title: item.title,
          kind: item.kind,
          sourcePath: item.sourcePath,
          provenance: {
            source: 'frontmatter-alias' as ExpansionSourceType,
            via: `keyword:${term}`,
            confidence: 'heuristic',
          },
        });
        added++;
      }
    }
  }

  private async expandViaSourceThreads(
    hits: EvidenceItem[],
    seen: Set<string>,
    hints: ExpansionHint[],
    maxPerType: number,
  ): Promise<void> {
    const threadRefs = new Set<string>();
    const threadPattern = /thread-[a-z0-9_-]+/gi;

    for (const item of hits) {
      // Check sourceIds for thread references
      if (item.sourceIds) {
        for (const sid of item.sourceIds) {
          if (threadPattern.test(sid)) threadRefs.add(sid);
          threadPattern.lastIndex = 0;
        }
      }
      // Check summary for thread-xxx patterns
      if (item.summary) {
        const matches = item.summary.match(threadPattern);
        if (matches) {
          for (const m of matches) threadRefs.add(m);
        }
      }
    }

    let added = 0;
    let probed = 0;
    for (const ref of threadRefs) {
      if (added >= maxPerType || probed >= MAX_TERMS_PER_TYPE) break;
      probed++;
      const result = await this.store.searchWithMeta!(ref, {
        scope: 'threads',
        mode: 'hybrid',
        limit: 3,
      } as SearchOptions);
      for (const item of result.items) {
        if (added >= maxPerType) break;
        const key = item.anchor.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        hints.push({
          anchor: item.anchor,
          title: item.title,
          kind: item.kind,
          sourcePath: item.sourcePath,
          provenance: {
            source: 'source-thread' as ExpansionSourceType,
            via: ref,
            confidence: 'heuristic',
          },
        });
        added++;
      }
    }
  }
}
