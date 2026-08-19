import { defineMcpMigrationFactory } from '../tool-governance-migration.js';

/**
 * Graph Resolve Tool — F188 Phase F (AC-F1)
 *
 * MCP wrapper for the existing /api/library/graph/resolve endpoint.
 * Exposes graph drill-down (precise anchor → connected subgraph) and
 * candidate list (fuzzy query → ranked candidates) to cats.
 *
 * KD-8 enforcement: callerCollections NOT in input schema. v1 ships
 * without dimension/collections params; future versions will derive
 * callerCollections server-side from agent identity. Client cannot
 * self-grant private collection visibility.
 */

import { formatRecallMeta } from '@cat-cafe/shared';
import { z } from 'zod';
import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';

const defineTool = defineMcpMigrationFactory('graph-tools.ts', undefined, {
  resourceFamily: 'evidence-navigation',
  authority: 'local-runtime',
});

const API_URL = process.env['CAT_CAFE_API_URL'] ?? 'http://localhost:3004';

const RELATION_TYPES = ['wikilink', 'doc_link', 'feature_ref', 'related_to'] as const;

export const graphResolveInputSchema = {
  query: z
    .string()
    .min(1)
    .describe(
      'Precise anchor (e.g. F186) or fuzzy term (e.g. harness). Exact anchor → graph drill-down; fuzzy → candidate list.',
    ),
  depth: z
    .number()
    .int()
    .min(1)
    .max(3)
    .optional()
    .describe('Graph traversal depth (default 1, max 3 to avoid edge explosion)'),
  relations: z
    .array(z.enum(RELATION_TYPES))
    .optional()
    .describe('Filter edges by relation type subset (wikilink / doc_link / feature_ref / related_to). Omit = all.'),
};

interface GraphNode {
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
  crossCollection?: boolean;
  edgeSensitivity?: string;
  provenance?: string;
}

/**
 * F188 Phase G AC-G1: API returns nested `{ status, graph: { nodes, edges, ... } }`
 * (GraphQueryResolver.ts:257), not flat. MCP wrapper must unwrap `data.graph`
 * before passing to formatGraph — otherwise `data.edges` is undefined and the
 * filter / for-of loop throws. Pre-Phase-G tests used flat mock — false green.
 */
interface GraphSubgraphInner {
  nodes: GraphNode[];
  edges: GraphEdge[];
  center?: string;
  depth: number;
  truncated?: boolean;
}

interface GraphSubgraphResponse {
  status: 'graph';
  queryKind?: 'exact' | 'search';
  query?: string;
  resolvedAnchor?: string;
  graph: GraphSubgraphInner;
  note?: 'no_edges';
}

interface GraphCandidates {
  status: 'candidates';
  query: string;
  candidates: Array<{
    anchor: string;
    title: string;
    kind: string;
    collectionId: string;
    sensitivity: string;
    matchReason: string;
    snippet?: string;
  }>;
}

interface GraphNoMatch {
  status: 'no_match';
  queryKind: 'anchor' | 'search';
  query: string;
  message: string;
  examples: string[];
}

type GraphResolveResponse = GraphSubgraphResponse | GraphCandidates | GraphNoMatch;

export async function handleGraphResolve(input: {
  query: string;
  depth?: number | undefined;
  relations?: readonly string[] | undefined;
}): Promise<ToolResult> {
  const params = new URLSearchParams({ query: input.query });
  if (input.depth != null) params.set('depth', String(input.depth));
  // 砚砚 cloud-9 P1: send relations filter at resolve time so traversal skips
  // disallowed-relation edges. Pre-fix, filter ran only at render — disallowed
  // edges still expanded the frontier and backend cost was unaffected.
  if (input.relations && input.relations.length > 0) {
    params.set('relations', input.relations.join(','));
  }

  const url = `${API_URL}/api/library/graph/resolve?${params.toString()}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text();
      return recallErrorResult(
        `graph_resolve failed (${response.status}): ${text}`,
        'graph_resolve failed before graph data was returned. Check the API error and retry.',
      );
    }
    const data = (await response.json()) as GraphResolveResponse;

    if (data.status === 'graph') {
      // F188 Phase G AC-G1: unwrap nested `data.graph` before formatGraph.
      // GraphQueryResolver.ts:257 returns `{ status, graph: { nodes, edges, center, depth } }`,
      // not flat. Pre-fix `formatGraph(data)` read `data.edges` → undefined → throw.
      return successResult(formatGraph(data.graph, input.relations));
    }
    if (data.status === 'candidates') {
      return successResult(formatCandidates(data));
    }
    return successResult(formatNoMatch(data));
  } catch (err) {
    return recallErrorResult(
      `graph_resolve error: ${err instanceof Error ? err.message : String(err)}`,
      'graph_resolve request failed before graph data was returned. Check API connectivity and retry.',
    );
  }
}

function recallErrorResult(message: string, readNextHint: string): ToolResult {
  return errorResult(
    [
      message,
      formatRecallMeta({
        resultStatus: 'error',
        resultCount: null,
        readNextHint,
      }),
    ].join('\n'),
  );
}

function formatGraph(g: GraphSubgraphInner, relationsFilter?: readonly string[]): string {
  const lines: string[] = [];
  const filterSet = relationsFilter && relationsFilter.length > 0 ? new Set(relationsFilter) : null;
  const visibleEdges = filterSet ? g.edges.filter((e) => filterSet.has(e.relation)) : g.edges;
  const visibleAnchors = new Set<string>();
  for (const e of visibleEdges) {
    visibleAnchors.add(e.from);
    visibleAnchors.add(e.to);
  }
  if (g.center) visibleAnchors.add(g.center);
  const visibleNodes = g.nodes.filter((n) => visibleAnchors.has(n.anchor));

  lines.push(
    `Graph for "${g.center ?? '(no center)'}":  ${visibleNodes.length} nodes, ${visibleEdges.length} edges (depth=${g.depth})`,
  );
  if (g.truncated) {
    lines.push('⚠️ Graph was truncated (hub-node degree cap hit). Some edges/nodes omitted.');
  }
  lines.push('');
  for (const n of visibleNodes) {
    const marker = n.anchor === g.center ? '★' : ' ';
    const sensitivityTag = n.sensitivity === 'private' || n.sensitivity === 'restricted' ? ` [${n.sensitivity}]` : '';
    lines.push(`${marker} ${n.anchor} — ${n.title} (${n.kind})${sensitivityTag}`);
  }
  if (visibleEdges.length > 0) {
    lines.push('');
    lines.push('Edges:');
    for (const e of visibleEdges) {
      lines.push(`  ${e.from} -[${e.relation}]-> ${e.to}`);
    }
  }
  lines.push('');
  lines.push(crossReferenceFooter());
  lines.push(
    formatRecallMeta({
      resultStatus: 'counted',
      resultCount: visibleNodes.length,
      truncated: g.truncated === true,
      previewItems: visibleNodes.slice(0, 3).map((node) => ({
        title: node.title,
        anchor: node.anchor,
        confidence: node.kind,
        snippet: node.anchor === g.center ? 'center node' : `depth=${g.depth}`,
      })),
      readNextHint: g.truncated
        ? 'Graph output was truncated by hub-node cap. Re-run graph_resolve with depth=1 or relation filters.'
        : 'Use exact anchors from this graph for follow-up graph_resolve/read operations.',
    }),
  );
  return lines.join('\n');
}

function formatCandidates(c: GraphCandidates): string {
  const lines: string[] = [];
  lines.push(
    `Candidates for "${c.query}" (${c.candidates.length} matches — pick one then call graph_resolve again with that anchor):`,
  );
  lines.push('');
  c.candidates.forEach((cand, i) => {
    lines.push(`[${i}] ${cand.anchor} — ${cand.title}`);
    lines.push(`     kind=${cand.kind} | source=${cand.collectionId} | match: ${cand.matchReason}`);
    if (cand.snippet) {
      const snip = cand.snippet.length > 160 ? `${cand.snippet.slice(0, 160)}...` : cand.snippet;
      lines.push(`     > ${snip.replace(/\n/g, ' ')}`);
    }
  });
  lines.push('');
  lines.push(crossReferenceFooter());
  lines.push(
    formatRecallMeta({
      resultStatus: c.candidates.length === 0 ? 'no_results' : 'counted',
      resultCount: c.candidates.length,
      previewItems: c.candidates.slice(0, 3).map((cand) => ({
        title: cand.title,
        anchor: cand.anchor,
        confidence: cand.kind,
        snippet: cand.snippet,
      })),
      readNextHint: 'Pick one candidate anchor and call graph_resolve again with that exact anchor.',
    }),
  );
  return lines.join('\n');
}

function formatNoMatch(n: GraphNoMatch): string {
  return [
    `No graph node found for "${n.query}": ${n.message}`,
    n.examples.length > 0 ? `Examples: ${n.examples.join(', ')}` : '',
    '',
    crossReferenceFooter(),
    formatRecallMeta({
      resultStatus: 'no_results',
      resultCount: 0,
      readNextHint: 'No graph node matched. Try search_evidence/list_recent or use one of the example anchors.',
    }),
  ]
    .filter(Boolean)
    .join('\n');
}

function crossReferenceFooter(): string {
  return [
    '— Clowder AI 7-tool memory family —',
    '  search_evidence: semantic / fuzzy find (lexical/semantic/hybrid)',
    '  graph_resolve: precise anchor / relations (this tool)',
    '  list_recent: zero-prior / scan recent',
    '  list_session_chain / read_session_digest / read_session_events / read_invocation_detail: drill into history',
  ].join('\n');
}

export const graphTools = [
  defineTool({
    name: 'cat_cafe_graph_resolve',
    description: [
      'Drill into the knowledge graph by anchor or fuzzy query.',
      'Use when: you have a precise anchor (F186) and want neighbors/edges, OR a fuzzy term and need candidate anchors.',
      'Not for: pure semantic search → use search_evidence. Scanning recent activity → use list_recent.',
      'Depth tip: depth>=2 without a relations filter can trigger hub fan-out around super-hubs (F102/F188). Prefer depth=1 first, or pass relations to narrow traversal.',
      '',
      'RANKING (F200 live): Edge weights incorporate consumption frequency — paths cats traverse more often rank higher in candidate ordering. Constitutional edges are immune to demotion.',
      '',
      'v1 limitation (KD-8): does NOT accept collection scoping params. Visibility is server-derived from agent identity. Future versions may add dimension/collections after server-side identity wiring lands.',
    ].join('\n'),
    inputSchema: graphResolveInputSchema,
    handler: handleGraphResolve,
    governance: {
      implementationExport: 'handleGraphResolve',
      action: 'read',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: ['full', 'readonly', 'desktop:fable-phase0', 'desktop:cloud-pro-phase0'],
    },
  }),
] as const;
