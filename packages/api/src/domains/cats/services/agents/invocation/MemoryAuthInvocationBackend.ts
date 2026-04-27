/**
 * F174 Phase B — In-memory IAuthInvocationBackend implementation.
 *
 * Default backend for unit tests (no Redis dep) and for `CAT_CAFE_INVOCATION_REGISTRY=memory`
 * fallback. Same in-memory Map + LRU + sliding TTL semantics that lived inside
 * InvocationRegistry pre-Phase-B.
 *
 * Behavior contract (mirrored by RedisAuthInvocationBackend):
 * - create() evicts oldest record if at maxRecords capacity (LRU)
 * - verify() emits typed reason {expired, invalid_token, unknown_invocation}
 *   and slides TTL on success
 * - latestByThreadCat tracks the most recent invocationId per (threadId, catId)
 * - claimClientMessageId enforces MAX_CLIENT_MESSAGE_IDS bound per record
 */

import type { AuthInvocationInput, IAuthInvocationBackend } from './IAuthInvocationBackend.js';
import type { InvocationRecord, VerifyResult } from './InvocationRegistry.js';

const DEFAULT_MAX_RECORDS = 500;
const MAX_CLIENT_MESSAGE_IDS = 1000;

export class MemoryAuthInvocationBackend implements IAuthInvocationBackend {
  private records = new Map<string, InvocationRecord>();
  private latestByThreadCat = new Map<string, string>();
  /** F174 Phase C — per-invocation refresh cooldown deadlines (ms epoch). */
  private refreshCooldown = new Map<string, number>();
  private readonly maxRecords: number;

  constructor(options?: { maxRecords?: number }) {
    this.maxRecords = options?.maxRecords ?? DEFAULT_MAX_RECORDS;
  }

  async tryClaimRefreshCooldown(invocationId: string, cooldownMs: number): Promise<boolean> {
    const now = Date.now();
    // Cloud Codex P2 (PR #1368, 5160ea926): check existing FIRST. If the
    // invocation is already in cooldown, return false without mutating the
    // map. Otherwise repeated re-claims at capacity would churn unrelated
    // valid cooldowns out of the map — letting victims bypass the 5min limit.
    const existing = this.refreshCooldown.get(invocationId);
    if (existing && existing > now) return false;

    // We're going to insert/refresh — clean up first.
    // Lazy GC of stale cooldown entries (cheap when most are expired).
    if (this.refreshCooldown.size > 100) {
      for (const [k, deadline] of this.refreshCooldown) {
        if (deadline <= now) this.refreshCooldown.delete(k);
      }
    }
    // Hard cap: if still over capacity after GC (all entries active), evict
    // oldest insertion (Map iteration order). Cap = this.maxRecords so cooldown
    // tracks parent invocation set — custom maxRecords govern both in lockstep.
    while (this.refreshCooldown.size >= this.maxRecords) {
      const oldest = this.refreshCooldown.keys().next().value;
      if (oldest === undefined) break;
      this.refreshCooldown.delete(oldest);
    }
    this.refreshCooldown.set(invocationId, now + cooldownMs);
    return true;
  }

  async create(input: AuthInvocationInput, ttlMs: number): Promise<void> {
    this.cleanupExpired();

    while (this.records.size >= this.maxRecords) {
      const oldestKey = this.records.keys().next().value;
      if (oldestKey === undefined) break;
      this.cleanupLatestPointer(oldestKey);
      this.records.delete(oldestKey);
    }

    const expiresAt = Date.now() + ttlMs;
    const record: InvocationRecord = { ...input, expiresAt };
    this.records.set(input.invocationId, record);
    this.latestByThreadCat.set(`${input.threadId}:${input.catId as string}`, input.invocationId);
  }

  /**
   * F174-C — verify token without sliding TTL. Refresh-token endpoint uses
   * this to authenticate before claiming cooldown, preventing bad-auth requests
   * from burning the slot.
   */
  async peek(invocationId: string, callbackToken: string): Promise<VerifyResult> {
    const record = this.records.get(invocationId);
    if (!record) return { ok: false, reason: 'unknown_invocation' };
    if (record.callbackToken !== callbackToken) {
      return { ok: false, reason: 'invalid_token' };
    }
    if (Date.now() > record.expiresAt) {
      return { ok: false, reason: 'expired' };
    }
    return { ok: true, record };
  }

  /**
   * F174-C — atomic verify + isLatest + slide. Single JS turn for memory
   * backend so no race window exists between staleness check and TTL slide.
   */
  async verifyLatest(invocationId: string, callbackToken: string, ttlMs: number): Promise<VerifyResult> {
    const record = this.records.get(invocationId);
    if (!record) return { ok: false, reason: 'unknown_invocation' };
    if (record.callbackToken !== callbackToken) {
      return { ok: false, reason: 'invalid_token' };
    }
    if (Date.now() > record.expiresAt) {
      this.cleanupLatestPointer(invocationId);
      this.records.delete(invocationId);
      return { ok: false, reason: 'expired' };
    }
    const latestKey = `${record.threadId}:${record.catId as string}`;
    if (this.latestByThreadCat.get(latestKey) !== invocationId) {
      return { ok: false, reason: 'stale_invocation' };
    }
    record.expiresAt = Date.now() + ttlMs;
    this.records.delete(invocationId);
    this.records.set(invocationId, record);
    return { ok: true, record };
  }

  async verify(invocationId: string, callbackToken: string, ttlMs: number): Promise<VerifyResult> {
    const record = this.records.get(invocationId);
    if (!record) return { ok: false, reason: 'unknown_invocation' };

    if (record.callbackToken !== callbackToken) {
      return { ok: false, reason: 'invalid_token' };
    }

    if (Date.now() > record.expiresAt) {
      this.cleanupLatestPointer(invocationId);
      this.records.delete(invocationId);
      return { ok: false, reason: 'expired' };
    }

    record.expiresAt = Date.now() + ttlMs;
    this.records.delete(invocationId);
    this.records.set(invocationId, record);

    return { ok: true, record };
  }

  async getRecord(invocationId: string): Promise<InvocationRecord | null> {
    const record = this.records.get(invocationId);
    if (!record) return null;
    if (Date.now() > record.expiresAt) {
      this.cleanupLatestPointer(invocationId);
      this.records.delete(invocationId);
      return null;
    }
    return record;
  }

  /**
   * F174 D2b-1 — pure record read, ignores expiry, never deletes. The notifier
   * needs threadId/catId metadata for a 401-causing invocation even when verify()
   * has just deleted it on expired (砚砚 P1 review: PR #1397).
   */
  async peekRecord(invocationId: string): Promise<InvocationRecord | null> {
    return this.records.get(invocationId) ?? null;
  }

  async isLatest(invocationId: string): Promise<boolean> {
    const record = this.records.get(invocationId);
    if (!record) return false;
    const key = `${record.threadId}:${record.catId as string}`;
    return this.latestByThreadCat.get(key) === invocationId;
  }

  async getLatestId(threadId: string, catId: string): Promise<string | undefined> {
    return this.latestByThreadCat.get(`${threadId}:${catId}`);
  }

  async claimClientMessageId(invocationId: string, clientMessageId: string): Promise<boolean> {
    const record = this.records.get(invocationId);
    if (!record) return false;

    if (record.clientMessageIds.has(clientMessageId)) return false;

    while (record.clientMessageIds.size >= MAX_CLIENT_MESSAGE_IDS) {
      const oldest = record.clientMessageIds.values().next().value;
      if (oldest === undefined) break;
      record.clientMessageIds.delete(oldest);
    }
    record.clientMessageIds.add(clientMessageId);
    return true;
  }

  private cleanupLatestPointer(invocationId: string): void {
    const record = this.records.get(invocationId);
    if (!record) return;
    const key = `${record.threadId}:${record.catId as string}`;
    if (this.latestByThreadCat.get(key) === invocationId) {
      this.latestByThreadCat.delete(key);
    }
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [key, record] of this.records) {
      if (now > record.expiresAt) {
        this.cleanupLatestPointer(key);
        this.records.delete(key);
      }
    }
  }
}
