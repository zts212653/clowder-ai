import type { CausalEdgeDTO } from '@cat-cafe/shared';
import { useId } from 'react';

const EDGE_PARALLEL_OFFSET = 10;
const LABEL_PARALLEL_OFFSET = 16;
const EDGE_TIME_BUCKET_PX = 48;

interface CausalEdgeOverlayProps {
  edges: CausalEdgeDTO[];
  laneMap: Map<string, number>;
  timeToX: (t: number) => number;
  laneY: (index: number) => number;
  totalHeight: number;
  timelineWidth: number;
}

interface EdgeGeometry {
  edge: CausalEdgeDTO;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  groupKey: string;
}

function edgeColor(kind: CausalEdgeDTO['kind']): string {
  return kind === 'thread_split' ? 'rgba(168, 85, 247, 0.6)' : 'rgba(16, 185, 129, 0.6)';
}

function collisionKey(x1: number, y1: number, x2: number, y2: number): string {
  const midBucket = Math.round((x1 + x2) / 2 / EDGE_TIME_BUCKET_PX);
  return `${midBucket}:${Math.min(y1, y2)}:${Math.max(y1, y2)}`;
}

function groupPositions(items: EdgeGeometry[]): Map<string, number> {
  const seen = new Map<string, number>();
  const positions = new Map<string, number>();
  for (const item of items) {
    const index = seen.get(item.groupKey) ?? 0;
    positions.set(item.edge.id, index);
    seen.set(item.groupKey, index + 1);
  }
  return positions;
}

export function CausalEdgeOverlay({
  edges,
  laneMap,
  timeToX,
  laneY,
  totalHeight,
  timelineWidth,
}: CausalEdgeOverlayProps) {
  const markerId = `birdseye-arrowhead-${useId().replace(/:/g, '')}`;
  const geometries = edges.flatMap((edge): EdgeGeometry[] => {
    const fromIdx = laneMap.get(edge.from.threadId);
    const toIdx = laneMap.get(edge.to.threadId);
    if (fromIdx === undefined || toIdx === undefined) return [];
    const x1 = timeToX(edge.from.time);
    const y1 = laneY(fromIdx);
    const x2 = timeToX(edge.to.time);
    const y2 = laneY(toIdx);
    return [{ edge, x1, y1, x2, y2, groupKey: collisionKey(x1, y1, x2, y2) }];
  });
  const groupSizes = new Map<string, number>();
  for (const item of geometries) {
    groupSizes.set(item.groupKey, (groupSizes.get(item.groupKey) ?? 0) + 1);
  }
  const positions = groupPositions(geometries);

  return (
    <svg
      width={timelineWidth}
      height={totalHeight}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        pointerEvents: 'none',
        overflow: 'visible',
      }}
    >
      <title>Feature story causal edges</title>
      {geometries.map(({ edge, x1, y1, x2, y2, groupKey }) => {
        const groupSize = groupSizes.get(groupKey) ?? 1;
        const groupIndex = positions.get(edge.id) ?? 0;
        const centeredIndex = groupIndex - (groupSize - 1) / 2;
        const lineOffset = centeredIndex * EDGE_PARALLEL_OFFSET;
        const labelOffset = centeredIndex * LABEL_PARALLEL_OFFSET;
        const strokeStyle = edge.confidence === 'high' ? 'none' : edge.confidence === 'medium' ? '6,4' : '2,4';
        const color = edgeColor(edge.kind);

        return (
          <g key={edge.id}>
            <line
              x1={x1 + lineOffset}
              y1={y1}
              x2={x2 + lineOffset}
              y2={y2}
              stroke={color}
              strokeWidth={2}
              strokeDasharray={strokeStyle}
              markerEnd={`url(#${markerId})`}
            />
            <text
              x={(x1 + x2) / 2 + lineOffset}
              y={(y1 + y2) / 2 - 8 + labelOffset}
              fill="rgba(255,255,255,0.5)"
              fontSize="var(--console-font-micro)"
              textAnchor="middle"
            >
              {edge.label}
            </text>
          </g>
        );
      })}
      <defs>
        <marker id={markerId} markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
          <polygon points="0 0, 8 3, 0 6" fill="rgba(168, 85, 247, 0.6)" />
        </marker>
      </defs>
    </svg>
  );
}
