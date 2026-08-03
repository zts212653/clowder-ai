export const RECALL_META_TAG = 'recall-meta';

export const RECALL_RESULT_STATUSES = [
  'counted',
  'no_results',
  'overflow',
  'error',
  'parser_miss',
  'result_unmerged',
  'legacy_unknown',
] as const;

export type RecallResultStatus = (typeof RECALL_RESULT_STATUSES)[number];

export const RECALL_MATCH_RANKS = ['high', 'mid', 'low'] as const;
export type RecallMatchRank = (typeof RECALL_MATCH_RANKS)[number];

export const RECALL_MATCH_TYPES = ['direct', 'alias', 'source-thread', 'convention'] as const;
export type RecallMatchType = (typeof RECALL_MATCH_TYPES)[number];

export interface RecallResultArtifactRef {
  path: string;
  bytes?: number;
  tokens?: number;
}

export interface RecallPreviewItem {
  title?: string;
  anchor?: string;
  snippet?: string;
  matchRank?: RecallMatchRank;
  matchType?: RecallMatchType;
  authority?: string;
  updatedAt?: string;
}

export interface RecallResultMeta {
  resultStatus: RecallResultStatus;
  resultCount?: number | null;
  artifactRef?: RecallResultArtifactRef;
  readNextHint?: string;
  truncated?: boolean;
  degraded?: boolean;
  degradeReason?: string;
  previewItems?: RecallPreviewItem[];
}

const STATUS_SET = new Set<string>(RECALL_RESULT_STATUSES);
const MATCH_RANK_SET = new Set<string>(RECALL_MATCH_RANKS);
const MATCH_TYPE_SET = new Set<string>(RECALL_MATCH_TYPES);
const RECALL_META_OPEN_TAG = `<${RECALL_META_TAG}>`;
const RECALL_META_CLOSE_TAG = `</${RECALL_META_TAG}>`;
const FRESHNESS_NOTICE_TRAILER_PATTERN =
  /^📬 提醒：你有 \d+ 条未读消息（当前 thread）\n来自：.+\n调 get_thread_context 查看完整内容$/u;

export function isRecallResultStatus(value: unknown): value is RecallResultStatus {
  return typeof value === 'string' && STATUS_SET.has(value);
}

export function isRecallMatchRank(value: unknown): value is RecallMatchRank {
  return typeof value === 'string' && MATCH_RANK_SET.has(value);
}

export function isRecallMatchType(value: unknown): value is RecallMatchType {
  return typeof value === 'string' && MATCH_TYPE_SET.has(value);
}

function readPersistedPreviewAxes(item: Record<string, unknown>): Pick<RecallPreviewItem, 'matchRank' | 'matchType'> {
  const axes: Pick<RecallPreviewItem, 'matchRank' | 'matchType'> = {};
  if (isRecallMatchRank(item.matchRank)) axes.matchRank = item.matchRank;
  if (isRecallMatchType(item.matchType)) axes.matchType = item.matchType;

  const legacyValue = item.confidence;
  if (!axes.matchRank && isRecallMatchRank(legacyValue)) axes.matchRank = legacyValue;
  if (!axes.matchType && isRecallMatchType(legacyValue)) axes.matchType = legacyValue;
  return axes;
}

export function formatRecallMeta(meta: RecallResultMeta): string {
  const json = JSON.stringify(meta).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `${RECALL_META_OPEN_TAG}${json}${RECALL_META_CLOSE_TAG}`;
}

export function extractAppendedRecallMetaBlock(text: string): string | undefined {
  return findAppendedRecallMetaBlock(text)?.block;
}

export function stripAppendedRecallMetaBlock(text: string): string {
  const block = findAppendedRecallMetaBlock(text);
  if (!block) return text;
  return `${text.slice(0, block.start)}${text.slice(block.end)}`;
}

export function parseRecallMetaFromText(text: string): RecallResultMeta | null {
  const sidecar = findAppendedRecallMetaBlock(text);
  if (!sidecar) return null;

  try {
    const parsed = JSON.parse(sidecar.json) as Record<string, unknown>;
    if (!isRecallResultStatus(parsed['resultStatus'])) return null;

    const meta: RecallResultMeta = {
      resultStatus: parsed['resultStatus'],
    };

    const count = parsed['resultCount'];
    if (typeof count === 'number' && Number.isFinite(count)) meta.resultCount = count;
    else if (count === null) meta.resultCount = null;

    const artifact = parsed['artifactRef'];
    if (artifact && typeof artifact === 'object') {
      const a = artifact as Record<string, unknown>;
      if (typeof a['path'] === 'string' && a['path']) {
        meta.artifactRef = { path: a['path'] };
        if (typeof a['bytes'] === 'number' && Number.isFinite(a['bytes'])) meta.artifactRef.bytes = a['bytes'];
        if (typeof a['tokens'] === 'number' && Number.isFinite(a['tokens'])) meta.artifactRef.tokens = a['tokens'];
      }
    }

    if (typeof parsed['readNextHint'] === 'string' && parsed['readNextHint']) {
      meta.readNextHint = parsed['readNextHint'];
    }
    if (typeof parsed['truncated'] === 'boolean') meta.truncated = parsed['truncated'];
    if (typeof parsed['degraded'] === 'boolean') meta.degraded = parsed['degraded'];
    if (typeof parsed['degradeReason'] === 'string' && parsed['degradeReason']) {
      meta.degradeReason = parsed['degradeReason'];
    }
    if (Array.isArray(parsed['previewItems'])) {
      meta.previewItems = parsed['previewItems']
        .map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>) : null))
        .filter((item): item is Record<string, unknown> => item != null)
        .map((item) => ({
          ...(typeof item['title'] === 'string' ? { title: item['title'] } : {}),
          ...(typeof item['anchor'] === 'string' ? { anchor: item['anchor'] } : {}),
          ...(typeof item['snippet'] === 'string' ? { snippet: item['snippet'] } : {}),
          ...readPersistedPreviewAxes(item),
          ...(typeof item['authority'] === 'string' ? { authority: item['authority'] } : {}),
          ...(typeof item['updatedAt'] === 'string' ? { updatedAt: item['updatedAt'] } : {}),
        }))
        .filter((item) => Object.keys(item).length > 0)
        .slice(0, 5);
    }

    return isValidRecallMeta(meta) ? meta : null;
  } catch {
    return null;
  }
}

function findAppendedRecallMetaBlock(
  text: string,
): { block: string; json: string; start: number; end: number } | undefined {
  const start = text.lastIndexOf(RECALL_META_OPEN_TAG);
  if (start < 0) return undefined;

  const jsonStart = start + RECALL_META_OPEN_TAG.length;
  const close = text.indexOf(RECALL_META_CLOSE_TAG, jsonStart);
  if (close < 0) return undefined;

  const end = close + RECALL_META_CLOSE_TAG.length;
  if (!isAllowedRecallMetaTrailer(text.slice(end))) return undefined;

  return {
    block: text.slice(start, end),
    json: text.slice(jsonStart, close),
    start,
    end,
  };
}

function isAllowedRecallMetaTrailer(trailer: string): boolean {
  const trimmed = trailer.trim();
  return trimmed.length === 0 || FRESHNESS_NOTICE_TRAILER_PATTERN.test(trimmed);
}

function isValidRecallMeta(meta: RecallResultMeta): boolean {
  switch (meta.resultStatus) {
    case 'counted':
      return typeof meta.resultCount === 'number' && meta.resultCount >= 1;
    case 'no_results':
      return meta.resultCount === 0;
    case 'overflow':
      return Boolean(meta.artifactRef || (meta.previewItems && meta.previewItems.length > 0));
    case 'error':
    case 'parser_miss':
    case 'result_unmerged':
    case 'legacy_unknown':
      return meta.resultCount == null;
  }
}
