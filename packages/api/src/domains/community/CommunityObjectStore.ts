/**
 * CommunityObjectStore — Redis-backed projection store (F168 Phase A)
 *
 * Stores serialised CommunityObjectProjection at:
 *   community:object:{subjectKey}   → STRING (JSON)
 *   community:objects:index         → SET (all subjectKeys with projections)
 *
 * TTL is never set (铁律 #5 / LL-048 — user-traceable state is persistent).
 */

import type { CommunityObjectProjection } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { CommunityKeys } from './community-keys.js';

export interface ICommunityObjectStore {
  get(subjectKey: string): Promise<CommunityObjectProjection | null>;
  save(projection: CommunityObjectProjection): Promise<void>;
  listSubjectKeys(): Promise<string[]>;
  delete(subjectKey: string): Promise<void>;
}

export class RedisCommunityObjectStore implements ICommunityObjectStore {
  constructor(private readonly redis: RedisClient) {}

  async get(subjectKey: string): Promise<CommunityObjectProjection | null> {
    const raw = await this.redis.get(CommunityKeys.objectProjection(subjectKey));
    if (!raw) return null;
    return JSON.parse(raw) as CommunityObjectProjection;
  }

  async save(projection: CommunityObjectProjection): Promise<void> {
    await this.redis.set(CommunityKeys.objectProjection(projection.subjectKey), JSON.stringify(projection));
    await this.redis.sadd(CommunityKeys.objectsIndex, projection.subjectKey);
  }

  async listSubjectKeys(): Promise<string[]> {
    return this.redis.smembers(CommunityKeys.objectsIndex);
  }

  async delete(subjectKey: string): Promise<void> {
    await this.redis.del(CommunityKeys.objectProjection(subjectKey));
    await this.redis.srem(CommunityKeys.objectsIndex, subjectKey);
  }
}
