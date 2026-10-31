import type { TranscriptEvent } from './TranscriptReader.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function hasValidEnvelopeFields(envelope: Record<string, unknown>): boolean {
  return [
    isFiniteNumber(envelope.v),
    isFiniteNumber(envelope.t),
    isNonEmptyString(envelope.threadId),
    isNonEmptyString(envelope.catId),
    isNonEmptyString(envelope.sessionId),
    Number.isInteger(envelope.eventNo),
    isFiniteNumber(envelope.eventNo) && envelope.eventNo >= 0,
    isOptionalString(envelope.cliSessionId),
    isOptionalString(envelope.invocationId),
  ].every(Boolean);
}

/**
 * Normalize the persisted JSONL trust boundary before transcript events reach
 * readers or projectors. Historical files can contain syntactically valid JSON
 * with an invalid envelope, so a successful JSON.parse is not sufficient.
 */
export function normalizeTranscriptEvent(value: unknown): TranscriptEvent | undefined {
  const envelope = asRecord(value);
  const event = asRecord(envelope?.event);
  if (!envelope || !event) return undefined;
  if (!hasValidEnvelopeFields(envelope)) return undefined;

  return {
    v: envelope.v as number,
    t: envelope.t as number,
    threadId: envelope.threadId as string,
    catId: envelope.catId as string,
    sessionId: envelope.sessionId as string,
    ...(typeof envelope.cliSessionId === 'string' ? { cliSessionId: envelope.cliSessionId } : {}),
    ...(typeof envelope.invocationId === 'string' ? { invocationId: envelope.invocationId } : {}),
    eventNo: envelope.eventNo as number,
    event,
  };
}

export function transcriptEventFingerprint(event: Pick<TranscriptEvent, 't' | 'invocationId' | 'event'>): string {
  return JSON.stringify([event.t, event.invocationId ?? null, event.event]);
}

/**
 * Merge two projections of one canonical transcript without collapsing valid
 * duplicate events. The supplemental source is authoritative for its overlap
 * and suffix; unmatched primary events retain their original order.
 */
export function mergeTranscriptEventSources(
  primaryEvents: TranscriptEvent[],
  supplementalEvents: TranscriptEvent[],
): TranscriptEvent[] {
  if (supplementalEvents.length === 0) return primaryEvents;

  const supplementalCounts = new Map<string, number>();
  for (const event of supplementalEvents) {
    const key = transcriptEventFingerprint(event);
    supplementalCounts.set(key, (supplementalCounts.get(key) ?? 0) + 1);
  }

  const primaryOnly: TranscriptEvent[] = [];
  for (const event of primaryEvents) {
    const key = transcriptEventFingerprint(event);
    const remaining = supplementalCounts.get(key) ?? 0;
    if (remaining > 0) {
      if (remaining === 1) supplementalCounts.delete(key);
      else supplementalCounts.set(key, remaining - 1);
    } else {
      primaryOnly.push(event);
    }
  }

  return [...primaryOnly, ...supplementalEvents].map((event, eventNo) => ({ ...event, eventNo }));
}
