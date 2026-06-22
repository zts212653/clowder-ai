/**
 * CommunityRepoConfigStore — Per-repo routing configuration (F168 Phase F — SO-0)
 *
 * operator defines guard thread + guard cat per repo. Static config, not a state machine.
 * Both InMemory (for unit tests) and Redis (for production) implementations.
 *
 * INV-F0: No repo config = fail-closed (no backfill, no autoRoute).
 *
 * Redis layout (ioredis keyPrefix applied by client factory):
 *   community:repo-config:{repo}         → HASH (config fields)
 *   community:repo-configs:index         → SET  (all repo keys)
 *
 * TTL=0 — persistent (铁律 #5 / LL-048).
 */

import type { CommunityRepoConfig } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

// ---------------------------------------------------------------------------
// Upsert input (repo + guard thread + guard cat)
// ---------------------------------------------------------------------------

export interface UpsertRepoConfigInput {
  readonly repo: string;
  readonly guardThreadId: string;
  readonly guardCatId: string;
}

// ---------------------------------------------------------------------------
// Port interface
// ---------------------------------------------------------------------------

export interface ICommunityRepoConfigStore {
  upsert(input: UpsertRepoConfigInput): Promise<CommunityRepoConfig>;
  getByRepo(repo: string): Promise<CommunityRepoConfig | null>;
  listAll(): Promise<CommunityRepoConfig[]>;
  deleteByRepo(repo: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// InMemory implementation (unit tests)
// ---------------------------------------------------------------------------

export class InMemoryCommunityRepoConfigStore implements ICommunityRepoConfigStore {
  private readonly configs = new Map<string, CommunityRepoConfig>();

  async upsert(input: UpsertRepoConfigInput): Promise<CommunityRepoConfig> {
    const existing = this.configs.get(input.repo);
    const now = Date.now();
    const config: CommunityRepoConfig = {
      repo: input.repo,
      guardThreadId: input.guardThreadId,
      guardCatId: input.guardCatId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.configs.set(input.repo, config);
    return config;
  }

  async getByRepo(repo: string): Promise<CommunityRepoConfig | null> {
    return this.configs.get(repo) ?? null;
  }

  async listAll(): Promise<CommunityRepoConfig[]> {
    return [...this.configs.values()];
  }

  async deleteByRepo(repo: string): Promise<boolean> {
    return this.configs.delete(repo);
  }
}

// ---------------------------------------------------------------------------
// Redis key helpers
// ---------------------------------------------------------------------------

const KEY_NS = 'community:repo-config:';
const INDEX_KEY = 'community:repo-configs:index';

function configKey(repo: string): string {
  return `${KEY_NS}${repo}`;
}

// ---------------------------------------------------------------------------
// Redis implementation (production)
// ---------------------------------------------------------------------------

export class RedisCommunityRepoConfigStore implements ICommunityRepoConfigStore {
  constructor(private readonly redis: RedisClient) {}

  async upsert(input: UpsertRepoConfigInput): Promise<CommunityRepoConfig> {
    const key = configKey(input.repo);
    const now = Date.now();

    // Check if exists to preserve createdAt
    const existingCreatedAt = await this.redis.hget(key, 'createdAt');
    const createdAt = existingCreatedAt ? Number(existingCreatedAt) : now;

    const config: CommunityRepoConfig = {
      repo: input.repo,
      guardThreadId: input.guardThreadId,
      guardCatId: input.guardCatId,
      createdAt,
      updatedAt: now,
    };

    await this.redis
      .multi()
      .hmset(key, {
        repo: config.repo,
        guardThreadId: config.guardThreadId,
        guardCatId: config.guardCatId,
        createdAt: String(config.createdAt),
        updatedAt: String(config.updatedAt),
      })
      .sadd(INDEX_KEY, input.repo)
      .exec();

    return config;
  }

  async getByRepo(repo: string): Promise<CommunityRepoConfig | null> {
    const raw = await this.redis.hgetall(configKey(repo));
    if (!raw || Object.keys(raw).length === 0) return null;
    return hydrate(raw);
  }

  async listAll(): Promise<CommunityRepoConfig[]> {
    const repos = await this.redis.smembers(INDEX_KEY);
    if (repos.length === 0) return [];

    const pipeline = this.redis.pipeline();
    for (const repo of repos) {
      pipeline.hgetall(configKey(repo));
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const configs: CommunityRepoConfig[] = [];
    for (const [err, raw] of results) {
      if (err || !raw || typeof raw !== 'object' || Object.keys(raw as object).length === 0) continue;
      configs.push(hydrate(raw as Record<string, string>));
    }
    return configs;
  }

  async deleteByRepo(repo: string): Promise<boolean> {
    const key = configKey(repo);
    const existed = await this.redis.exists(key);
    if (!existed) return false;

    await this.redis.multi().del(key).srem(INDEX_KEY, repo).exec();
    return true;
  }
}

// ---------------------------------------------------------------------------
// Hydration helper
// ---------------------------------------------------------------------------

function hydrate(raw: Record<string, string>): CommunityRepoConfig {
  return {
    repo: raw.repo,
    guardThreadId: raw.guardThreadId,
    guardCatId: raw.guardCatId,
    createdAt: Number(raw.createdAt),
    updatedAt: Number(raw.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCommunityRepoConfigStore(redis?: RedisClient): ICommunityRepoConfigStore {
  if (redis) {
    return new RedisCommunityRepoConfigStore(redis);
  }
  return new InMemoryCommunityRepoConfigStore();
}
