import type {
  SuggestionByline,
  SuggestionDeskView,
  SuggestionEventType,
  SuggestionReceiptView,
  SuggestionState,
  SuggestionUndoLabel,
} from '@cat-cafe/shared';

/**
 * F335 交付二「给人的东西」的唯一存储（契约）。用户状态，TTL=0（铁律 5）。实现见 `RedisSuggestionStore` /
 * `InMemorySuggestionStore`。
 *
 * Keys (under the client's own prefix):
 * - `suggestion:rec:<id>`                  JSON record, `revision` fences every transition
 * - `suggestion:message:<messageId>`       the one row a message may carry (SET NX)
 * - `suggestion:thread:<threadId>`         zset of ids by createdAt
 * - `suggestion:user-kind:<user>:<kind>`   zset of ids by createdAt (recent per kind)
 * - `suggestion:user-kinds:<user>`         set of kinds this user has seen
 * - `suggestion:counts:<user>:<kind>`      hash event type → count, bumped atomically with each transition
 * - `suggestion:open:<user>:<kind>`        zset of still-open offers by expiresAt (exact 「还开着」 and due 「不理」)
 * - `suggestion:desk:<user>`               zset of rows still on their way to / on the desk, by createdAt (F335 交付三)
 * - `suggestion:hidden:<user>`             hash `<catId>\u001f<kind>` → JSON { hiddenAt, byline }
 */
export interface SuggestionEvent {
  type: SuggestionEventType;
  at: number;
}

export interface SuggestionRecord {
  id: string;
  userId: string;
  threadId: string;
  messageId: string;
  catId: string;
  byline: SuggestionByline;
  kind: string;
  kindLabel: string;
  label: string;
  params: Record<string, unknown>;
  state: SuggestionState;
  appliedRef?: Record<string, unknown>;
  receipt?: SuggestionReceiptView;
  watcherSupplement?: { catId: string; text: string };
  undo: SuggestionUndoLabel | null;
  receiptOnly: boolean;
  /** F335 交付三：its delivery on the desk. */
  desk?: SuggestionDeskView;
  events: SuggestionEvent[];
  revision: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface HiddenKindEntry {
  catId: string;
  kind: string;
  byline: SuggestionByline;
  hiddenAt: number;
}

export type SuggestionCounts = Partial<Record<SuggestionEventType, number>>;
export type CreateSuggestionResult = { kind: 'created' } | { kind: 'message_taken'; existingId: string };
export type SwapSuggestionResult = { kind: 'swapped' } | { kind: 'conflict' } | { kind: 'missing' };

export interface ISuggestionStore {
  /** `countEvent` is added to the per-kind counts in the same atomic step (offers only; receipts pass none). */
  create(
    record: SuggestionRecord,
    countEvent?: SuggestionEventType,
    fence?: import('../concierge/watcher/watcher-output-fence.js').WatcherOutputFence,
  ): Promise<CreateSuggestionResult>;
  get(id: string): Promise<SuggestionRecord | null>;
  /**
   * Replace the record iff its stored revision is `expectedRevision`; `next.revision` must be `expectedRevision + 1`.
   * The per-kind counts and the open set move in the same atomic step.
   */
  swap(
    next: SuggestionRecord,
    expectedRevision: number,
    countEvent?: SuggestionEventType,
  ): Promise<SwapSuggestionResult>;
  listThread(threadId: string, limit: number): Promise<SuggestionRecord[]>;
  listUserKind(userId: string, kind: string, limit: number): Promise<SuggestionRecord[]>;
  listUserKinds(userId: string): Promise<string[]>;
  /** Every event count for this person and kind, never truncated. */
  kindCounts(userId: string, kind: string): Promise<SuggestionCounts>;
  /** Offers still open (or mid-click) whose expiry has passed, oldest first. */
  listOpenDue(userId: string, kind: string, now: number, limit: number): Promise<SuggestionRecord[]>;
  countOpen(userId: string, kind: string): Promise<number>;
  /** Offers still open, latest expiry first. */
  listOpen(userId: string, kind: string, limit: number): Promise<SuggestionRecord[]>;
  /** Rows still on their way to the desk or on it (desk status pending / shown), oldest first. */
  listDesk(userId: string, limit: number): Promise<SuggestionRecord[]>;
  hide(userId: string, entry: HiddenKindEntry): Promise<void>;
  unhide(userId: string, catId: string, kind: string): Promise<boolean>;
  listHidden(userId: string): Promise<HiddenKindEntry[]>;
  isHidden(userId: string, catId: string, kind: string): Promise<boolean>;
}

function part(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

export const SuggestionKeys = {
  record: (id: string) => `suggestion:rec:${part(id)}`,
  message: (messageId: string) => `suggestion:message:${part(messageId)}`,
  thread: (threadId: string) => `suggestion:thread:${part(threadId)}`,
  userKind: (userId: string, kind: string) => `suggestion:user-kind:${part(userId)}:${kind}`,
  userKinds: (userId: string) => `suggestion:user-kinds:${part(userId)}`,
  counts: (userId: string, kind: string) => `suggestion:counts:${part(userId)}:${kind}`,
  open: (userId: string, kind: string) => `suggestion:open:${part(userId)}:${kind}`,
  desk: (userId: string) => `suggestion:desk:${part(userId)}`,
  hidden: (userId: string) => `suggestion:hidden:${part(userId)}`,
};

export const HIDDEN_FIELD_SEPARATOR = '\u001f';
export const hiddenField = (catId: string, kind: string) => `${catId}${HIDDEN_FIELD_SEPARATOR}${kind}`;

/** An offer counts as open (for 「还开着」 and expiry) while its pill is up or a click on it is in flight. */
export function tracksAsOpen(record: SuggestionRecord): boolean {
  return !record.receiptOnly && (record.state === 'open' || record.state === 'applying');
}

/** On the desk's list until the person (or the countdown) settles it, or it stops being open anywhere else. */
export function tracksOnDesk(record: SuggestionRecord): boolean {
  return record.desk !== undefined && record.desk.status !== 'settled' && tracksAsOpen(record);
}

export function parseRecord(raw: string | null | undefined): SuggestionRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SuggestionRecord;
    return parsed && typeof parsed.id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}
