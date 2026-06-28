// F200 HW-1: Coverage Search Mode — multi-scope exhaustive search orchestrator
// See docs/plans/2026-06-19-f200-hw1-coverage-search.md
//
// This service does NOT modify IEvidenceStore.search() core semantics (砚砚 constraint #1).
// It orchestrates multiple searchWithMeta() calls across scopes and merges results.

import type {
  CoverageMatrixItem,
  CoverageSearchEvent,
  CoverageSearchResult,
  CoverageSource,
} from './coverage-search-types.js';
import { COVERAGE_MAX_TOTAL, COVERAGE_QUOTA } from './coverage-search-types.js';
import type { EvidenceItem, IEvidenceStore, SearchOptions } from './interfaces.js';

// ── Convention graph soft-dep interface ──────────────────────────────

/** Minimal interface for F242 convention graph queries (soft dependency) */
export interface ConventionGraphAdapter {
  /** Returns consumers of a given node by name/kind */
  queryConsumers(name: string): Promise<
    Array<{
      anchor: string;
      title: string;
      kind: string;
      filePath?: string;
      confidence: 'static' | 'heuristic';
      stale: boolean;
    }>
  >;
  /** Whether the graph is available and not globally stale */
  isAvailable(): boolean;
}

// ── Telemetry callback ──────────────────────────────────────────────

export interface CoverageSearchOptions {
  onCoverageEvent?: (event: CoverageSearchEvent) => void;
}

// ── Service ─────────────────────────────────────────────────────────

export class CoverageSearchService {
  private readonly store: Pick<IEvidenceStore, 'searchWithMeta'>;
  private readonly conventionGraph: ConventionGraphAdapter | null;
  private readonly options: CoverageSearchOptions;

  constructor(
    store: Pick<IEvidenceStore, 'searchWithMeta'>,
    conventionGraph?: ConventionGraphAdapter | null,
    options?: CoverageSearchOptions,
  ) {
    this.store = store;
    this.conventionGraph = conventionGraph ?? null;
    this.options = options ?? {};
  }

  async search(query: string): Promise<CoverageSearchResult> {
    const degraded: Array<{ source: CoverageSource; reason: string }> = [];

    // ── Step 1: Multi-scope parallel search ───────────────────────────
    const [docsItems, threadsItems] = await Promise.all([
      this.searchScope(query, 'docs', COVERAGE_QUOTA.docs),
      this.searchScope(query, 'threads', COVERAGE_QUOTA.threads),
    ]);

    // ── Step 2: Union + Dedup (direct hit wins) ──────────────────────
    const seen = new Set<string>();
    const matrix: CoverageMatrixItem[] = [];

    // Process docs first (higher priority in dedup)
    this.addDirectHits(docsItems, 'docs', seen, matrix);
    this.addDirectHits(threadsItems, 'threads', seen, matrix);

    // ── Step 3: Structured expansion (frontmatter + source-thread) ───
    await this.expandViaFrontmatter(docsItems, seen, matrix);
    await this.expandViaSourceThreads([...docsItems, ...threadsItems], seen, matrix);

    // ── Step 4: Convention graph expansion (soft dep) ─────────────────
    let conventionGraphStaleSkips = 0;
    if (!this.conventionGraph || !this.conventionGraph.isAvailable()) {
      degraded.push({
        source: 'convention-graph',
        reason: this.conventionGraph ? 'convention graph globally stale' : 'convention graph unavailable',
      });
    } else {
      conventionGraphStaleSkips = await this.expandViaConventionGraph([...docsItems, ...threadsItems], seen, matrix);
    }

    // ── Step 5: Cap to max total ─────────────────────────────────────
    const capped = matrix.slice(0, COVERAGE_MAX_TOTAL);

    // ── Assemble result ──────────────────────────────────────────────
    const docsCount = capped.filter((m) => m.source === 'docs').length;
    const threadsCount = capped.filter((m) => m.source === 'threads').length;
    const conventionCount = capped.filter((m) => m.source === 'convention-graph').length;

    const result: CoverageSearchResult = {
      query,
      totalHits: capped.length,
      bySource: {
        docs: { count: docsCount, cap: COVERAGE_QUOTA.docs },
        threads: { count: threadsCount, cap: COVERAGE_QUOTA.threads },
        conventionGraph: { count: conventionCount, cap: COVERAGE_QUOTA.conventionGraph },
      },
      matrix: capped,
      gaps: [],
      ...(degraded.length > 0 ? { degraded } : {}),
    };

    // ── Telemetry callback ───────────────────────────────────────────
    if (this.options.onCoverageEvent) {
      this.options.onCoverageEvent({
        coverageId: `cov-${Date.now()}`,
        catId: '',
        invocationId: '',
        query,
        totalHits: result.totalHits,
        directHits: capped.filter((m) => m.matchType === 'direct').length,
        indirectHits: capped.filter((m) => m.matchType !== 'direct').length,
        bySource: { docs: docsCount, threads: threadsCount, 'convention-graph': conventionCount },
        expansionSources: {
          'frontmatter-alias': capped.filter((m) => m.expansionProvenance?.source === 'frontmatter-alias').length,
          'source-thread': capped.filter((m) => m.expansionProvenance?.source === 'source-thread').length,
          'convention-edge': capped.filter((m) => m.expansionProvenance?.source === 'convention-edge').length,
        },
        conventionGraphUsed: !!this.conventionGraph?.isAvailable(),
        conventionGraphStaleSkips,
        matrixSize: capped.length,
        timestamp: Date.now(),
      });
    }

    return result;
  }

  // ── Private helpers ─────────────────────────────────────────────────

  private async searchScope(query: string, scope: 'docs' | 'threads', limit: number): Promise<EvidenceItem[]> {
    const opts: SearchOptions = { scope, mode: 'hybrid', limit };
    const execution = await this.store.searchWithMeta!(query, opts);
    return execution.items;
  }

  private addDirectHits(
    items: EvidenceItem[],
    source: CoverageSource,
    seen: Set<string>,
    matrix: CoverageMatrixItem[],
  ): void {
    for (const item of items) {
      const key = item.anchor.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      matrix.push({
        anchor: item.anchor,
        title: item.title,
        kind: item.kind,
        matchType: 'direct',
        confidence: item.confidence ?? 1,
        source,
        sourcePath: item.sourcePath,
        drillDown: item.drillDown,
      });
    }
  }

  // ── Task 2: Structured expansion ─────────────────────────────────────

  /** Expand coverage via keywords from direct hits (frontmatter aliases/topics) */
  private async expandViaFrontmatter(
    directHits: EvidenceItem[],
    seen: Set<string>,
    matrix: CoverageMatrixItem[],
  ): Promise<void> {
    const expandTerms = new Set<string>();
    for (const item of directHits) {
      if (item.keywords) {
        for (const kw of item.keywords) {
          expandTerms.add(kw);
        }
      }
    }

    for (const term of expandTerms) {
      const items = await this.searchScope(term, 'docs', 5);
      for (const item of items) {
        const key = item.anchor.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        matrix.push({
          anchor: item.anchor,
          title: item.title,
          kind: item.kind,
          matchType: 'alias',
          confidence: item.confidence ?? 0.7,
          source: 'docs',
          sourcePath: item.sourcePath,
          drillDown: item.drillDown,
          expansionProvenance: {
            source: 'frontmatter-alias',
            via: `keyword:${term}`,
            confidence: 'heuristic',
          },
        });
      }
    }
  }

  /** Expand coverage via thread references in summary or sourceIds */
  private async expandViaSourceThreads(
    directHits: EvidenceItem[],
    seen: Set<string>,
    matrix: CoverageMatrixItem[],
  ): Promise<void> {
    const threadRefs = new Set<string>();
    const threadPattern = /thread-[a-z0-9_-]+/gi;

    for (const item of directHits) {
      // Check sourceIds for thread references
      if (item.sourceIds) {
        for (const sid of item.sourceIds) {
          if (threadPattern.test(sid)) threadRefs.add(sid);
          threadPattern.lastIndex = 0; // reset regex state
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

    for (const ref of threadRefs) {
      const items = await this.searchScope(ref, 'threads', 3);
      for (const item of items) {
        const key = item.anchor.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        matrix.push({
          anchor: item.anchor,
          title: item.title,
          kind: item.kind,
          matchType: 'source-thread',
          confidence: item.confidence ?? 0.6,
          source: 'threads',
          sourcePath: item.sourcePath,
          drillDown: item.drillDown,
          expansionProvenance: {
            source: 'source-thread',
            via: ref,
            confidence: 'heuristic',
          },
        });
      }
    }
  }

  // ── Task 3: Convention graph expansion ────────────────────────────────

  /** Expand coverage via F242 convention graph edges (soft dependency) */
  private async expandViaConventionGraph(
    directHits: EvidenceItem[],
    seen: Set<string>,
    matrix: CoverageMatrixItem[],
  ): Promise<number> {
    if (!this.conventionGraph) return 0;

    let staleSkips = 0;
    const quota = COVERAGE_QUOTA.conventionGraph;
    let added = 0;

    for (const hit of directHits) {
      if (added >= quota) break;

      const consumers = await this.conventionGraph.queryConsumers(hit.anchor);
      for (const consumer of consumers) {
        if (added >= quota) break;

        const key = consumer.anchor.toLowerCase();
        if (seen.has(key)) continue;

        if (consumer.stale) {
          staleSkips++;
          continue;
        }

        seen.add(key);
        matrix.push({
          anchor: consumer.anchor,
          title: consumer.title,
          kind: consumer.kind as CoverageMatrixItem['kind'],
          matchType: 'convention',
          confidence: consumer.confidence === 'static' ? 0.9 : 0.7,
          source: 'convention-graph',
          expansionProvenance: {
            source: 'convention-edge',
            via: `${hit.anchor} → ${consumer.anchor}`,
            confidence: consumer.confidence,
          },
        });
        added++;
      }
    }

    return staleSkips;
  }
}
