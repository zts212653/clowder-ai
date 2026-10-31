import { isRecallResultStatus, RECALL_RESOLVER_FAMILIES } from '@cat-cafe/shared';
import type { RecallReplyCoordinate, RecallReplyCursor } from '@/hooks/recall-reply-lookup';
import type { RecallEvent } from '@/hooks/recall-types';
export interface MemoryRecallPageData {
  days: number;
  from: number;
  to: number;
  readStatus: 'ready' | 'partial';
  records: Array<{ threadId: string; threadTitle: string; event: RecallEvent }>;
  replies: Array<RecallReplyCoordinate & { threadId: string }>;
  replyCursors?: Record<string, RecallReplyCursor | null>;
  nextCursor: string | null;
}
export interface RecallLedger {
  days: number;
  from: number;
  to: number;
  rows: Array<{ source: 'pull' | 'push'; surface: string; presented: number; inspected: number; used: number }>;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const identifier = (value: unknown) => typeof value === 'string' && value.length > 0;
function window(value: Record<string, unknown>) {
  return (
    typeof value.days === 'number' &&
    [7, 14, 30].includes(value.days) &&
    typeof value.from === 'number' &&
    Number.isFinite(value.from) &&
    count(value.to) &&
    value.from <= Number(value.to)
  );
}
function recallResult(value: unknown): boolean {
  return (
    record(value) &&
    typeof value.title === 'string' &&
    (value.href == null || typeof value.href === 'string') &&
    (value.titleStatus === undefined || value.titleStatus === 'loading' || value.titleStatus === 'unavailable') &&
    (value.consumed === undefined || typeof value.consumed === 'boolean')
  );
}
function eventStatuses(value: Record<string, unknown>): boolean {
  return (
    (value.resultCount === undefined || count(value.resultCount)) &&
    (value.resultStatus === undefined || isRecallResultStatus(value.resultStatus)) &&
    (value.cueStatus === undefined ||
      ['presented_unreported', 'drilled', 'applied', 'dismissed', 'invalidated'].includes(String(value.cueStatus))) &&
    (value.resolverFamily === undefined || RECALL_RESOLVER_FAMILIES.some((family) => family === value.resolverFamily))
  );
}
function event(value: unknown): boolean {
  if (!record(value) || !identifier(value.id) || typeof value.query !== 'string' || !count(value.timestamp))
    return false;
  if (value.source !== 'pull' && value.source !== 'push') return false;
  for (const key of ['catId', 'invocationId', 'cueId', 'sourceRevision'])
    if (value[key] !== undefined && !identifier(value[key])) return false;
  if (!eventStatuses(value)) return false;
  return value.results === undefined || (Array.isArray(value.results) && value.results.every(recallResult));
}
export function isRecallPage(value: unknown): value is MemoryRecallPageData {
  if (
    !record(value) ||
    !window(value) ||
    !['ready', 'partial'].includes(String(value.readStatus)) ||
    !Array.isArray(value.records) ||
    !Array.isArray(value.replies)
  )
    return false;
  if (!(value.nextCursor === null || identifier(value.nextCursor))) return false;
  if (
    value.replyCursors !== undefined &&
    (!record(value.replyCursors) ||
      !Object.values(value.replyCursors).every(
        (cursor) => cursor === null || (record(cursor) && count(cursor.timestamp) && identifier(cursor.messageId)),
      ))
  )
    return false;
  return (
    value.records.every(
      (row: unknown) =>
        record(row) && identifier(row.threadId) && typeof row.threadTitle === 'string' && event(row.event),
    ) &&
    value.replies.every(
      (row: unknown) =>
        record(row) &&
        identifier(row.threadId) &&
        identifier(row.messageId) &&
        identifier(row.catId) &&
        identifier(row.invocationId) &&
        count(row.timestamp) &&
        (row.parentInvocationId === undefined || identifier(row.parentInvocationId)),
    )
  );
}
export function isRecallLedger(value: unknown): value is RecallLedger {
  return (
    record(value) &&
    window(value) &&
    Array.isArray(value.rows) &&
    value.rows.every(
      (row: unknown) =>
        record(row) &&
        (row.source === 'push' || row.source === 'pull') &&
        typeof row.surface === 'string' &&
        ['presented', 'inspected', 'used'].every((key) => count(row[key])),
    )
  );
}
