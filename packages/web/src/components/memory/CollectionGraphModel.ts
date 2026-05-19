export interface GraphNode {
  anchor: string;
  collectionId: string;
  sensitivity: string;
  kind: string;
  title: string;
  redacted: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  relation: string;
  crossCollection: boolean;
  edgeSensitivity: string;
  provenance: string;
  redacted: boolean;
}

export interface GraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  center?: string;
  depth: number;
}

export const KIND_FILL: Record<string, string> = {
  feature: '#2563eb',
  spec: '#0891b2',
  decision: '#7c3aed',
  plan: '#4f46e5',
  session: '#d97706',
  lesson: '#059669',
  thread: '#db2777',
  discussion: '#ea580c',
  research: '#0d9488',
  lore: '#9333ea',
  unresolved: '#d1d5db',
};

export const RELATION_COLOR: Record<string, string> = {
  related_to: '#6b7280',
  related: '#6b7280',
  evolved_from: '#8b5cf6',
  blocked_by: '#ef4444',
  supersedes: '#f97316',
  invalidates: '#dc2626',
  promoted_from: '#10b981',
  wikilink: '#3b82f6',
  doc_link: '#0891b2',
  feature_ref: '#d97706',
};

export function kindFill(kind: string): string {
  const color = KIND_FILL[kind];
  return typeof color === 'string' ? color : '#6b7280';
}

export function relationColor(relation: string): string {
  const color = RELATION_COLOR[relation];
  return typeof color === 'string' ? color : '#9ca3af';
}

export function compactAnchorLabel(anchor: string): string {
  const lastSegment = anchor.split(':').at(-1) ?? anchor;
  const withoutDocPrefix = lastSegment.replace(/^doc\//, '');
  return withoutDocPrefix.length > 12 ? `${withoutDocPrefix.slice(0, 10)}...` : withoutDocPrefix;
}

export function humanTitle(node: GraphNode): string {
  if (node.redacted) return 'Redacted node';
  const title = node.title.trim();
  if (!title || title === node.anchor) return compactAnchorLabel(node.anchor);
  const escapedAnchor = node.anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return title.replace(new RegExp(`^${escapedAnchor}\\s*[:：-]\\s*`, 'i'), '');
}

export function truncateLabel(value: string, maxChars: number): string {
  const chars = [...value];
  if (chars.length <= maxChars) return value;
  return `${chars.slice(0, maxChars - 1).join('')}…`;
}

export function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
  const off = Math.min(20, len * 0.12);
  const cx = (x1 + x2) / 2 + (-dy / len) * off;
  const cy = (y1 + y2) / 2 + (dx / len) * off;
  return `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`;
}
