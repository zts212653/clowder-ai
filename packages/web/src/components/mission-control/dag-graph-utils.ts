import type { BacklogItem, BacklogStatus } from '@cat-cafe/shared';
import dagre from '@dagrejs/dagre';
import { type Edge, MarkerType, type Node } from '@xyflow/react';
import { extractFeatureId } from './FeatureBirdEyePanel';

export type DagScope = 'connected' | 'active' | 'all';

export const SCOPE_LABELS: Record<DagScope, string> = {
  connected: '仅有依赖',
  active: '活跃',
  all: '全部',
};

export interface FeatureNodeData {
  featureId: string;
  name: string;
  status: BacklogStatus;
  evolvedFrom: string[];
  blockedBy: string[];
  related: string[];
  [key: string]: unknown;
}

export interface FeatureRecord {
  id: string;
  name: string;
  status: BacklogStatus;
  evolvedFrom: string[];
  blockedBy: string[];
  related: string[];
}

export const EDGE_STYLES = {
  evolved: { stroke: '#5B9BD5', strokeDasharray: undefined, label: '演化' },
  blocked: { stroke: '#E05252', strokeDasharray: '6 3', label: '阻塞' },
  related: { stroke: '#9A866F', strokeDasharray: '3 3', label: '关联' },
} as const;

export const STATUS_COLORS: Record<BacklogStatus, { border: string; bg: string; dot: string }> = {
  open: { border: '#C4B5A0', bg: '#FFFDF8', dot: '#C4B5A0' },
  suggested: { border: '#E4A853', bg: '#FFFBF0', dot: '#E4A853' },
  approved: { border: '#E4A853', bg: '#FFFBF0', dot: '#E4A853' },
  dispatched: { border: '#5B9BD5', bg: '#F5F9FF', dot: '#5B9BD5' },
  done: { border: '#7CB87C', bg: '#F5FFF5', dot: '#7CB87C' },
};

export const NODE_WIDTH = 160;
export const NODE_HEIGHT = 70;

function featureStatus(featureItems: BacklogItem[]): BacklogStatus {
  if (featureItems.some((i) => i.status === 'suggested' || i.status === 'approved')) return 'suggested';
  if (featureItems.some((i) => i.status === 'dispatched')) return 'dispatched';
  if (featureItems.some((i) => i.status === 'open')) return 'open';
  return 'done';
}

function featureName(featureItems: BacklogItem[]): string {
  const first = featureItems[0];
  if (!first) return '';
  return first.title.match(/^\[F\d+\]\s*(.+)/)?.[1]?.trim() ?? first.title;
}

function collectDeps(featureItems: BacklogItem[]) {
  const evolved = new Set<string>();
  const blocked = new Set<string>();
  const related = new Set<string>();
  for (const item of featureItems) {
    for (const d of item.dependencies?.evolvedFrom ?? []) evolved.add(d.toUpperCase());
    for (const d of item.dependencies?.blockedBy ?? []) blocked.add(d.toUpperCase());
    for (const d of item.dependencies?.related ?? []) related.add(d.toUpperCase());
  }
  return { evolvedFrom: [...evolved], blockedBy: [...blocked], related: [...related] };
}

export function buildFeatureRecords(items: BacklogItem[]): FeatureRecord[] {
  const groups = new Map<string, BacklogItem[]>();
  for (const item of items) {
    const fid = extractFeatureId(item.tags);
    if (fid === 'Untagged') continue;
    const list = groups.get(fid) ?? [];
    list.push(item);
    groups.set(fid, list);
  }
  const result: FeatureRecord[] = [];
  for (const [fid, fi] of groups) {
    result.push({ id: fid, name: featureName(fi), status: featureStatus(fi), ...collectDeps(fi) });
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

function makeEdge(src: string, tgt: string, type: keyof typeof EDGE_STYLES, width = 2): Edge {
  const s = EDGE_STYLES[type];
  const arrow = { type: MarkerType.ArrowClosed, color: s.stroke } as const;
  return {
    id: `${src}-${tgt}-${type}`,
    source: src,
    target: tgt,
    style: { stroke: s.stroke, strokeWidth: width, strokeDasharray: s.strokeDasharray },
    markerEnd: arrow,
    ...(type === 'related' && { markerStart: arrow }),
    label: s.label,
    labelStyle: { fontSize: 10, fill: s.stroke },
    interactionWidth: 20,
  };
}

export function collectEdges(records: FeatureRecord[]): Edge[] {
  const nodeIds = new Set(records.map((n) => n.id));
  const seenRelated = new Set<string>();
  const edges: Edge[] = [];
  for (const node of records) {
    edges.push(...node.evolvedFrom.filter((d) => nodeIds.has(d)).map((d) => makeEdge(d, node.id, 'evolved')));
    edges.push(...node.blockedBy.filter((d) => nodeIds.has(d)).map((d) => makeEdge(d, node.id, 'blocked')));
    for (const d of node.related) {
      if (!nodeIds.has(d)) continue;
      const key = [node.id, d].sort().join(':');
      if (seenRelated.has(key)) continue;
      seenRelated.add(key);
      edges.push(makeEdge(node.id, d, 'related', 1.5));
    }
  }
  return edges;
}

export function filterByScope(records: FeatureRecord[], scope: DagScope): FeatureRecord[] {
  if (scope === 'all') return records;
  if (scope === 'active') return records.filter((r) => r.status !== 'done');
  // 'connected': only nodes that participate in at least one drawable edge
  const edges = collectEdges(records);
  const connected = new Set<string>();
  for (const e of edges) {
    connected.add(e.source);
    connected.add(e.target);
  }
  return records.filter((r) => connected.has(r.id));
}

export function layoutDag(nodes: Node<FeatureNodeData>[], edges: Edge[]) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 60, marginx: 20, marginy: 20 });
  for (const n of nodes) g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);
  return {
    nodes: nodes.map((n) => {
      const p = g.node(n.id);
      return { ...n, position: { x: p.x - NODE_WIDTH / 2, y: p.y - NODE_HEIGHT / 2 } };
    }),
    edges,
  };
}

export function buildReactFlowGraph(records: FeatureRecord[]) {
  const rfNodes: Node<FeatureNodeData>[] = records.map((n) => ({
    id: n.id,
    type: 'feature',
    position: { x: 0, y: 0 },
    data: {
      featureId: n.id,
      name: n.name,
      status: n.status,
      evolvedFrom: n.evolvedFrom,
      blockedBy: n.blockedBy,
      related: n.related,
    },
  }));
  return layoutDag(rfNodes, collectEdges(records));
}

export function buildTooltip(data: FeatureNodeData): string {
  const lines = [`${data.featureId}: ${data.name}`];
  if (data.evolvedFrom.length) lines.push(`演化自: ${data.evolvedFrom.join(', ')}`);
  if (data.blockedBy.length) lines.push(`被阻塞: ${data.blockedBy.join(', ')}`);
  if (data.related.length) lines.push(`关联: ${data.related.join(', ')}`);
  return lines.join('\n');
}
