/**
 * Delivery Cursor Store
 *
 * Tracks per-user/per-cat/per-thread visibility positions.
 * Durable slots may use gated v1/v2 wire encodings, but monotonic progression
 * is always decided in the canonical visibility domain, never by raw-ID order.
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
import {
  visibilityCursorUnresolvedMutation,
  visibilityCursorUnresolvedRepair,
} from '../../../../../infrastructure/telemetry/instruments.js';
import { compareCursors, parseCursor } from '../cursor.js';
import { gateForDurableSlot } from '../cursor-activation.js';

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

interface CursorResolution {
  cursor: string;
  status: 'resolved' | 'unresolved';
  error?: unknown;
  failure?: 'parse' | 'canonicalize';
}

/** Raised only on durable mutation paths; read consumers retain conservative fallback semantics. */
export class UnresolvedVisibilityCursorError extends Error {
  readonly code = 'UNRESOLVED_VISIBILITY_CURSOR';

  constructor(namespace: 'delivery' | 'mention' | 'seen', threadId: string, cursor: string, cause?: unknown) {
    super(`UNRESOLVED_VISIBILITY_CURSOR: namespace=${namespace} threadId=${threadId} cursor=${cursor}`);
    this.name = 'UnresolvedVisibilityCursorError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: cause, enumerable: false });
    }
  }
}

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
  private async resolveCursor(cursor: string, threadId: string): Promise<CursorResolution> {
    let parsed: ReturnType<typeof parseCursor>;
    try {
      parsed = parseCursor(cursor);
    } catch (error) {
      return { cursor, status: 'unresolved', error, failure: 'parse' };
    }
    if (!parsed || parsed.version === 2) return { cursor, status: 'resolved' };
    // No resolver is an intentional legacy/in-memory configuration. Its v1
    // values remain comparable within the raw-ID domain; "unresolved" is
    // reserved for a configured resolver that failed to recover visibility.
    if (!this.canonicalizer) return { cursor, status: 'resolved' };
    try {
      const resolved = await this.canonicalizer(cursor, threadId);
      const resolvedCursor = parseCursor(resolved);
      return resolvedCursor?.version === 2
        ? { cursor: resolved, status: 'resolved' }
        : { cursor, status: 'unresolved' };
    } catch (error) {
      return { cursor, status: 'unresolved', error, failure: 'canonicalize' };
    }
  }

  private async canonicalize(cursor: string, threadId: string): Promise<string> {
    return (await this.resolveCursor(cursor, threadId)).cursor;
  }

  private assertResolvedForMutation(
    resolution: CursorResolution,
    namespace: 'delivery' | 'mention' | 'seen',
    threadId: string,
  ): void {
    if (resolution.failure === 'parse') {
      visibilityCursorUnresolvedMutation.add(1);
      throw resolution.error;
    }
    // A store without a canonicalizer is an intentionally legacy/in-memory
    // configuration. Once a resolver is configured, unresolved raw ingress is
    // a migration fault and must not silently create or freeze a durable slot.
    if (this.canonicalizer && resolution.status === 'unresolved') {
      visibilityCursorUnresolvedMutation.add(1);
      throw new UnresolvedVisibilityCursorError(namespace, threadId, resolution.cursor, resolution.error);
    }
  }

  private async resolveForMutation(
    cursor: string,
    namespace: 'delivery' | 'mention' | 'seen',
    threadId: string,
  ): Promise<string> {
    const resolution = await this.resolveCursor(cursor, threadId);
    this.assertResolvedForMutation(resolution, namespace, threadId);
    return resolution.cursor;
  }

  /**
   * Compare two cursor values after async canonicalization.
   * Both sides are resolved to v2 before comparison when possible.
   * Falls back to compareCursors which returns 0 for cross-format.
   */
  private async compareCanonical(
    a: string,
    b: string,
    threadId: string,
    namespace?: 'delivery' | 'mention' | 'seen',
  ): Promise<number> {
    const [ra, rb] = await Promise.all([this.resolveCursor(a, threadId), this.resolveCursor(b, threadId)]);
    if (namespace) {
      this.assertResolvedForMutation(ra, namespace, threadId);
      this.assertResolvedForMutation(rb, namespace, threadId);
    }
    if (ra.status === 'unresolved' || rb.status === 'unresolved') return 0;
    return compareCursors(ra.cursor, rb.cursor);
  }

  /**
   * A malformed or fully-pruned stored value has no position left to compare.
   * A later ACK is nevertheless fresh evidence: its caller has accepted a
   * canonical boundary. Resolver failure alone is not proof that the stored
   * position is gone. Replace only the exact value we inspected so concurrent
   * writers remain safe.
   */
  private async repairUnresolvedStoredCursor(
    userId: string,
    catId: CatId,
    threadId: string,
    namespace: 'delivery' | 'mention' | 'seen',
    stored: string | null,
    durableValue: string,
    canonicalValue: string,
    map: Map<string, string>,
    key: string,
  ): Promise<boolean> {
    if (!this.sessionStore || !this.canonicalizer || !stored) return false;
    const storedResolution = await this.resolveCursor(stored, threadId);
    if (storedResolution.status !== 'unresolved' || storedResolution.failure === 'canonicalize') return false;

    let repaired = false;
    if (namespace === 'delivery') {
      repaired = await this.sessionStore.replaceDeliveryCursorIfEqual(userId, catId, threadId, stored, durableValue);
    } else if (namespace === 'mention') {
      repaired = await this.sessionStore.replaceMentionAckCursorIfEqual(userId, catId, threadId, stored, durableValue);
    } else {
      repaired = await this.sessionStore.replaceSeenCursorIfEqual(userId, catId, threadId, stored, durableValue);
    }
    if (!repaired) return false;

    visibilityCursorUnresolvedRepair.add(1, { namespace });
    this.upsertMap(map, key, canonicalValue);
    return true;
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
            const winner = cmp > 0 ? memValue : redisValue;
            // #1200 P1-4: canonicalize return value so consumers never see raw v1.
            // Without this, compareCursors(v2, rawV1) returns 0 (indeterminate),
            // which consumers using `<= 0` interpret as "already processed".
            return this.canonicalize(winner, threadId);
          }
          return this.canonicalize(redisValue, threadId);
        }
        // Redis returned null — fall through to return memValue below
      } catch (err) {
        log.warn({ err }, 'getDeliveryCursor failed, fallback to in-memory cursor');
      }
    }
    return memValue ? this.canonicalize(memValue, threadId) : memValue;
  }

  /**
   * Monotonic ack: cursor only moves forward.
   * Redis path uses atomic compare-and-set (Lua script) to prevent
   * concurrent regression. In-memory path canonicalizes via async
   * resolver before comparison (#1200 P2-3).
   */
  async ackCursor(userId: string, catId: CatId, threadId: string, deliveredToId: string): Promise<void> {
    const key = cursorKey(userId, catId, threadId);
    // #1200 P2-3/A3: canonicalize input before comparison. A configured
    // resolver returning raw is explicit unresolved state, not a valid value
    // for a durable visibility slot.
    const canonDelivered = await this.resolveForMutation(deliveredToId, 'delivery', threadId);
    // Use max(canonicalized input, in-memory cursor) as effective value.
    // This prevents Redis-recovery regression: if Redis was down and
    // in-memory has a higher cursor, we seed Redis with that floor.
    const memCursor = this.cursors.get(key);
    let effective: string;
    if (memCursor) {
      const cmp = await this.compareCanonical(memCursor, canonDelivered, threadId, 'delivery');
      effective = cmp > 0 ? memCursor : canonDelivered;
    } else {
      effective = canonDelivered;
    }

    if (this.sessionStore) {
      try {
        // #1269: Read stored cursor for durable-slot gate decision.
        const stored = await this.getStoredCursor(userId, catId, threadId, 'delivery');
        const gated = gateForDurableSlot(effective, stored);

        if (
          await this.repairUnresolvedStoredCursor(
            userId,
            catId,
            threadId,
            'delivery',
            stored,
            gated,
            effective,
            this.cursors,
            key,
          )
        ) {
          return;
        }

        // #1200 Sol R5: Pre-reconcile stored v1→v2 only when writing v2.
        // When gate produces v1, stored is v1/null → same-format CAS works.
        // When gate produces v2, preReconcile ensures stored is v2 for CAS.
        if (gated.startsWith('v2:')) {
          await this.preReconcile(userId, catId, threadId, 'delivery');
        }

        // Atomic CAS in Redis — monotonic check + write in one round-trip
        const advanced = await this.sessionStore.setDeliveryCursor(userId, catId, threadId, gated);
        if (advanced) {
          // CAS accepted — sync in-memory with canonical v2 (for comparison)
          this.upsertMap(this.cursors, key, effective);
        } else {
          // CAS noop (Redis already has a higher value) — sync in-memory
          // to Redis's actual value so fallback reads don't regress.
          try {
            const actual = await this.sessionStore.getDeliveryCursor(userId, catId, threadId);
            if (actual) {
              // The incoming effective value was already resolved above. A
              // normal noop may sync memory only when Redis's actual value is
              // independently resolvable; otherwise the outcome is unknown.
              const canonActual = await this.resolveForMutation(actual, 'delivery', threadId);
              this.upsertMap(this.cursors, key, canonActual);
            }
          } catch (err) {
            if (err instanceof UnresolvedVisibilityCursorError) throw err;
            // GET failed after CAS noop — memory stays unchanged (safe)
          }
        }
        return;
      } catch (err) {
        if (err instanceof UnresolvedVisibilityCursorError) throw err;
        log.warn({ err }, 'setDeliveryCursor failed, fallback to in-memory cursor');
      }
    }

    // In-memory fallback: canonicalized comparison (no durable slot, no gate)
    const current = this.cursors.get(key);
    if (current) {
      const cmp = await this.compareCanonical(effective, current, threadId, 'delivery');
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
            const winner = cmp > 0 ? memValue : redisValue;
            // #1200 P1-4: canonicalize return — prevent cross-format 0 leak to consumers
            return this.canonicalize(winner, threadId);
          }
          return this.canonicalize(redisValue, threadId);
        }
        // Redis returned null — fall through to return memValue below
      } catch (err) {
        log.warn({ err }, 'getMentionAckCursor failed, fallback to in-memory');
      }
    }
    return memValue ? this.canonicalize(memValue, threadId) : memValue;
  }

  /**
   * Acknowledge mentions up to a message ID (monotonic forward only).
   * Redis path uses atomic compare-and-set (Lua script) to prevent
   * concurrent regression. In-memory path canonicalizes via async
   * resolver before comparison (#1200 P2-3).
   */
  async ackMentionCursor(userId: string, catId: CatId, threadId: string, messageId: string): Promise<void> {
    const key = cursorKey(userId, catId, threadId);
    // #1200 P2-3/A3: unresolved raw ingress is not a durable mention position.
    const canonMsg = await this.resolveForMutation(messageId, 'mention', threadId);
    const memCursor = this.mentionAckCursors.get(key);
    let effective: string;
    if (memCursor) {
      const cmp = await this.compareCanonical(memCursor, canonMsg, threadId, 'mention');
      effective = cmp > 0 ? memCursor : canonMsg;
    } else {
      effective = canonMsg;
    }

    if (this.sessionStore) {
      try {
        // #1269: Read stored cursor for durable-slot gate decision.
        const stored = await this.getStoredCursor(userId, catId, threadId, 'mention');
        const gated = gateForDurableSlot(effective, stored);

        if (
          await this.repairUnresolvedStoredCursor(
            userId,
            catId,
            threadId,
            'mention',
            stored,
            gated,
            effective,
            this.mentionAckCursors,
            key,
          )
        ) {
          return;
        }

        // #1200 Sol R5: Pre-reconcile only when writing v2 (same rationale as ackCursor)
        if (gated.startsWith('v2:')) {
          await this.preReconcile(userId, catId, threadId, 'mention');
        }
        // Atomic CAS in Redis — monotonic check + write in one round-trip
        const advanced = await this.sessionStore.setMentionAckCursor(userId, catId, threadId, gated);
        if (advanced) {
          // CAS accepted — sync in-memory with canonical v2 (for comparison)
          this.upsertMap(this.mentionAckCursors, key, effective);
        } else {
          // CAS noop — sync in-memory to Redis's actual value.
          try {
            const actual = await this.sessionStore.getMentionAckCursor(userId, catId, threadId);
            if (actual) {
              const canonActual = await this.resolveForMutation(actual, 'mention', threadId);
              this.upsertMap(this.mentionAckCursors, key, canonActual);
            }
          } catch (err) {
            if (err instanceof UnresolvedVisibilityCursorError) throw err;
            // GET failed after CAS noop — memory stays unchanged (safe)
          }
        }
        return;
      } catch (err) {
        if (err instanceof UnresolvedVisibilityCursorError) throw err;
        log.warn({ err }, 'setMentionAckCursor failed, fallback to in-memory');
      }
    }

    // In-memory fallback: canonicalized comparison (no durable slot, no gate)
    const current = this.mentionAckCursors.get(key);
    if (current) {
      const cmp = await this.compareCanonical(effective, current, threadId, 'mention');
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
            const winner = cmp > 0 ? memValue : redisValue;
            // #1200 P1-4: canonicalize return — prevent cross-format 0 leak to consumers
            return this.canonicalize(winner, threadId);
          }
          return this.canonicalize(redisValue, threadId);
        }
      } catch (err) {
        log.warn({ err }, 'getSeenCursor failed, fallback to in-memory');
      }
    }
    return memValue ? this.canonicalize(memValue, threadId) : memValue;
  }

  /**
   * Acknowledge seen messages up to a message ID (monotonic forward only, F254).
   * Called by MCP tools (list_recent, get_thread_context, get_message) when
   * cat reads thread messages, and by post_message on successful send.
   */
  async ackSeenCursor(userId: string, catId: CatId, threadId: string, messageId: string): Promise<void> {
    const key = cursorKey(userId, catId, threadId);
    // #1200 P2-3/A3: unresolved raw ingress is not canonical read evidence.
    const canonMsg = await this.resolveForMutation(messageId, 'seen', threadId);
    const memCursor = this.seenCursors.get(key);
    let effective: string;
    if (memCursor) {
      const cmp = await this.compareCanonical(memCursor, canonMsg, threadId, 'seen');
      effective = cmp > 0 ? memCursor : canonMsg;
    } else {
      effective = canonMsg;
    }

    if (this.sessionStore) {
      try {
        // #1269: Read stored cursor for durable-slot gate decision.
        const stored = await this.getStoredCursor(userId, catId, threadId, 'seen');
        const gated = gateForDurableSlot(effective, stored);

        if (
          await this.repairUnresolvedStoredCursor(
            userId,
            catId,
            threadId,
            'seen',
            stored,
            gated,
            effective,
            this.seenCursors,
            key,
          )
        ) {
          return;
        }

        // #1200 Sol R5: Pre-reconcile only when writing v2 (same rationale as ackCursor)
        if (gated.startsWith('v2:')) {
          await this.preReconcile(userId, catId, threadId, 'seen');
        }
        const advanced = await this.sessionStore.setSeenCursor(userId, catId, threadId, gated);
        if (advanced) {
          this.upsertMap(this.seenCursors, key, effective);
        } else {
          try {
            const actual = await this.sessionStore.getSeenCursor(userId, catId, threadId);
            if (actual) {
              const canonActual = await this.resolveForMutation(actual, 'seen', threadId);
              this.upsertMap(this.seenCursors, key, canonActual);
            }
          } catch (err) {
            if (err instanceof UnresolvedVisibilityCursorError) throw err;
            // GET failed after CAS noop — memory stays unchanged (safe)
          }
        }
        return;
      } catch (err) {
        if (err instanceof UnresolvedVisibilityCursorError) throw err;
        log.warn({ err }, 'setSeenCursor failed, fallback to in-memory');
      }
    }

    // In-memory fallback: canonicalized comparison (no durable slot, no gate)
    const current = this.seenCursors.get(key);
    if (current) {
      const cmp = await this.compareCanonical(effective, current, threadId, 'seen');
      if (cmp <= 0) return;
    }
    this.upsertMap(this.seenCursors, key, effective);
  }

  // ---- Durable-slot helpers (#1269) ----

  /** Read existing stored cursor value for a namespace (no side effects). */
  private async getStoredCursor(
    userId: string,
    catId: CatId,
    threadId: string,
    namespace: 'delivery' | 'mention' | 'seen',
  ): Promise<string | null> {
    if (!this.sessionStore) return null;
    if (namespace === 'delivery') {
      return this.sessionStore.getDeliveryCursor(userId, catId, threadId);
    }
    if (namespace === 'mention') {
      return this.sessionStore.getMentionAckCursor(userId, catId, threadId);
    }
    return this.sessionStore.getSeenCursor(userId, catId, threadId);
  }

  // ---- Pre-reconciliation (#1200 Sol R5) ----

  /**
   * Pre-reconcile stored v1 cursor to v2 format before CAS.
   *
   * Lua CAS is fail-closed on cross-format (stored v1 vs incoming v2 returns 0).
   * This method reads the stored cursor, canonicalizes v1→v2 via MessageStore
   * lookup, and atomically upgrades Redis with an exact-value replacement CAS.
   * After reconciliation, the subsequent CAS sees same-format (v2 vs v2).
   *
   * Best-effort: failure here means CAS will fail-closed, which is safe
   * (no incorrect advancement) but blocks cursor progress until migration.
   */
  private async preReconcile(
    userId: string,
    catId: CatId,
    threadId: string,
    namespace: 'delivery' | 'mention' | 'seen',
  ): Promise<void> {
    if (!this.sessionStore || !this.canonicalizer) return;
    try {
      let stored: string | null = null;
      if (namespace === 'delivery') {
        stored = await this.sessionStore.getDeliveryCursor(userId, catId, threadId);
      } else if (namespace === 'mention') {
        stored = await this.sessionStore.getMentionAckCursor(userId, catId, threadId);
      } else {
        stored = await this.sessionStore.getSeenCursor(userId, catId, threadId);
      }
      if (!stored || stored.startsWith('v2:')) return;

      const canonical = await this.canonicalize(stored, threadId);
      if (canonical === stored) return; // Couldn't resolve or already same

      if (namespace === 'delivery') {
        await this.sessionStore.reconcileDeliveryCursorFormat(userId, catId, threadId, stored, canonical);
      } else if (namespace === 'mention') {
        await this.sessionStore.reconcileMentionAckCursorFormat(userId, catId, threadId, stored, canonical);
      } else {
        await this.sessionStore.reconcileSeenCursorFormat(userId, catId, threadId, stored, canonical);
      }
    } catch (err) {
      // Best-effort: reconciliation failure → CAS handles cross-format via fail-closed
      log.debug({ err, namespace }, 'preReconcile failed, CAS will fail-closed on cross-format');
    }
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
