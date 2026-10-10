/**
 * Draft Store — streaming draft persistence (#80)
 *
 * Stores partial content during cat streaming so that F5 refresh
 * can recover in-progress messages from Redis instead of losing them.
 *
 * Key design decisions:
 * - userId-scoped for isolation (R1 P1-1)
 * - invocationId as primary identifier (supports parallel streaming)
 * - F117 KD-21/KD-23: no expiry. A draft lives exactly as long as its response R is processing; the
 *   R's terminal commit deletes it, and a turn leaves the response-pending ledger only after its
 *   draft is gone, so a failed delete is retried by the next settlement instead of leaking.
 */

import type { CatId } from '@cat-cafe/shared';

export interface DraftRecord {
  userId: string;
  threadId: string;
  invocationId: string;
  catId: CatId;
  content: string;
  toolEvents?: unknown[];
  thinking?: string;
  /** First time this draft was created. Stable across touch/upsert updates. */
  createdAt?: number;
  updatedAt: number;
}

/**
 * Common interface for draft stores (in-memory and Redis).
 * Methods return Promise to accommodate async Redis operations.
 */
export interface IDraftStore {
  /** Write/update draft (upsert semantics) */
  upsert(draft: DraftRecord): void | Promise<void>;
  /** Get all active drafts for a user+thread */
  getByThread(userId: string, threadId: string): DraftRecord[] | Promise<DraftRecord[]>;
  /** Delete a single draft (on stream completion) */
  delete(userId: string, threadId: string, invocationId: string): void | Promise<void>;
  /** Delete all drafts for a thread (cascade on thread deletion) */
  deleteByThread(userId: string, threadId: string): void | Promise<void>;
}

/** In-memory DraftStore implementation. */
export class DraftStore implements IDraftStore {
  private drafts = new Map<string, DraftRecord>();

  private key(userId: string, threadId: string, invocationId: string): string {
    return `${userId}:${threadId}:${invocationId}`;
  }

  upsert(draft: DraftRecord): void {
    const key = this.key(draft.userId, draft.threadId, draft.invocationId);
    const existing = this.drafts.get(key);
    this.drafts.set(key, {
      ...draft,
      createdAt: existing?.createdAt ?? draft.createdAt ?? draft.updatedAt,
    });
  }

  getByThread(userId: string, threadId: string): DraftRecord[] {
    const results: DraftRecord[] = [];
    const prefix = `${userId}:${threadId}:`;
    for (const [k, v] of this.drafts) {
      if (k.startsWith(prefix)) results.push(v);
    }
    return results;
  }

  delete(userId: string, threadId: string, invocationId: string): void {
    this.drafts.delete(this.key(userId, threadId, invocationId));
  }

  deleteByThread(userId: string, threadId: string): void {
    const prefix = `${userId}:${threadId}:`;
    for (const k of this.drafts.keys()) {
      if (k.startsWith(prefix)) {
        this.drafts.delete(k);
      }
    }
  }

  /** Expose size for testing */
  get size(): number {
    return this.drafts.size;
  }
}
