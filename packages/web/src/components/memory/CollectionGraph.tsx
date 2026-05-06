'use client';

import React, { useCallback, useRef, useState } from 'react';

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
  crossCollection: boolean;
  edgeSensitivity: string;
  provenance: string;
  redacted: boolean;
}

interface GraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  center?: string;
  depth: number;
}

const SENSITIVITY_COLOR: Record<string, string> = {
  public: '#22c55e',
  internal: '#3b82f6',
  private: '#f59e0b',
  restricted: '#ef4444',
};

const RELATION_STYLE: Record<string, string> = {
  related_to: '#6b7280',
  evolved_from: '#8b5cf6',
  blocked_by: '#ef4444',
  supersedes: '#f97316',
  invalidates: '#dc2626',
  promoted_from: '#10b981',
};

const W = 600;
const H = 400;

interface SimNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

function applyRepulsion(sim: SimNode[]) {
  for (let i = 0; i < sim.length; i++) {
    for (let j = i + 1; j < sim.length; j++) {
      const dx = sim[i].x - sim[j].x;
      const dy = sim[i].y - sim[j].y;
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const f = 3000 / (d * d);
      sim[i].vx += (dx / d) * f;
      sim[i].vy += (dy / d) * f;
      sim[j].vx -= (dx / d) * f;
      sim[j].vy -= (dy / d) * f;
    }
  }
}

function applySprings(sim: SimNode[], edges: GraphEdge[], idx: Map<string, number>) {
  for (const e of edges) {
    const ai = idx.get(e.from);
    const bi = idx.get(e.to);
    if (ai === undefined || bi === undefined) continue;
    const dx = sim[bi].x - sim[ai].x;
    const dy = sim[bi].y - sim[ai].y;
    const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
    const disp = d - 120;
    sim[ai].vx += 0.01 * disp * (dx / d);
    sim[ai].vy += 0.01 * disp * (dy / d);
    sim[bi].vx -= 0.01 * disp * (dx / d);
    sim[bi].vy -= 0.01 * disp * (dy / d);
  }
}

function forceLayout(nodes: GraphNode[], edges: GraphEdge[], center?: string): Map<string, { x: number; y: number }> {
  if (nodes.length === 0) return new Map();
  const cx = W / 2;
  const cy = H / 2;
  const sim: SimNode[] = nodes.map((n, i) => {
    if (n.anchor === center) return { x: cx, y: cy, vx: 0, vy: 0 };
    const a = (2 * Math.PI * i) / Math.max(nodes.length, 1);
    return { x: cx + 100 * Math.cos(a), y: cy + 100 * Math.sin(a), vx: 0, vy: 0 };
  });
  const idx = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) {
    idx.set(nodes[i].anchor, i);
  }

  for (let t = 0; t < 80; t++) {
    applyRepulsion(sim);
    applySprings(sim, edges, idx);
    for (const p of sim) {
      p.vx = (p.vx + (cx - p.x) * 0.01) * 0.8;
      p.vy = (p.vy + (cy - p.y) * 0.01) * 0.8;
      p.x = Math.max(30, Math.min(W - 30, p.x + p.vx));
      p.y = Math.max(30, Math.min(H - 30, p.y + p.vy));
    }
  }

  const result = new Map<string, { x: number; y: number }>();
  for (let i = 0; i < nodes.length; i++) {
    result.set(nodes[i].anchor, { x: sim[i].x, y: sim[i].y });
  }
  return result;
}

function renderGraphNode(
  node: GraphNode,
  pos: { x: number; y: number },
  centerAnchor: string | undefined,
  onNodeClick: (anchor: string) => void,
  onHover: (n: GraphNode | null) => void,
) {
  const color = SENSITIVITY_COLOR[node.sensitivity] ?? '#6b7280';
  const isCenter = node.anchor === centerAnchor;
  const dimmed = node.sensitivity === 'private' || node.sensitivity === 'restricted' || node.redacted;
  const r = isCenter ? 22 : 18;
  const label = node.title.length > 20 ? `${node.title.slice(0, 18)}…` : node.title;

  return (
    <g
      key={node.anchor}
      data-testid={`graph-node-${node.anchor}`}
      opacity={dimmed ? 0.5 : 1}
      className="cursor-pointer"
      role="treeitem"
      tabIndex={0}
      onClick={() => onNodeClick(node.anchor)}
      ref={(el) => {
        if (!el) return;
        el.onmouseenter = () => onHover(node);
        el.onmouseleave = () => onHover(null);
        el.onfocus = () => onHover(node);
        el.onblur = () => onHover(null);
        el.onkeydown = (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onNodeClick(node.anchor);
          }
        };
      }}
    >
      <circle
        cx={pos.x}
        cy={pos.y}
        r={r}
        fill="white"
        stroke={color}
        strokeWidth={isCenter ? 3 : 2}
        strokeDasharray={node.redacted ? '4 2' : undefined}
      />
      {node.redacted && (
        <text x={pos.x} y={pos.y + 1} textAnchor="middle" fontSize={12}>
          🔒
        </text>
      )}
      <text x={pos.x} y={pos.y + (node.redacted ? 14 : 4)} textAnchor="middle" fontSize={9} fill="#374151">
        {label}
      </text>
    </g>
  );
}

export function CollectionGraph() {
  const [graph, setGraph] = useState<GraphResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<GraphNode | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const fetchGraph = useCallback((a: string) => {
    if (!a.trim()) return;
    setLoading(true);
    setError(null);
    setHovered(null);
    fetch(`/api/library/graph?anchor=${encodeURIComponent(a)}&depth=1`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((data) => setGraph(data))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      fetchGraph(inputRef.current?.value ?? '');
    },
    [fetchGraph],
  );

  const handleNodeClick = useCallback(
    (nodeAnchor: string) => {
      if (inputRef.current) inputRef.current.value = nodeAnchor;
      fetchGraph(nodeAnchor);
    },
    [fetchGraph],
  );

  const positions = graph ? forceLayout(graph.nodes, graph.edges, graph.center) : new Map();

  return (
    <div data-testid="collection-graph">
      <form onSubmit={handleSubmit} className="flex gap-2 mb-4">
        <input
          ref={inputRef}
          type="text"
          defaultValue=""
          placeholder="Enter anchor (e.g. project:cafe:doc/f186)"
          className="flex-1 rounded border border-cafe bg-white px-3 py-1.5 text-sm text-cafe-primary"
          data-testid="graph-anchor-input"
        />
        <button
          type="submit"
          className="rounded bg-cafe-primary px-3 py-1.5 text-sm text-white"
          data-testid="graph-fetch-btn"
        >
          View Graph
        </button>
      </form>

      {loading && <div className="text-sm text-cafe-secondary">Loading graph...</div>}
      {error && <div className="text-sm text-red-500">Error: {error}</div>}
      {graph && graph.nodes.length === 0 && !loading && (
        <div className="text-sm text-cafe-secondary">No graph data for this anchor.</div>
      )}

      {graph && graph.nodes.length > 0 && (
        <div className="relative rounded-lg border border-cafe bg-white p-2">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="w-full"
            role="img"
            aria-label="Knowledge graph"
            data-testid="graph-svg"
          >
            {graph.edges.map((edge) => {
              const fromPos = positions.get(edge.from);
              const toPos = positions.get(edge.to);
              if (!fromPos || !toPos) return null;
              const color = RELATION_STYLE[edge.relation] ?? '#9ca3af';
              const mx = (fromPos.x + toPos.x) / 2;
              const my = (fromPos.y + toPos.y) / 2;
              return (
                <g key={`${edge.from}-${edge.to}-${edge.relation}`}>
                  <line
                    x1={fromPos.x}
                    y1={fromPos.y}
                    x2={toPos.x}
                    y2={toPos.y}
                    stroke={color}
                    strokeWidth={edge.crossCollection ? 2 : 1}
                    strokeDasharray={edge.redacted ? '4 2' : undefined}
                    opacity={0.6}
                  />
                  <text x={mx} y={my - 4} textAnchor="middle" fontSize={8} fill={color}>
                    {edge.relation}
                  </text>
                </g>
              );
            })}
            {graph.nodes.map((node) => {
              const pos = positions.get(node.anchor);
              if (!pos) return null;
              return renderGraphNode(node, pos, graph.center, handleNodeClick, setHovered);
            })}
          </svg>
          {hovered && (
            <div
              data-testid="graph-tooltip"
              className="absolute top-2 right-2 rounded bg-cafe-surface p-2 text-xs shadow-lg border border-cafe pointer-events-none"
            >
              <div className="font-medium text-cafe-primary">{hovered.title}</div>
              <div className="text-cafe-secondary">{hovered.collectionId}</div>
              <div className="text-cafe-secondary">{hovered.sensitivity}</div>
            </div>
          )}
          <div className="flex flex-wrap gap-3 mt-2 px-2 text-[10px] text-cafe-secondary">
            <span>Nodes: {graph.nodes.length}</span>
            <span>Edges: {graph.edges.length}</span>
            <span>Depth: {graph.depth}</span>
            {graph.center && <span>Center: {graph.center}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
