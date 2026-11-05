/**
 * F22: Rich Block Buffer
 *
 * Transient in-memory buffer for rich blocks created via MCP callback
 * during a cat's invocation. The cat message doesn't have a StoredMessage.id
 * yet (still streaming), so blocks are buffered by (threadId, catId) and
 * consumed at append time in route-serial/route-parallel.
 *
 * Each invocation owns its entry, including while an interim post is persisting.
 * A successor may replace idle work, but cannot retire a predecessor's live writer.
 * TTL: idle entries auto-expire after 15 minutes; a clock is not a write outcome.
 */

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { RichBlock } from '@cat-cafe/shared';

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes

interface BufferEntry {
  contextKey: string;
  invocationId: string;
  blocks: RichBlock[];
  touchedAt: number;
  consumers: number;
  reservation?: {
    publicationId: string;
    blocks: RichBlock[];
    retryKey?: string;
    inUse: boolean;
    writeUnconfirmed: boolean;
    settled: Promise<void>;
    settle(): void;
  };
}

export interface RichBlockPublication {
  requestId: string;
  issuedAt: number;
}

interface AcceptedBlock {
  block: RichBlock;
  publication?: RichBlockPublication;
  published: boolean;
}

export interface RichBlockReservation {
  readonly publicationId: string;
  blocks: RichBlock[];
  markWriteStarted(): void;
  commit(receipt: { publicationId: string | undefined; blocks: readonly RichBlock[] }): void;
  release(): void;
}

export type RichBlockAddResult = 'added' | 'updated' | 'duplicate' | 'published' | 'busy' | 'rejected';

function bufferKey(threadId: string, catId: string): string {
  return `${threadId}:${catId}`;
}

function entryKey(contextKey: string, invocationId: string): string {
  return `${contextKey}:${invocationId}`;
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
  /** Blocks already accepted during an invocation, including those attached to interim posts. */
  private readonly acceptedByInvocation = new Map<string, { blocks: Map<string, AcceptedBlock>; touchedAt: number }>();
  private readonly ttlMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options?: { ttlMs?: number }) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.cleanupTimer = setInterval(() => this.prune(), 5 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  /** Add or revise a pending block; distinguish retries, published blocks and closed invocations. */
  add(
    threadId: string,
    catId: string,
    block: RichBlock,
    invocationId?: string,
    publication?: RichBlockPublication,
  ): RichBlockAddResult {
    // Reject blocks for already-consumed invocations (late/replayed callbacks after stream done)
    if (invocationId && this.consumedInvocations.has(invocationId)) return 'rejected';

    const accepted = invocationId ? this.acceptedByInvocation.get(invocationId)?.blocks.get(block.id) : undefined;
    // A retry keeps its original request identity and time, even if its first delivery never arrived.
    if (
      publication &&
      accepted?.publication &&
      (publication.requestId === accepted.publication.requestId ||
        publication.issuedAt <= accepted.publication.issuedAt)
    )
      return 'duplicate';
    if (accepted?.published) return isDeepStrictEqual(accepted.block, block) ? 'duplicate' : 'published';
    const contextKey = bufferKey(threadId, catId);
    const key = entryKey(contextKey, invocationId ?? '');
    const existing = this.entries.get(key);
    if (existing) existing.touchedAt = Date.now();
    const pendingIndex = existing ? existing.blocks.findIndex((pending) => pending.id === block.id) : -1;
    if (existing && pendingIndex >= 0) {
      if (isDeepStrictEqual(existing.blocks[pendingIndex], block)) {
        if (invocationId) this.remember(invocationId, block, publication ?? accepted?.publication);
        return 'duplicate';
      }
      if (existing.reservation?.blocks.some((reserved) => reserved.id === block.id)) return 'busy';
      existing.blocks[pendingIndex] = block;
      if (invocationId) this.remember(invocationId, block, publication ?? accepted?.publication);
      return 'updated';
    }
    if (!existing) {
      // Preserve entries owned by a live writer/consumer, even when a successor starts.
      for (const [priorKey, prior] of this.entries) {
        if (prior.contextKey === contextKey && !prior.reservation && prior.consumers === 0) {
          this.entries.delete(priorKey);
        }
      }
      this.entries.set(key, {
        contextKey,
        invocationId: invocationId ?? '',
        blocks: [block],
        touchedAt: Date.now(),
        consumers: 0,
      });
    } else {
      existing.blocks.push(block);
    }
    if (invocationId) this.remember(invocationId, block, publication ?? accepted?.publication);
    return 'added';
  }

  private remember(invocationId: string, block: RichBlock, publication?: RichBlockPublication): void {
    const seen = this.acceptedByInvocation.get(invocationId);
    if (seen) {
      seen.blocks.set(block.id, { block, ...(publication ? { publication } : {}), published: false });
      seen.touchedAt = Date.now();
    } else {
      this.acceptedByInvocation.set(invocationId, {
        blocks: new Map([[block.id, { block, ...(publication ? { publication } : {}), published: false }]]),
        touchedAt: Date.now(),
      });
    }
  }

  /** Keep ownership until storage confirms the outcome. An identical keyed retry may reconcile an uncertain write. */
  reserve(
    threadId: string,
    catId: string,
    invocationId: string,
    retryKey?: string,
  ): RichBlockReservation | 'busy' | 'pending' | 'rejected' {
    const key = entryKey(bufferKey(threadId, catId), invocationId);
    const entry = this.entries.get(key);
    const prior = entry?.reservation;
    if (prior?.inUse && retryKey && prior.retryKey === retryKey) return 'pending';
    const resuming = prior && !prior.inUse && prior.writeUnconfirmed && retryKey && prior.retryKey === retryKey;
    if (this.consumedInvocations.has(invocationId) && !resuming) return 'rejected';
    if (prior && !resuming) return 'busy';
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const reservation = prior ?? {
      publicationId: randomUUID(),
      blocks: entry ? [...entry.blocks] : [],
      ...(retryKey ? { retryKey } : {}),
      inUse: true,
      writeUnconfirmed: false,
      settled,
      settle,
    };
    reservation.inUse = true;
    if (entry) {
      entry.reservation = reservation;
    }
    let finished = false;
    return {
      publicationId: reservation.publicationId,
      blocks: reservation.blocks,
      markWriteStarted: () => {
        if (!finished) reservation.writeUnconfirmed = true;
      },
      commit: (receipt) => {
        if (finished || !entry || this.entries.get(key) !== entry || entry.reservation !== reservation) return;
        reservation.writeUnconfirmed = false;
        // A durable older idempotency winner settles the request, but cannot own this snapshot.
        if (receipt.publicationId !== reservation.publicationId) return;
        const publishedIds = new Set<string>();
        for (const block of reservation.blocks) {
          const persisted = receipt.blocks.find((candidate) => candidate.id === block.id);
          if (!persisted) continue;
          publishedIds.add(block.id);
          const accepted = this.acceptedByInvocation.get(invocationId)?.blocks.get(block.id);
          if (accepted) {
            accepted.block = persisted;
            accepted.published = true;
          }
        }
        entry.blocks = entry.blocks.filter((block) => !publishedIds.has(block.id));
      },
      release: () => {
        if (finished) return;
        finished = true;
        reservation.inUse = false;
        // A rejected storage promise is not proof that its server-side write did not commit.
        if (reservation.writeUnconfirmed && entry?.blocks.length) return;
        if (entry && this.entries.get(key) === entry && entry.reservation === reservation) {
          delete entry.reservation;
          entry.touchedAt = Date.now();
          const seen = this.acceptedByInvocation.get(invocationId);
          if (seen) seen.touchedAt = entry.touchedAt;
          if (entry.blocks.length === 0 && entry.consumers === 0) this.entries.delete(key);
        }
        reservation.settle();
      },
    };
  }

  /**
   * Consume all buffered blocks for an invocation context (removes them).
   * If invocationId is provided, only returns blocks matching that invocation (P1-2).
   * Final consumption closes the invocation even when no blocks remain.
   * Interim consumption confirms already-persisted blocks; post_message uses reserve/commit instead.
   */
  async consume(
    threadId: string,
    catId: string,
    invocationId?: string,
    options?: { final?: boolean },
  ): Promise<RichBlock[]> {
    const contextKey = bufferKey(threadId, catId);
    const entry =
      invocationId === undefined
        ? [...this.entries.values()].reverse().find((candidate) => candidate.contextKey === contextKey)
        : this.entries.get(entryKey(contextKey, invocationId));
    const consumingInvocationId = invocationId ?? entry?.invocationId;
    const key = entryKey(contextKey, consumingInvocationId ?? '');
    // Seal new admission now, but keep accepted history until the publication owner settles.
    if (options?.final !== false && consumingInvocationId) {
      this.consumedInvocations.set(consumingInvocationId, Date.now());
    }
    if (entry) {
      entry.consumers++;
      try {
        while (this.entries.get(key) === entry && entry.reservation) await entry.reservation.settled;
      } finally {
        entry.consumers--;
      }
    }
    if (options?.final !== false && consumingInvocationId) this.acceptedByInvocation.delete(consumingInvocationId);
    if (!entry) return [];
    if (this.entries.get(key) !== entry) return [];
    this.entries.delete(key);
    if (options?.final === false) {
      for (const block of entry.blocks) {
        const accepted = this.acceptedByInvocation.get(entry.invocationId)?.blocks.get(block.id);
        if (accepted) accepted.published = true;
      }
    }
    // Mark invocation as consumed — late callbacks will be rejected by add()
    if (options?.final !== false && entry.invocationId) {
      this.consumedInvocations.set(entry.invocationId, Date.now());
      this.acceptedByInvocation.delete(entry.invocationId);
    }
    return entry.blocks;
  }

  /** Content-free proof for an in-flight invocation; never exposes buffered block bodies. */
  hasBlock(threadId: string, blockId: string): boolean {
    this.prune();
    for (const entry of this.entries.values()) {
      if (
        entry.contextKey.slice(0, entry.contextKey.lastIndexOf(':')) === threadId &&
        entry.blocks.some((block) => block.id === blockId)
      )
        return true;
    }
    return false;
  }

  /** Content-free: whether one of these invocations has a block still waiting to land on its reply. */
  hasPendingBlock(
    threadId: string,
    catId: string,
    invocationIds: readonly string[],
    match: (block: RichBlock) => boolean,
  ): boolean {
    const contextKey = bufferKey(threadId, catId);
    return invocationIds.some((invocationId) =>
      this.entries.get(entryKey(contextKey, invocationId))?.blocks.some(match),
    );
  }

  hasKind(threadId: string, catId: string, invocationId: string, kind: RichBlock['kind']): boolean {
    const entry = this.entries.get(entryKey(bufferKey(threadId, catId), invocationId));
    return Boolean(entry && entry.invocationId === invocationId && entry.blocks.some((block) => block.kind === kind));
  }

  private prune(): void {
    const now = Date.now();
    const activeInvocations = new Set<string>();
    for (const [key, entry] of this.entries) {
      if (entry.reservation || entry.consumers > 0) {
        activeInvocations.add(entry.invocationId);
      } else if (now - entry.touchedAt > this.ttlMs) {
        this.entries.delete(key);
      }
    }
    for (const [id, consumedAt] of this.consumedInvocations) {
      if (!activeInvocations.has(id) && now - consumedAt > this.ttlMs) {
        this.consumedInvocations.delete(id);
      }
    }
    for (const [id, seen] of this.acceptedByInvocation) {
      if (!activeInvocations.has(id) && now - seen.touchedAt > this.ttlMs) this.acceptedByInvocation.delete(id);
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const entry of this.entries.values()) entry.reservation?.settle();
    this.entries.clear();
    this.consumedInvocations.clear();
    this.acceptedByInvocation.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
