/**
 * Pending Request Store
 * 持久化待审批队列 — 铲屎官离线时请求不丢失
 *
 * 只存可序列化的 PendingRequestRecord，不存运行时 waiter。
 */

import type { CatId, PendingRequestRecord, RespondScope } from '@cat-cafe/shared';
import { generateSortableId } from './MessageStore.js';

export interface CreatePendingInput {
  readonly invocationId: string;
  readonly catId: CatId;
  readonly threadId: string;
  readonly action: string;
  readonly reason: string;
  readonly context?: string;
}

export interface IPendingRequestStore {
  create(input: CreatePendingInput): PendingRequestRecord | Promise<PendingRequestRecord>;
  get(requestId: string): PendingRequestRecord | null | Promise<PendingRequestRecord | null>;
  respond(
    requestId: string,
    decision: 'granted' | 'denied',
    scope: RespondScope,
    reason?: string,
  ): PendingRequestRecord | null | Promise<PendingRequestRecord | null>;
  listWaiting(threadId?: string): PendingRequestRecord[] | Promise<PendingRequestRecord[]>;
}

const DEFAULT_MAX = 1000;

export class PendingRequestStore implements IPendingRequestStore {
  private records = new Map<string, PendingRequestRecord>();
  private readonly maxRecords: number;

  constructor(options?: { maxRecords?: number }) {
    this.maxRecords = options?.maxRecords ?? DEFAULT_MAX;
  }

  create(input: CreatePendingInput): PendingRequestRecord {
    if (this.records.size >= this.maxRecords) {
      // Evict oldest resolved first, then oldest waiting
      let evicted = false;
      for (const [id, rec] of this.records) {
        if (rec.status !== 'waiting') {
          this.records.delete(id);
          evicted = true;
          break;
        }
      }
      if (!evicted) {
        const firstKey = this.records.keys().next().value;
        if (firstKey) this.records.delete(firstKey);
      }
    }

    const record: PendingRequestRecord = {
      requestId: generateSortableId(Date.now()),
      invocationId: input.invocationId,
      catId: input.catId,
      threadId: input.threadId,
      action: input.action,
      reason: input.reason,
      ...(input.context ? { context: input.context } : {}),
      createdAt: Date.now(),
      status: 'waiting',
    };
    this.records.set(record.requestId, record);
    return record;
  }

  get(requestId: string): PendingRequestRecord | null {
    return this.records.get(requestId) ?? null;
  }

  respond(
    requestId: string,
    decision: 'granted' | 'denied',
    scope: RespondScope,
    reason?: string,
  ): PendingRequestRecord | null {
    const existing = this.records.get(requestId);
    if (!existing || existing.status !== 'waiting') return null;

    const updated: PendingRequestRecord = {
      ...existing,
      status: decision,
      respondedAt: Date.now(),
      respondScope: scope,
      ...(reason ? { respondReason: reason } : {}),
    };
    this.records.set(requestId, updated);
    return updated;
  }

  listWaiting(threadId?: string): PendingRequestRecord[] {
    const result: PendingRequestRecord[] = [];
    for (const rec of this.records.values()) {
      if (rec.status !== 'waiting') continue;
      if (threadId && rec.threadId !== threadId) continue;
      result.push(rec);
    }
    return result.sort((a, b) => a.createdAt - b.createdAt);
  }

  get size(): number {
    return this.records.size;
  }
}
