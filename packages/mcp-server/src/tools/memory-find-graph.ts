import { deploymentDefaults, type ReadRef } from '@cat-cafe/shared';
import { invocationFetch, resolveInvocationEnv } from './invocation-auth.js';
import type { FindContext } from './memory-find-context.js';
import {
  type Candidate,
  ERROR_TEXT_CAP,
  type FindGroup,
  type GroupOutcome,
  type GroupPlan,
} from './memory-find-group.js';

/**
 * F332 find unification — the graph group (formerly the graph_resolve tool). The original resolver decides: an
 * exact anchor returns its subgraph (graphDepth 1–3, graphRelations filter, hub truncation); other text returns
 * candidate anchors with their match reason. Visibility stays server-derived (KD-8): no collection parameters.
 */

export const GRAPH_RELATION_TYPES = ['wikilink', 'doc_link', 'feature_ref', 'related_to'] as const;
const SNIPPET_CAP = 160;

interface GraphNode {
  readRef?: ReadRef;
  anchor: string;
  collectionId: string;
  sensitivity: string;
  kind: string;
  title: string;
  redacted: boolean;
}
interface GraphEdge {
  from: string;
  to: string;
  relation: string;
}
type GraphResponse =
  | {
      status: 'graph';
      graph: { nodes: GraphNode[]; edges: GraphEdge[]; center?: string; depth: number; truncated?: boolean };
    }
  | {
      status: 'candidates';
      query: string;
      candidates: Array<{
        readRef?: ReadRef;
        anchor: string;
        title: string;
        kind: string;
        collectionId: string;
        sensitivity: string;
        matchReason: string;
        snippet?: string;
      }>;
    }
  | { status: 'no_match'; queryKind: string; query: string; message: string; examples: string[] };

export interface GraphRun {
  query: string;
  depth?: number;
  relations?: readonly string[];
}

export function planGraph(context: FindContext): GroupPlan<GraphRun> {
  if (context.watcher || !context.query || context.mode === 'browse') return { kind: 'skip' };
  if (context.mode === 'continue' && context.continueGroup !== 'graph') return { kind: 'skip' };
  if (context.scope && !['all', 'docs'].includes(context.scope)) return { kind: 'skip' };
  const notCovered = (reason: string, detail: string) => ({ kind: 'not_covered' as const, reason, detail });
  if (context.dimension)
    return notCovered(
      'collection_scope_unsupported',
      'Graph visibility is server-derived; an explicit dimension cannot be applied.',
    );
  if (context.kinds?.length) return notCovered('kinds_filter_unsupported', 'The graph resolver has no kinds filter.');
  if (context.threadId)
    return notCovered('thread_filter_unsupported', 'Graph nodes cannot be restricted to one thread.');
  if (context.lowerBound || context.dateTo)
    return notCovered('time_filter_unsupported', 'The graph resolver has no time filter.');
  return {
    kind: 'run',
    run: {
      query: context.query,
      ...(context.graphDepth !== undefined ? { depth: context.graphDepth } : {}),
      ...(context.graphRelations?.length ? { relations: context.graphRelations } : {}),
    },
  };
}

async function fetchGraph(run: GraphRun, signal: AbortSignal): Promise<GroupOutcome<GraphResponse>> {
  const params = new URLSearchParams({ query: run.query });
  if (run.depth !== undefined) params.set('depth', String(run.depth));
  // Sent at resolve time so disallowed relations neither expand the frontier nor cost the backend.
  if (run.relations?.length) params.set('relations', run.relations.join(','));
  const base = resolveInvocationEnv('CAT_CAFE_API_URL') ?? deploymentDefaults.apiBaseUrl;
  const response = await invocationFetch(`${base}/api/library/graph/resolve?${params.toString()}`, { signal });
  if (signal.aborted) return { status: 'timeout' };
  if (!response.ok)
    return {
      status: 'failed',
      error: `graph resolve failed (${response.status}): ${(await response.text()).slice(0, ERROR_TEXT_CAP)}`,
    };
  const data = (await response.json()) as GraphResponse;
  if (data.status === 'graph') return { status: 'ok', data };
  if (data.status === 'candidates') return { status: data.candidates.length > 0 ? 'ok' : 'no_results', data };
  return { status: 'no_results', data };
}

/** Edges outside the relations filter and nodes they alone reached are not shown (the resolver also skips them). */
function visibleGraph(data: Extract<GraphResponse, { status: 'graph' }>, relations?: readonly string[]) {
  const filter = relations?.length ? new Set(relations) : null;
  const edges = filter ? data.graph.edges.filter((edge) => filter.has(edge.relation)) : data.graph.edges;
  const anchors = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  if (data.graph.center) anchors.add(data.graph.center);
  return { nodes: data.graph.nodes.filter((node) => anchors.has(node.anchor)), edges };
}

type Projection = 'full' | 'compact' | 'minimal';

function nodeView(node: GraphNode, projection: Projection): Record<string, unknown> {
  const readRef = node.readRef && !node.redacted ? { readRef: node.readRef } : {};
  const sensitive =
    node.sensitivity === 'private' || node.sensitivity === 'restricted' ? { sensitivity: node.sensitivity } : {};
  if (projection === 'minimal') return { anchor: node.anchor, ...readRef };
  if (projection === 'compact') return { anchor: node.anchor, title: node.title, ...sensitive, ...readRef };
  return {
    anchor: node.anchor,
    title: node.title,
    kind: node.kind,
    collectionId: node.collectionId,
    ...sensitive,
    ...readRef,
  };
}

function graphPage(run: GraphRun, data: GraphResponse, status: string, projection: Projection): string {
  const head = { group: 'graph', status, ...(projection !== 'full' ? { projection } : {}) };
  if (data.status === 'graph') {
    const { nodes, edges } = visibleGraph(data, run.relations);
    return JSON.stringify({
      ...head,
      result: 'subgraph',
      center: data.graph.center,
      depth: data.graph.depth,
      ...(run.relations?.length ? { relations: run.relations } : {}),
      ...(data.graph.truncated ? { truncated: 'hub-node degree cap hit; use graphDepth 1 or graphRelations' } : {}),
      nodes: nodes.map((node) => nodeView(node, projection)),
      edges:
        projection === 'minimal'
          ? edges.map((edge) => `${edge.from} -${edge.relation}-> ${edge.to}`)
          : edges.map(({ from, to, relation }) => ({ from, to, relation })),
    });
  }
  if (data.status !== 'candidates') return JSON.stringify(head);
  return JSON.stringify({
    ...head,
    result: 'candidates',
    match: 'resolver candidate anchors with their match reason; pass one anchor as query to see its relations',
    items: data.candidates.map((candidate) => {
      const readRef = candidate.readRef ? { readRef: candidate.readRef } : {};
      if (projection === 'minimal') return { anchor: candidate.anchor, ...readRef };
      const base = { anchor: candidate.anchor, title: candidate.title, match: candidate.matchReason, ...readRef };
      if (projection === 'compact') return base;
      const snippet = candidate.snippet?.replace(/\n/g, ' ');
      return {
        ...base,
        kind: candidate.kind,
        collectionId: candidate.collectionId,
        ...(snippet ? { snippet: snippet.length > SNIPPET_CAP ? `${snippet.slice(0, SNIPPET_CAP)}…` : snippet } : {}),
      };
    }),
  });
}

export function createGraphGroup(context: FindContext): FindGroup<GraphResponse> {
  const plan = planGraph(context);
  const run = plan.kind === 'run' ? plan.run : undefined;
  return {
    name: 'graph',
    plan,
    start: (signal) => (run ? fetchGraph(run, signal) : Promise.resolve({ status: 'timeout' })),
    counts: (data) => ({
      count:
        data.status === 'graph'
          ? visibleGraph(data, run?.relations).nodes.length
          : data.status === 'candidates'
            ? data.candidates.length
            : 0,
      hasNext: false,
    }),
    emptyDetail: (data) =>
      data.status === 'no_match'
        ? { message: data.message, ...(data.examples.length ? { examples: data.examples } : {}) }
        : {},
    continueArguments: () => ({
      ...(run ? { query: run.query } : {}),
      continueGroup: 'graph',
      ...(run?.depth !== undefined ? { graphDepth: run.depth } : {}),
      ...(run?.relations?.length ? { graphRelations: run.relations } : {}),
    }),
    pages: (outcome) =>
      run
        ? (['full', 'compact', 'minimal'] as const).map(
            (projection): Candidate => ({
              status: outcome.status,
              text: graphPage(run, outcome.data, outcome.status, projection),
            }),
          )
        : [],
  };
}
