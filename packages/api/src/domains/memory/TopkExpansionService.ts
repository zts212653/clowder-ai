// F256 Phase B+C: Expansion hints for default topk search
//
// Projects the expansion provenance from intent=coverage into intent=topk output.
// Design: docs/discussions/2026-06-24-memory-search-strategy-evolution.md §6.4
//
// Constraints:
//   - Only top-3 hits expanded (budget: §6.4 取舍 A)
//   - Each expansion type ≤ 3 hints
//   - Max 5 terms probed per type (query budget — scanner keywords have no upper bound)
//   - Convention-edge expansion via ConventionGraphAdapter (Phase C: l0-prompt-builder domain)
//   - Provenance visible per hint (AC-B2)

import type { ExpansionHintTargetRef } from '@cat-cafe/shared';
import type { ConventionGraphAdapter } from './CoverageSearchService.js';
import type { ExpansionProvenance, ExpansionSourceType } from './coverage-search-types.js';
import type { EvidenceItem, IEvidenceStore, SearchOptions } from './interfaces.js';

// ── Output types ─────────────────────────────────────────────────────

export interface ExpansionHint {
  anchor: string;
  title: string;
  kind: string;
  sourcePath?: string;
  targetRef: ExpansionHintTargetRef;
  provenance: ExpansionProvenance;
}

export interface TopkExpansionOptions {
  /** Max number of top results to expand (default 3) */
  maxHitsToExpand?: number;
  /** Max hints per expansion type (default 3) */
  maxHintsPerType?: number;
}

// ── F256 health funnel: per-stage telemetry ─────────────────────────

export interface ExpansionSourceFunnel {
  probed: number;
  added: number;
  deduped: number;
}

export interface ExpansionConventionEdgeFunnel {
  attempted: boolean;
  added: number;
  deduped: number;
  staleSkipped: number;
}

export interface ExpansionFunnel {
  attempted: boolean;
  keyword: ExpansionSourceFunnel;
  sourceThread: ExpansionSourceFunnel;
  conventionEdge: ExpansionConventionEdgeFunnel;
  presented: number;
}

export interface ExpandWithMetaResult {
  hints: ExpansionHint[];
  funnel: ExpansionFunnel;
}

// Scanner-generated keywords (section headings, wikilinks, frontmatter topics)
// have no upper bound. Cap internal searchWithMeta calls to avoid amplifying
// every default topk search into many sub-queries. (砚砚 review P1-2)
const MAX_TERMS_PER_TYPE = 5;

// ── Service ──────────────────────────────────────────────────────────

export class TopkExpansionService {
  private readonly store: Pick<IEvidenceStore, 'searchWithMeta'>;
  private readonly conventionGraph: ConventionGraphAdapter | null;

  constructor(store: Pick<IEvidenceStore, 'searchWithMeta'>, conventionGraph?: ConventionGraphAdapter | null) {
    this.store = store;
    this.conventionGraph = conventionGraph ?? null;
  }

  async expand(topResults: EvidenceItem[], _query: string, options?: TopkExpansionOptions): Promise<ExpansionHint[]> {
    const result = await this.expandWithMeta(topResults, _query, options);
    return result.hints;
  }

  async expandWithMeta(
    topResults: EvidenceItem[],
    _query: string,
    options?: TopkExpansionOptions,
  ): Promise<ExpandWithMetaResult> {
    const emptyFunnel: ExpansionFunnel = {
      attempted: false,
      keyword: { probed: 0, added: 0, deduped: 0 },
      sourceThread: { probed: 0, added: 0, deduped: 0 },
      conventionEdge: { attempted: false, added: 0, deduped: 0, staleSkipped: 0 },
      presented: 0,
    };

    if (topResults.length === 0) return { hints: [], funnel: emptyFunnel };

    const maxHits = options?.maxHitsToExpand ?? 3;
    const maxPerType = options?.maxHintsPerType ?? 3;

    // Seed the seen set with existing result anchors (dedup)
    const seen = new Set<string>(topResults.map((r) => r.anchor.toLowerCase()));
    const hints: ExpansionHint[] = [];

    const hitsToExpand = topResults.slice(0, maxHits);

    const funnel: ExpansionFunnel = {
      attempted: true,
      keyword: { probed: 0, added: 0, deduped: 0 },
      sourceThread: { probed: 0, added: 0, deduped: 0 },
      conventionEdge: { attempted: false, added: 0, deduped: 0, staleSkipped: 0 },
      presented: 0,
    };

    // ── Frontmatter-alias expansion ──────────────────────────────────
    await this.expandViaKeywords(hitsToExpand, seen, hints, maxPerType, funnel.keyword);

    // ── Source-thread expansion ──────────────────────────────────────
    await this.expandViaSourceThreads(hitsToExpand, seen, hints, maxPerType, funnel.sourceThread);

    // ── Convention-edge expansion (Phase C: F242 extractor + l0-prompt-builder) ──
    await this.expandViaConventionEdges(hitsToExpand, seen, hints, maxPerType, funnel.conventionEdge);

    funnel.presented = hints.length;

    return { hints, funnel };
  }

  // ── Private helpers ────────────────────────────────────────────────

  private async expandViaKeywords(
    hits: EvidenceItem[],
    seen: Set<string>,
    hints: ExpansionHint[],
    maxPerType: number,
    meter?: ExpansionSourceFunnel,
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
        if (seen.has(key)) {
          if (meter) meter.deduped++;
          continue;
        }
        seen.add(key);
        hints.push({
          anchor: item.anchor,
          title: item.title,
          kind: item.kind,
          sourcePath: item.sourcePath,
          targetRef: expansionTargetRef(item),
          provenance: {
            source: 'frontmatter-alias' as ExpansionSourceType,
            via: `keyword:${term}`,
            edgeStrength: 'heuristic',
          },
        });
        added++;
      }
    }
    if (meter) {
      meter.probed = probed;
      meter.added = added;
    }
  }

  private async expandViaConventionEdges(
    hits: EvidenceItem[],
    seen: Set<string>,
    hints: ExpansionHint[],
    maxPerType: number,
    meter?: ExpansionConventionEdgeFunnel,
  ): Promise<void> {
    if (!this.conventionGraph || !this.conventionGraph.isAvailable()) return;

    if (meter) meter.attempted = true;

    let added = 0;
    for (const item of hits) {
      if (added >= maxPerType) break;

      const consumers = await this.conventionGraph.queryConsumers(item.anchor);
      for (const consumer of consumers) {
        if (added >= maxPerType) break;

        const key = consumer.anchor.toLowerCase();
        if (seen.has(key)) {
          if (meter) meter.deduped++;
          continue;
        }

        if (consumer.stale) {
          if (meter) meter.staleSkipped++;
          continue;
        }

        seen.add(key);
        hints.push({
          anchor: consumer.anchor,
          title: consumer.title,
          kind: consumer.kind,
          sourcePath: consumer.filePath,
          targetRef: {
            kind: 'doc',
            sourcePath: consumer.filePath ?? '',
            anchor: consumer.anchor,
          },
          provenance: {
            source: 'convention-edge' as ExpansionSourceType,
            via: `${item.anchor} → ${consumer.anchor}`,
            edgeStrength: consumer.edgeStrength,
          },
        });
        added++;
      }
    }
    if (meter) meter.added = added;
  }

  private async expandViaSourceThreads(
    hits: EvidenceItem[],
    seen: Set<string>,
    hints: ExpansionHint[],
    maxPerType: number,
    meter?: ExpansionSourceFunnel,
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
        if (seen.has(key)) {
          if (meter) meter.deduped++;
          continue;
        }
        seen.add(key);
        hints.push({
          anchor: item.anchor,
          title: item.title,
          kind: item.kind,
          sourcePath: item.sourcePath,
          targetRef: expansionTargetRef(item),
          provenance: {
            source: 'source-thread' as ExpansionSourceType,
            via: ref,
            edgeStrength: 'heuristic',
          },
        });
        added++;
      }
    }
    if (meter) {
      meter.probed = probed;
      meter.added = added;
    }
  }
}

function expansionTargetRef(item: Pick<EvidenceItem, 'anchor' | 'kind' | 'sourcePath'>): ExpansionHintTargetRef {
  if (item.kind === 'thread' && item.anchor.startsWith('thread-')) {
    const threadId = item.anchor.slice('thread-'.length);
    if (threadId) return { kind: 'thread', threadId };
  }
  return {
    kind: 'doc',
    sourcePath: item.sourcePath ?? '',
    anchor: item.anchor,
  };
}
