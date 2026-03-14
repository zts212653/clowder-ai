/**
 * Draft Store — streaming draft persistence (#80)
 *
 * Stores partial content during cat streaming so that F5 refresh
 * can recover in-progress messages from Redis instead of losing them.
 *
 * Key design decisions:
 * - userId-scoped for isolation (R1 P1-1)
 * - invocationId as primary identifier (supports parallel streaming)
 * - TTL-based auto-cleanup (300s) with explicit delete on completion
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
  updatedAt: number;
}

/**
 * Common interface for draft stores (in-memory and Redis).
 * Methods return Promise to accommodate async Redis operations.
 */
export interface IDraftStore {
  /** Write/update draft (upsert semantics), reset TTL */
  upsert(draft: DraftRecord): void | Promise<void>;
  /** Renew TTL without updating content (keeps draft alive during tool calls) */
  touch(userId: string, threadId: string, invocationId: string): void | Promise<void>;
  /** Get all active drafts for a user+thread */
  getByThread(userId: string, threadId: string): DraftRecord[] | Promise<DraftRecord[]>;
  /** Delete a single draft (on stream completion) */
  delete(userId: string, threadId: string, invocationId: string): void | Promise<void>;
  /** Delete all drafts for a thread (cascade on thread deletion) */
  deleteByThread(userId: string, threadId: string): void | Promise<void>;
}

/** Default TTL for drafts: 5 minutes (300 seconds) */
const DEFAULT_DRAFT_TTL_MS = 300_000;

/**
 * In-memory DraftStore implementation.
 * Uses Map with TTL simulation via updatedAt + reap on read.
 */
export class DraftStore implements IDraftStore {
  private drafts = new Map<string, DraftRecord>();
  private ttlMs: number;

  constructor(options?: { ttlMs?: number }) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_DRAFT_TTL_MS;
  }

  private key(userId: string, threadId: string, invocationId: string): string {
    return `${userId}:${threadId}:${invocationId}`;
  }

  upsert(draft: DraftRecord): void {
    this.drafts.set(this.key(draft.userId, draft.threadId, draft.invocationId), draft);
  }

  touch(userId: string, threadId: string, invocationId: string): void {
    const k = this.key(userId, threadId, invocationId);
    const existing = this.drafts.get(k);
    if (existing) {
      existing.updatedAt = Date.now();
    }
  }

  getByThread(userId: string, threadId: string): DraftRecord[] {
    const now = Date.now();
    const results: DraftRecord[] = [];
    const prefix = `${userId}:${threadId}:`;
    for (const [k, v] of this.drafts) {
      if (!k.startsWith(prefix)) continue;
      if (now - v.updatedAt > this.ttlMs) {
        this.drafts.delete(k);
        continue;
      }
      results.push(v);
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
