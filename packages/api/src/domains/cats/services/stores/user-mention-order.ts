import { messageFrom } from './message-from.js';
import type { StoredMessage } from './ports/MessageStore.js';
import { isTimelinePublished } from './visibility.js';

export type UserMentionEvent = 'request' | 'reply';
export type UserMentionHandlingReason = 'viewed' | 'replied' | 'ignored';

export interface UserMentionHandlingMetadata {
  reason: UserMentionHandlingReason;
  handledAt: number;
}

/** Explicit persisted mention and published human reply are the only input signals. No prose classification. */
export function userMentionEvent(message: StoredMessage): UserMentionEvent | null {
  if (message.visibility === 'whisper' || message.deletedAt || message.recall || !isTimelinePublished(message)) {
    return null;
  }
  if (message.source || message.sourceParseFailure || message.origin === 'briefing') return null;
  if (
    message.extra?.systemKind ||
    message.extra?.systemInfo ||
    message.userId === 'system' ||
    message.userId === 'scheduler'
  ) {
    return null;
  }
  const sender = messageFrom(message);
  if (sender.kind === 'user') return message.extra?.crossPost ? null : 'reply';
  return sender.kind === 'agent' && message.mentionsUser ? 'request' : null;
}

export interface MentionCoordinate {
  id: string;
  position: number;
}

export interface MentionState {
  ownerUserId: string;
  threadId: string;
  current: MentionCoordinate | null;
  pending: boolean;
  /** Human replies retain the legacy logical/message-id boundary. */
  replyClosedThrough: string;
  /** Durable reads use the canonical visibility boundary without advancing the reply/legacy ID barrier. */
  handledThrough: MentionCoordinate | null;
  candidates: Map<string, number>;
  restoredId: string;
  revision: number;
}

export type MentionRef = { threadId: string; messageId: string; expectedRevision?: number };

export type SavedMentionHandling = MentionRef & {
  coordinate: MentionCoordinate;
  previousReplyClosed: string;
  previousHandledThrough: MentionCoordinate | null;
  previousRestored: string;
  candidates: MentionCoordinate[];
  replyClosedAfter: string;
  handledThroughAfter: MentionCoordinate | null;
  revision: number;
};

export function messageMentionCoordinate(message: StoredMessage): MentionCoordinate | null {
  const position = message.visibilitySeq;
  return typeof position === 'number' && Number.isSafeInteger(position) && position >= 0
    ? { id: message.id, position }
    : null;
}

export function compareMentionCoordinates(left: MentionCoordinate, right: MentionCoordinate): number {
  return left.position === right.position ? left.id.localeCompare(right.id) : left.position - right.position;
}

export function sameMentionCoordinate(left: MentionCoordinate | null, right: MentionCoordinate | null): boolean {
  return left === right || (!!left && !!right && left.id === right.id && left.position === right.position);
}

export function latestMentionCoordinate(candidates: ReadonlyMap<string, number>): MentionCoordinate | null {
  let latest: MentionCoordinate | null = null;
  for (const [id, position] of candidates) {
    const candidate = { id, position };
    if (!latest || compareMentionCoordinates(candidate, latest) > 0) latest = candidate;
  }
  return latest;
}

export function isMentionSuppressed(state: MentionState, messageId: string, coordinate: MentionCoordinate): boolean {
  if (messageId === state.restoredId) return false;
  if (messageId <= state.replyClosedThrough) return true;
  return !!state.handledThrough && compareMentionCoordinates(coordinate, state.handledThrough) <= 0;
}

export function observeMentionRequestState(
  state: MentionState,
  messageId: string,
  coordinate: MentionCoordinate,
): void {
  if (!state.candidates.has(messageId)) state.revision++;
  state.candidates.set(messageId, coordinate.position);
  if (!state.current || compareMentionCoordinates(coordinate, state.current) > 0) {
    state.current = coordinate;
    state.pending = true;
  }
}

export function latestReplyCandidateId(state: MentionState, replyId: string): string | undefined {
  return [...state.candidates.keys()]
    .filter((candidateId) => candidateId <= replyId)
    .sort()
    .at(-1);
}

export function selectCurrentMentionRequest(
  state: MentionState,
  userId: string,
  get: (id: string) => StoredMessage | null,
): StoredMessage | null {
  const candidates = [...state.candidates]
    .map(([id, position]) => ({ id, position }))
    .sort((left, right) => compareMentionCoordinates(right, left));
  for (const candidate of candidates) {
    const message = get(candidate.id);
    const open =
      candidate.id === state.restoredId ||
      (candidate.id > state.replyClosedThrough &&
        (!state.handledThrough || compareMentionCoordinates(candidate, state.handledThrough) > 0));
    if (open && message?.userId === userId && userMentionEvent(message) === 'request') return message;
    state.candidates.delete(candidate.id);
  }
  return null;
}
