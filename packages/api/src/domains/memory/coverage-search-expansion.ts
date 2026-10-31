import { type CoverageLatencyContext, runWithinCoverageLatency } from './coverage-search-contract.js';
import type { CoverageMatrixItem } from './coverage-search-types.js';
import { COVERAGE_MAX_TOTAL, COVERAGE_QUOTA } from './coverage-search-types.js';
import type { EvidenceItem } from './interfaces.js';

export interface ConventionGraphAdapter {
  queryConsumers(name: string): Promise<
    Array<{
      anchor: string;
      title: string;
      kind: string;
      filePath?: string;
      edgeStrength: 'static' | 'heuristic';
      stale: boolean;
    }>
  >;
  isAvailable(): boolean;
}

export interface CoverageExpansionBudget {
  remaining: number;
}

export type CoverageScopeSearch = (
  query: string,
  scope: 'docs' | 'threads',
  limit: number,
  mode: 'lexical',
  latency: CoverageLatencyContext,
) => Promise<EvidenceItem[]>;

export const COVERAGE_MAX_EXPANSION_LOOKUPS = 20;

export async function expandViaFrontmatter(
  directHits: EvidenceItem[],
  seen: Set<string>,
  matrix: CoverageMatrixItem[],
  latency: CoverageLatencyContext,
  budget: CoverageExpansionBudget,
  searchScope: CoverageScopeSearch,
): Promise<void> {
  const terms = new Set(directHits.flatMap((item) => item.keywords ?? []));
  for (const term of terms) {
    if (!claimExpansionLookup(budget, matrix)) return;
    const items = await searchScope(term, 'docs', 5, 'lexical', latency);
    if (latency.timedOutSources.size > 0) return;
    addIndirectItems(items, seen, matrix, 'alias', 'docs', 'frontmatter-alias', `keyword:${term}`);
  }
}

export async function expandViaSourceThreads(
  directHits: EvidenceItem[],
  seen: Set<string>,
  matrix: CoverageMatrixItem[],
  latency: CoverageLatencyContext,
  budget: CoverageExpansionBudget,
  searchScope: CoverageScopeSearch,
): Promise<void> {
  for (const ref of collectThreadRefs(directHits)) {
    if (!claimExpansionLookup(budget, matrix)) return;
    const items = await searchScope(ref, 'threads', 3, 'lexical', latency);
    if (latency.timedOutSources.size > 0) return;
    addIndirectItems(items, seen, matrix, 'source-thread', 'threads', 'source-thread', ref);
  }
}

export async function expandViaConventionGraph(
  graph: ConventionGraphAdapter,
  directHits: EvidenceItem[],
  seen: Set<string>,
  matrix: CoverageMatrixItem[],
  latency: CoverageLatencyContext,
): Promise<number> {
  let staleSkips = 0;
  let added = 0;
  for (const hit of directHits) {
    if (added >= COVERAGE_QUOTA.conventionGraph) break;
    const outcome = await runWithinCoverageLatency(latency, 'convention-graph', () => graph.queryConsumers(hit.anchor));
    if (outcome.timedOut) break;
    const batch = addConventionConsumers(
      outcome.value,
      hit.anchor,
      seen,
      matrix,
      COVERAGE_QUOTA.conventionGraph - added,
    );
    staleSkips += batch.stale;
    added += batch.added;
  }
  return staleSkips;
}

function claimExpansionLookup(budget: CoverageExpansionBudget, matrix: CoverageMatrixItem[]): boolean {
  if (budget.remaining <= 0 || matrix.length >= COVERAGE_MAX_TOTAL) return false;
  budget.remaining--;
  return true;
}

function collectThreadRefs(items: EvidenceItem[]): Set<string> {
  const refs = new Set<string>();
  const addMatches = (value: string) => {
    for (const match of value.matchAll(/thread-[a-z0-9_-]+/gi)) refs.add(match[0]);
  };
  for (const item of items) {
    for (const sourceId of item.sourceIds ?? []) addMatches(sourceId);
    if (item.summary) addMatches(item.summary);
  }
  return refs;
}

function addIndirectItems(
  items: EvidenceItem[],
  seen: Set<string>,
  matrix: CoverageMatrixItem[],
  matchType: 'alias' | 'source-thread',
  source: 'docs' | 'threads',
  expansionSource: 'frontmatter-alias' | 'source-thread',
  via: string,
): void {
  for (const item of items) {
    const key = item.anchor.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    matrix.push({
      anchor: item.anchor,
      title: item.title,
      kind: item.kind,
      matchType,
      retrievalScore: item.retrievalScore,
      source,
      sourcePath: item.sourcePath,
      drillDown: item.drillDown,
      expansionProvenance: { source: expansionSource, via, edgeStrength: 'heuristic' },
    });
  }
}

function addConventionConsumer(
  consumer: Awaited<ReturnType<ConventionGraphAdapter['queryConsumers']>>[number],
  sourceAnchor: string,
  seen: Set<string>,
  matrix: CoverageMatrixItem[],
): 'added' | 'stale' | 'seen' {
  const key = consumer.anchor.toLowerCase();
  if (seen.has(key)) return 'seen';
  if (consumer.stale) return 'stale';
  seen.add(key);
  matrix.push({
    anchor: consumer.anchor,
    title: consumer.title,
    kind: consumer.kind as CoverageMatrixItem['kind'],
    matchType: 'convention',
    source: 'convention-graph',
    expansionProvenance: {
      source: 'convention-edge',
      via: `${sourceAnchor} → ${consumer.anchor}`,
      edgeStrength: consumer.edgeStrength,
    },
  });
  return 'added';
}

function addConventionConsumers(
  consumers: Awaited<ReturnType<ConventionGraphAdapter['queryConsumers']>>,
  sourceAnchor: string,
  seen: Set<string>,
  matrix: CoverageMatrixItem[],
  capacity: number,
): { added: number; stale: number } {
  let added = 0;
  let stale = 0;
  for (const consumer of consumers) {
    if (added >= capacity) break;
    const disposition = addConventionConsumer(consumer, sourceAnchor, seen, matrix);
    if (disposition === 'added') added++;
    if (disposition === 'stale') stale++;
  }
  return { added, stale };
}
