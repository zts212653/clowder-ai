/**
 * InjectionTraceStore — F237 (Trace v0)
 *
 * Dual-layer Redis persistence for prompt injection traces:
 *   Layer 1: InjectionTraceSummary — persistent (TTL=0)
 *   Layer 2: InjectionTraceDetail — short TTL (default 7 days)
 */

import type { InjectionTraceDetail, InjectionTraceSummary } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

const SUMMARY_PREFIX = 'injection-trace-summary:';
const DETAIL_PREFIX = 'injection-trace-detail:';
const INDEX_PREFIX = 'injection-trace-index:';

function summaryKey(threadId: string, turnId: string): string {
  return `${SUMMARY_PREFIX}${threadId}:${turnId}`;
}
function detailKey(threadId: string, turnId: string): string {
  return `${DETAIL_PREFIX}${threadId}:${turnId}`;
}
function indexKey(threadId: string): string {
  return `${INDEX_PREFIX}${threadId}`;
}

const DEFAULT_DETAIL_TTL_SECONDS = 7 * 24 * 60 * 60;

export class InjectionTraceStore {
  private readonly detailTtl: number;

  constructor(
    private readonly redis: RedisClient,
    options?: { detailTtlSeconds?: number },
  ) {
    this.detailTtl = options?.detailTtlSeconds ?? DEFAULT_DETAIL_TTL_SECONDS;
  }

  async persist(summary: InjectionTraceSummary, detail: InjectionTraceDetail): Promise<void> {
    const sKey = summaryKey(summary.threadId, summary.turnId);
    const dKey = detailKey(detail.threadId, detail.turnId);
    const iKey = indexKey(summary.threadId);
    await this.redis.set(sKey, JSON.stringify(summary));
    await this.redis.set(dKey, JSON.stringify(detail), 'EX', this.detailTtl);
    await this.redis.zadd(iKey, summary.timestamp, summary.turnId);
  }

  async getSummary(threadId: string, turnId: string): Promise<InjectionTraceSummary | null> {
    const raw = await this.redis.get(summaryKey(threadId, turnId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as InjectionTraceSummary;
    } catch {
      return null;
    }
  }

  async getDetail(threadId: string, turnId: string): Promise<InjectionTraceDetail | null> {
    const raw = await this.redis.get(detailKey(threadId, turnId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as InjectionTraceDetail;
    } catch {
      return null;
    }
  }

  async listTurnIds(
    threadId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ turnIds: string[]; total: number }> {
    const iKey = indexKey(threadId);
    const total = await this.redis.zcard(iKey);
    const limit = options?.limit ?? 20;
    const offset = options?.offset ?? 0;
    const turnIds = await this.redis.zrevrange(iKey, offset, offset + limit - 1);
    return { turnIds, total };
  }

  async listSummaries(
    threadId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ summaries: InjectionTraceSummary[]; total: number }> {
    const { turnIds, total } = await this.listTurnIds(threadId, options);
    const summaries: InjectionTraceSummary[] = [];
    for (const turnId of turnIds) {
      const summary = await this.getSummary(threadId, turnId);
      if (summary) summaries.push(summary);
    }
    return { summaries, total };
  }

  async deleteTurn(threadId: string, turnId: string): Promise<void> {
    await this.redis.del(summaryKey(threadId, turnId));
    await this.redis.del(detailKey(threadId, turnId));
    await this.redis.zrem(indexKey(threadId), turnId);
  }
}
