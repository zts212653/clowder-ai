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
  readonly reviewMode?: CommunityRepoConfig['reviewMode'];
  readonly cloudReviewPolicy?: CommunityRepoConfig['cloudReviewPolicy'];
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

function canonicalRepoName(repo: string): string {
  return repo.toLowerCase();
}

// ---------------------------------------------------------------------------
// InMemory implementation (unit tests)
// ---------------------------------------------------------------------------

export class InMemoryCommunityRepoConfigStore implements ICommunityRepoConfigStore {
  private readonly configs = new Map<string, CommunityRepoConfig>();

  async upsert(input: UpsertRepoConfigInput): Promise<CommunityRepoConfig> {
    const repo = canonicalRepoName(input.repo);
    const existing = this.configs.get(repo);
    const now = Date.now();
    const config: CommunityRepoConfig = {
      repo,
      guardThreadId: input.guardThreadId,
      guardCatId: input.guardCatId,
      reviewMode: input.reviewMode ?? existing?.reviewMode ?? 'observe_only',
      cloudReviewPolicy: input.cloudReviewPolicy ?? existing?.cloudReviewPolicy ?? 'optional',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.configs.set(repo, config);
    return config;
  }

  async getByRepo(repo: string): Promise<CommunityRepoConfig | null> {
    return this.configs.get(canonicalRepoName(repo)) ?? null;
  }

  async listAll(): Promise<CommunityRepoConfig[]> {
    return [...this.configs.values()];
  }

  async deleteByRepo(repo: string): Promise<boolean> {
    return this.configs.delete(canonicalRepoName(repo));
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

const MIGRATE_LEGACY_REPO_CONFIG_KEYS_LUA = `
local canonicalExists = redis.call('EXISTS', KEYS[1])
if canonicalExists == 0 then
  local winnerIndex = nil
  local winnerUpdatedAt = -1
  for i = 3, #KEYS do
    if redis.call('EXISTS', KEYS[i]) == 1 then
      local updatedAt = tonumber(redis.call('HGET', KEYS[i], 'updatedAt')) or 0
      if winnerIndex == nil or updatedAt > winnerUpdatedAt then
        winnerIndex = i
        winnerUpdatedAt = updatedAt
      end
    end
  end
  if winnerIndex ~= nil then
    redis.call('RENAME', KEYS[winnerIndex], KEYS[1])
    redis.call('HSET', KEYS[1], 'repo', ARGV[1])
  end
end

for i = 3, #KEYS do
  if redis.call('EXISTS', KEYS[i]) == 1 then
    redis.call('DEL', KEYS[i])
  end
  redis.call('SREM', KEYS[2], ARGV[i - 1])
end

if redis.call('EXISTS', KEYS[1]) == 1 then
  redis.call('SADD', KEYS[2], ARGV[1])
  return 1
end
return 0
`;

// ---------------------------------------------------------------------------
// Redis implementation (production)
// ---------------------------------------------------------------------------

export class RedisCommunityRepoConfigStore implements ICommunityRepoConfigStore {
  constructor(private readonly redis: RedisClient) {}

  async upsert(input: UpsertRepoConfigInput): Promise<CommunityRepoConfig> {
    const repo = canonicalRepoName(input.repo);
    await this.migrateLegacyRepos(repo);
    const key = configKey(repo);
    const now = Date.now();

    // Read the existing row once so omitted policy fields preserve explicit opt-in.
    const existingRaw = await this.redis.hgetall(key);
    const existing = Object.keys(existingRaw).length > 0 ? hydrate(existingRaw) : null;
    const createdAt = existing?.createdAt ?? now;

    const config: CommunityRepoConfig = {
      repo,
      guardThreadId: input.guardThreadId,
      guardCatId: input.guardCatId,
      reviewMode: input.reviewMode ?? existing?.reviewMode ?? 'observe_only',
      cloudReviewPolicy: input.cloudReviewPolicy ?? existing?.cloudReviewPolicy ?? 'optional',
      createdAt,
      updatedAt: now,
    };

    await this.redis
      .multi()
      .hmset(key, {
        repo: config.repo,
        guardThreadId: config.guardThreadId,
        guardCatId: config.guardCatId,
        reviewMode: config.reviewMode,
        cloudReviewPolicy: config.cloudReviewPolicy,
        createdAt: String(config.createdAt),
        updatedAt: String(config.updatedAt),
      })
      .sadd(INDEX_KEY, repo)
      .exec();

    return config;
  }

  async getByRepo(repo: string): Promise<CommunityRepoConfig | null> {
    const canonicalRepo = canonicalRepoName(repo);
    await this.migrateLegacyRepos(canonicalRepo);
    const raw = await this.redis.hgetall(configKey(canonicalRepo));
    if (!raw || Object.keys(raw).length === 0) return null;
    return hydrate(raw);
  }

  async listAll(): Promise<CommunityRepoConfig[]> {
    const repos = await this.redis.smembers(INDEX_KEY);
    if (repos.length === 0) return [];

    const canonicalRepos = [...new Set(repos.map(canonicalRepoName))];
    for (const repo of canonicalRepos) {
      if (repos.some((candidate) => candidate !== repo && canonicalRepoName(candidate) === repo)) {
        await this.migrateLegacyRepos(repo, repos);
      }
    }

    const pipeline = this.redis.pipeline();
    for (const repo of canonicalRepos) {
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
    const canonicalRepo = canonicalRepoName(repo);
    await this.migrateLegacyRepos(canonicalRepo);
    const key = configKey(canonicalRepo);
    const existed = await this.redis.exists(key);
    if (!existed) return false;

    await this.redis.multi().del(key).srem(INDEX_KEY, canonicalRepo).exec();
    return true;
  }

  private async migrateLegacyRepos(canonicalRepo: string, indexedRepos?: readonly string[]): Promise<void> {
    const repos = indexedRepos ?? (await this.redis.smembers(INDEX_KEY));
    const legacyRepos = repos.filter(
      (candidate) => candidate !== canonicalRepo && canonicalRepoName(candidate) === canonicalRepo,
    );
    if (legacyRepos.length === 0) return;

    const keys = [configKey(canonicalRepo), INDEX_KEY, ...legacyRepos.map(configKey)];
    await this.redis.eval(MIGRATE_LEGACY_REPO_CONFIG_KEYS_LUA, keys.length, ...keys, canonicalRepo, ...legacyRepos);
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
    reviewMode: raw.reviewMode === 'maintainer_review' ? 'maintainer_review' : 'observe_only',
    cloudReviewPolicy: raw.cloudReviewPolicy === 'required' ? 'required' : 'optional',
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
