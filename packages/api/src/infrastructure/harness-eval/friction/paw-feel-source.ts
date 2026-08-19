import { createHash } from 'node:crypto';
import { isCrossThreadProvenance, type PawFeelSignalId } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../../domains/cats/services/stores/ports/MessageStore.js';
import { getTimelineOrderTime } from '../../../domains/cats/services/stores/visibility.js';
import { extractPawFeelMarkers, isStandalonePawFeelMarker, type PawFeelMarker } from './paw-feel-marker.js';

const DEFAULT_PAGE_SIZE = 200;

export interface PawFeelSourceOptions {
  pageSize?: number;
}

export interface CanonicalPawFeelCandidate {
  signalId: PawFeelSignalId;
  sourceMessageId: string;
  sourceThreadId: string;
  sourceCatId: string;
  markerDigest: string;
  sameDigestOrdinal: number;
  markerIndex: number;
  occurredAt: string;
  captureAssessment: 'ambiguous';
  /** Ephemeral only. F278 persistence must keep only its digest and source ref. */
  marker: PawFeelMarker;
}

export type PawFeelMessageInspection =
  | { kind: 'ignored' }
  | { kind: 'cross_post_copy'; markerCount: number }
  | { kind: 'canonical'; captureAssessment: 'ambiguous'; candidates: CanonicalPawFeelCandidate[] };

interface PageCursor {
  ts: number;
  id: string;
}

export function pawFeelMarkerDigest(rawMarker: string): string {
  return createHash('sha256').update(rawMarker).digest('hex');
}

export function buildPawFeelSignalId(
  sourceMessageId: string,
  markerDigest: string,
  sameDigestOrdinal: number,
): PawFeelSignalId {
  return `${sourceMessageId}:${markerDigest}:${sameDigestOrdinal}`;
}

export function inspectPawFeelMessage(message: StoredMessage): PawFeelMessageInspection {
  return inspectPawFeelMessageWithMode(message, 'legacy');
}

export function inspectDeclaredPawFeelMessage(message: StoredMessage): PawFeelMessageInspection {
  return inspectPawFeelMessageWithMode(message, 'typed_intent');
}

function inspectPawFeelMessageWithMode(
  message: StoredMessage,
  mode: 'legacy' | 'typed_intent',
): PawFeelMessageInspection {
  const sourceCatId = message.catId;
  if (!sourceCatId) return { kind: 'ignored' };
  const markers = extractPawFeelMarkers(message.content);
  if (markers.length === 0) return { kind: 'ignored' };
  if (isCrossThreadProvenance(message.extra?.crossPost?.sourceThreadId, message.threadId)) {
    return { kind: 'cross_post_copy', markerCount: markers.length };
  }

  const digestCounts = new Map<string, number>();
  const candidates = markers.map((marker, markerIndex) => {
    const markerDigest = pawFeelMarkerDigest(marker.raw);
    const sameDigestOrdinal = digestCounts.get(markerDigest) ?? 0;
    digestCounts.set(markerDigest, sameDigestOrdinal + 1);
    return {
      signalId: buildPawFeelSignalId(message.id, markerDigest, sameDigestOrdinal),
      sourceMessageId: message.id,
      sourceThreadId: message.threadId,
      sourceCatId,
      markerDigest,
      sameDigestOrdinal,
      markerIndex,
      occurredAt: new Date(getTimelineOrderTime(message)).toISOString(),
      captureAssessment: 'ambiguous' as const,
      marker,
    };
  });
  const selected =
    mode === 'typed_intent'
      ? candidates.filter((candidate) => isStandalonePawFeelMarker(message.content, candidate.marker))
      : candidates;
  return selected.length === 0
    ? { kind: 'ignored' }
    : { kind: 'canonical', captureAssessment: 'ambiguous', candidates: selected };
}

export async function collectPawFeelMessages(
  messageStore: Pick<IMessageStore, 'getBefore'>,
  sinceMs: number,
  untilMs: number,
  options: PawFeelSourceOptions = {},
): Promise<StoredMessage[]> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const collected: StoredMessage[] = [];
  const seen = new Set<string>();
  let cursor: PageCursor | undefined;

  for (;;) {
    const page = await fetchBefore(messageStore, cursor, untilMs, pageSize);
    if (page.length === 0) break;
    const fresh = absorbPage(page, seen, collected, sinceMs, untilMs);
    const oldest = page[0];
    if (!oldest || fresh === 0 || getTimelineOrderTime(oldest) < sinceMs || page.length < pageSize) break;
    cursor = { ts: getTimelineOrderTime(oldest), id: oldest.id };
  }
  return collected;
}

function fetchBefore(
  messageStore: Pick<IMessageStore, 'getBefore'>,
  cursor: PageCursor | undefined,
  untilMs: number,
  pageSize: number,
): StoredMessage[] | Promise<StoredMessage[]> {
  return cursor
    ? messageStore.getBefore(cursor.ts, pageSize, undefined, cursor.id)
    : messageStore.getBefore(untilMs, pageSize, undefined);
}

function absorbPage(
  page: StoredMessage[],
  seen: Set<string>,
  collected: StoredMessage[],
  sinceMs: number,
  untilMs: number,
): number {
  let fresh = 0;
  for (const message of page) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    fresh += 1;
    const timestamp = getTimelineOrderTime(message);
    if (timestamp >= sinceMs && timestamp < untilMs) collected.push(message);
  }
  return fresh;
}
