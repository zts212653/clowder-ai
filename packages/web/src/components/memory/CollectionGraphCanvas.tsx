'use client';

import React from 'react';
import typographyTokens from '@/styles/typography-tokens.json';
import { edgePath, type GraphNode, type GraphResult, relationColor } from './CollectionGraphModel';
import { GraphNodeGlyph, GraphTooltip } from './CollectionGraphParts';
import { GraphTitleNode, GraphTitleTooltip } from './CollectionGraphTitleParts';

const W = 940;
const H = 620;

export function GraphCanvas({
  center,
  graph,
  hovered,
  onHover,
  onNodeClick,
  positions,
  showEdgeLabels,
  visibleEdges,
  viewHeight,
  titles,
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
  titles: boolean;
}) {
  const renderedHeight = Math.round((viewHeight / H) * 560);
  return (
    <div className="relative min-w-0 overflow-auto rounded-md bg-[var(--console-card-bg)]">
      <svg
        viewBox={`0 0 ${W} ${viewHeight}`}
        className="w-full"
        style={{ height: `${renderedHeight}px`, minWidth: titles ? 640 : undefined }}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="知识图谱"
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
              {showEdgeLabels && !titles && <SparseEdgeLabel edge={edge} from={fp} to={tp} />}
            </React.Fragment>
          );
        })}

        {graph.nodes.map((node) => {
          const pos = positions.get(node.anchor);
          if (!pos) return null;
          const Node = titles ? GraphTitleNode : GraphNodeGlyph;
          return (
            <Node
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
      {hovered && (titles ? <GraphTitleTooltip node={hovered} /> : <GraphTooltip node={hovered} />)}
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
      fontSize={typographyTokens.fontSizePx.micro}
      fill={color}
      fontWeight="700"
      data-testid={`graph-edge-label-${edge.from}-${edge.to}-${edge.relation}`}
    >
      {edge.relation.replace(/_/g, ' ')}
    </text>
  );
}
