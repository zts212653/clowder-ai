/**
 * ConciergeThreadService (F229 PR-A1)
 *
 * 懒创建/获取 per-user 专属前台猫对话载体（concierge thread）。
 *
 * 设计决策（架构归一，Design Gate §3 选项 a）：
 * - 对话载体 = 普通 thread（消息/invocation/记忆全复用现有设施）
 * - 创建者为 userId（P1 fix：每个用户的 concierge thread 在自己的 Redis user index 下，
 *   无跨用户泄漏风险）
 * - thread.threadKind = 'concierge' — route 层通过此字段过滤，默认不出现在 sidebar；
 *   GET /api/threads?includeConcierge=true 时暴露（threadStore.list(userId) 会返回）
 * - 懒创建：第一次 getOrCreate 时建立，后续调用幂等返回相同 threadId
 *
 * 存储方式：
 * - 生产环境：Redis（ConciergeKeys.threadId(userId)）
 * - 测试/无 Redis：内部 Map（单实例内幂等，跨实例不持久）
 */

import type { CatId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { IThreadStore } from '../cats/services/stores/ports/ThreadStore.js';
import type { IConciergeConfigStore } from './ConciergeConfigStore.js';
import { ConciergeKeys } from './concierge-keys.js';

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface ConciergeThreadServiceDeps {
  threadStore: IThreadStore;
  /** Production: Redis client for per-user threadId persistence */
  redis?: RedisClient;
  /**
   * F229 P1 routing fix: load ConciergeConfig to sync thread.preferredCats = [dutyCatProfileId].
   * When provided, getOrCreate() calls updatePreferredCats so routing targets the duty cat
   * on threads with no @mentions (standard AgentRouter preferredCats fallback path).
   */
  conciergeConfigStore?: IConciergeConfigStore;
}

export class ConciergeThreadService {
  private readonly threadStore: IThreadStore;
  private readonly redis?: RedisClient;
  /** Fallback in-memory index when Redis is absent (testing / standalone) */
  private readonly memIndex = new Map<string, string>();
  /** In-flight deduplication: concurrent getOrCreate for same userId share one Promise */
  private readonly inFlight = new Map<string, Promise<string>>();
  private readonly conciergeConfigStore?: IConciergeConfigStore;

  constructor(deps: ConciergeThreadServiceDeps) {
    this.threadStore = deps.threadStore;
    this.redis = deps.redis;
    this.conciergeConfigStore = deps.conciergeConfigStore;
  }

  /**
   * 获取或懒创建 per-user concierge thread。
   * 幂等：同 userId 多次调用（含并发）返回相同 threadId。
   */
  async getOrCreate(userId: string): Promise<string> {
    const existing = this.inFlight.get(userId);
    if (existing) return existing;

    const promise = this._doGetOrCreate(userId).finally(() => {
      this.inFlight.delete(userId);
    });
    this.inFlight.set(userId, promise);
    return promise;
  }

  private async _doGetOrCreate(userId: string): Promise<string> {
    // 1. Check stored threadId
    const stored = await this.getStoredThreadId(userId);
    let threadId: string;

    if (stored) {
      const thread = await this.threadStore.get(stored);
      if (thread && !thread.deletedAt) {
        // R19 P2 self-heal: if the canonical thread lacks threadKind='concierge' (can happen
        // when a crash occurs after storeThreadId() wins SET NX but before updateThreadKind()
        // completes), repair the marker now so concierge prompt injection and route-layer
        // filtering (AgentRouter bypass, sidebar hide) activate correctly on this call.
        if (thread.threadKind !== 'concierge') {
          await this.threadStore.updateThreadKind(stored, 'concierge');
        }
        threadId = stored;
      } else {
        // Thread was hard-deleted or soft-deleted (deletedAt set) — re-create fresh.
        // CAS-DEL the stale key first. If another instance already wrote a fresh
        // canonical threadId (CAS no-op → false), read it back instead of creating
        // a new concierge thread — avoids user-indexed orphan threads appearing in
        // GET /api/threads?includeConcierge=true.
        const staleKeyRemoved = await this.deleteStaleKey(userId, stored);
        if (staleKeyRemoved) {
          threadId = await this.createThread(userId);
        } else {
          // CAS no-op: another instance is recovering this key. Two sub-cases:
          //   A) Winner already finished SET NX → getStoredThreadId returns canonical id.
          //   B) Winner deleted stale key but SET NX still in-flight → null.
          // Poll until the canonical id appears (handles slow winners: Redis hiccup,
          // event-loop pause, cold store). Fall back to createThread only if null
          // persists past the 500ms timeout window (winner crash — extremely unlikely).
          let canonical = await this.getStoredThreadId(userId);
          const deadline = Date.now() + 500;
          while (!canonical && Date.now() < deadline) {
            await new Promise<void>((r) => setTimeout(r, 50));
            canonical = await this.getStoredThreadId(userId);
          }
          threadId = canonical ?? (await this.createThread(userId));
        }
      }
    } else {
      threadId = await this.createThread(userId);
    }

    // F229 P1 routing fix: sync preferredCats = [dutyCatProfileId] so routing targets the
    // duty cat on messages without @mention (standard AgentRouter preferredCats fallback path).
    // Called on every getOrCreate so config changes stay in sync.
    if (this.conciergeConfigStore) {
      const config = await this.conciergeConfigStore.get(userId);
      if (config.dutyCatProfileId) {
        await this.threadStore.updatePreferredCats(threadId, [config.dutyCatProfileId as CatId]);
      }
    }

    return threadId;
  }

  private async createThread(userId: string): Promise<string> {
    // createdBy = userId: thread is per-user indexed; threadKind='concierge' is the
    // route-layer signal for default filtering (hidden unless includeConcierge=true).
    const thread = await this.threadStore.create(userId, `前台猫·${userId}`, undefined);
    // R18 P2 (crash-atomicity): claim the canonical key BEFORE setting threadKind.
    // If the process crashes between create() and storeThreadId(), the orphan is a
    // plain thread (no threadKind) — visible in sidebar but single-canonical-carrier
    // invariant holds (no key claimed, next getOrCreate creates a fresh canonical).
    // If it crashes after storeThreadId() but before updateThreadKind(), the thread is
    // canonical but lacks the marker — degraded UX, no duplicate carrier.
    // Contrast: old order (create → updateThreadKind → storeThreadId) could leave an
    // orphan thread with threadKind='concierge' but no key, allowing a second canonical.
    const canonicalId = await this.storeThreadId(userId, thread.id);
    if (canonicalId !== thread.id) {
      // SET NX lost the race — soft-delete our orphan so it doesn't appear in the
      // user's thread list as a ghost normal thread.
      await this.threadStore.softDelete(thread.id);
      return canonicalId;
    }
    await this.threadStore.updateThreadKind(thread.id, 'concierge');
    return thread.id;
  }

  // ---------------------------------------------------------------------------
  // Public discovery helpers
  // ---------------------------------------------------------------------------

  /**
   * Return the stored concierge threadId without creating one.
   * Used by threads route (includeConcierge=true) to surface the thread to the caller.
   * Returns null if the thread has not been created yet or was deleted.
   */
  async findThreadId(userId: string): Promise<string | null> {
    const stored = await this.getStoredThreadId(userId);
    if (!stored) return null;
    const thread = await this.threadStore.get(stored);
    // Treat soft-deleted threads as not found — caller should not surface tombstoned threads
    return thread && !thread.deletedAt ? stored : null;
  }

  /**
   * Sync routing preference immediately after a duty-cat config change (P2 cloud fix).
   * Without this, preferredCats on the thread stays stale until the next getOrCreate call,
   * so the old cat answers without the concierge duty prompt after a dutyCatProfileId update.
   * No-op when the thread does not exist yet — getOrCreate will sync on first call.
   */
  async syncPreferredCats(userId: string, dutyCatProfileId: CatId): Promise<void> {
    const stored = await this.getStoredThreadId(userId);
    if (!stored) return;
    const thread = await this.threadStore.get(stored);
    // Skip soft-deleted threads — routing sync is only meaningful on live threads
    if (!thread || thread.deletedAt) return;
    await this.threadStore.updatePreferredCats(stored, [dutyCatProfileId]);
  }

  // ---------------------------------------------------------------------------
  // Phase B: propose_thread action
  // ---------------------------------------------------------------------------

  /**
   * Create a proposed thread (Phase B §2b).
   * Unlike getOrCreate (concierge-specific lazy singleton), this creates a regular
   * thread on behalf of the user, used by the propose_thread intent.
   */
  async createProposedThread(userId: string, title: string, _description?: string): Promise<string> {
    // threadStore.create(userId, title, projectPath?, parentThreadId?, proposalAudit?)
    // description is informational only — not stored as projectPath
    const thread = await this.threadStore.create(userId, title);
    return thread.id;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Conditional compare-and-delete: remove the concierge Redis key for userId
   * ONLY if it still holds the exact `staleId` we read earlier.
   *
   * Why CAS instead of unconditional DEL:
   *   Race with two concurrent recovery paths (both see deleted thread):
   *   1. Process A: DEL key → createThread → thread-Y → SET NX → key = thread-Y
   *   2. Process B: DEL key — if fired AFTER step 1, this removes canonical thread-Y.
   *      B's SET NX then claims thread-Z; A returns an orphaned id.
   *   With CAS-DEL, B's eval sees `GET key = thread-Y ≠ staleId` → skips DEL →
   *   returns false → caller reads back thread-Y instead of calling createThread().
   *   No orphaned user-indexed concierge threads are created.
   *
   * In-memory fallback uses an equivalent synchronous compare-and-delete.
   * TTL=0 (no EX/PX) — persistent per LL-048.
   *
   * Returns true if the key was deleted (caller should createThread), false if
   * the key had already been updated (caller should read the canonical value).
   */
  private async deleteStaleKey(userId: string, staleId: string): Promise<boolean> {
    if (this.redis) {
      // Lua CAS-DEL: atomic GET + conditional DEL, returns 1 if deleted, 0 if no-op
      const casDelScript = `
        if redis.call('GET', KEYS[1]) == ARGV[1] then
          redis.call('DEL', KEYS[1])
          return 1
        else
          return 0
        end
      `;
      const result = await this.redis.eval(casDelScript, 1, ConciergeKeys.threadId(userId), staleId);
      return result === 1;
    } else {
      if (this.memIndex.get(userId) === staleId) {
        this.memIndex.delete(userId);
        return true;
      }
      return false;
    }
  }

  private async getStoredThreadId(userId: string): Promise<string | null> {
    if (this.redis) {
      return this.redis.get(ConciergeKeys.threadId(userId));
    }
    return this.memIndex.get(userId) ?? null;
  }

  /**
   * Atomically store the concierge threadId for a user.
   *
   * Uses Redis SET NX so that concurrent API instances can't stomp each other:
   *   - If this process wins (key was absent), returns `threadId`.
   *   - If another process already wrote the key (race lost), soft-deletes our thread
   *     (best-effort) to prevent it from appearing as a duplicate in includeConcierge=true
   *     queries, then returns the winner's canonical threadId.
   *
   * TTL=0 implicit (no EX/PX) — persistent per LL-048.
   *
   * Returns the authoritative threadId (may differ from `threadId` on race loss).
   */
  private async storeThreadId(userId: string, threadId: string): Promise<string> {
    if (this.redis) {
      const claimed = await this.redis.set(ConciergeKeys.threadId(userId), threadId, 'NX');
      if (!claimed) {
        // Race lost — another API instance already created the concierge thread for this user.
        // Soft-delete our orphaned thread (best-effort) so it doesn't appear as a duplicate
        // empty concierge thread in GET /api/threads?includeConcierge=true.
        await Promise.resolve(this.threadStore.softDelete(threadId)).catch(() => {});
        return (await this.redis.get(ConciergeKeys.threadId(userId))) ?? threadId;
      }
      return threadId;
    } else {
      this.memIndex.set(userId, threadId);
      return threadId;
    }
  }
}
