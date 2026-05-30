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

// Graph node kind colors — mapped to F056 chart palette tokens for theme/contrast consistency.
// Hue groups roughly preserve original semantic intent:
//   blue/cyan family → spec / feature
//   violet family → decision / plan
//   green family → lesson / research
//   orange family → session / discussion
//   magenta family → thread / lore
export const KIND_FILL: Record<string, string> = {
  feature: 'var(--chart-4)', // hue 210 — cyan-blue (was #2563eb)
  spec: 'var(--chart-3)', // hue 150 — teal-green (was #0891b2)
  decision: 'var(--chart-5)', // hue 270 — violet (was #7c3aed)
  plan: 'var(--chart-11)', // hue 270 deeper — indigo-violet (was #4f46e5)
  session: 'var(--chart-1)', // hue 30 — orange-red (was #d97706)
  lesson: 'var(--chart-9)', // hue 150 deeper — emerald (was #059669)
  thread: 'var(--chart-6)', // hue 330 — magenta-pink (was #db2777)
  discussion: 'var(--chart-7)', // hue 30 deeper — burnt orange (was #ea580c)
  research: 'var(--chart-8)', // hue 90 deeper — chartreuse (was #0d9488)
  lore: 'var(--chart-12)', // hue 330 deeper — plum (was #9333ea)
  unresolved: 'var(--neutral-400)', // was #d1d5db
};

// Graph edge relation colors — mapped to design system chart/semantic tokens
export const RELATION_COLOR: Record<string, string> = {
  related_to: 'var(--neutral-400)',
  related: 'var(--neutral-400)',
  evolved_from: 'var(--chart-5)',
  blocked_by: 'var(--semantic-critical)',
  supersedes: 'var(--chart-1)',
  invalidates: 'var(--chart-6)',
  promoted_from: 'var(--semantic-success)',
  wikilink: 'var(--semantic-info)',
  doc_link: 'var(--chart-4)',
  feature_ref: 'var(--chart-7)',
};

// Fallback color for unknown node kinds — uses neutral token
export function kindFill(kind: string): string {
  const color = KIND_FILL[kind];
  return typeof color === 'string' ? color : 'var(--neutral-500)';
}

// Fallback color for unknown edge relations — uses neutral token
export function relationColor(relation: string): string {
  const color = RELATION_COLOR[relation];
  return typeof color === 'string' ? color : 'var(--neutral-400)';
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
