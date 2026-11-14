import type { CollectionSensitivity } from './collection-types.js';
import { GraphResolver, type GraphResult, type GraphStore } from './GraphResolver.js';
import { computeEdgeWeight } from './graph-edge-weight.js';
import type { EvidenceItem, IEvidenceStore } from './interfaces.js';
import { KnowledgeResolver } from './KnowledgeResolver.js';
import { documentDiscoverySource } from './knowledge-document-source.js';
import { classifyIndexedMatch, TEXT_MATCH_SCORES } from './knowledge-match-evidence.js';
import { isGenericRecallEligible, isGenericRecallEligibleAnchor } from './recall-delivery-eligibility.js';

const CANDIDATE_LIMIT = 8;
const NO_MATCH_EXAMPLES = ['F186', 'f186', 'harness', 'doc:plans/example.md'];
type MatchReason = ReturnType<typeof classifyIndexedMatch>['matchReason'];

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
      resolvedCollectionId?: string;
      resolvedSource?: string;
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

export interface GraphQueryResolverCatalog {
  list(): Array<{ id: string; sensitivity: CollectionSensitivity; kind: string; status?: string }>;
  get(id: string): { id: string; sensitivity: CollectionSensitivity; kind: string; status?: string } | undefined;
}

export interface GraphQueryResolveOptions {
  depth?: number;
  callerCollections?: string[];
  /** 砚砚 cloud-9 P1: relation-type filter applied AT TRAVERSAL TIME. */
  relations?: readonly string[];
}

export type GraphQueryResolverStore = IEvidenceStore & Partial<GraphStore>;
type CatalogLike = GraphQueryResolverCatalog;
type ResolveOptions = GraphQueryResolveOptions;
type QueryStore = GraphQueryResolverStore;
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
  manifest: { sensitivity: CollectionSensitivity; status?: string } | undefined,
  collectionId: string,
  callerCollections: Set<string>,
): boolean {
  if (!manifest) return true;
  if (manifest.status === 'archived') return false;
  if (!isRestrictedSensitivity(manifest.sensitivity)) return true;
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
        visibleExactMatches[0].item.sourcePath,
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
      if (item && isGenericRecallEligible(item)) matches.push({ collectionId, item, store });
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
    resolvedSource?: string,
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
      ...(centerCollectionId ? { resolvedCollectionId: centerCollectionId } : {}),
      ...(resolvedSource ? { resolvedSource } : {}),
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
    const discovery = await KnowledgeResolver.discover(query, {
      limit: CANDIDATE_LIMIT * 2,
      sources: [...this.stores]
        .filter(([collectionId]) => canShowCandidate(this.catalog.get(collectionId), collectionId, callerCollections))
        .map(([collectionId, store]) => {
          const source = documentDiscoverySource({
            id: collectionId,
            store,
            options: { mode: 'hybrid', scope: 'all' },
            generic: true,
            requireMatchEvidence: query,
          });
          return {
            id: source.id,
            read: source.read,
            eligible: source.eligible,
            project: (item: EvidenceItem) => this.toCandidate(query, collectionId, item, store, callerCollections),
            key: (item: GraphQueryCandidate) => `${item.collectionId}:${item.anchor}`,
          };
        }),
    });
    const pool = discovery.sources.flatMap((source) => source.items);
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
    const { matchReason, snippet } = classifyIndexedMatch(item, query);
    const textMatchScore = TEXT_MATCH_SCORES[matchReason];
    let edgeCount: number | undefined;
    let weightedEdgeScore: number | undefined;
    if (isGraphStore(store)) {
      const rels = (await store.getRelated(item.anchor)).filter(
        (rel) =>
          isGenericRecallEligibleAnchor(rel.anchor) && canCountRelationEdge(this.catalog, rel, callerCollections),
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
