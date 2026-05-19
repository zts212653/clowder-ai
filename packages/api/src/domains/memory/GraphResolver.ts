import type { CollectionSensitivity } from './collection-types.js';
import { COLLECTION_SENSITIVITY_ORDER } from './collection-types.js';
import { computeEdgeWeight } from './graph-edge-weight.js';
import type { EvidenceItem } from './interfaces.js';

export interface GraphStore {
  getByAnchor(anchor: string): Promise<EvidenceItem | null>;
  getRelated(anchor: string): Promise<
    Array<{
      anchor: string;
      relation: string;
      fromCollectionId: string | null;
      toCollectionId: string | null;
      edgeSensitivity: string | null;
      provenance: string | null;
      traversalCount: number;
      lastTraversedAt: string | null;
    }>
  >;
}

export interface GraphNode {
  anchor: string;
  collectionId: string;
  sensitivity: CollectionSensitivity;
  kind: string;
  title: string;
  redacted: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  relation: string;
  crossCollection: boolean;
  edgeSensitivity: CollectionSensitivity;
  provenance: string;
  redacted: boolean;
  weight?: number;
}

export interface GraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  center?: string;
  depth: number;
  truncated?: boolean;
  deprecationWarnings?: string[];
}

const MAX_EDGES_PER_NODE = 15;
const MAX_TOTAL_NODES = 50;

interface CatalogLike {
  list(): Array<{ id: string; sensitivity: CollectionSensitivity; kind: string; status?: string }>;
  get(id: string): { id: string; sensitivity: CollectionSensitivity; kind: string; status?: string } | undefined;
}

interface BuildSubgraphOptions {
  depth?: number;
  callerCollections?: string[];
  centerCollectionId?: string;
  /**
   * 砚砚 cloud-9 P1: filter edges by relation type AT TRAVERSAL TIME, not just at
   * render time. Without this, disallowed-relation edges still expanded the
   * frontier — caller-visible nodes could be reached via filtered-out edges and
   * the backend traversal cost was unaffected by the filter.
   */
  relations?: readonly string[];
}

function inferCollectionIdSync(anchor: string, catalog: CatalogLike): string | undefined {
  const manifests = catalog.list();
  for (const m of manifests) {
    if (m.status === 'archived') continue;
    if (anchor.startsWith(`${m.id}:`)) return m.id;
  }
  return undefined;
}

async function inferCollectionId(
  anchor: string,
  catalog: CatalogLike,
  stores: Map<string, GraphStore>,
): Promise<string | undefined> {
  const fast = inferCollectionIdSync(anchor, catalog);
  if (fast) return fast;
  for (const [collectionId, s] of stores) {
    const doc = await s.getByAnchor(anchor);
    if (doc) return collectionId;
  }
  return undefined;
}

function stricterSensitivity(a: CollectionSensitivity, b: CollectionSensitivity): CollectionSensitivity {
  const orderA = COLLECTION_SENSITIVITY_ORDER[a] ?? 3;
  const orderB = COLLECTION_SENSITIVITY_ORDER[b] ?? 3;
  return orderA <= orderB ? a : b;
}

function relationTouchesCollection(
  collectionId: string | undefined,
  rel: { fromCollectionId: string | null; toCollectionId: string | null },
): boolean {
  if (!collectionId) return true;
  if (!rel.fromCollectionId || !rel.toCollectionId) return true;
  return rel.fromCollectionId === collectionId || rel.toCollectionId === collectionId;
}

export class GraphResolver {
  constructor(
    private catalog: CatalogLike,
    private stores: Map<string, GraphStore>,
  ) {}

  async buildSubgraph(anchor: string, opts?: BuildSubgraphOptions): Promise<GraphResult> {
    const depth = opts?.depth ?? 1;
    const callerCollections = new Set(opts?.callerCollections ?? []);
    const relationFilter = opts?.relations && opts.relations.length > 0 ? new Set<string>(opts.relations) : null;
    const nodesMap = new Map<string, GraphNode>();
    const edgesArr: GraphEdge[] = [];
    const edgeKeySet = new Set<string>();
    const visited = new Set<string>();
    const redactedAnchorMap = new Map<string, string>();
    const unresolvedRedactionMap = new Map<string, { sensitivity: CollectionSensitivity; redacted: boolean }>();
    const lookupAliasesByCanonicalAnchor = new Map<string, Set<string>>();
    let redactedCounter = 0;
    let frontier = [anchor];
    let resolvedCenterAnchor = anchor;
    let truncated = false;
    const nodeEdgeCount = new Map<string, number>();

    const opaqueAnchor = (realAnchor: string): string => {
      if (redactedAnchorMap.has(realAnchor)) return redactedAnchorMap.get(realAnchor)!;
      const opaque = `[redacted:${++redactedCounter}]`;
      redactedAnchorMap.set(realAnchor, opaque);
      return opaque;
    };

    const rememberLookupAlias = (canonicalAnchor: string, lookupAnchor: string): void => {
      if (canonicalAnchor === lookupAnchor) return;
      const aliases = lookupAliasesByCanonicalAnchor.get(canonicalAnchor) ?? new Set<string>();
      aliases.add(lookupAnchor);
      lookupAliasesByCanonicalAnchor.set(canonicalAnchor, aliases);
    };

    const lookupAnchorsFor = (canonicalAnchor: string): string[] => {
      const anchors = new Set([canonicalAnchor]);
      for (const alias of lookupAliasesByCanonicalAnchor.get(canonicalAnchor) ?? []) {
        anchors.add(alias);
      }
      return [...anchors];
    };

    const canUseLookupAnchorInStore = async (
      store: GraphStore,
      lookupAnchor: string,
      canonicalAnchor: string,
    ): Promise<boolean> => {
      if (lookupAnchor === canonicalAnchor) return true;
      const lookupDoc = await store.getByAnchor(lookupAnchor);
      return lookupDoc?.anchor === canonicalAnchor;
    };

    for (let d = 0; d <= depth && frontier.length > 0; d++) {
      const nextFrontier: string[] = [];

      for (const currentAnchor of frontier) {
        if (visited.has(currentAnchor)) continue;
        visited.add(currentAnchor);

        const preferredCollectionId = d === 0 && currentAnchor === anchor ? opts?.centerCollectionId : undefined;
        const preferredStore = preferredCollectionId ? this.stores.get(preferredCollectionId) : undefined;
        const preferredDoc = preferredStore ? await preferredStore.getByAnchor(currentAnchor) : null;
        const collectionId =
          preferredCollectionId && preferredDoc
            ? preferredCollectionId
            : await inferCollectionId(currentAnchor, this.catalog, this.stores);
        if (!collectionId) {
          if (d > 0 && !nodesMap.has(currentAnchor)) {
            const unresolvedRedaction = unresolvedRedactionMap.get(currentAnchor);
            const shouldRedact = unresolvedRedaction?.redacted ?? false;
            const sensitivity = unresolvedRedaction?.sensitivity ?? 'internal';
            nodesMap.set(currentAnchor, {
              anchor: shouldRedact ? opaqueAnchor(currentAnchor) : currentAnchor,
              collectionId: '',
              sensitivity,
              kind: 'unresolved',
              title: shouldRedact ? `[redacted — ${sensitivity} unresolved]` : currentAnchor,
              redacted: shouldRedact,
            });
          }
          continue;
        }
        const manifest = this.catalog.get(collectionId);
        if (manifest?.status === 'archived') continue;
        const sensitivity: CollectionSensitivity = manifest?.sensitivity ?? 'internal';
        const isRedacted =
          (sensitivity === 'private' || sensitivity === 'restricted') && !callerCollections.has(collectionId);
        const store = collectionId ? this.stores.get(collectionId) : undefined;
        const doc = preferredDoc ?? (store ? await store.getByAnchor(currentAnchor) : null);
        const canonicalAnchor = doc?.anchor ?? currentAnchor;
        rememberLookupAlias(canonicalAnchor, currentAnchor);

        if (d === 0 && currentAnchor === anchor) {
          resolvedCenterAnchor = canonicalAnchor;
        }
        if (canonicalAnchor !== currentAnchor) {
          if (visited.has(canonicalAnchor)) continue;
          visited.add(canonicalAnchor);
        }

        const nodeAnchor = isRedacted ? opaqueAnchor(canonicalAnchor) : canonicalAnchor;

        if (!nodesMap.has(canonicalAnchor)) {
          let kind = manifest?.kind ?? 'unknown';
          let title = canonicalAnchor;

          if (doc) {
            kind = doc.kind;
            title = doc.title;
          }

          nodesMap.set(canonicalAnchor, {
            anchor: nodeAnchor,
            collectionId: isRedacted ? '' : collectionId,
            sensitivity,
            kind: isRedacted ? 'redacted' : kind,
            title: isRedacted ? `[redacted — ${sensitivity} collection]` : title,
            redacted: isRedacted,
          });
        }

        if (d >= depth) continue;

        let nodeCapped = false;
        for (const [, s] of this.stores) {
          if (nodeCapped) break;
          for (const lookupAnchor of lookupAnchorsFor(canonicalAnchor)) {
            if (nodeCapped) break;
            if (!(await canUseLookupAnchorInStore(s, lookupAnchor, canonicalAnchor))) continue;
            const related = await s.getRelated(lookupAnchor);
            for (const rel of related) {
              if (!relationTouchesCollection(collectionId, rel)) continue;
              if (relationFilter && !relationFilter.has(rel.relation)) continue;
              const currentNodeEdges = nodeEdgeCount.get(canonicalAnchor) ?? 0;
              if (currentNodeEdges >= MAX_EDGES_PER_NODE || nodesMap.size >= MAX_TOTAL_NODES) {
                truncated = true;
                nodeCapped = true;
                break;
              }
              const relCollectionId = await inferCollectionId(rel.anchor, this.catalog, this.stores);
              const relStore = relCollectionId ? this.stores.get(relCollectionId) : undefined;
              const relDoc = relStore ? await relStore.getByAnchor(rel.anchor) : null;
              const relCanonicalAnchor = relDoc?.anchor ?? rel.anchor;
              rememberLookupAlias(relCanonicalAnchor, rel.anchor);
              const isCross = collectionId !== relCollectionId;
              const relManifest = relCollectionId ? this.catalog.get(relCollectionId) : undefined;
              if (relManifest?.status === 'archived') continue;
              const relSensitivity: CollectionSensitivity = relManifest?.sensitivity ?? 'internal';

              const edgeSensitivity =
                (rel.edgeSensitivity as CollectionSensitivity) ?? stricterSensitivity(sensitivity, relSensitivity);
              const relIsRedacted =
                (relSensitivity === 'private' || relSensitivity === 'restricted') &&
                !callerCollections.has(relCollectionId ?? '');
              const edgeRedacted =
                (edgeSensitivity === 'private' || edgeSensitivity === 'restricted') &&
                (!callerCollections.has(collectionId ?? '') || !callerCollections.has(relCollectionId ?? ''));
              const unresolvedRelRedacted = !relCollectionId && edgeRedacted;
              if (unresolvedRelRedacted) {
                unresolvedRedactionMap.set(relCanonicalAnchor, { sensitivity: edgeSensitivity, redacted: true });
              }
              const unresolvedRelRedaction = unresolvedRedactionMap.get(relCanonicalAnchor);
              const relOutputRedacted =
                relIsRedacted || unresolvedRelRedacted || (unresolvedRelRedaction?.redacted ?? false);

              const edgeKey = `${canonicalAnchor}→${relCanonicalAnchor}:${rel.relation}`;
              const reverseKey = `${relCanonicalAnchor}→${canonicalAnchor}:${rel.relation}`;
              if (!edgeKeySet.has(edgeKey) && !edgeKeySet.has(reverseKey)) {
                edgeKeySet.add(edgeKey);
                nodeEdgeCount.set(canonicalAnchor, (nodeEdgeCount.get(canonicalAnchor) ?? 0) + 1);
                const daysSinceTraversal = rel.lastTraversedAt
                  ? (Date.now() - new Date(rel.lastTraversedAt).getTime()) / 86_400_000
                  : null;
                const ew = computeEdgeWeight(rel.relation, rel.traversalCount ?? 0, daysSinceTraversal);
                edgesArr.push({
                  from: isRedacted ? opaqueAnchor(canonicalAnchor) : canonicalAnchor,
                  to: relOutputRedacted ? opaqueAnchor(relCanonicalAnchor) : relCanonicalAnchor,
                  relation: rel.relation,
                  crossCollection: isCross,
                  edgeSensitivity,
                  provenance: rel.provenance ?? 'manual',
                  redacted: edgeRedacted || (unresolvedRelRedaction?.redacted ?? false),
                  weight: ew.total,
                });
              }

              if (!visited.has(relCanonicalAnchor)) {
                nextFrontier.push(relCanonicalAnchor);
              }
            }
          }
        }
      }

      frontier = nextFrontier;
    }

    const finalNodes = Array.from(nodesMap.entries()).map(([realAnchor, node]) => {
      const unresolvedRedaction = unresolvedRedactionMap.get(realAnchor);
      if (!unresolvedRedaction?.redacted) return node;
      return {
        ...node,
        anchor: opaqueAnchor(realAnchor),
        sensitivity: unresolvedRedaction.sensitivity,
        title: `[redacted — ${unresolvedRedaction.sensitivity} unresolved]`,
        redacted: true,
      };
    });
    const centerRedaction = unresolvedRedactionMap.get(resolvedCenterAnchor);
    const center = nodesMap.has(resolvedCenterAnchor)
      ? centerRedaction?.redacted
        ? opaqueAnchor(resolvedCenterAnchor)
        : nodesMap.get(resolvedCenterAnchor)?.anchor
      : undefined;

    const finalEdges = edgesArr.map((edge) => {
      const fromUnresolvedRedacted = unresolvedRedactionMap.get(edge.from)?.redacted ?? false;
      const toUnresolvedRedacted = unresolvedRedactionMap.get(edge.to)?.redacted ?? false;
      if (!fromUnresolvedRedacted && !toUnresolvedRedacted) return edge;
      return {
        ...edge,
        from: fromUnresolvedRedacted ? opaqueAnchor(edge.from) : edge.from,
        to: toUnresolvedRedacted ? opaqueAnchor(edge.to) : edge.to,
        redacted: true,
      };
    });

    return {
      nodes: finalNodes,
      edges: finalEdges,
      center,
      depth,
      truncated: truncated || undefined,
    };
  }
}
