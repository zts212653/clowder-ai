/**
 * Delivery Cursor Store
 *
 * Tracks per-user/per-cat/per-thread last delivered message ID.
 * IDs are lexicographically sortable (timestamp+seq prefix), so monotonic
 * progression can be enforced with string comparison.
 */

import type { CatId } from '@cat-cafe/shared';
import { catRegistry, createCatId } from '@cat-cafe/shared';
import type { SessionStore } from '@cat-cafe/shared/utils';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';

const log = createModuleLogger('delivery-cursor-store');

const MAX_CURSORS = 5000;
const FALLBACK_CATS: readonly CatId[] = [createCatId('opus'), createCatId('codex'), createCatId('gemini')];

/** Get all cat IDs dynamically from registry, with static fallback */
function getAllCats(): readonly CatId[] {
  const ids = catRegistry.getAllIds();
  return ids.length > 0 ? ids.map((id) => createCatId(id)) : FALLBACK_CATS;
}

function cursorKey(userId: string, catId: CatId, threadId: string): string {
  return `${userId}:${catId}:${threadId}`;
}

export class DeliveryCursorStore {
  private readonly sessionStore: SessionStore | null;
  private readonly cursors: Map<string, string> = new Map();
  /** Mention-ack cursors — separate namespace from delivery cursors (#77) */
  private readonly mentionAckCursors: Map<string, string> = new Map();

  constructor(sessionStore?: SessionStore) {
    this.sessionStore = sessionStore ?? null;
  }

  async getCursor(userId: string, catId: CatId, threadId: string): Promise<string | undefined> {
    const key = cursorKey(userId, catId, threadId);
    const memValue = this.cursors.get(key);
    if (this.sessionStore) {
      try {
        const redisValue = await this.sessionStore.getDeliveryCursor(userId, catId, threadId);
        if (redisValue != null) {
          // Return max(redis, memory) — Redis may hold a stale value if a
          // prior ack succeeded in-memory but failed to write to Redis
          return memValue && memValue > redisValue ? memValue : redisValue;
        }
        // Redis returned null — fall through to return memValue below
      } catch (err) {
        log.warn({ err }, 'getDeliveryCursor failed, fallback to in-memory cursor');
      }
    }
    return memValue;
  }

  /**
   * Monotonic ack: cursor only moves forward.
   * Redis path uses atomic compare-and-set (Lua script) to prevent
   * concurrent regression. In-memory path is safe because Node.js is
   * single-threaded with no await between read and write.
   */
  async ackCursor(userId: string, catId: CatId, threadId: string, deliveredToId: string): Promise<void> {
    const key = cursorKey(userId, catId, threadId);
    // Use max(deliveredToId, in-memory cursor) as effective value.
    // This prevents Redis-recovery regression: if Redis was down and
    // in-memory has a higher cursor, we seed Redis with that floor.
    const memCursor = this.cursors.get(key);
    const effective = memCursor && memCursor > deliveredToId ? memCursor : deliveredToId;

    if (this.sessionStore) {
      try {
        // Atomic CAS in Redis — monotonic check + write in one round-trip
        const advanced = await this.sessionStore.setDeliveryCursor(userId, catId, threadId, effective);
        if (advanced) {
          // CAS accepted — sync in-memory to match Redis
          this.upsertMap(this.cursors, key, effective);
        } else {
          // CAS noop (Redis already has a higher value) — sync in-memory
          // to Redis's actual value so fallback reads don't regress.
          // Inner try-catch: if this GET fails, we must NOT fall through
          // to the outer catch which would write `effective` (a lower value)
          // into memory. Instead, leave memory unchanged and return.
          try {
            const actual = await this.sessionStore.getDeliveryCursor(userId, catId, threadId);
            if (actual) this.upsertMap(this.cursors, key, actual);
          } catch {
            // GET failed after CAS noop — memory stays unchanged (safe)
          }
        }
        return;
      } catch (err) {
        log.warn({ err }, 'setDeliveryCursor failed, fallback to in-memory cursor');
      }
    }

    // In-memory fallback: monotonic check then write (no await gap = safe)
    const current = this.cursors.get(key);
    if (current && effective <= current) {
      return;
    }
    this.upsertMap(this.cursors, key, effective);
  }

  // ---- Mention Ack Cursor (#77) ----

  /**
   * Get the last acknowledged mention message ID for a cat in a thread.
   * Returns undefined if no ack cursor exists (= all mentions are pending).
   */
  async getMentionAckCursor(userId: string, catId: CatId, threadId: string): Promise<string | undefined> {
    const key = cursorKey(userId, catId, threadId);
    const memValue = this.mentionAckCursors.get(key);
    if (this.sessionStore) {
      try {
        const redisValue = await this.sessionStore.getMentionAckCursor(userId, catId, threadId);
        if (redisValue != null) {
          // Return max(redis, memory) — same rationale as getCursor
          return memValue && memValue > redisValue ? memValue : redisValue;
        }
        // Redis returned null — fall through to return memValue below
      } catch (err) {
        log.warn({ err }, 'getMentionAckCursor failed, fallback to in-memory');
      }
    }
    return memValue;
  }

  /**
   * Acknowledge mentions up to a message ID (monotonic forward only).
   * Redis path uses atomic compare-and-set (Lua script) to prevent
   * concurrent regression. In-memory path is safe (no await gap).
   */
  async ackMentionCursor(userId: string, catId: CatId, threadId: string, messageId: string): Promise<void> {
    const key = cursorKey(userId, catId, threadId);
    // Use max(messageId, in-memory cursor) as effective value.
    // Prevents Redis-recovery regression (same as ackCursor).
    const memCursor = this.mentionAckCursors.get(key);
    const effective = memCursor && memCursor > messageId ? memCursor : messageId;

    if (this.sessionStore) {
      try {
        // Atomic CAS in Redis — monotonic check + write in one round-trip
        const advanced = await this.sessionStore.setMentionAckCursor(userId, catId, threadId, effective);
        if (advanced) {
          // CAS accepted — sync in-memory to match Redis
          this.upsertMap(this.mentionAckCursors, key, effective);
        } else {
          // CAS noop — sync in-memory to Redis's actual value.
          // Inner try-catch: same rationale as ackCursor above.
          try {
            const actual = await this.sessionStore.getMentionAckCursor(userId, catId, threadId);
            if (actual) this.upsertMap(this.mentionAckCursors, key, actual);
          } catch {
            // GET failed after CAS noop — memory stays unchanged (safe)
          }
        }
        return;
      } catch (err) {
        log.warn({ err }, 'setMentionAckCursor failed, fallback to in-memory');
      }
    }

    // In-memory fallback: monotonic check then write (no await gap = safe)
    const current = this.mentionAckCursors.get(key);
    if (current && effective <= current) {
      return;
    }
    this.upsertMap(this.mentionAckCursors, key, effective);
  }

  // ---- Helpers ----

  /** Insert or update a cursor map, enforcing MAX_CURSORS eviction. */
  private upsertMap(map: Map<string, string>, key: string, value: string): void {
    if (map.has(key)) {
      map.delete(key);
    }
    while (map.size >= MAX_CURSORS) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) {
        map.delete(oldest);
      }
    }
    map.set(key, value);
  }

  // ---- Cleanup ----

  /**
   * Cleanup all per-cat delivery + mention-ack cursors for one user's thread.
   * Called during thread cascade delete to avoid stale cursor accumulation.
   */
  async deleteByThreadForUser(userId: string, threadId: string): Promise<number> {
    let deleted = 0;

    if (this.sessionStore) {
      for (const catId of getAllCats()) {
        try {
          deleted += await this.sessionStore.deleteDeliveryCursor(userId, catId, threadId);
        } catch (err) {
          log.warn({ err }, 'deleteDeliveryCursor failed, continue cleanup in-memory');
        }
        try {
          deleted += await this.sessionStore.deleteMentionAckCursor(userId, catId, threadId);
        } catch (err) {
          log.warn({ err }, 'deleteMentionAckCursor failed, continue cleanup in-memory');
        }
      }
    }

    const suffix = `:${threadId}`;
    const prefix = `${userId}:`;
    for (const key of this.cursors.keys()) {
      if (key.startsWith(prefix) && key.endsWith(suffix)) {
        this.cursors.delete(key);
        deleted++;
      }
    }
    for (const key of this.mentionAckCursors.keys()) {
      if (key.startsWith(prefix) && key.endsWith(suffix)) {
        this.mentionAckCursors.delete(key);
        deleted++;
      }
    }

    return deleted;
  }
}
