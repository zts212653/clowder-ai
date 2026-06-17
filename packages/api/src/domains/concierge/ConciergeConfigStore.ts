/**
 * ConciergeConfigStore (F229 PR-A1)
 *
 * Per-user 前台猫配置持久化。TTL=0（铁律 5 LL-048）。
 * 遵照 LabelStore/GameStore 三件模式：port interface + Redis 实现 + Memory 实现（测试用）。
 *
 * dutyCatProfileId 默认值解析：
 * - 优先 'gemini35'（co-creator directive 2026-06-12：暹罗猫 Gemini 3.5 Flash）
 * - 不存在则取 catRegistry.getAllIds()[0]
 * - registry 为空时 fallback 'sonnet'
 */

import { CONCIERGE_CONFIG_DEFAULTS, type ConciergeConfig, catRegistry } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { ConciergeKeys } from './concierge-keys.js';

// ---------------------------------------------------------------------------
// Default resolution helper
// ---------------------------------------------------------------------------

function resolveDefaultDutyCatProfileId(): string {
  const ids = catRegistry.getAllIds();
  if (ids.includes('gemini35' as never)) return 'gemini35';
  if (ids.length > 0) return ids[0];
  return 'sonnet';
}

// ---------------------------------------------------------------------------
// Port interface
// ---------------------------------------------------------------------------

export interface IConciergeConfigStore {
  /** 获取用户配置；不存在则返回 defaults（含 dutyCatProfileId 解析） */
  get(userId: string): Promise<ConciergeConfig>;
  /** 覆盖写入用户配置（TTL=0，持久化） */
  put(userId: string, config: ConciergeConfig): Promise<void>;
}

// ---------------------------------------------------------------------------
// Redis implementation
// ---------------------------------------------------------------------------

export class RedisConciergeConfigStore implements IConciergeConfigStore {
  private readonly redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async get(userId: string): Promise<ConciergeConfig> {
    const raw = await this.redis.get(ConciergeKeys.config(userId));
    if (!raw) {
      return {
        ...CONCIERGE_CONFIG_DEFAULTS,
        dutyCatProfileId: resolveDefaultDutyCatProfileId(),
      };
    }
    const config = JSON.parse(raw) as ConciergeConfig;
    // FIX-3: validate stored dutyCatProfileId — stale/missing values (e.g., config
    // saved before resolution logic existed, or cat removed from roster) should
    // re-resolve to the plan default (gemini35 → first available → sonnet).
    if (!config.dutyCatProfileId || !catRegistry.has(config.dutyCatProfileId)) {
      config.dutyCatProfileId = resolveDefaultDutyCatProfileId();
    }
    return config;
  }

  async put(userId: string, config: ConciergeConfig): Promise<void> {
    // TTL=0 意味着"不设置 EXPIRE" = 持久化（铁律 5 LL-048）
    await this.redis.set(ConciergeKeys.config(userId), JSON.stringify(config));
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation（仅用于单元测试 / stub）
// ---------------------------------------------------------------------------

export class MemoryConciergeConfigStore implements IConciergeConfigStore {
  private readonly store = new Map<string, ConciergeConfig>();

  async get(userId: string): Promise<ConciergeConfig> {
    const entry = this.store.get(userId);
    if (!entry) {
      return {
        ...CONCIERGE_CONFIG_DEFAULTS,
        dutyCatProfileId: resolveDefaultDutyCatProfileId(),
      };
    }
    const config = { ...entry };
    // FIX-3: same validation as Redis impl
    if (!config.dutyCatProfileId || !catRegistry.has(config.dutyCatProfileId)) {
      config.dutyCatProfileId = resolveDefaultDutyCatProfileId();
    }
    return config;
  }

  async put(userId: string, config: ConciergeConfig): Promise<void> {
    this.store.set(userId, { ...config });
  }
}
