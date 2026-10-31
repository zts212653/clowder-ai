export type SearchType = 'all' | 'memory' | 'documents' | 'conversations';
export type SearchDestination =
  | { kind: 'taste'; id: string; revision: string }
  | { kind: 'document'; collection: string; anchor: string }
  | { kind: 'message'; threadId: string; messageId: string; contentRevision: string };
export interface MemorySearchRow {
  id: string;
  title: string;
  snippet: string;
  displayType: string;
  authority: string | null;
  updatedAt: string | number | null;
  destination: SearchDestination | null;
  graph: { anchor: string; collection: string } | null;
}
export interface MemorySearchGroup {
  type: Exclude<SearchType, 'all'>;
  status: 'ready' | 'partial' | 'unavailable';
  results: MemorySearchRow[];
  hasMore: boolean;
  degraded?: boolean;
}
export interface MemorySearchData {
  query: string;
  readStatus: 'ready' | 'partial' | 'unavailable';
  groups: MemorySearchGroup[];
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
export function isSearchDestination(v: unknown): v is SearchDestination {
  if (!object(v)) return false;
  if (v.kind === 'taste') return text(v.id) && text(v.revision);
  if (v.kind === 'document') return text(v.collection) && text(v.anchor);
  return v.kind === 'message' && text(v.threadId) && text(v.messageId) && text(v.contentRevision);
}
function row(v: unknown): v is MemorySearchRow {
  return (
    object(v) &&
    text(v.id) &&
    typeof v.title === 'string' &&
    typeof v.snippet === 'string' &&
    text(v.displayType) &&
    (v.authority === null || typeof v.authority === 'string') &&
    (v.updatedAt === null || typeof v.updatedAt === 'string' || typeof v.updatedAt === 'number') &&
    (v.destination === null || isSearchDestination(v.destination)) &&
    (v.graph === null || (object(v.graph) && text(v.graph.anchor) && text(v.graph.collection)))
  );
}
export function isMemorySearchData(v: unknown): v is MemorySearchData {
  if (
    !object(v) ||
    typeof v.query !== 'string' ||
    !['ready', 'partial', 'unavailable'].includes(String(v.readStatus)) ||
    !Array.isArray(v.groups) ||
    !v.groups.length ||
    v.groups.length > 3
  )
    return false;
  return v.groups.every(
    (g) =>
      object(g) &&
      ['memory', 'documents', 'conversations'].includes(String(g.type)) &&
      ['ready', 'partial', 'unavailable'].includes(String(g.status)) &&
      typeof g.hasMore === 'boolean' &&
      Array.isArray(g.results) &&
      g.results.length <= 20 &&
      g.results.every(row),
  );
}
export const SEARCH_LABELS = { all: '全部', memory: '记忆', documents: '文档', conversations: '对话' } as const;
