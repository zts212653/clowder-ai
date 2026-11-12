/**
 * ConciergeConfigStore (F229 PR-A1)
 *
 * Per-user 前台猫运行状态持久化。TTL=0（铁律 5 LL-048）。
 * 遵照 LabelStore/GameStore 三件模式：port interface + Redis 实现 + Memory 实现（测试用）。
 * 猫猫球的主人设置是 official.companion 的插件配置（companion-settings.ts）。
 */

import {
  applyWatcherConfigPatch,
  CONCIERGE_CONFIG_DEFAULTS,
  type ConciergeConfig,
  parseWatcherConfig,
  type WatcherConfig,
  type WatcherConfigPatch,
} from '@cat-cafe/shared';
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
import { assertWatcherConfigRevision, updateRedisWatcherConfig } from './watcher/watcher-config-store.js';

// ---------------------------------------------------------------------------
// Port interface
// ---------------------------------------------------------------------------

export interface IConciergeConfigStore {
  initializeWatcherCursor?(userId: string, sequence: number): Promise<number>;
  /** 获取用户配置；不存在则返回 defaults */
  get(userId: string): Promise<ConciergeConfig>;
  /** 覆盖写入用户配置（TTL=0，持久化） */
  put(userId: string, config: ConciergeConfig): Promise<void>;
  /** Atomic partial update used by the original settings route. */
  patch?(userId: string, patch: Partial<ConciergeConfig>): Promise<void>;
  claimAppAssistDay?(userId: string, appKey: string, day: string): Promise<AppAssistClaim>;
  watchAppAssistPolicy?(userId: string, listener: AppAssistPolicyListener): Promise<() => Promise<void>>;
  readWatcherConfig?(userId: string): Promise<WatcherConfig>;
  updateWatcherConfig?(
    userId: string,
    expectedRevision: number,
    patch: WatcherConfigPatch,
    resumeAfterSequence?: number,
  ): Promise<WatcherConfig | null>;
}

// ---------------------------------------------------------------------------
// Redis implementation
// ---------------------------------------------------------------------------

export class RedisConciergeConfigStore implements IConciergeConfigStore {
  async initializeWatcherCursor(userId: string, sequence: number): Promise<number> {
    const result = await this.redis.eval(
      `
      local raw = redis.call('GET', KEYS[1])
      local config = raw and cjson.decode(raw) or cjson.decode(ARGV[2])
      if not config.watcher then config.watcher = cjson.decode(ARGV[3]) end
      if config.watcher.startedAfterSequence ~= nil then return config.watcher.startedAfterSequence end
      config.watcher.startedAfterSequence = tonumber(ARGV[1])
      config.watcher.activatedAt = tonumber(ARGV[4])
      redis.call('SET', KEYS[1], cjson.encode(config))
      return tonumber(ARGV[1])
    `,
      1,
      ConciergeKeys.config(userId),
      String(sequence),
      JSON.stringify(CONCIERGE_CONFIG_DEFAULTS),
      JSON.stringify(parseWatcherConfig(undefined)),
      String(Date.now()),
    );
    return Number(result);
  }
  private readonly redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async readWatcherConfig(userId: string): Promise<WatcherConfig> {
    return parseWatcherConfig((await this.get(userId)).watcher);
  }

  updateWatcherConfig(
    userId: string,
    expectedRevision: number,
    patch: WatcherConfigPatch,
    resumeAfterSequence?: number,
  ): Promise<WatcherConfig | null> {
    return updateRedisWatcherConfig(
      this.redis,
      userId,
      expectedRevision,
      patch,
      CONCIERGE_CONFIG_DEFAULTS,
      resumeAfterSequence,
    );
  }

  async get(userId: string): Promise<ConciergeConfig> {
    const raw = await this.redis.get(ConciergeKeys.config(userId));
    return raw ? { appAssistEnabled: false, ...JSON.parse(raw) } : { ...CONCIERGE_CONFIG_DEFAULTS };
  }

  async put(userId: string, config: ConciergeConfig): Promise<void> {
    // TTL=0 意味着"不设置 EXPIRE" = 持久化（铁律 5 LL-048）
    await writeConciergeConfig(this.redis, userId, config);
  }

  async patch(userId: string, patch: Partial<ConciergeConfig>): Promise<void> {
    await writeConciergeConfig(this.redis, userId, patch, CONCIERGE_CONFIG_DEFAULTS);
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
  async initializeWatcherCursor(userId: string, sequence: number): Promise<number> {
    const entry = this.store.get(userId) ?? CONCIERGE_CONFIG_DEFAULTS;
    const config = parseWatcherConfig(entry.watcher);
    if (config.startedAfterSequence !== undefined) return config.startedAfterSequence;
    this.store.set(userId, {
      ...entry,
      watcher: { ...config, startedAfterSequence: sequence, activatedAt: Date.now() },
    });
    return sequence;
  }
  private readonly store = new Map<string, ConciergeConfig>();
  private readonly days = new Map<string, AppAssistDay>();
  private readonly listeners = new Map<string, Set<AppAssistPolicyListener>>();

  async readWatcherConfig(userId: string): Promise<WatcherConfig> {
    return parseWatcherConfig(this.store.get(userId)?.watcher);
  }

  async updateWatcherConfig(
    userId: string,
    expectedRevision: number,
    patch: WatcherConfigPatch,
    resumeAfterSequence?: number,
  ): Promise<WatcherConfig | null> {
    assertWatcherConfigRevision(expectedRevision);
    const existing = this.store.get(userId) ?? CONCIERGE_CONFIG_DEFAULTS;
    const current = parseWatcherConfig(existing.watcher);
    if (current.revision !== expectedRevision) return null;
    const next = applyWatcherConfigPatch(current, patch);
    if (resumeAfterSequence !== undefined) {
      next.startedAfterSequence = Math.max(current.startedAfterSequence ?? 0, resumeAfterSequence);
      next.activationRevision = next.revision;
      next.activatedAt = Date.now();
    }
    this.store.set(userId, { ...existing, watcher: next });
    return parseWatcherConfig(next);
  }

  async get(userId: string): Promise<ConciergeConfig> {
    const entry = this.store.get(userId);
    return entry ? { appAssistEnabled: false, ...entry } : { ...CONCIERGE_CONFIG_DEFAULTS };
  }

  async put(userId: string, config: ConciergeConfig): Promise<void> {
    await this.keep(userId, config);
  }

  async patch(userId: string, patch: Partial<ConciergeConfig>): Promise<void> {
    await this.keep(userId, { ...(this.store.get(userId) ?? CONCIERGE_CONFIG_DEFAULTS), ...patch });
  }

  private async keep(userId: string, config: ConciergeConfig): Promise<void> {
    this.store.set(userId, config);
    await Promise.all([...(this.listeners.get(userId) ?? [])].map((listener) => listener(appAssistAllowed(config))));
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
