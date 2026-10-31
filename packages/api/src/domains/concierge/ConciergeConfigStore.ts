/**
 * ConciergeConfigStore (F229 PR-A1)
 *
 * Per-user 前台猫配置持久化。TTL=0（铁律 5 LL-048）。
 * 遵照 LabelStore/GameStore 三件模式：port interface + Redis 实现 + Memory 实现（测试用）。
 *
 * dutyCatProfileId 默认值解析：
 * - 优先 'gemini35'（co-creator directive 2026-06-12：暹罗猫 Gemini Flash，当前 3.6 Flash）
 * - 不存在则取 catRegistry.getAllIds()[0]
 * - registry 为空时 fallback 'sonnet'
 */

import { CONCIERGE_CONFIG_DEFAULTS, type ConciergeConfig, catRegistry } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import {
  type AppAssistClaim,
  type AppAssistDay,
  type AppAssistPolicyListener,
  appAssistAllowed,
  claimMemoryAppAssistDay,
  claimRedisAppAssistDay,
  validateAppAssistClaim,
  watchRedisAppAssistPolicy,
  writeConciergeConfig,
} from './concierge-app-assist-store.js';
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
  /** Settings must show the saved selection even if the profile was removed.
   * Older adapters without this read capability cannot claim that projection. */
  getSaved?(userId: string): Promise<ConciergeConfig>;
  /** 覆盖写入用户配置（TTL=0，持久化） */
  put(userId: string, config: ConciergeConfig): Promise<void>;
  /** Atomic partial update used by the original settings route. */
  patch?(userId: string, patch: Partial<ConciergeConfig>): Promise<void>;
  claimAppAssistDay?(userId: string, appKey: string, day: string): Promise<AppAssistClaim>;
  watchAppAssistPolicy?(userId: string, listener: AppAssistPolicyListener): Promise<() => Promise<void>>;
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
    const config = await this.getSaved(userId);
    // Ordinary routing retains its existing default-selection semantics.
    if (!config.dutyCatProfileId || !catRegistry.has(config.dutyCatProfileId)) {
      config.dutyCatProfileId = resolveDefaultDutyCatProfileId();
    }
    return config;
  }

  async getSaved(userId: string): Promise<ConciergeConfig> {
    const raw = await this.redis.get(ConciergeKeys.config(userId));
    if (!raw) {
      return {
        ...CONCIERGE_CONFIG_DEFAULTS,
        dutyCatProfileId: resolveDefaultDutyCatProfileId(),
      };
    }
    return { appAssistEnabled: false, ...JSON.parse(raw) } as ConciergeConfig;
  }

  async put(userId: string, config: ConciergeConfig): Promise<void> {
    // TTL=0 意味着"不设置 EXPIRE" = 持久化（铁律 5 LL-048）
    await writeConciergeConfig(this.redis, userId, config);
  }

  async patch(userId: string, patch: Partial<ConciergeConfig>): Promise<void> {
    await writeConciergeConfig(this.redis, userId, patch, {
      ...CONCIERGE_CONFIG_DEFAULTS,
      dutyCatProfileId: resolveDefaultDutyCatProfileId(),
    });
  }

  claimAppAssistDay(userId: string, appKey: string, day: string): Promise<AppAssistClaim> {
    return claimRedisAppAssistDay(this.redis, userId, appKey, day);
  }

  watchAppAssistPolicy(userId: string, listener: AppAssistPolicyListener) {
    return watchRedisAppAssistPolicy(this.redis, userId, listener);
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation（仅用于单元测试 / stub）
// ---------------------------------------------------------------------------

export class MemoryConciergeConfigStore implements IConciergeConfigStore {
  private readonly store = new Map<string, ConciergeConfig>();
  private readonly days = new Map<string, AppAssistDay>();
  private readonly listeners = new Map<string, Set<AppAssistPolicyListener>>();

  async get(userId: string): Promise<ConciergeConfig> {
    const config = await this.getSaved(userId);
    if (!config.dutyCatProfileId || !catRegistry.has(config.dutyCatProfileId)) {
      config.dutyCatProfileId = resolveDefaultDutyCatProfileId();
    }
    return config;
  }

  async getSaved(userId: string): Promise<ConciergeConfig> {
    const entry = this.store.get(userId);
    if (!entry) {
      return {
        ...CONCIERGE_CONFIG_DEFAULTS,
        dutyCatProfileId: resolveDefaultDutyCatProfileId(),
      };
    }
    return { appAssistEnabled: false, ...entry };
  }

  async put(userId: string, config: ConciergeConfig): Promise<void> {
    this.store.set(userId, { ...config });
    await Promise.all([...(this.listeners.get(userId) ?? [])].map((listener) => listener(appAssistAllowed(config))));
  }

  async patch(userId: string, patch: Partial<ConciergeConfig>): Promise<void> {
    const existing = this.store.get(userId) ?? {
      ...CONCIERGE_CONFIG_DEFAULTS,
      dutyCatProfileId: resolveDefaultDutyCatProfileId(),
    };
    await this.put(userId, { ...existing, ...patch });
  }

  async claimAppAssistDay(userId: string, appKey: string, day: string): Promise<AppAssistClaim> {
    validateAppAssistClaim(appKey, day);
    const config = this.store.get(userId);
    if (!config || !appAssistAllowed(config)) return 'disabled';
    return claimMemoryAppAssistDay(this.days, userId, appKey, day);
  }

  async watchAppAssistPolicy(userId: string, listener: AppAssistPolicyListener) {
    const listeners = this.listeners.get(userId) ?? new Set<AppAssistPolicyListener>();
    listeners.add(listener);
    this.listeners.set(userId, listeners);
    return async () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(userId);
    };
  }
}
