/**
 * Delivery Cursor Store
 *
 * Tracks per-user/per-cat/per-thread last delivered message ID.
 * IDs are lexicographically sortable (timestamp+seq prefix), so monotonic
 * progression can be enforced with string comparison.
 *
 * #1200 P2-3: Async cursor canonicalization.
 * All cursor comparisons require same-format inputs (v2-v2 or v1-v1).
 * The optional cursorCanonicalizer resolves v1 raw IDs → v2 cursors via
 * MessageStore visibility index lookup. Without it, v1 values pass through
 * unchanged and compareCursors returns 0 for cross-format (safe no-advance).
 */

import type { CatId } from '@cat-cafe/shared';
import { catRegistry, createCatId } from '@cat-cafe/shared';
import type { SessionStore } from '@cat-cafe/shared/utils';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { compareCursors } from '../cursor.js';

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

/**
 * Async resolver that canonicalizes a raw message ID (v1 cursor) to a v2 cursor
 * by looking up the message's visibilitySeq from the store.
 * Returns the v2 cursor if resolution succeeds, or the original value unchanged.
 */
export type CursorCanonicalizer = (messageId: string, threadId: string) => Promise<string>;

export class DeliveryCursorStore {
  private readonly sessionStore: SessionStore | null;
  private readonly canonicalizer: CursorCanonicalizer | null;
  private readonly cursors: Map<string, string> = new Map();
  /** Mention-ack cursors — separate namespace from delivery cursors (#77) */
  private readonly mentionAckCursors: Map<string, string> = new Map();
  /** F254: Seen cursors — independent namespace tracking what cat READ mid-turn.
   *  MUST NOT affect delivery cursor or incremental injection (AC-A9). */
  private readonly seenCursors: Map<string, string> = new Map();

  constructor(sessionStore?: SessionStore, canonicalizer?: CursorCanonicalizer) {
    this.sessionStore = sessionStore ?? null;
    this.canonicalizer = canonicalizer ?? null;
  }

  /**
   * Canonicalize a cursor value: v2 passes through, v1 is resolved via
   * the injected canonicalizer (MessageStore visibility index lookup).
   * Returns the original value if no canonicalizer or resolution fails.
   */
  private async canonicalize(cursor: string, threadId: string): Promise<string> {
    if (!cursor || cursor.startsWith('v2:')) return cursor;
    if (!this.canonicalizer) return cursor;
    try {
      return await this.canonicalizer(cursor, threadId);
    } catch {
      // Resolver failed (message pruned, store error) — keep v1
      return cursor;
    }
  }

  /**
   * Compare two cursor values after async canonicalization.
   * Both sides are resolved to v2 before comparison when possible.
   * Falls back to compareCursors which returns 0 for cross-format.
   */
  private async compareCanonical(a: string, b: string, threadId: string): Promise<number> {
    const ca = await this.canonicalize(a, threadId);
    const cb = await this.canonicalize(b, threadId);
    return compareCursors(ca, cb);
  }

  async getCursor(userId: string, catId: CatId, threadId: string): Promise<string | undefined> {
    const key = cursorKey(userId, catId, threadId);
    const memValue = this.cursors.get(key);
    if (this.sessionStore) {
      try {
        const redisValue = await this.sessionStore.getDeliveryCursor(userId, catId, threadId);
        if (redisValue != null) {
          // Return max(redis, memory) — Redis may hold a stale value if a
          // prior ack succeeded in-memory but failed to write to Redis.
          // #1200 P2-3: canonicalize before comparison (async resolver)
          if (memValue) {
            const cmp = await this.compareCanonical(memValue, redisValue, threadId);
            return cmp > 0 ? memValue : redisValue;
          }
          return redisValue;
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
   * concurrent regression. In-memory path canonicalizes via async
   * resolver before comparison (#1200 P2-3).
   */
  async ackCursor(userId: string, catId: CatId, threadId: string, deliveredToId: string): Promise<void> {
    const key = cursorKey(userId, catId, threadId);
    // #1200 P2-3: canonicalize input before comparison
    const canonDelivered = await this.canonicalize(deliveredToId, threadId);
    // Use max(canonicalized input, in-memory cursor) as effective value.
    // This prevents Redis-recovery regression: if Redis was down and
    // in-memory has a higher cursor, we seed Redis with that floor.
    const memCursor = this.cursors.get(key);
    let effective: string;
    if (memCursor) {
      const cmp = await this.compareCanonical(memCursor, canonDelivered, threadId);
      effective = cmp > 0 ? memCursor : canonDelivered;
    } else {
      effective = canonDelivered;
    }

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

    // In-memory fallback: canonicalized comparison
    const current = this.cursors.get(key);
    if (current) {
      const cmp = await this.compareCanonical(effective, current, threadId);
      if (cmp <= 0) return;
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
          // #1200 P2-3: canonicalize before comparison
          if (memValue) {
            const cmp = await this.compareCanonical(memValue, redisValue, threadId);
            return cmp > 0 ? memValue : redisValue;
          }
          return redisValue;
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
   * concurrent regression. In-memory path canonicalizes via async
   * resolver before comparison (#1200 P2-3).
   */
  async ackMentionCursor(userId: string, catId: CatId, threadId: string, messageId: string): Promise<void> {
    const key = cursorKey(userId, catId, threadId);
    // #1200 P2-3: canonicalize input
    const canonMsg = await this.canonicalize(messageId, threadId);
    const memCursor = this.mentionAckCursors.get(key);
    let effective: string;
    if (memCursor) {
      const cmp = await this.compareCanonical(memCursor, canonMsg, threadId);
      effective = cmp > 0 ? memCursor : canonMsg;
    } else {
      effective = canonMsg;
    }

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

    // In-memory fallback: canonicalized comparison
    const current = this.mentionAckCursors.get(key);
    if (current) {
      const cmp = await this.compareCanonical(effective, current, threadId);
      if (cmp <= 0) return;
    }
    this.upsertMap(this.mentionAckCursors, key, effective);
  }

  // ---- F254 Seen Cursor ----
  // Independent namespace tracking what the cat actually READ mid-turn.
  // Uses same monotonic CAS pattern as delivery/mention cursors.
  // CRITICAL: pushing seenCursor MUST NOT affect deliveryCursor (AC-A9).

  /**
   * Get the last seen message ID for a cat in a thread (F254).
   * Returns undefined if no seen cursor exists (= fail-open in freshness gate).
   */
  async getSeenCursor(userId: string, catId: CatId, threadId: string): Promise<string | undefined> {
    const key = cursorKey(userId, catId, threadId);
    const memValue = this.seenCursors.get(key);
    if (this.sessionStore) {
      try {
        const redisValue = await this.sessionStore.getSeenCursor(userId, catId, threadId);
        if (redisValue != null) {
          // #1200 P2-3: canonicalize before comparison
          if (memValue) {
            const cmp = await this.compareCanonical(memValue, redisValue, threadId);
            return cmp > 0 ? memValue : redisValue;
          }
          return redisValue;
        }
      } catch (err) {
        log.warn({ err }, 'getSeenCursor failed, fallback to in-memory');
      }
    }
    return memValue;
  }

  /**
   * Acknowledge seen messages up to a message ID (monotonic forward only, F254).
   * Called by MCP tools (list_recent, get_thread_context, get_message) when
   * cat reads thread messages, and by post_message on successful send.
   */
  async ackSeenCursor(userId: string, catId: CatId, threadId: string, messageId: string): Promise<void> {
    const key = cursorKey(userId, catId, threadId);
    // #1200 P2-3: canonicalize input
    const canonMsg = await this.canonicalize(messageId, threadId);
    const memCursor = this.seenCursors.get(key);
    let effective: string;
    if (memCursor) {
      const cmp = await this.compareCanonical(memCursor, canonMsg, threadId);
      effective = cmp > 0 ? memCursor : canonMsg;
    } else {
      effective = canonMsg;
    }

    if (this.sessionStore) {
      try {
        const advanced = await this.sessionStore.setSeenCursor(userId, catId, threadId, effective);
        if (advanced) {
          this.upsertMap(this.seenCursors, key, effective);
        } else {
          try {
            const actual = await this.sessionStore.getSeenCursor(userId, catId, threadId);
            if (actual) this.upsertMap(this.seenCursors, key, actual);
          } catch {
            // GET failed after CAS noop — memory stays unchanged (safe)
          }
        }
        return;
      } catch (err) {
        log.warn({ err }, 'setSeenCursor failed, fallback to in-memory');
      }
    }

    // In-memory fallback: canonicalized comparison
    const current = this.seenCursors.get(key);
    if (current) {
      const cmp = await this.compareCanonical(effective, current, threadId);
      if (cmp <= 0) return;
    }
    this.upsertMap(this.seenCursors, key, effective);
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
   * Cleanup all per-cat delivery + mention-ack + seen cursors for one user's thread.
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
        try {
          deleted += await this.sessionStore.deleteSeenCursor(userId, catId, threadId);
        } catch (err) {
          log.warn({ err }, 'deleteSeenCursor failed, continue cleanup in-memory');
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
    for (const key of this.seenCursors.keys()) {
      if (key.startsWith(prefix) && key.endsWith(suffix)) {
        this.seenCursors.delete(key);
        deleted++;
      }
    }

    return deleted;
  }
}
