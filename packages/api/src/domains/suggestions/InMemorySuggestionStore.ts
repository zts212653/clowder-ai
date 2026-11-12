import type { SuggestionEventType } from '@cat-cafe/shared';
import {
  type CreateSuggestionResult,
  type HiddenKindEntry,
  hiddenField,
  type ISuggestionStore,
  parseRecord,
  type SuggestionCounts,
  type SuggestionRecord,
  type SwapSuggestionResult,
  tracksAsOpen,
  tracksOnDesk,
} from './SuggestionStore.js';

/** Same contract as `RedisSuggestionStore` without Redis (no-Redis startup and unit tests). */
export class InMemorySuggestionStore implements ISuggestionStore {
  private readonly records = new Map<string, string>();
  private readonly byMessage = new Map<string, string>();
  private readonly counts = new Map<string, SuggestionCounts>();
  private readonly hidden = new Map<string, Map<string, HiddenKindEntry>>();

  private bump(record: SuggestionRecord, event: SuggestionEventType | undefined): void {
    if (!event) return;
    const key = `${record.userId}\u001f${record.kind}`;
    const counts = this.counts.get(key) ?? {};
    counts[event] = (counts[event] ?? 0) + 1;
    this.counts.set(key, counts);
  }

  async create(record: SuggestionRecord, countEvent?: SuggestionEventType): Promise<CreateSuggestionResult> {
    const existing = this.byMessage.get(record.messageId);
    if (existing) return { kind: 'message_taken', existingId: existing };
    this.byMessage.set(record.messageId, record.id);
    this.records.set(record.id, JSON.stringify(record));
    this.bump(record, countEvent);
    return { kind: 'created' };
  }

  async get(id: string): Promise<SuggestionRecord | null> {
    return parseRecord(this.records.get(id));
  }

  async swap(
    next: SuggestionRecord,
    expectedRevision: number,
    countEvent?: SuggestionEventType,
  ): Promise<SwapSuggestionResult> {
    if (next.revision !== expectedRevision + 1) throw new Error('next.revision must be expectedRevision + 1');
    const current = parseRecord(this.records.get(next.id));
    if (!current) return { kind: 'missing' };
    if (current.revision !== expectedRevision) return { kind: 'conflict' };
    this.records.set(next.id, JSON.stringify(next));
    this.bump(next, countEvent);
    return { kind: 'swapped' };
  }

  private all(): SuggestionRecord[] {
    return [...this.records.values()]
      .map((raw) => parseRecord(raw))
      .filter((record): record is SuggestionRecord => record !== null)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async listThread(threadId: string, limit: number): Promise<SuggestionRecord[]> {
    return this.all()
      .filter((record) => record.threadId === threadId)
      .slice(0, limit);
  }

  async listUserKind(userId: string, kind: string, limit: number): Promise<SuggestionRecord[]> {
    return this.all()
      .filter((record) => record.userId === userId && record.kind === kind)
      .slice(0, limit);
  }

  async listUserKinds(userId: string): Promise<string[]> {
    return [
      ...new Set(
        this.all()
          .filter((record) => record.userId === userId)
          .map((record) => record.kind),
      ),
    ].sort();
  }

  async kindCounts(userId: string, kind: string): Promise<SuggestionCounts> {
    return { ...(this.counts.get(`${userId}\u001f${kind}`) ?? {}) };
  }

  private open(userId: string, kind: string): SuggestionRecord[] {
    return this.all()
      .filter((record) => record.userId === userId && record.kind === kind && tracksAsOpen(record))
      .sort((a, b) => a.expiresAt - b.expiresAt);
  }

  async listOpenDue(userId: string, kind: string, now: number, limit: number): Promise<SuggestionRecord[]> {
    return this.open(userId, kind)
      .filter((record) => record.expiresAt <= now)
      .slice(0, limit);
  }

  async countOpen(userId: string, kind: string): Promise<number> {
    return this.open(userId, kind).length;
  }

  async listOpen(userId: string, kind: string, limit: number): Promise<SuggestionRecord[]> {
    return this.open(userId, kind)
      .sort((a, b) => b.expiresAt - a.expiresAt)
      .slice(0, limit);
  }

  async listDesk(userId: string, limit: number): Promise<SuggestionRecord[]> {
    return this.all()
      .filter((record) => record.userId === userId && tracksOnDesk(record))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit);
  }

  async hide(userId: string, entry: HiddenKindEntry): Promise<void> {
    const rows = this.hidden.get(userId) ?? new Map<string, HiddenKindEntry>();
    rows.set(hiddenField(entry.catId, entry.kind), { ...entry });
    this.hidden.set(userId, rows);
  }

  async unhide(userId: string, catId: string, kind: string): Promise<boolean> {
    return this.hidden.get(userId)?.delete(hiddenField(catId, kind)) ?? false;
  }

  async listHidden(userId: string): Promise<HiddenKindEntry[]> {
    return [...(this.hidden.get(userId)?.values() ?? [])].sort((a, b) => b.hiddenAt - a.hiddenAt);
  }

  async isHidden(userId: string, catId: string, kind: string): Promise<boolean> {
    return this.hidden.get(userId)?.has(hiddenField(catId, kind)) ?? false;
  }
}
