/**
 * Redis Summary Store (拍立得照片墙)
 * Redis-backed summary storage with same interface as in-memory SummaryStore.
 *
 * Redis 数据结构:
 *   cat-cafe:summary:{summaryId}              → Hash (纪要详情)
 *   cat-cafe:summaries:thread:{threadId}      → Sorted Set (每线程纪要列表, score=createdAt)
 *
 * TTL 默认 30 天。
 */

import type { CreateSummaryInput, ThreadSummary } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { generateSortableId } from '../ports/MessageStore.js';
import type { ISummaryStore } from '../ports/SummaryStore.js';
import { SummaryKeys } from '../redis-keys/summary-keys.js';

const DEFAULT_TTL = 0; // persistent — set >0 via env to enable expiry

export class RedisSummaryStore implements ISummaryStore {
  private readonly redis: RedisClient;
  /** null means no expiration. */
  private readonly ttlSeconds: number | null;

  constructor(redis: RedisClient, options?: { ttlSeconds?: number }) {
    this.redis = redis;
    const raw = options?.ttlSeconds ?? DEFAULT_TTL;
    if (!Number.isFinite(raw) || raw <= 0) {
      this.ttlSeconds = null;
    } else {
      this.ttlSeconds = Math.floor(raw);
    }
  }

  async create(input: CreateSummaryInput): Promise<ThreadSummary> {
    const now = Date.now();
    const summary: ThreadSummary = {
      id: generateSortableId(now),
      threadId: input.threadId,
      topic: input.topic,
      conclusions: input.conclusions,
      openQuestions: input.openQuestions,
      createdAt: now,
      createdBy: input.createdBy,
    };

    const key = SummaryKeys.detail(summary.id);
    const pipeline = this.redis.multi();
    pipeline.hset(key, this.serializeSummary(summary));
    if (this.ttlSeconds !== null) {
      pipeline.expire(key, this.ttlSeconds);
    }
    pipeline.zadd(SummaryKeys.thread(summary.threadId), String(now), summary.id);
    if (this.ttlSeconds !== null) {
      pipeline.expire(SummaryKeys.thread(summary.threadId), this.ttlSeconds);
    }
    await pipeline.exec();

    return summary;
  }

  async get(summaryId: string): Promise<ThreadSummary | null> {
    const data = await this.redis.hgetall(SummaryKeys.detail(summaryId));
    if (!data || !data.id) return null;
    return this.hydrateSummary(data);
  }

  async listByThread(threadId: string): Promise<ThreadSummary[]> {
    const ids = await this.redis.zrange(SummaryKeys.thread(threadId), 0, -1);
    if (ids.length === 0) return [];

    const pipeline = this.redis.multi();
    for (const id of ids) {
      pipeline.hgetall(SummaryKeys.detail(id));
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const summaries: ThreadSummary[] = [];
    for (const [err, data] of results) {
      if (err || !data || typeof data !== 'object') continue;
      const d = data as Record<string, string>;
      if (!d.id) continue;
      summaries.push(this.hydrateSummary(d));
    }
    return summaries;
  }

  async delete(summaryId: string): Promise<boolean> {
    const data = await this.redis.hgetall(SummaryKeys.detail(summaryId));
    if (!data || !data.id) return false;

    const threadId = data.threadId ?? '';
    const pipeline = this.redis.multi();
    pipeline.del(SummaryKeys.detail(summaryId));
    if (threadId) {
      pipeline.zrem(SummaryKeys.thread(threadId), summaryId);
    }
    await pipeline.exec();
    return true;
  }

  private serializeSummary(summary: ThreadSummary): Record<string, string> {
    return {
      id: summary.id,
      threadId: summary.threadId,
      topic: summary.topic,
      conclusions: JSON.stringify(summary.conclusions),
      openQuestions: JSON.stringify(summary.openQuestions),
      createdAt: String(summary.createdAt),
      createdBy: summary.createdBy,
    };
  }

  private hydrateSummary(data: Record<string, string>): ThreadSummary {
    return {
      id: data.id ?? '',
      threadId: data.threadId ?? '',
      topic: data.topic ?? '',
      conclusions: safeParseArray(data.conclusions),
      openQuestions: safeParseArray(data.openQuestions),
      createdAt: parseInt(data.createdAt ?? '0', 10),
      createdBy: (data.createdBy ?? 'user') as ThreadSummary['createdBy'],
    };
  }
}

function safeParseArray(raw: string | undefined): readonly string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
