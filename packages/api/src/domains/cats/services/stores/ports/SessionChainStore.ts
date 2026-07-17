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
  workingDirectory?: string;
  workspaceFingerprint?: string;
  threadId: string;
  catId: CatId;
  userId: string;
  reuseExistingCliSession?: boolean;
  /** F192 Phase I: immutable creation identity; backlink is SessionBootstrap-only. */
  openedByInvocationId?: string;
  continuedFromSessionId?: string;
  /**
   * F198 Bug #3: stable conversation anchor for bg carrier
   * (`bg:${threadId}:${catId}`). When set, the record is indexed by chainKey
   * so session_init can reuse it across daemon sessionId rotation instead of
   * seal+create. Undefined for non-bg providers.
   */
  chainKey?: string;
}

/** Owner-scoped bounded discovery of observed continuation targets. */
export interface SessionContinuationTargetScan {
  ownerUserId: string;
  windowStartMs: number;
  windowEndMs: number;
  limit: number;
  catId?: string;
  threadId?: string;
}

export type SessionRecordPatch = Partial<
  Pick<
    SessionRecord,
    | 'cliSessionId'
    | 'workingDirectory'
    | 'workspaceFingerprint'
    | 'status'
    | 'contextHealth'
    | 'lastUsage'
    | 'messageCount'
    | 'updatedAt'
    | 'compressionCount'
    | 'continuityCapsule'
    | 'consecutiveRestoreFailures'
    | 'latestResumeSessionId'
    | 'catHandoffNote'
  >
> & {
  sealReason?: SessionRecord['sealReason'] | null;
  sealedAt?: number | null;
};

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
  /**
   * F198 Bug #3: Look up by chainKey (stable bg conversation anchor). Returns
   * the record regardless of status (unlike getActive) so a sealed record is
   * still reachable for write-tolerance during concurrent edges.
   */
  getByChainKey(chainKey: string): SessionRecord | null | Promise<SessionRecord | null>;
  /** Atomically increment compressionCount and return the new value. Returns null if session not found. */
  incrementCompressionCount(id: string): number | null | Promise<number | null>;
  /** F118: List IDs of all sessions currently in 'sealing' status (for global reaper). */
  listSealingSessions(): string[] | Promise<string[]>;
  /** F192 Phase I: discover only targets explicitly opened from a cross-invocation SessionBootstrap. */
  scanContinuationTargets(query: SessionContinuationTargetScan): SessionRecord[] | Promise<SessionRecord[]>;
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
  /** F198 Bug #3: chainKey (stable bg conversation anchor) → record ID */
  private chainKeyIndex = new Map<string, string>();

  /** Composite key for the per-(catId,threadId) chain/active indexes. */
  private catThreadKey(catId: string, threadId: string): string {
    return `${catId}:${threadId}`;
  }

  create(input: CreateSessionInput): SessionRecord {
    if (input.reuseExistingCliSession) {
      const existingId = this.cliIndex.get(input.cliSessionId);
      if (existingId) {
        const existing = this.records.get(existingId);
        if (existing) return existing;
        this.cliIndex.delete(input.cliSessionId);
      }
    }

    const now = Date.now();
    const key = this.catThreadKey(input.catId, input.threadId);

    // Compute next seq
    const chain = this.chains.get(key) ?? [];
    const seq = chain.length;

    const id = randomUUID();
    const record: SessionRecord = {
      id,
      cliSessionId: input.cliSessionId,
      ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
      ...(input.workspaceFingerprint ? { workspaceFingerprint: input.workspaceFingerprint } : {}),
      threadId: input.threadId,
      catId: input.catId,
      userId: input.userId,
      seq,
      openedByInvocationId: input.openedByInvocationId,
      continuedFromSessionId: input.continuedFromSessionId,
      status: 'active',
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
      ...(input.chainKey ? { chainKey: input.chainKey } : {}),
    };

    this.records.set(id, record);
    chain.push(id);
    this.chains.set(key, chain);
    this.activeIndex.set(key, id);
    this.cliIndex.set(input.cliSessionId, id);
    if (input.chainKey) this.chainKeyIndex.set(input.chainKey, id);

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
    const activeId = this.activeIndex.get(this.catThreadKey(catId, threadId));
    if (!activeId) return null;
    const record = this.records.get(activeId);
    if (!record || record.status !== 'active') return null;
    return record;
  }

  getChain(catId: CatId, threadId: string): SessionRecord[] {
    const chain = this.chains.get(this.catThreadKey(catId, threadId)) ?? [];
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
    if (patch.workingDirectory !== undefined) record.workingDirectory = patch.workingDirectory;
    if (patch.workspaceFingerprint !== undefined) record.workspaceFingerprint = patch.workspaceFingerprint;
    if (patch.status !== undefined) {
      record.status = patch.status;
      const key = this.catThreadKey(record.catId, record.threadId);
      if (patch.status === 'active') {
        this.activeIndex.set(key, id);
      } else {
        if (this.activeIndex.get(key) === id) {
          this.activeIndex.delete(key);
        }
      }
    }
    if (patch.contextHealth !== undefined) record.contextHealth = patch.contextHealth;
    if (patch.lastUsage !== undefined) record.lastUsage = patch.lastUsage;
    if (patch.messageCount !== undefined) record.messageCount = patch.messageCount;
    if ('sealReason' in patch) {
      if (patch.sealReason === null) delete record.sealReason;
      else if (patch.sealReason !== undefined) record.sealReason = patch.sealReason;
    }
    if ('sealedAt' in patch) {
      if (patch.sealedAt === null) delete record.sealedAt;
      else if (patch.sealedAt !== undefined) record.sealedAt = patch.sealedAt;
    }
    if (patch.compressionCount !== undefined) record.compressionCount = patch.compressionCount;
    if (patch.continuityCapsule !== undefined) record.continuityCapsule = patch.continuityCapsule;
    if (patch.consecutiveRestoreFailures !== undefined)
      record.consecutiveRestoreFailures = patch.consecutiveRestoreFailures;
    if (patch.latestResumeSessionId !== undefined) record.latestResumeSessionId = patch.latestResumeSessionId;
    if (patch.catHandoffNote !== undefined) record.catHandoffNote = patch.catHandoffNote;
    record.updatedAt = patch.updatedAt ?? Date.now();

    return record;
  }

  getByCliSessionId(cliSessionId: string): SessionRecord | null {
    const id = this.cliIndex.get(cliSessionId);
    if (!id) return null;
    return this.records.get(id) ?? null;
  }

  getByChainKey(chainKey: string): SessionRecord | null {
    const id = this.chainKeyIndex.get(chainKey);
    if (!id) return null;
    // No status filter (unlike getActive): a sealed record must remain
    // reachable so a concurrent done write during a seal edge keeps its state.
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

  scanContinuationTargets(query: SessionContinuationTargetScan): SessionRecord[] {
    assertValidContinuationTargetScan(query);
    return [...this.records.values()]
      .filter((record) => record.userId === query.ownerUserId)
      .filter((record) => record.continuedFromSessionId !== undefined)
      .filter((record) => record.createdAt >= query.windowStartMs && record.createdAt < query.windowEndMs)
      .filter((record) => !query.catId || record.catId === query.catId)
      .filter((record) => !query.threadId || record.threadId === query.threadId)
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      .slice(0, query.limit);
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
    // F198 Bug #3 (cloud review P1): only drop the chainKey index if it still
    // points at THIS record. After a sealed→fresh re-create, a newer active
    // record owns the same chainKey, so evicting the old sealed one must not
    // delete the live index (mirrors the activeIndex ownership check below).
    if (record.chainKey && this.chainKeyIndex.get(record.chainKey) === id) {
      this.chainKeyIndex.delete(record.chainKey);
    }

    const key = this.catThreadKey(record.catId, record.threadId);
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

export function assertValidContinuationTargetScan(query: SessionContinuationTargetScan): void {
  if (!query.ownerUserId || /[\r\n]/.test(query.ownerUserId)) {
    throw new RangeError('continuation target scan requires a single-line ownerUserId');
  }
  if (!Number.isFinite(query.windowStartMs) || !Number.isFinite(query.windowEndMs)) {
    throw new RangeError('continuation target scan timestamps must be finite');
  }
  if (query.windowStartMs < 0 || query.windowEndMs <= query.windowStartMs) {
    throw new RangeError('continuation target scan requires a non-empty half-open window');
  }
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 1000) {
    throw new RangeError('continuation target scan limit must be between 1 and 1000');
  }
  for (const value of [query.catId, query.threadId]) {
    if (value !== undefined && (!value || /[\r\n]/.test(value))) {
      throw new RangeError('continuation target filters must be non-empty single-line strings');
    }
  }
}
