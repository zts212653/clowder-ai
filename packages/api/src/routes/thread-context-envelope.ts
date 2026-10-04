import { createHash } from 'node:crypto';

export const THREAD_CONTEXT_RESPONSE_MAX_BYTES = 24_000;
const THREAD_CONTEXT_CURSOR_MAX_LENGTH = 4_096;

export interface ThreadContextCursorScope {
  readonly threadId: string;
  readonly userId: string;
  readonly catId: string;
  readonly limit: number;
  readonly messageId?: string;
  readonly before?: number;
  readonly after?: number;
  readonly filterCatId?: string;
  readonly keyword?: string;
  readonly responseMode: 'anchor' | 'full';
  readonly readIntent: 'history' | 'unread';
}

export type ThreadContextSelection =
  | { readonly kind: 'history' }
  | { readonly kind: 'unread'; readonly afterCursor?: string };

interface ThreadContextCursorV1 {
  readonly v: 1;
  readonly scopeHash: string;
  readonly lastItemId: string;
  readonly selection: ThreadContextSelection;
  /**
   * The previous page exhausted its bounded unread candidate window and moved
   * `selection.afterCursor` to the last returned storage item. The next page
   * therefore starts at index zero of a newly selected window instead of
   * looking for `lastItemId` inside that window.
   */
  readonly resumeFromStart?: true;
}

export interface ThreadContextEnvelopeCandidate<TProjection extends Record<string, unknown>> {
  readonly id: string;
  readonly projection: TProjection;
  readonly oversizedProjection: TProjection;
  readonly originalChars: number;
  readonly source: 'published' | 'queued';
}

interface ThreadContextEnvelopeBase {
  readonly threadId: string;
  readonly scanCapped?: boolean;
  readonly workflowSop?: Record<string, unknown>;
}

export interface ThreadContextEnvelopePage<TProjection extends Record<string, unknown>> {
  readonly payload: ThreadContextEnvelopeBase & {
    readonly messages: TProjection[];
    readonly hasMore: boolean;
    readonly nextCursor?: string;
  };
  readonly candidates: ThreadContextEnvelopeCandidate<TProjection>[];
}

interface BuiltThreadContextEnvelopePage<TProjection extends Record<string, unknown>>
  extends ThreadContextEnvelopePage<TProjection> {
  readonly completeCandidateCount: number;
}

export class InvalidThreadContextCursorError extends Error {
  constructor(message = 'cursor is malformed or belongs to another thread-context read') {
    super(message);
    this.name = 'InvalidThreadContextCursorError';
  }
}

export function hashThreadContextCursorScope(scope: ThreadContextCursorScope): string {
  return createHash('sha256').update(JSON.stringify(scope)).digest('base64url');
}

function encodeThreadContextCursor(cursor: ThreadContextCursorV1): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeThreadContextCursor(
  value: string | undefined,
  expectedScopeHash: string,
): ThreadContextCursorV1 | undefined {
  if (!value) return undefined;
  if (value.length > THREAD_CONTEXT_CURSOR_MAX_LENGTH) throw new InvalidThreadContextCursorError();
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<ThreadContextCursorV1>;
    if (
      parsed.v !== 1 ||
      parsed.scopeHash !== expectedScopeHash ||
      typeof parsed.lastItemId !== 'string' ||
      parsed.lastItemId.length === 0 ||
      !parsed.selection ||
      (parsed.selection.kind !== 'history' && parsed.selection.kind !== 'unread') ||
      (parsed.selection.kind === 'unread' &&
        parsed.selection.afterCursor !== undefined &&
        (typeof parsed.selection.afterCursor !== 'string' || parsed.selection.afterCursor.length === 0)) ||
      (parsed.resumeFromStart !== undefined && parsed.resumeFromStart !== true) ||
      (parsed.resumeFromStart === true && parsed.selection.kind !== 'unread')
    ) {
      throw new Error('cursor scope mismatch');
    }
    return parsed as ThreadContextCursorV1;
  } catch (error) {
    if (error instanceof InvalidThreadContextCursorError) throw error;
    throw new InvalidThreadContextCursorError();
  }
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function buildPayload<TProjection extends Record<string, unknown>>(
  base: ThreadContextEnvelopeBase,
  messages: TProjection[],
  hasMore: boolean,
  nextCursor?: string,
) {
  return {
    threadId: base.threadId,
    messages,
    hasMore,
    ...(nextCursor ? { nextCursor } : {}),
    ...(base.scanCapped === undefined ? {} : { scanCapped: base.scanCapped }),
    ...(base.workflowSop ? { workflowSop: base.workflowSop } : {}),
  };
}

function cursorAfterCandidate(
  hasMore: boolean,
  scopeHash: string,
  candidateId: string,
  selection: ThreadContextSelection,
  resumeFromStart = false,
): string | undefined {
  if (!hasMore) return undefined;
  return encodeThreadContextCursor({
    v: 1,
    scopeHash,
    lastItemId: candidateId,
    selection,
    ...(resumeFromStart ? { resumeFromStart: true } : {}),
  });
}

type CandidateFit = 'full' | 'oversized' | 'stop' | 'unbounded';

function continuationAfterCandidate(input: {
  readonly candidateIndex: number;
  readonly candidateCount: number;
  readonly selection: ThreadContextSelection;
  readonly tailContinuationSelection?: ThreadContextSelection;
}): { readonly hasMore: boolean; readonly selection: ThreadContextSelection; readonly resumeFromStart: boolean } {
  if (input.candidateIndex + 1 < input.candidateCount) {
    return { hasMore: true, selection: input.selection, resumeFromStart: false };
  }
  if (input.tailContinuationSelection) {
    return { hasMore: true, selection: input.tailContinuationSelection, resumeFromStart: true };
  }
  return { hasMore: false, selection: input.selection, resumeFromStart: false };
}

function fitCandidate<TProjection extends Record<string, unknown>>(input: {
  readonly base: ThreadContextEnvelopeBase;
  readonly selected: ThreadContextEnvelopeCandidate<TProjection>[];
  readonly candidate: ThreadContextEnvelopeCandidate<TProjection>;
  readonly hasMore: boolean;
  readonly nextCursor?: string;
  readonly maxBytes: number;
}): CandidateFit {
  const selectedProjections = input.selected.map((item) => item.projection);
  const fullPayload = buildPayload(
    input.base,
    [...selectedProjections, input.candidate.projection],
    input.hasMore,
    input.nextCursor,
  );
  if (serializedBytes(fullPayload) <= input.maxBytes) return 'full';

  if (input.selected.length > 0) {
    const candidateAlone = buildPayload(input.base, [input.candidate.projection], input.hasMore, input.nextCursor);
    if (serializedBytes(candidateAlone) <= input.maxBytes) return 'stop';
  }

  const oversizedPayload = buildPayload(
    input.base,
    [...selectedProjections, input.candidate.oversizedProjection],
    input.hasMore,
    input.nextCursor,
  );
  if (serializedBytes(oversizedPayload) <= input.maxBytes) return 'oversized';
  return input.selected.length > 0 ? 'stop' : 'unbounded';
}

function tryBuildPage<TProjection extends Record<string, unknown>>(input: {
  readonly base: ThreadContextEnvelopeBase;
  readonly allCandidates: ThreadContextEnvelopeCandidate<TProjection>[];
  readonly startIndex: number;
  readonly scopeHash: string;
  readonly selection: ThreadContextSelection;
  readonly tailContinuationSelection?: ThreadContextSelection;
  readonly maxBytes: number;
}): BuiltThreadContextEnvelopePage<TProjection> | undefined {
  const selected: ThreadContextEnvelopeCandidate<TProjection>[] = [];
  let completeCandidateCount = 0;
  for (let index = input.startIndex; index < input.allCandidates.length; index += 1) {
    const candidate = input.allCandidates[index];
    if (!candidate) continue;
    const continuation = continuationAfterCandidate({
      candidateIndex: index,
      candidateCount: input.allCandidates.length,
      selection: input.selection,
      tailContinuationSelection: input.tailContinuationSelection,
    });
    const nextCursor = cursorAfterCandidate(
      continuation.hasMore,
      input.scopeHash,
      candidate.id,
      continuation.selection,
      continuation.resumeFromStart,
    );
    const fit = fitCandidate({ ...input, selected, candidate, hasMore: continuation.hasMore, nextCursor });
    if (fit === 'full') {
      selected.push(candidate);
      completeCandidateCount += 1;
      continue;
    }
    if (fit === 'oversized') {
      selected.push({ ...candidate, projection: candidate.oversizedProjection });
      continue;
    }
    if (fit === 'stop') break;
    return undefined;
  }

  const lastSelected = selected.at(-1);
  const consumedThrough = lastSelected
    ? input.allCandidates.findIndex((candidate) => candidate.id === lastSelected.id) + 1
    : input.startIndex;
  const continuation = lastSelected
    ? continuationAfterCandidate({
        candidateIndex: consumedThrough - 1,
        candidateCount: input.allCandidates.length,
        selection: input.selection,
        tailContinuationSelection: input.tailContinuationSelection,
      })
    : { hasMore: false, selection: input.selection, resumeFromStart: false };
  const nextCursor = lastSelected
    ? cursorAfterCandidate(
        continuation.hasMore,
        input.scopeHash,
        lastSelected.id,
        continuation.selection,
        continuation.resumeFromStart,
      )
    : undefined;
  const payload = buildPayload(
    input.base,
    selected.map((candidate) => candidate.projection),
    continuation.hasMore,
    nextCursor,
  );
  return serializedBytes(payload) <= input.maxBytes
    ? { payload, candidates: selected, completeCandidateCount }
    : undefined;
}

function preservesMoreContext<TProjection extends Record<string, unknown>>(
  candidate: BuiltThreadContextEnvelopePage<TProjection>,
  current: BuiltThreadContextEnvelopePage<TProjection>,
): boolean {
  if (candidate.completeCandidateCount !== current.completeCandidateCount) {
    return candidate.completeCandidateCount > current.completeCandidateCount;
  }
  return candidate.candidates.length > current.candidates.length;
}

export function pageThreadContextEnvelope<TProjection extends Record<string, unknown>>(input: {
  readonly base: ThreadContextEnvelopeBase;
  readonly boundedBase?: ThreadContextEnvelopeBase;
  readonly allCandidates: ThreadContextEnvelopeCandidate<TProjection>[];
  readonly cursor: ThreadContextCursorV1 | undefined;
  readonly scopeHash: string;
  readonly selection: ThreadContextSelection;
  /** Known unread storage continuation after `allCandidates` is exhausted. */
  readonly tailContinuationSelection?: ThreadContextSelection;
  readonly maxBytes?: number;
}): ThreadContextEnvelopePage<TProjection> {
  const maxBytes = input.maxBytes ?? THREAD_CONTEXT_RESPONSE_MAX_BYTES;
  let startIndex = 0;
  if (input.cursor && !input.cursor.resumeFromStart) {
    const lastIndex = input.allCandidates.findIndex((candidate) => candidate.id === input.cursor?.lastItemId);
    if (lastIndex < 0) throw new InvalidThreadContextCursorError('cursor resume point is no longer available');
    startIndex = lastIndex + 1;
  }

  const pageWithBase = (base: ThreadContextEnvelopeBase) =>
    tryBuildPage({
      base,
      allCandidates: input.allCandidates,
      startIndex,
      scopeHash: input.scopeHash,
      selection: input.selection,
      tailContinuationSelection: input.tailContinuationSelection,
      maxBytes,
    });

  const primaryPage = pageWithBase(input.base);
  if (!primaryPage) {
    const boundedPage = input.boundedBase ? pageWithBase(input.boundedBase) : undefined;
    if (boundedPage) return boundedPage;
    throw new Error('thread-context envelope cannot fit one bounded response');
  }

  if (!input.boundedBase) return primaryPage;
  const boundedPage = pageWithBase(input.boundedBase);
  return boundedPage && preservesMoreContext(boundedPage, primaryPage) ? boundedPage : primaryPage;
}
