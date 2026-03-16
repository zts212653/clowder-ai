/**
 * Invocation Registry
 * 管理 MCP 回传工具的调用鉴权
 *
 * 每次 AgentRouter 调用一只猫时，生成 invocationId + callbackToken pair。
 * MCP 回传工具通过 env var 获取这对凭证，调用 API callback 端点时由此模块验证。
 *
 * 安全契约:
 * - invocationId → { userId, catId, callbackToken, expiresAt }
 * - verify() 同时检查 token 匹配 + TTL 过期
 * - LRU + TTL 双重清理
 */

import { randomUUID } from 'node:crypto';
import type { CatId } from '@cat-cafe/shared';

/**
 * A registered invocation record
 */
export interface InvocationRecord {
  invocationId: string;
  callbackToken: string;
  userId: string;
  catId: CatId;
  /** Thread this invocation belongs to (for WebSocket room scoping) */
  threadId: string;
  /** F108 fix: InvocationRecordStore's parent invocation ID for worklist key alignment */
  parentInvocationId?: string;
  /** F121: The A2A trigger message ID — the @mention message that caused this cat to be invoked */
  a2aTriggerMessageId?: string;
  /** In-invocation idempotency keys for callback post-message de-duplication. */
  clientMessageIds: Set<string>;
  createdAt: number;
  expiresAt: number;
}

/** Default TTL: 2 hours (was 10 min — cats routinely run 20-40 min, first callback was 401) */
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

/** Max concurrent invocations before LRU eviction */
const MAX_INVOCATIONS = 500;
/** Max remembered callback idempotency keys per invocation */
const MAX_CLIENT_MESSAGE_IDS = 1000;

/**
 * Registry for managing invocation auth tokens.
 * In-memory implementation — Phase 3 will migrate to Redis.
 */
export class InvocationRegistry {
  private records = new Map<string, InvocationRecord>();
  /** Track the latest invocationId per thread+cat (stale callback guard, cloud Codex P1). */
  private latestByThreadCat = new Map<string, string>();
  private readonly ttlMs: number;
  private readonly maxRecords: number;

  constructor(options?: { ttlMs?: number; maxRecords?: number }) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.maxRecords = options?.maxRecords ?? MAX_INVOCATIONS;
  }

  /**
   * Create a new invocation and return the auth credentials.
   * The caller should pass these as env vars to the CLI subprocess.
   */
  create(
    userId: string,
    catId: CatId,
    threadId: string = 'default',
    parentInvocationId?: string,
    a2aTriggerMessageId?: string,
  ): { invocationId: string; callbackToken: string } {
    this.cleanup();

    // Evict oldest if at capacity
    while (this.records.size >= this.maxRecords) {
      const oldestKey = this.records.keys().next().value;
      if (oldestKey !== undefined) {
        this.cleanupLatestPointer(oldestKey);
        this.records.delete(oldestKey);
      }
    }

    const invocationId = randomUUID();
    const callbackToken = randomUUID();
    const now = Date.now();

    this.records.set(invocationId, {
      invocationId,
      callbackToken,
      userId,
      catId,
      threadId,
      ...(parentInvocationId ? { parentInvocationId } : {}),
      ...(a2aTriggerMessageId ? { a2aTriggerMessageId } : {}),
      clientMessageIds: new Set<string>(),
      createdAt: now,
      expiresAt: now + this.ttlMs,
    });

    // Track latest invocation per thread+cat (stale callback guard)
    this.latestByThreadCat.set(`${threadId}:${catId as string}`, invocationId);

    return { invocationId, callbackToken };
  }

  /**
   * Verify invocationId + callbackToken binding.
   * Returns the record if valid, null if invalid or expired.
   */
  verify(invocationId: string, callbackToken: string): InvocationRecord | null {
    const record = this.records.get(invocationId);
    if (!record) return null;

    // Check token match
    if (record.callbackToken !== callbackToken) return null;

    // Check TTL
    if (Date.now() > record.expiresAt) {
      this.cleanupLatestPointer(invocationId);
      this.records.delete(invocationId);
      return null;
    }

    // Sliding window: each successful verify extends the TTL
    record.expiresAt = Date.now() + this.ttlMs;

    // Refresh recency (LRU): delete + re-set moves to end of Map iteration order
    this.records.delete(invocationId);
    this.records.set(invocationId, record);

    return record;
  }

  /**
   * Check if an invocationId is the latest for its thread+cat slot.
   * Stale callbacks from preempted invocations return false.
   * (Cloud Codex P1 + 缅因猫 R3 suggestion)
   */
  isLatest(invocationId: string): boolean {
    const record = this.records.get(invocationId);
    if (!record) return false;
    const key = `${record.threadId}:${record.catId as string}`;
    return this.latestByThreadCat.get(key) === invocationId;
  }

  /** Get the latest invocationId for a given thread+cat slot, if any. */
  getLatestId(threadId: string, catId: string): string | undefined {
    return this.latestByThreadCat.get(`${threadId}:${catId}`);
  }

  /**
   * Claim a callback clientMessageId for an invocation.
   * Returns true if this ID is first-seen, false if duplicate or invocation missing.
   */
  claimClientMessageId(invocationId: string, clientMessageId: string): boolean {
    const record = this.records.get(invocationId);
    if (!record) return false;

    if (record.clientMessageIds.has(clientMessageId)) {
      return false;
    }

    while (record.clientMessageIds.size >= MAX_CLIENT_MESSAGE_IDS) {
      const oldest = record.clientMessageIds.values().next().value;
      if (oldest === undefined) break;
      record.clientMessageIds.delete(oldest);
    }

    record.clientMessageIds.add(clientMessageId);
    return true;
  }

  /**
   * Clean up latestByThreadCat pointer when a record is about to be removed.
   * Only removes the pointer if it still points to the record being deleted
   * (a newer invocation may have already superseded it).
   */
  private cleanupLatestPointer(invocationId: string): void {
    const record = this.records.get(invocationId);
    if (!record) return;
    const key = `${record.threadId}:${record.catId as string}`;
    if (this.latestByThreadCat.get(key) === invocationId) {
      this.latestByThreadCat.delete(key);
    }
  }

  /**
   * Remove expired records (and their latestByThreadCat pointers)
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, record] of this.records) {
      if (now > record.expiresAt) {
        this.cleanupLatestPointer(key);
        this.records.delete(key);
      }
    }
  }
}
