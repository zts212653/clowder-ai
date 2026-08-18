import type { IMessageStore, StoredMessage } from '../stores/ports/MessageStore.js';
import { isSystemUserMessage } from '../stores/visibility.js';
import { isAccessibleSourceRecord, isSourceGroupTerminal, sortSourceRecords } from './MessageBundleSourceProjection.js';
import type { MessageSelectionAuth } from './message-selection-types.js';

export type SourceRecordResolution =
  | { status: 'resolved'; anchor: StoredMessage; records: StoredMessage[] }
  | { status: 'unavailable' }
  | { status: 'changed' };

export type SourceRecordResolver = (
  sourceMessageIds: readonly string[],
  anchorMessageId: string,
  sourceThreadId: string,
  auth: MessageSelectionAuth,
) => Promise<SourceRecordResolution>;

interface ResolveCanonicalSourceRecordsInput {
  timeline: readonly StoredMessage[];
  sourceMessageIds: readonly string[];
  anchorMessageId: string;
  sourceThreadId: string;
  auth: MessageSelectionAuth;
}

function compareRecords(left: StoredMessage, right: StoredMessage): number {
  return left.timestamp - right.timestamp || left.id.localeCompare(right.id);
}

function isBrowserUserRecord(message: StoredMessage): boolean {
  return message.catId === null && message.source === undefined && !isSystemUserMessage(message);
}

function bubbleInvocationId(message: StoredMessage): string | null {
  if (message.extra?.isExplicitPost) return null;
  return message.extra?.stream?.turnInvocationId ?? message.extra?.stream?.invocationId ?? null;
}

function assistantBaseKey(message: StoredMessage): string | null {
  if (message.catId === null || isSystemUserMessage(message)) return null;
  const invocationId = bubbleInvocationId(message);
  return invocationId ? `${message.catId}::${invocationId}` : null;
}

function buildTurnSegments(records: readonly StoredMessage[]): Map<StoredMessage, number> {
  const segments = new Map<StoredMessage, number>();
  let segment = 0;
  for (const record of records) {
    if (isBrowserUserRecord(record)) segment += 1;
    segments.set(record, segment);
  }
  return segments;
}

function buildStreamSegments(
  records: readonly StoredMessage[],
  turnSegments: ReadonlyMap<StoredMessage, number>,
): Map<string, Map<string, number>> {
  const streams = new Map<string, Map<string, number>>();
  for (const record of records) {
    if (record.origin !== 'stream') continue;
    const baseKey = assistantBaseKey(record);
    const segment = turnSegments.get(record);
    if (!baseKey || segment === undefined) continue;
    const byId = streams.get(baseKey);
    if (byId) byId.set(record.id, segment);
    else streams.set(baseKey, new Map([[record.id, segment]]));
  }
  return streams;
}

function canonicalGroupKey(
  message: StoredMessage,
  turnSegments: ReadonlyMap<StoredMessage, number>,
  streamSegments: ReadonlyMap<string, ReadonlyMap<string, number>>,
): string {
  const baseKey = assistantBaseKey(message);
  if (!baseKey) return `message::${message.id}`;
  if (message.origin === 'callback') {
    const exactStreamSegment = streamSegments.get(baseKey)?.get(message.id);
    return exactStreamSegment === undefined
      ? `callback::${message.catId}::${message.id}`
      : `stream::${baseKey}::turn:${exactStreamSegment}`;
  }
  return `stream::${baseKey}::turn:${turnSegments.get(message) ?? 0}`;
}

/** Mirrors the Web canonical bubble projector's grouping identity on persisted records. */
export function canonicalSourceGroup(
  records: readonly StoredMessage[],
  anchorMessageId: string,
): StoredMessage[] | null {
  const sorted = records.slice().sort(compareRecords);
  const turnSegments = buildTurnSegments(sorted);
  const streamSegments = buildStreamSegments(sorted, turnSegments);
  const anchor = sorted.find((record) => record.id === anchorMessageId);
  if (!anchor) return null;
  const anchorKey = canonicalGroupKey(anchor, turnSegments, streamSegments);
  return sortSourceRecords(
    sorted.filter((record) => canonicalGroupKey(record, turnSegments, streamSegments) === anchorKey),
  );
}

function hasExactOrderedIds(records: readonly StoredMessage[], sourceMessageIds: readonly string[]): boolean {
  return (
    records.length === sourceMessageIds.length &&
    records.every((record, index) => record.id === sourceMessageIds[index])
  );
}

export async function resolveCanonicalSourceRecords({
  timeline,
  sourceMessageIds,
  anchorMessageId,
  sourceThreadId,
  auth,
}: ResolveCanonicalSourceRecordsInput): Promise<SourceRecordResolution> {
  const records = canonicalSourceGroup(timeline, anchorMessageId);
  if (!records) return { status: 'unavailable' };
  if (records.some((record) => !isAccessibleSourceRecord(record, sourceThreadId, auth))) {
    return { status: 'unavailable' };
  }
  if (!hasExactOrderedIds(records, sourceMessageIds) || !isSourceGroupTerminal(records)) {
    return { status: 'changed' };
  }
  const anchor = records.find((record) => record.id === anchorMessageId);
  return anchor ? { status: 'resolved', anchor, records } : { status: 'unavailable' };
}

/** One browser-equivalent timeline snapshot per source Thread and resolver operation. */
export function createCanonicalSourceRecordResolver(
  messageStore: Pick<IMessageStore, 'getByThreadAfter'>,
): SourceRecordResolver {
  const timelineByOwnerAndThread = new Map<string, Promise<StoredMessage[]>>();
  return async (sourceMessageIds, anchorMessageId, sourceThreadId, auth) => {
    const cacheKey = `${auth.userId}\0${sourceThreadId}`;
    let timeline = timelineByOwnerAndThread.get(cacheKey);
    if (!timeline) {
      timeline = Promise.resolve(
        messageStore.getByThreadAfter(sourceThreadId, undefined, undefined, auth.userId, {
          includeQueuedCatMessages: true,
          includeQueuedUserMessages: true,
          includeRecalledUserMessages: true,
        }),
      );
      timelineByOwnerAndThread.set(cacheKey, timeline);
    }
    return resolveCanonicalSourceRecords({
      timeline: await timeline,
      sourceMessageIds,
      anchorMessageId,
      sourceThreadId,
      auth,
    });
  };
}
