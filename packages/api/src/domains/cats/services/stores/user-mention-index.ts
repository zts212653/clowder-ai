import { randomUUID } from 'node:crypto';
import type { StoredMessage } from './ports/MessageStore.js';
import {
  compareMentionCoordinates,
  isMentionSuppressed,
  latestMentionCoordinate,
  latestReplyCandidateId,
  type MentionCoordinate,
  type MentionRef,
  type MentionState,
  messageMentionCoordinate,
  observeMentionRequestState,
  type SavedMentionHandling,
  sameMentionCoordinate,
  selectCurrentMentionRequest,
  type UserMentionHandlingMetadata,
  type UserMentionHandlingReason,
  userMentionEvent,
} from './user-mention-order.js';

export type { UserMentionHandlingMetadata, UserMentionHandlingReason } from './user-mention-order.js';
export { userMentionEvent } from './user-mention-order.js';

/** Message-owned identities and versions, mirrored by the atomic Redis projection. */
export class UserMentionIndex {
  private readonly latest = new Map<string, MentionState>();
  private readonly handledRefs = new Map<string, Set<string>>();
  private readonly handledMetadata = new Map<string, Map<string, UserMentionHandlingMetadata>>();
  private readonly undo = new Map<string, { userId: string; rows: SavedMentionHandling[] }>();
  private readonly lastUndo = new Map<string, string>();

  revisions(userId: string): Record<string, number> {
    return Object.fromEntries(
      [...this.latest].filter(([, s]) => s.ownerUserId === userId).map(([, s]) => [s.threadId, s.revision]),
    );
  }

  lastHandling(userId: string, get: (id: string) => StoredMessage | null) {
    const undoId = this.lastUndo.get(userId);
    const action = undoId ? this.undo.get(undoId) : null;
    return action && undoId
      ? {
          undoId,
          handled: action.rows.length,
          remaining: action.rows.filter((row) =>
            this.canUndo(this.latest.get(this.key(userId, row.threadId)), row, userId, get(row.messageId)),
          ).length,
        }
      : null;
  }

  handled(userId: string, get: (id: string) => StoredMessage | null): StoredMessage[] {
    return [...(this.handledRefs.get(userId) ?? [])]
      .map(get)
      .filter((m): m is StoredMessage => m !== null && m.userId === userId && userMentionEvent(m) === 'request')
      .sort((a, b) => b.id.localeCompare(a.id));
  }

  handlingMetadata(userId: string): Record<string, UserMentionHandlingMetadata> {
    return Object.fromEntries(this.handledMetadata.get(userId) ?? []);
  }

  handle(userId: string, refs: MentionRef[]) {
    if (!refs.length || new Set(refs.map((r) => r.threadId)).size !== refs.length) return null;
    const rows: { ref: MentionRef; current: MentionState; coordinate: MentionCoordinate }[] = [];
    for (const ref of refs) {
      const current = this.latest.get(this.key(userId, ref.threadId));
      const coordinate = current?.current;
      if (
        !current?.pending ||
        !coordinate ||
        coordinate.id !== ref.messageId ||
        !this.matchesRevision(current, ref.expectedRevision)
      )
        return null;
      rows.push({ ref, current, coordinate });
    }
    const saved: SavedMentionHandling[] = rows.map(({ ref, current, coordinate }) => ({
      ...ref,
      coordinate: { ...coordinate },
      previousReplyClosed: current.replyClosedThrough,
      previousHandledThrough: current.handledThrough ? { ...current.handledThrough } : null,
      previousRestored: current.restoredId,
      candidates: [...current.candidates].map(([id, position]) => ({ id, position })),
      replyClosedAfter: '',
      handledThroughAfter: null,
      revision: 0,
    }));
    for (const [i, { ref, current, coordinate }] of rows.entries()) {
      this.recordHandling(userId, ref.messageId, 'ignored', Date.now());
      this.closeExplicitHandling(current, coordinate);
      const savedRow = saved[i];
      if (!savedRow) throw new Error('Missing saved mention handling row');
      savedRow.replyClosedAfter = current.replyClosedThrough;
      savedRow.handledThroughAfter = current.handledThrough ? { ...current.handledThrough } : null;
      savedRow.revision = current.revision;
    }
    const old = this.lastUndo.get(userId);
    if (old) this.undo.delete(old);
    const undoId = randomUUID();
    this.undo.set(undoId, { userId, rows: saved });
    this.lastUndo.set(userId, undoId);
    return { handled: rows.length, undoId };
  }

  undoHandling(userId: string, undoId: string, get: (id: string) => StoredMessage | null) {
    const action = this.undo.get(undoId);
    if (!action || action.userId !== userId) return null;
    this.undo.delete(undoId);
    let restored = 0;
    for (const row of action.rows) {
      const current = this.latest.get(this.key(userId, row.threadId));
      const message = get(row.messageId);
      if (!this.canUndo(current, row, userId, message)) continue;
      current.replyClosedThrough = row.previousReplyClosed;
      current.handledThrough = row.previousHandledThrough ? { ...row.previousHandledThrough } : null;
      current.current = { ...row.coordinate };
      current.restoredId = row.previousRestored;
      current.pending = true;
      current.revision++;
      for (const candidate of row.candidates) current.candidates.set(candidate.id, candidate.position);
      this.handledRefs.get(userId)?.delete(row.messageId);
      this.handledMetadata.get(userId)?.delete(row.messageId);
      restored++;
    }
    return { restored };
  }

  private canUndo(
    current: MentionState | undefined,
    row: SavedMentionHandling,
    userId: string,
    message: StoredMessage | null,
  ): current is MentionState {
    return (
      !!current &&
      !current.pending &&
      current.revision === row.revision &&
      current.replyClosedThrough === row.replyClosedAfter &&
      sameMentionCoordinate(current.handledThrough, row.handledThroughAfter) &&
      current.current?.id === row.messageId &&
      !!message &&
      message.userId === userId &&
      message.threadId === row.threadId &&
      userMentionEvent(message) === 'request'
    );
  }

  restore(
    userId: string,
    threadId: string,
    messageId: string,
    expectedRevision: number,
    get: (id: string) => StoredMessage | null,
  ): boolean {
    const state = this.latest.get(this.key(userId, threadId));
    const message = get(messageId);
    const coordinate = message ? messageMentionCoordinate(message) : null;
    if (
      !state ||
      state.pending ||
      state.revision !== expectedRevision ||
      !this.handledRefs.get(userId)?.has(messageId) ||
      !message ||
      message.userId !== userId ||
      message.threadId !== threadId ||
      userMentionEvent(message) !== 'request' ||
      !coordinate
    )
      return false;
    state.current = coordinate;
    state.restoredId = messageId;
    state.pending = true;
    state.candidates.set(messageId, coordinate.position);
    state.revision++;
    this.handledRefs.get(userId)?.delete(messageId);
    this.handledMetadata.get(userId)?.delete(messageId);
    return true;
  }

  private key(userId: string, threadId: string): string {
    return JSON.stringify([userId, threadId]);
  }

  observe(message: StoredMessage): void {
    const event = userMentionEvent(message);
    const coordinate = messageMentionCoordinate(message);
    if (!event || !coordinate) return;
    const key = this.key(message.userId, message.threadId);
    const current = this.latest.get(key) ?? {
      ownerUserId: message.userId,
      threadId: message.threadId,
      current: null,
      pending: false,
      replyClosedThrough: '',
      handledThrough: null,
      candidates: new Map<string, number>(),
      restoredId: '',
      revision: 0,
    };
    this.latest.set(key, current);
    if (isMentionSuppressed(current, message.id, coordinate)) return;
    if (event === 'request') {
      observeMentionRequestState(current, message.id, coordinate);
    } else {
      const repliedRequestId = latestReplyCandidateId(current, message.id);
      if (repliedRequestId) {
        this.recordHandling(message.userId, repliedRequestId, 'replied', message.deliveredAt ?? message.timestamp);
      }
      this.closeReplyThrough(current, message.id);
    }
  }

  list(userId: string, get: (id: string) => StoredMessage | null): StoredMessage[] {
    const messages: StoredMessage[] = [];
    for (const current of this.latest.values()) {
      if (!current.pending || current.ownerUserId !== userId) continue;
      const found = selectCurrentMentionRequest(current, userId, get);
      current.current = found ? messageMentionCoordinate(found) : null;
      current.pending = found !== null;
      if (found) messages.push(found);
    }
    return messages.sort((a, b) => b.id.localeCompare(a.id));
  }

  resolve(userId: string, threadId: string, expectedMessageId: string, expectedRevision?: number): boolean {
    const current = this.latest.get(this.key(userId, threadId));
    if (
      !current?.pending ||
      current.current?.id !== expectedMessageId ||
      !this.matchesRevision(current, expectedRevision)
    )
      return false;
    this.recordHandling(userId, expectedMessageId, 'ignored', Date.now());
    this.closeExplicitHandling(current, current.current);
    return true;
  }

  resolveRead(
    userId: string,
    threadId: string,
    expectedMessageId: string,
    boundary: MentionCoordinate,
    handledAt: number,
  ): boolean {
    const current = this.latest.get(this.key(userId, threadId));
    if (!current?.pending || current.current?.id !== expectedMessageId) return false;
    this.recordHandling(userId, expectedMessageId, 'viewed', handledAt);
    this.closeHandledThrough(current, boundary);
    return true;
  }

  private recordHandling(
    userId: string,
    messageId: string,
    reason: UserMentionHandlingReason,
    handledAt: number,
  ): void {
    const handled = this.handledRefs.get(userId) ?? new Set<string>();
    this.handledRefs.set(userId, handled);
    handled.add(messageId);
    const metadata = this.handledMetadata.get(userId) ?? new Map<string, UserMentionHandlingMetadata>();
    this.handledMetadata.set(userId, metadata);
    metadata.set(messageId, { reason, handledAt });
  }

  private matchesRevision(current: MentionState, revision?: number): boolean {
    return revision === undefined ? current.restoredId === '' : revision === current.revision;
  }

  private closeReplyThrough(current: MentionState, messageId: string): void {
    if (messageId > current.replyClosedThrough) current.replyClosedThrough = messageId;
    current.restoredId = '';
    current.revision++;
    for (const id of current.candidates.keys()) {
      if (id <= current.replyClosedThrough) current.candidates.delete(id);
    }
    this.reconcileCurrent(current);
  }

  private closeExplicitHandling(current: MentionState, coordinate: MentionCoordinate): void {
    for (const id of current.candidates.keys()) {
      if (id > current.replyClosedThrough) current.replyClosedThrough = id;
    }
    if (coordinate.id > current.replyClosedThrough) current.replyClosedThrough = coordinate.id;
    current.candidates.clear();
    current.restoredId = '';
    current.revision++;
    current.current = { ...coordinate };
    current.pending = false;
  }

  private closeHandledThrough(current: MentionState, boundary: MentionCoordinate): void {
    if (!current.handledThrough || compareMentionCoordinates(boundary, current.handledThrough) > 0) {
      current.handledThrough = { ...boundary };
    }
    current.restoredId = '';
    current.revision++;
    for (const [id, position] of current.candidates) {
      if (current.handledThrough && compareMentionCoordinates({ id, position }, current.handledThrough) <= 0) {
        current.candidates.delete(id);
      }
    }
    this.reconcileCurrent(current);
  }

  private reconcileCurrent(current: MentionState): void {
    const latest = latestMentionCoordinate(current.candidates);
    current.current = latest;
    current.pending = latest !== null;
  }
}
