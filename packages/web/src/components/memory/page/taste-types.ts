export interface TasteMemory {
  id: string;
  revision: string;
  visibility: 'public' | 'private';
  title: string;
  when: string;
  quotes: string[];
  scene: string;
  takeaway: string | null;
  tags: string[];
  dimension: string | null;
  catId: string | null;
  whenRemembered?: string;
  approval?: { status: 'approved' | 'not_recorded' | 'unavailable'; proposedAt?: number; approvedAt?: number | null };
  recall: {
    namedDelivery: {
      counts: { presented: number; drilled: number; applied: number; dismissed: number };
      latest?: TasteLatest | null;
    } | null;
    search: { hits: number; opened: number; unverified: number; latest?: TasteLatest | null } | null;
  } | null;
}
export interface TasteLatest {
  at: number;
  outcome: string;
  title: string | null;
  threadId?: string;
}
export interface TasteBrowse {
  readStatus: 'ready' | 'partial';
  entries: TasteMemory[];
  coverage: { unverified: number } | null;
}
export interface TasteSource {
  status: 'ready' | 'not_recorded' | 'unavailable';
  title: string | null;
  canOpen: boolean;
  threadId?: string;
  messageId?: string;
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isNullableText = (value: unknown) => value === null || typeof value === 'string';
const isTextList = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === 'string');
const isCount = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isTimestamp = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime());

function isLatest(value: unknown) {
  return (
    value == null ||
    (isRecord(value) &&
      isTimestamp(value.at) &&
      typeof value.outcome === 'string' &&
      isNullableText(value.title) &&
      (value.threadId === undefined || typeof value.threadId === 'string'))
  );
}
function isRecall(value: unknown) {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  const named = value.namedDelivery;
  const search = value.search;
  return (
    (named === null ||
      (isRecord(named) &&
        isRecord(named.counts) &&
        ['presented', 'drilled', 'applied', 'dismissed'].every((key) =>
          isCount((named.counts as Record<string, unknown>)[key]),
        ) &&
        isLatest(named.latest))) &&
    (search === null ||
      (isRecord(search) &&
        ['hits', 'opened', 'unverified'].every((key) => isCount(search[key])) &&
        isLatest(search.latest)))
  );
}
function isApproval(value: unknown) {
  return (
    value === undefined ||
    (isRecord(value) &&
      (value.status === 'approved' || value.status === 'not_recorded' || value.status === 'unavailable') &&
      (value.proposedAt === undefined || isTimestamp(value.proposedAt)) &&
      (value.approvedAt == null || isTimestamp(value.approvedAt)))
  );
}
/** Validate the fields consumed by both cards and detail before rendering either response. */
export function isTasteMemory(value: unknown): value is TasteMemory {
  if (!isRecord(value)) return false;
  return (
    ['id', 'revision', 'title', 'when', 'scene'].every((key) => typeof value[key] === 'string') &&
    (value.visibility === 'public' || value.visibility === 'private') &&
    isTextList(value.quotes) &&
    isTextList(value.tags) &&
    isNullableText(value.takeaway) &&
    isNullableText(value.dimension) &&
    isNullableText(value.catId) &&
    (value.whenRemembered === undefined || typeof value.whenRemembered === 'string') &&
    isApproval(value.approval) &&
    isRecall(value.recall)
  );
}
export function isTasteBrowse(value: unknown): value is TasteBrowse {
  return (
    isRecord(value) &&
    (value.readStatus === 'ready' || value.readStatus === 'partial') &&
    Array.isArray(value.entries) &&
    value.entries.every(isTasteMemory)
  );
}
export function isTasteSource(value: unknown): value is TasteSource {
  return (
    isRecord(value) &&
    (value.status === 'ready' || value.status === 'not_recorded' || value.status === 'unavailable') &&
    isNullableText(value.title) &&
    typeof value.canOpen === 'boolean' &&
    (value.threadId === undefined || typeof value.threadId === 'string') &&
    (value.messageId === undefined || typeof value.messageId === 'string')
  );
}
export function canOpenTasteSource(
  value: TasteSource | null,
): value is TasteSource & { threadId: string; messageId: string } {
  return (
    value?.status === 'ready' &&
    value.canOpen === true &&
    typeof value.threadId === 'string' &&
    value.threadId.length > 0 &&
    typeof value.messageId === 'string' &&
    value.messageId.length > 0
  );
}
const DIMENSIONS: Record<string, string> = {
  'relationship-stance': '关系姿态',
  'cognitive-honesty': '认知诚实',
  'architecture-aesthetics': '架构审美',
  'visual-quality': '视觉品质',
  'authentic-expression': '表达真实',
  'system-philosophy': '系统哲学',
  'creative-craft': '创作手法',
};
export const tasteDimension = (key: string | null) =>
  key && Object.hasOwn(DIMENSIONS, key) ? DIMENSIONS[key] : '分类没有记录';
