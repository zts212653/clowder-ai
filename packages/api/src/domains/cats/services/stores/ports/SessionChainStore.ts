/**
 * #1382 review P2: stable identity of the capacity-pin recovery note. A pin
 * carries at most ONE recovery instruction — when the carrier's reported
 * number jitters (245480 → 245481), the previous note is replaced in place
 * rather than appended, so provenance never grows unbounded.
 */
export const CAPACITY_PIN_RECOVERY_NOTE_PATTERN =
  /; carrier now reports [\d,]+ tokens — seal the session to recover if this pin was polluted/;

/**
 * Upsert the recovery note into a provenance string: exact note already
 * present → unchanged; an older note with a different report number →
 * replaced in place; otherwise appended.
 */
export function upsertCapacityPinRecoveryNote(provenance: string, note: string): string {
  if (provenance.includes(note)) return provenance;
  if (CAPACITY_PIN_RECOVERY_NOTE_PATTERN.test(provenance)) {
    return provenance.replace(CAPACITY_PIN_RECOVERY_NOTE_PATTERN, note);
  }
  return `${provenance}${note}`;
}

/**
 * Session Chain Store
 * F24: Thread → N Sessions per cat, context health tracking.
 *
 * Interface + in-memory implementation.
 * Follows existing Store pattern (InvocationRecordStore.ts).
 */

import { randomUUID } from 'node:crypto';
import type { CatId, HybridProgress, SessionCapacityPin, SessionPolicySnapshot, SessionRecord } from '@cat-cafe/shared';
import type { StoreReadOptions } from './StoreReadOptions.js';
import { throwIfStoreReadAborted } from './StoreReadOptions.js';

export interface CreateSessionInput {
  cliSessionId?: string;
  workingDirectory?: string;
  workspaceFingerprint?: string;
  threadId: string;
  catId: CatId;
  userId: string;
  reuseExistingCliSession?: boolean;
  /** Internal atomic path used by the managed invocation boundary. */
  reuseExistingActive?: boolean;
  /** `null` when lifetime compression observation did not start with the session. */
  compressionCount?: number | null;
  /**
   * F198 Bug #3: stable conversation anchor for bg carrier
   * (`bg:${threadId}:${catId}`). When set, the record is indexed by chainKey
   * so session_init can reuse it across daemon sessionId rotation instead of
   * seal+create. Undefined for non-bg providers.
   */
  chainKey?: string;
}

export type SessionRecordPatch = Partial<
  Pick<
    SessionRecord,
    | 'cliSessionId'
    | 'workingDirectory'
    | 'workspaceFingerprint'
    | 'status'
    | 'contextHealth'
    | 'capacityPin'
    | 'lastUsage'
    | 'messageCount'
    | 'updatedAt'
    | 'continuityCapsule'
    | 'consecutiveRestoreFailures'
    | 'latestResumeSessionId'
    | 'catHandoffNote'
  >
> & {
  compressionCount?: number | null;
  appliedPolicy?: SessionPolicySnapshot | null;
  hybridProgress?: HybridProgress | null;
  sealReason?: SessionRecord['sealReason'] | null;
  sealedAt?: number | null;
};

export interface CompressionEventResult {
  compressionCount: number | null;
  hybridProgress: HybridProgress | null;
  revisionMatched: boolean;
}

export interface RestoreActiveSessionInput {
  targetSessionId: string;
  expectedActiveSessionId: string | null;
  displacedSealReason: string;
}

export type RestoreActiveSessionResult =
  | { status: 'restored'; session: SessionRecord; displacedSessionId?: string }
  | { status: 'already_active'; session: SessionRecord }
  | { status: 'target_missing' }
  | { status: 'target_not_restorable'; targetStatus: SessionRecord['status'] }
  | { status: 'active_changed'; activeSessionId?: string };

export interface ISessionChainStore {
  /** Create SessionRecord (seq auto-increments, status=active) */
  create(input: CreateSessionInput): SessionRecord | Promise<SessionRecord>;
  /** Atomically return the existing active record or create one logical unbound node. */
  getOrCreateActive(input: CreateSessionInput): SessionRecord | Promise<SessionRecord>;
  /** Bind a provider runtime ID to an existing logical node without creating a new node. */
  bindCliSessionId(id: string, cliSessionId: string): SessionRecord | null | Promise<SessionRecord | null>;
  /** Apply an invocation snapshot and reset hybrid progress only across policy revisions. */
  applyPolicySnapshot(
    id: string,
    snapshot: SessionPolicySnapshot,
  ): SessionRecord | null | Promise<SessionRecord | null>;
  /** Record one trusted compression event against the applied policy revision. */
  recordCompressionEvent(
    id: string,
    policyRevision: string,
    invocationId: string,
  ): CompressionEventResult | null | Promise<CompressionEventResult | null>;
  /** Atomically transition active -> sealing, optionally guarded by the applied policy revision. */
  transitionToSealing(
    id: string,
    reason: string,
    expectedPolicyRevision?: string,
  ): SessionRecord | null | Promise<SessionRecord | null>;
  /** Atomically preserve the current record as sealing and reactivate one selected sealed record in place. */
  restoreActiveSession(
    input: RestoreActiveSessionInput,
  ): RestoreActiveSessionResult | Promise<RestoreActiveSessionResult>;
  /** Get by internal ID */
  get(id: string): SessionRecord | null | Promise<SessionRecord | null>;
  /** Get active session for a cat in a thread */
  getActive(catId: CatId, threadId: string, userId?: string): SessionRecord | null | Promise<SessionRecord | null>;
  /** Get full session chain (sorted by seq) */
  getChain(catId: CatId, threadId: string, userId?: string): SessionRecord[] | Promise<SessionRecord[]>;
  /** Get all cats' sessions for a thread */
  getChainByThread(threadId: string, options?: StoreReadOptions): SessionRecord[] | Promise<SessionRecord[]>;
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
  /**
   * #1382 maintainer P1: atomically merge a provenance note into the STORED
   * capacityPin without copying caller-stale numeric fields — a concurrent
   * pin shrink must never be undone by a delayed provenance write. Dedup:
   * no-op when the exact note is already present. Returns the updated record,
   * or null when nothing was written.
   */
  appendCapacityPinProvenance(id: string, note: string): SessionRecord | null | Promise<SessionRecord | null>;
  /**
   * #1382 maintainer P1: atomically apply a shrink-only capacity pin — the
   * candidate is written only when no usable pin is stored or its windowTokens
   * is <= the CURRENT stored pin's. A stored smaller constraint is never
   * overwritten by a delayed larger candidate (one-way pin invariant).
   * Returns the record as it stands after the atomic decision, or null when
   * the session does not exist.
   */
  shrinkCapacityPin(id: string, candidate: SessionCapacityPin): SessionRecord | null | Promise<SessionRecord | null>;
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
  /** userId:catId:threadId → active session ID (#1329 ownership boundary). */
  private ownerActiveIndex = new Map<string, string>();
  /** cliSessionId → record ID */
  private cliIndex = new Map<string, string>();
  /** F198 Bug #3: chainKey (stable bg conversation anchor) → record ID */
  private chainKeyIndex = new Map<string, string>();

  /** Composite key for the per-(catId,threadId) chain/active indexes. */
  private catThreadKey(catId: string, threadId: string): string {
    return `${catId}:${threadId}`;
  }

  private ownerCatThreadKey(userId: string, catId: string, threadId: string): string {
    return `${userId}:${catId}:${threadId}`;
  }

  create(input: CreateSessionInput): SessionRecord {
    if (input.reuseExistingActive) {
      const active = this.getActive(input.catId, input.threadId, input.userId);
      if (active) return active;
    }

    if (input.reuseExistingCliSession && input.cliSessionId) {
      const existingId = this.cliIndex.get(input.cliSessionId);
      if (existingId) {
        const existing = this.records.get(existingId);
        if (existing) return existing;
        this.cliIndex.delete(input.cliSessionId);
      }
    }

    const now = Date.now();
    const key = this.catThreadKey(input.catId, input.threadId);

    // Sequence belongs to the logical ownership chain. The shared default
    // thread may contain records for multiple users in the same physical map.
    const chain = this.chains.get(key) ?? [];
    const seq = chain.reduce((count, recordId) => {
      return this.records.get(recordId)?.userId === input.userId ? count + 1 : count;
    }, 0);

    const id = randomUUID();
    const record: SessionRecord = {
      id,
      ...(input.cliSessionId ? { cliSessionId: input.cliSessionId } : {}),
      ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
      ...(input.workspaceFingerprint ? { workspaceFingerprint: input.workspaceFingerprint } : {}),
      threadId: input.threadId,
      catId: input.catId,
      userId: input.userId,
      seq,
      status: 'active',
      messageCount: 0,
      compressionCount: input.compressionCount ?? null,
      createdAt: now,
      updatedAt: now,
      ...(input.chainKey ? { chainKey: input.chainKey } : {}),
    };

    this.records.set(id, record);
    chain.push(id);
    this.chains.set(key, chain);
    this.activeIndex.set(key, id);
    this.ownerActiveIndex.set(this.ownerCatThreadKey(input.userId, input.catId, input.threadId), id);
    if (input.cliSessionId) this.cliIndex.set(input.cliSessionId, id);
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

  getOrCreateActive(input: CreateSessionInput): SessionRecord {
    const active = this.getActive(input.catId, input.threadId, input.userId);
    if (active) return active;
    if (input.cliSessionId) {
      const claimed = this.getByCliSessionId(input.cliSessionId);
      if (
        claimed?.status === 'active' &&
        claimed.userId === input.userId &&
        claimed.catId === input.catId &&
        claimed.threadId === input.threadId
      ) {
        return claimed;
      }
      if (claimed) {
        return this.create({ ...input, cliSessionId: undefined, reuseExistingActive: true });
      }
    }
    return this.create({ ...input, reuseExistingActive: true });
  }

  bindCliSessionId(id: string, cliSessionId: string): SessionRecord | null {
    const record = this.records.get(id);
    if (!record || record.status !== 'active') return null;
    const claimedBy = this.cliIndex.get(cliSessionId);
    if (claimedBy && claimedBy !== id) return null;
    if (record.cliSessionId) this.cliIndex.delete(record.cliSessionId);
    record.cliSessionId = cliSessionId;
    this.cliIndex.set(cliSessionId, id);
    record.updatedAt = Date.now();
    return record;
  }

  applyPolicySnapshot(id: string, snapshot: SessionPolicySnapshot): SessionRecord | null {
    const record = this.records.get(id);
    if (!record || record.status !== 'active') return null;
    if (record.appliedPolicy?.revision !== snapshot.revision) {
      record.hybridProgress =
        snapshot.config.strategy === 'hybrid'
          ? { policyRevision: snapshot.revision, observedCount: 0, startedAt: new Date().toISOString() }
          : undefined;
    }
    record.appliedPolicy = snapshot;
    record.updatedAt = Date.now();
    return record;
  }

  recordCompressionEvent(id: string, policyRevision: string, invocationId: string): CompressionEventResult | null {
    const record = this.records.get(id);
    if (!record || record.status !== 'active') return null;
    if (record.compressionCount !== null) record.compressionCount += 1;

    const revisionMatched = record.appliedPolicy?.revision === policyRevision;
    if (
      revisionMatched &&
      record.appliedPolicy?.config.strategy === 'hybrid' &&
      record.hybridProgress?.policyRevision === policyRevision
    ) {
      record.hybridProgress.observedCount += 1;
    }
    const observedAt = Date.now();
    const sequence = record.compressionCount ?? record.hybridProgress?.observedCount;
    if (typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence >= 1) {
      record.compressionObservation = { invocationId, sequence, observedAt };
    } else {
      record.compressionObservation = undefined;
    }
    record.updatedAt = observedAt;
    return {
      compressionCount: record.compressionCount,
      hybridProgress: record.hybridProgress ?? null,
      revisionMatched,
    };
  }

  transitionToSealing(id: string, reason: string, expectedPolicyRevision?: string): SessionRecord | null {
    const record = this.records.get(id);
    if (!record || record.status !== 'active') return null;
    if (expectedPolicyRevision !== undefined && record.appliedPolicy?.revision !== expectedPolicyRevision) {
      return null;
    }

    record.status = 'sealing';
    record.sealReason = reason;
    record.updatedAt = Date.now();
    const key = this.catThreadKey(record.catId, record.threadId);
    if (this.activeIndex.get(key) === id) this.activeIndex.delete(key);
    const ownerKey = this.ownerCatThreadKey(record.userId, record.catId, record.threadId);
    if (this.ownerActiveIndex.get(ownerKey) === id) this.ownerActiveIndex.delete(ownerKey);
    return record;
  }

  restoreActiveSession(input: RestoreActiveSessionInput): RestoreActiveSessionResult {
    const target = this.records.get(input.targetSessionId);
    if (!target) return { status: 'target_missing' };

    const key = this.catThreadKey(target.catId, target.threadId);
    const ownerKey = this.ownerCatThreadKey(target.userId, target.catId, target.threadId);
    const activeSessionId = this.ownerActiveIndex.get(ownerKey);
    if (target.status === 'active' && activeSessionId === target.id) {
      return { status: 'already_active', session: target };
    }
    if (target.status !== 'sealed') {
      return { status: 'target_not_restorable', targetStatus: target.status };
    }
    if ((activeSessionId ?? null) !== input.expectedActiveSessionId) {
      return { status: 'active_changed', ...(activeSessionId ? { activeSessionId } : {}) };
    }

    let displacedSessionId: string | undefined;
    if (activeSessionId) {
      const displaced = this.records.get(activeSessionId);
      if (
        !displaced ||
        displaced.status !== 'active' ||
        displaced.userId !== target.userId ||
        displaced.catId !== target.catId ||
        displaced.threadId !== target.threadId
      ) {
        return { status: 'active_changed', activeSessionId };
      }
      displaced.status = 'sealing';
      displaced.sealReason = input.displacedSealReason;
      displaced.updatedAt = Date.now();
      displacedSessionId = displaced.id;
    }

    target.status = 'active';
    delete target.sealReason;
    delete target.sealedAt;
    target.updatedAt = Date.now();
    this.activeIndex.set(key, target.id);
    this.ownerActiveIndex.set(ownerKey, target.id);

    return {
      status: 'restored',
      session: target,
      ...(displacedSessionId ? { displacedSessionId } : {}),
    };
  }

  get(id: string): SessionRecord | null {
    return this.records.get(id) ?? null;
  }

  getActive(catId: CatId, threadId: string, userId?: string): SessionRecord | null {
    const key = this.catThreadKey(catId, threadId);
    const ownerKey = userId ? this.ownerCatThreadKey(userId, catId, threadId) : undefined;
    let activeId = ownerKey ? this.ownerActiveIndex.get(ownerKey) : this.activeIndex.get(key);
    if (!activeId && ownerKey) {
      const chain = this.chains.get(key) ?? [];
      activeId = [...chain].reverse().find((id) => {
        const record = this.records.get(id);
        return record?.status === 'active' && record.userId === userId;
      });
      if (activeId) this.ownerActiveIndex.set(ownerKey, activeId);
    }
    if (!activeId) return null;
    const record = this.records.get(activeId);
    if (!record || record.status !== 'active' || (userId !== undefined && record.userId !== userId)) return null;
    return record;
  }

  getChain(catId: CatId, threadId: string, userId?: string): SessionRecord[] {
    const chain = this.chains.get(this.catThreadKey(catId, threadId)) ?? [];
    return chain
      .map((id) => this.records.get(id))
      .filter((r): r is SessionRecord => r != null)
      .filter((record) => userId === undefined || record.userId === userId)
      .sort((a, b) => a.seq - b.seq);
  }

  getChainByThread(threadId: string, options?: StoreReadOptions): SessionRecord[] {
    throwIfStoreReadAborted(options);
    const results: SessionRecord[] = [];
    for (const record of this.records.values()) {
      throwIfStoreReadAborted(options);
      if (record.threadId === threadId) {
        results.push(record);
      }
    }
    throwIfStoreReadAborted(options);
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
      if (record.cliSessionId) this.cliIndex.delete(record.cliSessionId);
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
        this.ownerActiveIndex.set(this.ownerCatThreadKey(record.userId, record.catId, record.threadId), id);
      } else {
        if (this.activeIndex.get(key) === id) {
          this.activeIndex.delete(key);
        }
        const ownerKey = this.ownerCatThreadKey(record.userId, record.catId, record.threadId);
        if (this.ownerActiveIndex.get(ownerKey) === id) this.ownerActiveIndex.delete(ownerKey);
      }
    }
    if (patch.contextHealth !== undefined) record.contextHealth = patch.contextHealth;
    if (patch.capacityPin !== undefined) record.capacityPin = patch.capacityPin;
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
    if ('appliedPolicy' in patch) {
      if (patch.appliedPolicy === null) delete record.appliedPolicy;
      else if (patch.appliedPolicy !== undefined) record.appliedPolicy = patch.appliedPolicy;
    }
    if ('hybridProgress' in patch) {
      if (patch.hybridProgress === null) delete record.hybridProgress;
      else if (patch.hybridProgress !== undefined) record.hybridProgress = patch.hybridProgress;
    }
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
    if (record.compressionCount === null) return null;
    record.compressionCount += 1;
    record.updatedAt = Date.now();
    return record.compressionCount;
  }

  appendCapacityPinProvenance(id: string, note: string): SessionRecord | null {
    const record = this.records.get(id);
    if (!record?.capacityPin) return null;
    const pin = record.capacityPin;
    if (typeof pin.provenance !== 'string' || pin.provenance.includes(note)) return null;
    // Merge onto the CURRENT stored pin — never a caller-stale copy, so a
    // concurrent shrink is never undone (synchronous store = atomic here).
    // upsert = semantic dedup: a jittered report number replaces the previous
    // note in place instead of growing provenance unbounded.
    record.capacityPin = { ...pin, provenance: upsertCapacityPinRecoveryNote(pin.provenance, note) };
    record.updatedAt = Date.now();
    return record;
  }

  shrinkCapacityPin(id: string, candidate: SessionCapacityPin): SessionRecord | null {
    const record = this.records.get(id);
    if (!record) return null;
    const current = record.capacityPin;
    if (
      current &&
      Number.isFinite(current.windowTokens) &&
      current.windowTokens > 0 &&
      candidate.windowTokens > current.windowTokens
    ) {
      // A smaller constraint is already stored — never expand (synchronous
      // store = the compare-and-write is atomic here).
      return record;
    }
    record.capacityPin = candidate;
    record.updatedAt = Date.now();
    return record;
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
    // The legacy cat/thread pointer names only the most recently created
    // owner. On the shared default thread, every owner-scoped pointer is an
    // equally live session and must participate in the eviction guard.
    const currentActiveIds = new Set([...this.activeIndex.values(), ...this.ownerActiveIndex.values()]);

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

    if (record.cliSessionId) this.cliIndex.delete(record.cliSessionId);
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
    const ownerKey = this.ownerCatThreadKey(record.userId, record.catId, record.threadId);
    if (this.ownerActiveIndex.get(ownerKey) === id) this.ownerActiveIndex.delete(ownerKey);

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
