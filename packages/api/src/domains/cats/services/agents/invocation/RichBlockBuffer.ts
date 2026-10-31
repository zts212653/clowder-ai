/**
 * F22: Rich Block Buffer
 *
 * Transient in-memory buffer for rich blocks created via MCP callback
 * during a cat's invocation. The cat message doesn't have a StoredMessage.id
 * yet (still streaming), so blocks are buffered by (threadId, catId) and
 * consumed at append time in route-serial/route-parallel.
 *
 * Key: (threadId, catId) — only one active invocation per (thread, cat) at a time.
 * Each entry also stores invocationId to prevent cross-contamination from late callbacks.
 * TTL: entries auto-expire after 15 minutes (stale invocations).
 */

import type { RichBlock } from '@cat-cafe/shared';

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes

interface BufferEntry {
  invocationId: string;
  blocks: RichBlock[];
  /** Deduplication for callers without an invocationId. */
  seenIds: Set<string>;
  createdAt: number;
}

export type RichBlockAddResult = 'added' | 'duplicate' | 'rejected';

function bufferKey(threadId: string, catId: string): string {
  return `${threadId}:${catId}`;
}

/** Module-level singleton */
let _instance: RichBlockBuffer | null = null;

export function getRichBlockBuffer(): RichBlockBuffer {
  if (!_instance) {
    _instance = new RichBlockBuffer();
  }
  return _instance;
}

export class RichBlockBuffer {
  private readonly entries = new Map<string, BufferEntry>();
  /** Consumed invocationIds — late callbacks for these are rejected */
  private readonly consumedInvocations = new Map<string, number>();
  /** Block IDs already accepted during an invocation, including those attached to interim posts. */
  private readonly seenByInvocation = new Map<string, { ids: Set<string>; touchedAt: number }>();
  private readonly ttlMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options?: { ttlMs?: number }) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.cleanupTimer = setInterval(() => this.prune(), 5 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  /** Add a rich block, distinguishing an idempotent retry from a closed invocation. */
  add(threadId: string, catId: string, block: RichBlock, invocationId?: string): RichBlockAddResult {
    // Reject blocks for already-consumed invocations (late/replayed callbacks after stream done)
    if (invocationId && this.consumedInvocations.has(invocationId)) return 'rejected';
    if (invocationId && this.seenByInvocation.get(invocationId)?.ids.has(block.id)) return 'duplicate';

    const key = bufferKey(threadId, catId);
    const existing = this.entries.get(key);
    if (existing) {
      // If invocationId changed, this is a new invocation — discard stale blocks
      if (invocationId && existing.invocationId !== invocationId) {
        this.entries.set(key, {
          invocationId,
          blocks: [block],
          seenIds: new Set([block.id]),
          createdAt: Date.now(),
        });
        this.remember(invocationId, block.id);
        return 'added';
      }
      // Deduplicate by block.id (idempotent callback retry)
      if (existing.seenIds.has(block.id)) return 'duplicate';
      existing.seenIds.add(block.id);
      existing.blocks.push(block);
    } else {
      this.entries.set(key, {
        invocationId: invocationId ?? '',
        blocks: [block],
        seenIds: new Set([block.id]),
        createdAt: Date.now(),
      });
    }
    if (invocationId) this.remember(invocationId, block.id);
    return 'added';
  }

  private remember(invocationId: string, blockId: string): void {
    const seen = this.seenByInvocation.get(invocationId);
    if (seen) {
      seen.ids.add(blockId);
      seen.touchedAt = Date.now();
    } else {
      this.seenByInvocation.set(invocationId, { ids: new Set([blockId]), touchedAt: Date.now() });
    }
  }

  /**
   * Consume all buffered blocks for an invocation context (removes them).
   * If invocationId is provided, only returns blocks matching that invocation (P1-2).
   * Final consumption closes the invocation even when no blocks remain.
   * Interim post_message consumption keeps it open for later blocks.
   */
  consume(threadId: string, catId: string, invocationId?: string, options?: { final?: boolean }): RichBlock[] {
    const key = bufferKey(threadId, catId);
    const entry = this.entries.get(key);
    if (options?.final !== false && invocationId) {
      this.consumedInvocations.set(invocationId, Date.now());
      this.seenByInvocation.delete(invocationId);
    }
    if (!entry) return [];
    // If invocationId provided and doesn't match, reject but KEEP the entry —
    // the newer invocation's blocks belong to it, not to us (cloud Codex P1).
    // Stale entries are cleaned up by TTL prune and by add() replacement.
    if (invocationId && entry.invocationId !== invocationId) {
      return [];
    }
    this.entries.delete(key);
    // Mark invocation as consumed — late callbacks will be rejected by add()
    if (options?.final !== false && entry.invocationId) {
      this.consumedInvocations.set(entry.invocationId, Date.now());
      this.seenByInvocation.delete(entry.invocationId);
    }
    return entry.blocks;
  }

  /** Content-free proof for an in-flight invocation; never exposes buffered block bodies. */
  hasBlock(threadId: string, blockId: string): boolean {
    this.prune();
    for (const [key, entry] of this.entries) {
      if (key.slice(0, key.lastIndexOf(':')) === threadId && entry.blocks.some((block) => block.id === blockId))
        return true;
    }
    return false;
  }

  hasKind(threadId: string, catId: string, invocationId: string, kind: RichBlock['kind']): boolean {
    const entry = this.entries.get(bufferKey(threadId, catId));
    return Boolean(entry && entry.invocationId === invocationId && entry.blocks.some((block) => block.kind === kind));
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.createdAt > this.ttlMs) {
        this.entries.delete(key);
      }
    }
    for (const [id, consumedAt] of this.consumedInvocations) {
      if (now - consumedAt > this.ttlMs) {
        this.consumedInvocations.delete(id);
      }
    }
    for (const [id, seen] of this.seenByInvocation) {
      if (now - seen.touchedAt > this.ttlMs) this.seenByInvocation.delete(id);
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.entries.clear();
    this.consumedInvocations.clear();
    this.seenByInvocation.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
