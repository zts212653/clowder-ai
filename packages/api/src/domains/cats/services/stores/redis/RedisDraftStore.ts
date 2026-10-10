/**
 * Redis Draft Store — streaming draft persistence (#80)
 *
 * Redis 数据结构 (cat-cafe: prefix applied by client):
 *   draft:{userId}:{threadId}:{invocationId}  → Hash (draft details)
 *   drafts:idx:{userId}:{threadId}            → Set (invocationId members)
 *
 * 不设过期（F117 KD-21/KD-23）：草稿活到它的 response R 终局；删除失败由 response-pending 账本在下次
 * settlement 时重试。升级前写入的 key 带着旧的 EXPIRE，HSET / SADD 不会清除它；索引 key 按 thread 共用，
 * 旧 EXPIRE 到期会连带删掉升级后新写入的草稿引用，所以 upsert 顺手 PERSIST 两个 key。
 */

import type { CatId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { DraftRecord, IDraftStore } from '../ports/DraftStore.js';
import { DraftKeys } from '../redis-keys/draft-keys.js';

export class RedisDraftStore implements IDraftStore {
  private readonly redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async upsert(draft: DraftRecord): Promise<void> {
    const detailKey = DraftKeys.detail(draft.userId, draft.threadId, draft.invocationId);
    const indexKey = DraftKeys.index(draft.userId, draft.threadId);
    const createdAtForMissing = await this.createdAtForMissing(detailKey, draft.createdAt ?? draft.updatedAt);

    const fields: Record<string, string> = {
      userId: draft.userId,
      threadId: draft.threadId,
      invocationId: draft.invocationId,
      catId: draft.catId as string,
      content: draft.content,
      updatedAt: String(draft.updatedAt),
    };
    if (draft.toolEvents && draft.toolEvents.length > 0) {
      fields.toolEvents = JSON.stringify(draft.toolEvents);
    }
    if (draft.thinking) {
      fields.thinking = draft.thinking;
    }

    const pipeline = this.redis.multi();
    pipeline.hsetnx(detailKey, 'createdAt', createdAtForMissing);
    pipeline.hset(detailKey, fields);
    pipeline.sadd(indexKey, draft.invocationId);
    pipeline.persist(detailKey);
    pipeline.persist(indexKey);
    await pipeline.exec();
  }

  private async createdAtForMissing(detailKey: string, fallback: number): Promise<string> {
    const existingUpdatedAt = await this.redis.hget(detailKey, 'updatedAt');
    return existingUpdatedAt ?? String(fallback);
  }

  async getByThread(userId: string, threadId: string): Promise<DraftRecord[]> {
    const indexKey = DraftKeys.index(userId, threadId);
    const invocationIds = await this.redis.smembers(indexKey);
    if (invocationIds.length === 0) return [];

    const pipeline = this.redis.multi();
    for (const invId of invocationIds) {
      pipeline.hgetall(DraftKeys.detail(userId, threadId, invId));
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const drafts: DraftRecord[] = [];
    const staleIds: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const [err, data] = results[i]!;
      if (err || !data || typeof data !== 'object') {
        // Hash gone (deleted, or a pre-KD-21 key that expired) but index entry remains — mark for cleanup
        staleIds.push(invocationIds[i]!);
        continue;
      }
      const d = data as Record<string, string>;
      if (!d.invocationId) {
        staleIds.push(invocationIds[i]!);
        continue;
      }
      drafts.push(this.hydrate(d));
    }

    // Best-effort cleanup of stale index entries
    if (staleIds.length > 0) {
      this.redis.srem(indexKey, ...staleIds).catch(() => {});
    }

    return drafts;
  }

  async delete(userId: string, threadId: string, invocationId: string): Promise<void> {
    const detailKey = DraftKeys.detail(userId, threadId, invocationId);
    const indexKey = DraftKeys.index(userId, threadId);

    const pipeline = this.redis.multi();
    pipeline.del(detailKey);
    pipeline.srem(indexKey, invocationId);
    await pipeline.exec();
  }

  async deleteByThread(userId: string, threadId: string): Promise<void> {
    const indexKey = DraftKeys.index(userId, threadId);
    const invocationIds = await this.redis.smembers(indexKey);

    if (invocationIds.length === 0) {
      // Still delete the index key in case it's empty but exists
      await this.redis.del(indexKey);
      return;
    }

    const pipeline = this.redis.multi();
    for (const invId of invocationIds) {
      pipeline.del(DraftKeys.detail(userId, threadId, invId));
    }
    pipeline.del(indexKey);
    await pipeline.exec();
  }

  private hydrate(d: Record<string, string>): DraftRecord {
    let toolEvents: unknown[] | undefined;
    if (d.toolEvents) {
      try {
        toolEvents = JSON.parse(d.toolEvents);
      } catch {
        /* ignore parse errors */
      }
    }
    return {
      userId: d.userId ?? '',
      threadId: d.threadId ?? '',
      invocationId: d.invocationId ?? '',
      catId: (d.catId ?? 'opus') as CatId,
      content: d.content ?? '',
      createdAt: parseInt(d.createdAt ?? d.updatedAt ?? '0', 10),
      updatedAt: parseInt(d.updatedAt ?? '0', 10),
      ...(toolEvents ? { toolEvents } : {}),
      ...(d.thinking ? { thinking: d.thinking } : {}),
    };
  }
}
