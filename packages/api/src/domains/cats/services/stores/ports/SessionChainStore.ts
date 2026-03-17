/**
 * Session Chain Store
 * F24: Thread → N Sessions per cat, context health tracking.
 *
 * Interface + in-memory implementation.
 * Follows existing Store pattern (InvocationRecordStore.ts).
 */

import { randomUUID } from 'node:crypto';
import type { CatId, SessionRecord } from '@cat-cafe/shared';

export interface CreateSessionInput {
  cliSessionId: string;
  threadId: string;
  catId: CatId;
  userId: string;
}

export type SessionRecordPatch = Partial<
  Pick<
    SessionRecord,
    | 'cliSessionId'
    | 'status'
    | 'contextHealth'
    | 'lastUsage'
    | 'messageCount'
    | 'sealReason'
    | 'sealedAt'
    | 'updatedAt'
    | 'compressionCount'
    | 'consecutiveRestoreFailures'
  >
>;

export interface ISessionChainStore {
  /** Create SessionRecord (seq auto-increments, status=active) */
  create(input: CreateSessionInput): SessionRecord | Promise<SessionRecord>;
  /** Get by internal ID */
  get(id: string): SessionRecord | null | Promise<SessionRecord | null>;
  /** Get active session for a cat in a thread */
  getActive(catId: CatId, threadId: string): SessionRecord | null | Promise<SessionRecord | null>;
  /** Get full session chain (sorted by seq) */
  getChain(catId: CatId, threadId: string): SessionRecord[] | Promise<SessionRecord[]>;
  /** Get all cats' sessions for a thread */
  getChainByThread(threadId: string): SessionRecord[] | Promise<SessionRecord[]>;
  /** Update partial fields */
  update(id: string, patch: SessionRecordPatch): SessionRecord | null | Promise<SessionRecord | null>;
  /** Look up by CLI session ID */
  getByCliSessionId(cliSessionId: string): SessionRecord | null | Promise<SessionRecord | null>;
  /** Atomically increment compressionCount and return the new value. Returns null if session not found. */
  incrementCompressionCount(id: string): number | null | Promise<number | null>;
  /** F118: List IDs of all sessions currently in 'sealing' status (for global reaper). */
  listSealingSessions(): string[] | Promise<string[]>;
}

const MAX_RECORDS = 1000;

/**
 * In-memory SessionChainStore.
 * Single-threaded Node.js → synchronous Map operations.
 */
export class SessionChainStore implements ISessionChainStore {
  private records = new Map<string, SessionRecord>();
  /** catId:threadId → session IDs ordered by seq */
  private chains = new Map<string, string[]>();
  /** catId:threadId → active session ID */
  private activeIndex = new Map<string, string>();
  /** cliSessionId → record ID */
  private cliIndex = new Map<string, string>();

  private chainKey(catId: string, threadId: string): string {
    return `${catId}:${threadId}`;
  }

  create(input: CreateSessionInput): SessionRecord {
    const now = Date.now();
    const key = this.chainKey(input.catId, input.threadId);

    // Compute next seq
    const chain = this.chains.get(key) ?? [];
    const seq = chain.length;

    const id = randomUUID();
    const record: SessionRecord = {
      id,
      cliSessionId: input.cliSessionId,
      threadId: input.threadId,
      catId: input.catId,
      userId: input.userId,
      seq,
      status: 'active',
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.records.set(id, record);
    chain.push(id);
    this.chains.set(key, chain);
    this.activeIndex.set(key, id);
    this.cliIndex.set(input.cliSessionId, id);

    // Trim if over capacity — prefer evicting sealed/non-active records
    if (this.records.size > MAX_RECORDS) {
      const evicted = this.evictOne();
      if (!evicted) {
        // Roll back: remove the just-created record
        this.removeRecord(id);
        throw new Error(
          `SessionChainStore at capacity (${MAX_RECORDS}): all records are truly active. ` +
            'Cannot evict without data loss. Seal or remove existing sessions first.',
        );
      }
    }

    return record;
  }

  get(id: string): SessionRecord | null {
    return this.records.get(id) ?? null;
  }

  getActive(catId: CatId, threadId: string): SessionRecord | null {
    const activeId = this.activeIndex.get(this.chainKey(catId, threadId));
    if (!activeId) return null;
    const record = this.records.get(activeId);
    if (!record || record.status !== 'active') return null;
    return record;
  }

  getChain(catId: CatId, threadId: string): SessionRecord[] {
    const chain = this.chains.get(this.chainKey(catId, threadId)) ?? [];
    return chain
      .map((id) => this.records.get(id))
      .filter((r): r is SessionRecord => r != null)
      .sort((a, b) => a.seq - b.seq);
  }

  getChainByThread(threadId: string): SessionRecord[] {
    const results: SessionRecord[] = [];
    for (const record of this.records.values()) {
      if (record.threadId === threadId) {
        results.push(record);
      }
    }
    return results.sort((a, b) => {
      if (a.catId !== b.catId) return a.catId.localeCompare(b.catId);
      return a.seq - b.seq;
    });
  }

  update(id: string, patch: SessionRecordPatch): SessionRecord | null {
    const record = this.records.get(id);
    if (!record) return null;

    if (patch.cliSessionId !== undefined) {
      // Update CLI index
      this.cliIndex.delete(record.cliSessionId);
      record.cliSessionId = patch.cliSessionId;
      this.cliIndex.set(patch.cliSessionId, id);
    }
    if (patch.status !== undefined) {
      record.status = patch.status;
      // If sealed/sealing, remove from active index
      if (patch.status !== 'active') {
        const key = this.chainKey(record.catId, record.threadId);
        if (this.activeIndex.get(key) === id) {
          this.activeIndex.delete(key);
        }
      }
    }
    if (patch.contextHealth !== undefined) record.contextHealth = patch.contextHealth;
    if (patch.lastUsage !== undefined) record.lastUsage = patch.lastUsage;
    if (patch.messageCount !== undefined) record.messageCount = patch.messageCount;
    if (patch.sealReason !== undefined) record.sealReason = patch.sealReason;
    if (patch.sealedAt !== undefined) record.sealedAt = patch.sealedAt;
    if (patch.compressionCount !== undefined) record.compressionCount = patch.compressionCount;
    if (patch.consecutiveRestoreFailures !== undefined)
      record.consecutiveRestoreFailures = patch.consecutiveRestoreFailures;
    record.updatedAt = patch.updatedAt ?? Date.now();

    return record;
  }

  getByCliSessionId(cliSessionId: string): SessionRecord | null {
    const id = this.cliIndex.get(cliSessionId);
    if (!id) return null;
    return this.records.get(id) ?? null;
  }

  incrementCompressionCount(id: string): number | null {
    const record = this.records.get(id);
    if (!record) return null;
    if (record.status !== 'active') return null;
    record.compressionCount = (record.compressionCount ?? 0) + 1;
    record.updatedAt = Date.now();
    return record.compressionCount;
  }

  listSealingSessions(): string[] {
    const ids: string[] = [];
    for (const [id, record] of this.records) {
      if (record.status === 'sealing') ids.push(id);
    }
    return ids;
  }

  /**
   * Evict one record to stay within MAX_RECORDS.
   * Priority: sealed > non-active > superseded active.
   * Refuses to evict truly active sessions — returns false.
   */
  private evictOne(): boolean {
    const currentActiveIds = new Set(this.activeIndex.values());

    // First pass: sealed records (safest to evict)
    let victim: string | null = null;
    for (const [id, r] of this.records) {
      if (r.status === 'sealed') {
        victim = id;
        break;
      }
    }
    // Second pass: non-active, non-sealed (e.g., sealing)
    if (!victim) {
      for (const [id, r] of this.records) {
        if (r.status !== 'active') {
          victim = id;
          break;
        }
      }
    }
    // Third pass: active records NOT currently in activeIndex (superseded)
    if (!victim) {
      for (const id of this.records.keys()) {
        if (!currentActiveIds.has(id)) {
          victim = id;
          break;
        }
      }
    }
    // Refuse to evict truly active sessions
    if (!victim) return false;

    this.removeRecord(victim);
    return true;
  }

  /** Remove a record and clean up all indexes. */
  private removeRecord(id: string): void {
    const record = this.records.get(id);
    if (!record) return;

    this.cliIndex.delete(record.cliSessionId);

    const key = this.chainKey(record.catId, record.threadId);
    if (this.activeIndex.get(key) === id) {
      this.activeIndex.delete(key);
    }

    const chain = this.chains.get(key);
    if (chain) {
      const idx = chain.indexOf(id);
      if (idx !== -1) chain.splice(idx, 1);
      if (chain.length === 0) this.chains.delete(key);
    }

    this.records.delete(id);
  }

  /** Current record count (for testing) */
  get size(): number {
    return this.records.size;
  }
}
