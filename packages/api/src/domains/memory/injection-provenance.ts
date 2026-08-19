/** Coordinates that let a reader drill from injected text back to its source. */
export interface InjectionProvenancePointer {
  source?: string;
  anchor?: string;
  sourcePath?: string;
  threadId?: string;
  messageId?: string;
  messageIds?: string[];
  sessionId?: string;
  eventNo?: number;
  invocationId?: string;
}

/** A story coordinate must lead beyond the registry record itself. */
export function hasInjectionStoryCoordinate(pointer: InjectionProvenancePointer, selfAnchor?: string): boolean {
  if (
    pointer.sourcePath ||
    pointer.threadId ||
    pointer.messageId ||
    pointer.messageIds?.length ||
    pointer.sessionId ||
    pointer.eventNo !== undefined ||
    pointer.invocationId
  ) {
    return true;
  }
  return Boolean(pointer.anchor && pointer.anchor !== selfAnchor);
}

function sanitizePointerValue(value: string | number): string {
  return String(value)
    .replace(/[\r\n;\]]/g, ' ')
    .trim();
}

/**
 * Render a compact, content-free provenance pointer.
 *
 * A source label alone is not drillable. Callers must provide at least one
 * coordinate, which turns the F263 renderer rule into a runtime invariant.
 */
export function formatInjectionProvenance(pointer: InjectionProvenancePointer): string {
  const hasCoordinate =
    Boolean(pointer.anchor) ||
    Boolean(pointer.sourcePath) ||
    Boolean(pointer.threadId) ||
    Boolean(pointer.messageId) ||
    Boolean(pointer.messageIds?.length) ||
    Boolean(pointer.sessionId) ||
    pointer.eventNo !== undefined ||
    Boolean(pointer.invocationId);
  if (!hasCoordinate) {
    throw new Error('injected provenance requires a drillable coordinate');
  }

  const fields: Array<[keyof InjectionProvenancePointer, string | number | undefined]> = [
    ['source', pointer.source],
    ['anchor', pointer.anchor],
    ['sourcePath', pointer.sourcePath],
    ['threadId', pointer.threadId],
    ['messageId', pointer.messageId],
    ['messageIds', pointer.messageIds?.join(',')],
    ['sessionId', pointer.sessionId],
    ['eventNo', pointer.eventNo],
    ['invocationId', pointer.invocationId],
  ];
  const body = fields
    .filter((entry): entry is [keyof InjectionProvenancePointer, string | number] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${sanitizePointerValue(value)}`)
    .join('; ');
  return `[provenance: ${body}]`;
}

export function hasInjectionProvenance(text: string): boolean {
  return /\[provenance:\s+[^\]]*(?:anchor|sourcePath|threadId|messageId|messageIds|sessionId|eventNo|invocationId)=/.test(
    text,
  );
}
