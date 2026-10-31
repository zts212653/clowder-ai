/**
 * BallCustodyProjectionStore — Redis-backed projection store（F233 Phase B）
 * 照 CommunityObjectStore（F168）。TTL 永不设（铁律#5 / LL-048）。
 *   ballcustody:projection:{subjectKey} → STRING (JSON)
 *   ballcustody:projections:index       → SET
 */

import type { BallCustodyProjection } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { BallCustodyKeys } from './ball-custody-keys.js';

export interface IBallCustodyProjectionStore {
  get(subjectKey: string): Promise<BallCustodyProjection | null>;
  save(projection: BallCustodyProjection): Promise<void>;
  listSubjectKeys(): Promise<string[]>;
  delete(subjectKey: string): Promise<void>;
}

export class RedisBallCustodyProjectionStore implements IBallCustodyProjectionStore {
  constructor(private readonly redis: RedisClient) {}

  async get(subjectKey: string): Promise<BallCustodyProjection | null> {
    const raw = await this.redis.get(BallCustodyKeys.projection(subjectKey));
    if (!raw) return null;
    return JSON.parse(raw) as BallCustodyProjection;
  }

  async save(projection: BallCustodyProjection): Promise<void> {
    await this.redis.set(BallCustodyKeys.projection(projection.subjectKey), JSON.stringify(projection));
    await this.redis.sadd(BallCustodyKeys.projectionsIndex, projection.subjectKey);
  }

  async listSubjectKeys(): Promise<string[]> {
    return this.redis.smembers(BallCustodyKeys.projectionsIndex);
  }

  async delete(subjectKey: string): Promise<void> {
    await this.redis.del(BallCustodyKeys.projection(subjectKey));
    await this.redis.srem(BallCustodyKeys.projectionsIndex, subjectKey);
  }
}
