import type { CollectionSensitivity } from './collection-types.js';
import { GraphResolver, type GraphResult, type GraphStore } from './GraphResolver.js';
import { computeEdgeWeight } from './graph-edge-weight.js';
import type { EvidenceItem, IEvidenceStore } from './interfaces.js';

const CANDIDATE_LIMIT = 8;
const NO_MATCH_EXAMPLES = ['F186', 'f186', 'harness', 'doc:plans/example.md'];
const SEARCH_STOPWORDS = new Set([
  'anchor',
  'anchors',
  'and',
  'doc',
  'docs',
  'document',
  'documents',
  'feature',
  'features',
  'graph',
  'graphs',
  'node',
  'nodes',
  'query',
  'search',
  'such',
  'the',
]);

type MatchReason = 'anchor' | 'title' | 'source' | 'summary' | 'keyword' | 'content';

export interface GraphQueryCandidate {
  anchor: string;
  title: string;
  kind: string;
  collectionId: string;
  source?: string;
  matchReason: MatchReason;
  snippet?: string;
  edgeCount?: number;
  weightedEdgeScore?: number;
  textMatchScore?: number;
}

export type GraphQueryResolution =
  | {
      status: 'graph';
      queryKind: 'exact';
      query: string;
      resolvedAnchor: string;
      graph: GraphResult;
      note?: 'no_edges';
    }
  | {
      status: 'candidates';
      queryKind: 'search';
      query: string;
      candidates: GraphQueryCandidate[];
    }
  | {
      status: 'no_match';
      queryKind: 'search';
      query: string;
      message: string;
      examples: string[];
    };

interface CatalogLike {
  list(): Array<{ id: string; sensitivity: CollectionSensitivity; kind: string }>;
  get(id: string): { id: string; sensitivity: CollectionSensitivity; kind: string } | undefined;
}

interface ResolveOptions {
  depth?: number;
  callerCollections?: string[];
  /** 砚砚 cloud-9 P1: relation-type filter applied AT TRAVERSAL TIME. */
  relations?: readonly string[];
}

type QueryStore = IEvidenceStore & Partial<GraphStore>;
type RelatedEdge = Awaited<ReturnType<GraphStore['getRelated']>>[number];

interface ExactMatch {
  collectionId: string;
  item: EvidenceItem;
  store: QueryStore;
}

function isGraphStore(store: QueryStore): store is QueryStore & GraphStore {
  return typeof store.getRelated === 'function';
}

function isRestrictedSensitivity(sensitivity: CollectionSensitivity): boolean {
  return sensitivity === 'private' || sensitivity === 'restricted';
}

function canShowCandidate(
  manifest: { sensitivity: CollectionSensitivity } | undefined,
  collectionId: string,
  callerCollections: Set<string>,
): boolean {
  if (!manifest || !isRestrictedSensitivity(manifest.sensitivity)) return true;
  return callerCollections.has(collectionId);
}

function canShowCollection(catalog: CatalogLike, collectionId: string | null, callerCollections: Set<string>): boolean {
  if (!collectionId) return true;
  return canShowCandidate(catalog.get(collectionId), collectionId, callerCollections);
}

function canCountRelationEdge(catalog: CatalogLike, rel: RelatedEdge, callerCollections: Set<string>): boolean {
  if (!canShowCollection(catalog, rel.fromCollectionId, callerCollections)) return false;
  if (!canShowCollection(catalog, rel.toCollectionId, callerCollections)) return false;
  const edgeSensitivity = rel.edgeSensitivity as CollectionSensitivity | null;
  if (!edgeSensitivity || !isRestrictedSensitivity(edgeSensitivity)) return true;
  if (!rel.fromCollectionId || !rel.toCollectionId) return false;
  return callerCollections.has(rel.fromCollectionId) && callerCollections.has(rel.toCollectionId);
}

function includesIgnoreCase(value: string | undefined, query: string): boolean {
  return value?.toLowerCase().includes(query) ?? false;
}

function queryTokens(query: string): string[] {
  const tokens = new Set<string>();
  for (const token of query.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (token.length < 3 || /^\d+$/.test(token) || SEARCH_STOPWORDS.has(token)) continue;
    tokens.add(token);
  }
  for (const run of query.match(/\p{Script=Han}+/gu) ?? []) {
    if (run.length < 2) continue;
    tokens.add(run);
    for (let index = 0; index < run.length - 1; index += 1) tokens.add(run.slice(index, index + 2));
    for (let index = 0; index < run.length - 2; index += 1) tokens.add(run.slice(index, index + 3));
  }
  return [...tokens];
}

function candidateSearchText(item: EvidenceItem): string {
  return [
    item.anchor,
    item.title,
    item.sourcePath,
    item.summary,
    ...(item.keywords ?? []),
    ...(item.passages ?? []).flatMap((passage) => [
      passage.content,
      ...(passage.context ?? []).map((contextPassage) => contextPassage.content),
    ]),
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n')
    .toLowerCase();
}

function hasExplainableFieldMatch(item: EvidenceItem, query: string): boolean {
  const q = query.toLowerCase();
  if (
    includesIgnoreCase(item.anchor, q) ||
    includesIgnoreCase(item.title, q) ||
    includesIgnoreCase(item.sourcePath, q) ||
    includesIgnoreCase(item.summary, q) ||
    item.passages?.some(
      (passage) =>
        includesIgnoreCase(passage.content, q) ||
        passage.context?.some((contextPassage) => includesIgnoreCase(contextPassage.content, q)),
    ) ||
    item.keywords?.some((keyword) => includesIgnoreCase(keyword, q))
  )
    return true;
  const searchText = candidateSearchText(item);
  return queryTokens(query).some((token) => searchText.includes(token));
}

const TEXT_MATCH_SCORES: Record<MatchReason, number> = {
  anchor: 10,
  title: 6,
  source: 3,
  summary: 3,
  keyword: 3,
  content: 1,
};

function truncateSnippet(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= 160) return text;
  return `${text.slice(0, 157)}...`;
}

function classifyMatch(item: EvidenceItem, query: string): { matchReason: MatchReason; snippet?: string } {
  const q = query.toLowerCase();
  if (includesIgnoreCase(item.anchor, q)) return { matchReason: 'anchor', snippet: item.anchor };
  if (item.anchor) {
    const anchorLower = item.anchor.toLowerCase();
    const queryWords = q.match(/[a-z0-9]+/g) ?? [];
    if (queryWords.some((w) => w === anchorLower)) return { matchReason: 'anchor', snippet: item.anchor };
  }
  if (includesIgnoreCase(item.title, q)) return { matchReason: 'title', snippet: item.title };
  if (includesIgnoreCase(item.sourcePath, q)) return { matchReason: 'source', snippet: item.sourcePath };
  if (includesIgnoreCase(item.summary, q)) return { matchReason: 'summary', snippet: truncateSnippet(item.summary) };
  const keyword = item.keywords?.find((k) => includesIgnoreCase(k, q));
  if (keyword) return { matchReason: 'keyword', snippet: keyword };
  return { matchReason: 'content', snippet: truncateSnippet(item.summary) ?? item.title };
}

export class GraphQueryResolver {
  constructor(
    private readonly catalog: CatalogLike,
    private readonly stores: Map<string, QueryStore>,
  ) {}

  async resolve(query: string, opts?: ResolveOptions): Promise<GraphQueryResolution> {
    const normalizedQuery = query.trim();
    const depth = opts?.depth ?? 1;
    const callerCollections = new Set(opts?.callerCollections ?? []);
    const relations = opts?.relations;

    const exactMatches = await this.findExactMatches(normalizedQuery);
    const visibleExactMatches = exactMatches.filter((match) =>
      canShowCandidate(this.catalog.get(match.collectionId), match.collectionId, callerCollections),
    );
    if (visibleExactMatches.length === 1) {
      return this.buildGraphResolution(
        normalizedQuery,
        visibleExactMatches[0].item.anchor,
        depth,
        callerCollections,
        visibleExactMatches[0].collectionId,
        relations,
      );
    }
    if (visibleExactMatches.length > 1) {
      const candidates = await this.buildCandidatesFromExactMatches(
        normalizedQuery,
        visibleExactMatches,
        callerCollections,
      );
      if (candidates.length > 0)
        return { status: 'candidates', queryKind: 'search', query: normalizedQuery, candidates };
      return this.noMatch(normalizedQuery);
    }
    if (exactMatches.length > 0) return this.noMatch(normalizedQuery);

    const candidates = await this.searchCandidates(normalizedQuery, callerCollections);
    if (candidates.length > 0) return { status: 'candidates', queryKind: 'search', query: normalizedQuery, candidates };

    return this.noMatch(normalizedQuery);
  }

  private async findExactMatches(query: string): Promise<ExactMatch[]> {
    const matches: ExactMatch[] = [];
    for (const [collectionId, store] of this.stores) {
      const item = await store.getByAnchor(query);
      if (item) matches.push({ collectionId, item, store });
    }
    return matches;
  }

  private async buildGraphResolution(
    query: string,
    resolvedAnchor: string,
    depth: number,
    callerCollections: Set<string>,
    centerCollectionId?: string,
    relations?: readonly string[],
  ): Promise<GraphQueryResolution> {
    const graphResolver = new GraphResolver(this.catalog, this.graphStores());
    const graph = await graphResolver.buildSubgraph(resolvedAnchor, {
      depth,
      callerCollections: [...callerCollections],
      ...(centerCollectionId ? { centerCollectionId } : {}),
      ...(relations && relations.length > 0 ? { relations } : {}),
    });
    return {
      status: 'graph',
      queryKind: 'exact',
      query,
      resolvedAnchor: graph.center ?? resolvedAnchor,
      graph,
      ...(graph.nodes.length === 1 && graph.edges.length === 0 ? { note: 'no_edges' as const } : {}),
    };
  }

  private graphStores(): Map<string, GraphStore> {
    const graphStores = new Map<string, GraphStore>();
    for (const [collectionId, store] of this.stores) {
      if (isGraphStore(store)) graphStores.set(collectionId, store);
    }
    return graphStores;
  }

  private async buildCandidatesFromExactMatches(
    query: string,
    matches: ExactMatch[],
    callerCollections: Set<string>,
  ): Promise<GraphQueryCandidate[]> {
    const candidates: GraphQueryCandidate[] = [];
    for (const match of matches) {
      const manifest = this.catalog.get(match.collectionId);
      if (!canShowCandidate(manifest, match.collectionId, callerCollections)) continue;
      candidates.push(await this.toCandidate(query, match.collectionId, match.item, match.store, callerCollections));
      if (candidates.length >= CANDIDATE_LIMIT) break;
    }
    return candidates;
  }

  private async searchCandidates(query: string, callerCollections: Set<string>): Promise<GraphQueryCandidate[]> {
    const pool: GraphQueryCandidate[] = [];
    const seen = new Set<string>();
    for (const [collectionId, store] of this.stores) {
      const manifest = this.catalog.get(collectionId);
      if (!canShowCandidate(manifest, collectionId, callerCollections)) continue;
      const results = await store.search(query, { mode: 'hybrid', scope: 'all', limit: CANDIDATE_LIMIT * 2 });
      for (const item of results) {
        if (!hasExplainableFieldMatch(item, query)) continue;
        const key = `${collectionId}:${item.anchor}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pool.push(await this.toCandidate(query, collectionId, item, store, callerCollections));
      }
    }
    const primaryCollectionId = this.inferPrimaryCollection(query);
    pool.sort((a, b) => {
      const textDiff = (b.textMatchScore ?? 0) - (a.textMatchScore ?? 0);
      if (textDiff !== 0) return textDiff;
      const aDomainPenalty = a.collectionId === primaryCollectionId ? 0 : 2;
      const bDomainPenalty = b.collectionId === primaryCollectionId ? 0 : 2;
      const scoreDiff = (b.weightedEdgeScore ?? 0) - bDomainPenalty - ((a.weightedEdgeScore ?? 0) - aDomainPenalty);
      if (scoreDiff !== 0) return scoreDiff;
      return aDomainPenalty - bDomainPenalty;
    });
    return pool.slice(0, CANDIDATE_LIMIT);
  }

  private inferPrimaryCollection(query: string): string | undefined {
    for (const [collectionId] of this.stores) {
      const manifest = this.catalog.get(collectionId);
      if (manifest?.kind === 'project') return collectionId;
    }
    return this.stores.keys().next().value;
  }

  private async toCandidate(
    query: string,
    collectionId: string,
    item: EvidenceItem,
    store: QueryStore,
    callerCollections: Set<string>,
  ): Promise<GraphQueryCandidate> {
    const { matchReason, snippet } = classifyMatch(item, query);
    const textMatchScore = TEXT_MATCH_SCORES[matchReason];
    let edgeCount: number | undefined;
    let weightedEdgeScore: number | undefined;
    if (isGraphStore(store)) {
      const rels = (await store.getRelated(item.anchor)).filter((rel) =>
        canCountRelationEdge(this.catalog, rel, callerCollections),
      );
      edgeCount = rels.length;
      if (rels.length > 0) {
        weightedEdgeScore = 0;
        for (const rel of rels) {
          const daysSinceTraversal = rel.lastTraversedAt
            ? (Date.now() - new Date(rel.lastTraversedAt).getTime()) / 86_400_000
            : null;
          weightedEdgeScore += computeEdgeWeight(rel.relation, rel.traversalCount ?? 0, daysSinceTraversal).total;
        }
      }
    }
    return {
      anchor: item.anchor,
      title: item.title,
      kind: item.kind,
      collectionId,
      ...(item.sourcePath ? { source: item.sourcePath } : {}),
      matchReason,
      ...(snippet ? { snippet } : {}),
      textMatchScore,
      ...(edgeCount !== undefined ? { edgeCount } : {}),
      ...(weightedEdgeScore !== undefined ? { weightedEdgeScore } : {}),
    };
  }

  private noMatch(query: string): GraphQueryResolution {
    return {
      status: 'no_match',
      queryKind: 'search',
      query,
      message: 'No knowledge nodes matched this query. Try an anchor, feature id, title keyword, or document path.',
      examples: NO_MATCH_EXAMPLES,
    };
  }
}
