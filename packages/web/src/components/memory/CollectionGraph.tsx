'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GraphCanvas } from './CollectionGraphCanvas';
import type { GraphNode, GraphResult } from './CollectionGraphModel';
import { GraphInspector } from './CollectionGraphParts';
import {
  GraphCandidates,
  GraphNoEdgesNote,
  GraphNoMatch,
  type GraphQueryCandidate,
  GraphSearchForm,
} from './CollectionGraphQueryStates';
import { GraphTitleInspector } from './CollectionGraphTitleParts';
import { forceLayout, readableHubLayout, readableHubLayoutHeight, usesReadableHubLayout } from './graph-layout';

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

export function CollectionGraph({
  initialAnchor,
  initialCollection,
  presentation = 'coordinates',
}: {
  initialAnchor?: string;
  initialCollection?: string;
  presentation?: 'coordinates' | 'titles';
} = {}) {
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

  useEffect(() => {
    if (initialAnchor) fetchGraph(initialAnchor, initialCollection);
  }, [initialAnchor, initialCollection, fetchGraph]);

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
  const titles = presentation === 'titles';
  const { positions, viewHeight } = graphGeometry(graph, visibleEdges, titles);
  const selectedNode = useSelectedNode(graph, selectedAnchor);
  const selectedEdges = useMemo(() => {
    if (!graph || !selectedNode) return [];
    return visibleEdges.filter((edge) => edge.from === selectedNode.anchor || edge.to === selectedNode.anchor);
  }, [graph, selectedNode, visibleEdges]);
  const nodeByAnchor = useMemo(() => new Map((graph?.nodes ?? []).map((node) => [node.anchor, node])), [graph?.nodes]);
  const showEdgeLabels = visibleEdges.length <= 10;

  return (
    <div data-testid="collection-graph">
      {!titles && <GraphSearchForm inputRef={inputRef} onSubmit={handleSubmit} />}

      {loading && <div className="text-sm text-cafe-secondary">加载图谱...</div>}
      {error && <div className="text-sm text-conn-red-text">错误: {error}</div>}
      {candidates.length > 0 && !loading && <GraphCandidates candidates={candidates} onSelect={handleNodeClick} />}
      {noMatch && !loading && <GraphNoMatch examples={noMatch.examples} message={noMatch.message} />}
      {graph && graph.nodes.length === 0 && !loading && (
        <div className="text-sm text-cafe-secondary">该锚点暂无图谱数据。</div>
      )}

      {graph && graph.nodes.length > 0 && (
        <div className="relative rounded-lg bg-[var(--console-card-bg)] p-3">
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
              titles={titles}
            />
            {titles ? (
              <GraphTitleInspector
                graph={graph}
                selectedNode={selectedNode}
                selectedEdges={selectedEdges}
                nodeByAnchor={nodeByAnchor}
              />
            ) : (
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
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function graphGeometry(graph: GraphResult | null, visibleEdges: GraphResult['edges'], titles: boolean) {
  if (!graph) return { positions: new Map<string, { x: number; y: number }>(), viewHeight: H };
  const viewHeight =
    titles || usesReadableHubLayout(graph.nodes, visibleEdges, graph.center)
      ? readableHubLayoutHeight(graph.nodes.length, H)
      : H;
  const positions =
    titles && graph.center
      ? readableHubLayout(graph.nodes, graph.center, W, viewHeight)
      : forceLayout(graph.nodes, visibleEdges, graph.center, W, H);
  return { positions, viewHeight };
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
