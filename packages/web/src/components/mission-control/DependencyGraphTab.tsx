'use client';

import { type BacklogItem, type BacklogStatus } from '@cat-cafe/shared';
import { Handle, type Node, type NodeProps, Position, ReactFlow, useEdgesState, useNodesState } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  buildFeatureRecords,
  buildReactFlowGraph,
  buildTooltip,
  type DagScope,
  EDGE_STYLES,
  type FeatureNodeData,
  filterByScope,
  NODE_HEIGHT,
  NODE_WIDTH,
  SCOPE_LABELS,
  STATUS_COLORS,
} from './dag-graph-utils';

interface DependencyGraphTabProps {
  items: BacklogItem[];
}

function FeatureNode({ data }: NodeProps<Node<FeatureNodeData>>) {
  const colors = STATUS_COLORS[data.status];
  const isDone = data.status === 'done';

  return (
    <div
      className={`rounded-xl border-2 bg-cafe-surface px-3 py-2 shadow-sm transition-shadow hover:shadow-md ${isDone ? 'opacity-50' : ''}`}
      style={{
        borderColor: colors.border,
        backgroundColor: colors.bg,
        width: NODE_WIDTH,
        minHeight: NODE_HEIGHT - 10,
      }}
      data-testid={`mc-dep-node-${data.featureId}`}
      title={buildTooltip(data)}
    >
      <Handle type="target" position={Position.Top} className="!h-1.5 !w-1.5 !border-0 !bg-transparent" />
      <div className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: colors.dot }} />
        <span className="text-xs font-bold text-[#8B6F47]">{data.featureId}</span>
      </div>
      <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-[#5A4A38]">{data.name}</p>
      <Handle type="source" position={Position.Bottom} className="!h-1.5 !w-1.5 !border-0 !bg-transparent" />
    </div>
  );
}

const nodeTypes = { feature: FeatureNode };

const STATUS_LABEL: Record<BacklogStatus, string> = {
  open: '待建议',
  suggested: '待审批',
  approved: '待审批',
  dispatched: '执行中',
  done: '已完成',
};

export function DependencyGraphTab({ items }: DependencyGraphTabProps) {
  const allRecords = useMemo(() => buildFeatureRecords(items), [items]);
  const [scope, setScope] = useState<DagScope>('connected');

  const filtered = useMemo(() => filterByScope(allRecords, scope), [allRecords, scope]);
  const layouted = useMemo(() => buildReactFlowGraph(filtered), [filtered]);

  const [nodes, setNodes, onNodesChange] = useNodesState(layouted.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layouted.edges);
  const [selectedNode, setSelectedNode] = useState<FeatureNodeData | null>(null);

  useEffect(() => {
    setNodes(layouted.nodes);
    setEdges(layouted.edges);
  }, [layouted, setNodes, setEdges]);

  useEffect(() => {
    setSelectedNode((prev) => {
      if (!prev) return null;
      const updated = filtered.find((n) => n.id === prev.featureId);
      if (!updated) return null;
      return {
        featureId: updated.id,
        name: updated.name,
        status: updated.status,
        evolvedFrom: updated.evolvedFrom,
        blockedBy: updated.blockedBy,
        related: updated.related,
      };
    });
  }, [filtered]);

  const onInit = useCallback((instance: { fitView: () => void }) => {
    instance.fitView();
  }, []);

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node<FeatureNodeData>) => {
    setSelectedNode((prev) => (prev?.featureId === node.data.featureId ? null : node.data));
  }, []);

  if (allRecords.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-[#9A866F]" data-testid="mc-dep-graph-empty">
        暂无 Feature 依赖数据
      </div>
    );
  }

  return (
    <div data-testid="mc-dep-graph">
      {/* Toolbar: scope filter + stats */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#E7DAC7] bg-[#FFFDF8] px-3 py-2">
        <div className="flex items-center gap-2">
          {(Object.keys(SCOPE_LABELS) as DagScope[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              className={`rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors ${
                scope === s ? 'bg-[#8B6F47] text-white' : 'bg-[#F5EDE0] text-[#9A866F] hover:bg-[#E7DAC7]'
              }`}
              data-testid={`mc-dep-scope-${s}`}
            >
              {SCOPE_LABELS[s]}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-[#9A866F]" data-testid="mc-dep-stats">
          {filtered.length} 个 Feature / {layouted.edges.length} 条依赖
        </span>
      </div>

      {/* Legend */}
      <div className="mb-3 flex flex-wrap items-center gap-4 rounded-xl border border-[#E7DAC7] bg-[#FFFDF8] px-3 py-2">
        <LegendDot color="#E4A853" label="待审批" />
        <LegendDot color="#5B9BD5" label="执行中" />
        <LegendDot color="#7CB87C" label="已完成" />
        <LegendDot color="#C4B5A0" label="待建议" />
        <span className="text-[11px] text-[#9A866F]">
          <span style={{ color: EDGE_STYLES.evolved.stroke }}>── 演化</span>
          {' · '}
          <span style={{ color: EDGE_STYLES.blocked.stroke }}>- - 阻塞</span>
          {' · '}
          <span style={{ color: EDGE_STYLES.related.stroke }}>··· 关联</span>
        </span>
      </div>

      {/* DAG graph or empty state */}
      {filtered.length === 0 ? (
        <div className="flex items-center justify-center rounded-xl border border-[#E7DAC7] bg-[#FFFDF8] py-16 text-sm text-[#9A866F]">
          当前筛选无有依赖关系的 Feature — 尝试切换到「全部」或刷新依赖数据
        </div>
      ) : (
        <div className="h-[500px] w-full rounded-xl border border-[#E7DAC7] bg-[#FFFDF8]">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            onInit={onInit}
            onNodeClick={onNodeClick}
            onPaneClick={() => setSelectedNode(null)}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.3}
            maxZoom={1.5}
            nodesDraggable={false}
            nodesConnectable={false}
            edgesFocusable
            proOptions={{ hideAttribution: true }}
          />
        </div>
      )}

      {selectedNode && <NodeDetailPanel data={selectedNode} onClose={() => setSelectedNode(null)} />}
    </div>
  );
}

function NodeDetailPanel({ data, onClose }: { data: FeatureNodeData; onClose: () => void }) {
  const colors = STATUS_COLORS[data.status];
  return (
    <div className="mt-3 rounded-xl border border-[#E7DAC7] bg-[#FFFDF8] p-4" data-testid="mc-dep-node-detail">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full" style={{ backgroundColor: colors.dot }} />
          <span className="text-sm font-bold text-[#8B6F47]">{data.featureId}</span>
          <span
            className="rounded-md px-1.5 py-0.5 text-[10px] font-medium"
            style={{ backgroundColor: colors.bg, color: colors.border }}
          >
            {STATUS_LABEL[data.status]}
          </span>
        </div>
        <button type="button" onClick={onClose} className="text-xs text-[#9A866F] hover:text-[#5A4A38]">
          ✕
        </button>
      </div>
      <p className="mt-1 text-xs text-[#5A4A38]">{data.name}</p>
      {data.evolvedFrom.length > 0 && (
        <div className="mt-2">
          <span className="text-[10px] font-medium text-[#9A866F]">演化自：</span>
          <span className="text-[11px] text-blue-700">{data.evolvedFrom.join(', ')}</span>
        </div>
      )}
      {data.blockedBy.length > 0 && (
        <div className="mt-1">
          <span className="text-[10px] font-medium text-[#9A866F]">被阻塞：</span>
          <span className="text-[11px] text-red-700">{data.blockedBy.join(', ')}</span>
        </div>
      )}
      {data.related.length > 0 && (
        <div className="mt-1">
          <span className="text-[10px] font-medium text-[#9A866F]">关联：</span>
          <span className="text-[11px] text-cafe-secondary">{data.related.join(', ')}</span>
        </div>
      )}
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      <span className="text-[11px] text-[#9A866F]">{label}</span>
    </span>
  );
}
