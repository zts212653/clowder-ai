'use client';

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { edgePath, type GraphNode, type GraphResult, relationColor } from './CollectionGraphModel';
import { GraphInspector, GraphNodeGlyph, GraphTooltip } from './CollectionGraphParts';
import {
  GraphCandidates,
  GraphNoEdgesNote,
  GraphNoMatch,
  type GraphQueryCandidate,
  GraphSearchForm,
} from './CollectionGraphQueryStates';
import { forceLayout, readableHubLayoutHeight, usesReadableHubLayout } from './graph-layout';

const W = 940;
const H = 620;

type GraphQueryResolution =
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

function GraphCanvas({
  center,
  graph,
  hovered,
  onHover,
  onNodeClick,
  positions,
  showEdgeLabels,
  visibleEdges,
  viewHeight,
}: {
  center: string | undefined;
  graph: GraphResult;
  hovered: GraphNode | null;
  onHover: (node: GraphNode | null) => void;
  onNodeClick: (anchor: string, collectionId?: string) => void;
  positions: Map<string, { x: number; y: number }>;
  showEdgeLabels: boolean;
  visibleEdges: GraphResult['edges'];
  viewHeight: number;
}) {
  const renderedHeight = Math.round((viewHeight / H) * 560);
  return (
    <div className="relative min-w-0 overflow-auto rounded-md border border-[#e5dacd] bg-white">
      <svg
        viewBox={`0 0 ${W} ${viewHeight}`}
        className="w-full"
        style={{ height: `${renderedHeight}px` }}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Knowledge graph"
        data-testid="graph-svg"
      >
        <defs>
          <filter id="node-shadow">
            <feDropShadow dx="0" dy="1" stdDeviation="2" floodOpacity="0.15" />
          </filter>
        </defs>

        {visibleEdges.map((edge) => {
          const fp = positions.get(edge.from);
          const tp = positions.get(edge.to);
          if (!fp || !tp) return null;
          const color = relationColor(edge.relation);
          return (
            <React.Fragment key={`${edge.from}-${edge.to}-${edge.relation}`}>
              <path
                d={edgePath(fp.x, fp.y, tp.x, tp.y)}
                fill="none"
                stroke={color}
                strokeWidth={edge.crossCollection ? 2.5 : 1.5}
                strokeDasharray={edge.redacted ? '6 3' : undefined}
                opacity={0.5}
              />
              {showEdgeLabels && <SparseEdgeLabel edge={edge} from={fp} to={tp} />}
            </React.Fragment>
          );
        })}

        {graph.nodes.map((node) => {
          const pos = positions.get(node.anchor);
          if (!pos) return null;
          return (
            <GraphNodeGlyph
              centerAnchor={center}
              key={node.anchor}
              node={node}
              onHover={onHover}
              onNodeClick={onNodeClick}
              pos={pos}
            />
          );
        })}
      </svg>
      {hovered && <GraphTooltip node={hovered} />}
    </div>
  );
}

function SparseEdgeLabel({
  edge,
  from,
  to,
}: {
  edge: GraphResult['edges'][number];
  from: { x: number; y: number };
  to: { x: number; y: number };
}) {
  const labelX = (from.x + to.x) / 2;
  const labelY = (from.y + to.y) / 2;
  const color = relationColor(edge.relation);
  return (
    <text
      x={labelX}
      y={labelY - 6}
      textAnchor="middle"
      fontSize={10}
      fill={color}
      fontWeight="700"
      data-testid={`graph-edge-label-${edge.from}-${edge.to}-${edge.relation}`}
    >
      {edge.relation.replace(/_/g, ' ')}
    </text>
  );
}

export function CollectionGraph() {
  const [graph, setGraph] = useState<GraphResult | null>(null);
  const [graphNote, setGraphNote] = useState<'no_edges' | null>(null);
  const [candidates, setCandidates] = useState<GraphQueryCandidate[]>([]);
  const [noMatch, setNoMatch] = useState<{ message: string; examples: string[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<GraphNode | null>(null);
  const [selectedAnchor, setSelectedAnchor] = useState<string | null>(null);
  const [hiddenRelations, setHiddenRelations] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  const clearResolutionStates = useCallback(() => {
    setCandidates([]);
    setNoMatch(null);
    setGraphNote(null);
  }, []);

  const fetchGraph = useCallback((a: string, collectionId?: string) => {
    if (!a.trim()) return;
    setLoading(true);
    setError(null);
    setHovered(null);
    setCandidates([]);
    setNoMatch(null);
    setGraphNote(null);
    fetch(
      `/api/library/graph?anchor=${encodeURIComponent(a)}&depth=1${
        collectionId ? `&collection=${encodeURIComponent(collectionId)}` : ''
      }`,
    )
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((data: GraphResult) => {
        setGraph(data);
        setSelectedAnchor(data.center ?? data.nodes[0]?.anchor ?? null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const resolveQuery = useCallback(
    (query: string) => {
      const trimmed = query.trim();
      if (!trimmed) return;
      setLoading(true);
      setError(null);
      setHovered(null);
      clearResolutionStates();
      fetch(`/api/library/graph/resolve?query=${encodeURIComponent(trimmed)}&depth=1`)
        .then((r) => {
          if (!r.ok) throw new Error(`${r.status}`);
          return r.json();
        })
        .then((data: GraphQueryResolution) => {
          if (data.status === 'graph') {
            setGraph(data.graph);
            setGraphNote(data.note ?? null);
            setSelectedAnchor(data.graph.center ?? data.resolvedAnchor ?? data.graph.nodes[0]?.anchor ?? null);
            return;
          }
          setGraph(null);
          setSelectedAnchor(null);
          if (data.status === 'candidates') {
            setCandidates(data.candidates);
            return;
          }
          setNoMatch({ message: data.message, examples: data.examples });
        })
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false));
    },
    [clearResolutionStates],
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      resolveQuery(inputRef.current?.value ?? '');
    },
    [resolveQuery],
  );

  const handleNodeClick = useCallback(
    (anchor: string, collectionId?: string) => {
      setSelectedAnchor(anchor);
      if (inputRef.current) inputRef.current.value = anchor;
      fetchGraph(anchor, collectionId);
    },
    [fetchGraph],
  );

  const toggleRelation = useCallback((rel: string) => {
    setHiddenRelations((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });
  }, []);

  const visibleEdges = useMemo(
    () => (graph?.edges ?? []).filter((edge) => !hiddenRelations.has(edge.relation)),
    [graph?.edges, hiddenRelations],
  );
  const uniqueRelations = useMemo(
    () => [...new Set((graph?.edges ?? []).map((edge) => edge.relation))],
    [graph?.edges],
  );
  const uniqueKinds = useMemo(() => [...new Set((graph?.nodes ?? []).map((node) => node.kind))], [graph?.nodes]);
  const positions = graph ? forceLayout(graph.nodes, visibleEdges, graph.center, W, H) : new Map();
  const selectedNode = useSelectedNode(graph, selectedAnchor);
  const selectedEdges = useMemo(() => {
    if (!graph || !selectedNode) return [];
    return visibleEdges.filter((edge) => edge.from === selectedNode.anchor || edge.to === selectedNode.anchor);
  }, [graph, selectedNode, visibleEdges]);
  const nodeByAnchor = useMemo(() => new Map((graph?.nodes ?? []).map((node) => [node.anchor, node])), [graph?.nodes]);
  const viewHeight =
    graph && usesReadableHubLayout(graph.nodes, visibleEdges, graph.center)
      ? readableHubLayoutHeight(graph.nodes.length, H)
      : H;
  const showEdgeLabels = visibleEdges.length <= 10;

  return (
    <div data-testid="collection-graph">
      <GraphSearchForm inputRef={inputRef} onSubmit={handleSubmit} />

      {loading && <div className="text-sm text-cafe-secondary">Loading graph...</div>}
      {error && <div className="text-sm text-conn-red-text">Error: {error}</div>}
      {candidates.length > 0 && !loading && <GraphCandidates candidates={candidates} onSelect={handleNodeClick} />}
      {noMatch && !loading && <GraphNoMatch examples={noMatch.examples} message={noMatch.message} />}
      {graph && graph.nodes.length === 0 && !loading && (
        <div className="text-sm text-cafe-secondary">No graph data for this anchor.</div>
      )}

      {graph && graph.nodes.length > 0 && (
        <div className="relative rounded-lg border border-cafe bg-[#fbfaf7] p-3">
          {graphNote === 'no_edges' && <GraphNoEdgesNote />}
          <div data-testid="graph-stage" className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
            <GraphCanvas
              center={graph.center}
              graph={graph}
              hovered={hovered}
              onHover={setHovered}
              onNodeClick={handleNodeClick}
              positions={positions}
              showEdgeLabels={showEdgeLabels}
              visibleEdges={visibleEdges}
              viewHeight={viewHeight}
            />
            <GraphInspector
              graph={graph}
              hiddenRelations={hiddenRelations}
              nodeByAnchor={nodeByAnchor}
              selectedEdges={selectedEdges}
              selectedNode={selectedNode}
              toggleRelation={toggleRelation}
              uniqueKinds={uniqueKinds}
              uniqueRelations={uniqueRelations}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function useSelectedNode(graph: GraphResult | null, selectedAnchor: string | null): GraphNode | null {
  return useMemo(() => {
    if (!graph) return null;
    return (
      graph.nodes.find((node) => node.anchor === selectedAnchor) ??
      graph.nodes.find((node) => node.anchor === graph.center) ??
      graph.nodes[0] ??
      null
    );
  }, [graph, selectedAnchor]);
}
