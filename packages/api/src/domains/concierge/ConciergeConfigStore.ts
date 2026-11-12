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

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyWatcherConfigPatch,
  CONCIERGE_CONFIG_DEFAULTS,
  type ConciergeConfig,
  catRegistry,
  parseWatcherConfig,
  type WatcherConfig,
  type WatcherConfigPatch,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { readPluginConfig, writePluginConfig } from '../plugin/plugin-config-store.js';
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
// Default resolution helper
// ---------------------------------------------------------------------------

function resolveDefaultDutyCatProfileId(): string {
  const ids = catRegistry.getAllIds();
  if (ids.includes('gemini35' as never)) return 'gemini35';
  if (ids.length > 0) return ids[0];
  return 'sonnet';
}

// ---------------------------------------------------------------------------
// Owner-managed settings are the companion plugin's configuration
// ---------------------------------------------------------------------------

const COMPANION_PLUGIN_ID = 'official.companion';
const PLUGIN_KEYS = [
  'dutyCatProfileId',
  'displayName',
  'personaTone',
  'proactivePolicy',
  'behaviorEnabled',
  'skin',
  'ballSize',
] as const;
type PluginKey = (typeof PLUGIN_KEYS)[number];

function readPluginSettings(projectRoot: string): Pick<ConciergeConfig, PluginKey> {
  const stored = readPluginConfig(projectRoot, COMPANION_PLUGIN_ID);
  const d = CONCIERGE_CONFIG_DEFAULTS;
  return {
    dutyCatProfileId: stored.dutyCatProfileId ?? resolveDefaultDutyCatProfileId(),
    displayName: stored.displayName ?? d.displayName,
    personaTone: stored.personaTone ?? d.personaTone,
    proactivePolicy: (stored.proactivePolicy as ConciergeConfig['proactivePolicy']) ?? d.proactivePolicy,
    behaviorEnabled: stored.behaviorEnabled === undefined ? d.behaviorEnabled : stored.behaviorEnabled === 'true',
    skin: (stored.skin as ConciergeConfig['skin']) ?? d.skin,
    ballSize: stored.ballSize === undefined ? d.ballSize : Number(stored.ballSize),
  };
}

/** Writes the plugin-owned keys to the plugin configuration and returns the rest. */
function writePluginSettings(projectRoot: string, patch: Partial<ConciergeConfig>): Partial<ConciergeConfig> {
  const rest: Record<string, unknown> = {};
  const updates: { name: string; value: string | null }[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if ((PLUGIN_KEYS as readonly string[]).includes(key))
      updates.push({ name: key, value: value == null ? null : String(value) });
    else rest[key] = value;
  }
  if (updates.length) writePluginConfig(projectRoot, COMPANION_PLUGIN_ID, updates);
  return rest as Partial<ConciergeConfig>;
}

/** One-time move of settings saved before they became the companion plugin's configuration. */
export async function moveConciergeSettingsToPlugin(redis: RedisClient, projectRoot: string, userId: string) {
  const raw = await redis.get(ConciergeKeys.config(userId));
  const stored = readPluginConfig(projectRoot, COMPANION_PLUGIN_ID);
  if (!raw || PLUGIN_KEYS.some((key) => key in stored)) return;
  const saved = JSON.parse(raw) as Partial<ConciergeConfig>;
  writePluginSettings(
    projectRoot,
    Object.fromEntries(PLUGIN_KEYS.filter((key) => saved[key] != null).map((key) => [key, saved[key]])),
  );
}

// ---------------------------------------------------------------------------
// Port interface
// ---------------------------------------------------------------------------

export interface IConciergeConfigStore {
  initializeWatcherCursor?(userId: string, sequence: number): Promise<number>;
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
    const defaults = { ...CONCIERGE_CONFIG_DEFAULTS, dutyCatProfileId: resolveDefaultDutyCatProfileId() };
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
      JSON.stringify(defaults),
      JSON.stringify(parseWatcherConfig(undefined)),
      String(Date.now()),
    );
    return Number(result);
  }
  private readonly redis: RedisClient;

  constructor(
    redis: RedisClient,
    private readonly projectRoot: string,
  ) {
    this.redis = redis;
  }

  async readWatcherConfig(userId: string): Promise<WatcherConfig> {
    return parseWatcherConfig((await this.getSaved(userId)).watcher);
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
      {
        ...CONCIERGE_CONFIG_DEFAULTS,
        dutyCatProfileId: resolveDefaultDutyCatProfileId(),
      },
      resumeAfterSequence,
    );
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
    const saved = raw ? { appAssistEnabled: false, ...JSON.parse(raw) } : CONCIERGE_CONFIG_DEFAULTS;
    return { ...saved, ...readPluginSettings(this.projectRoot) } as ConciergeConfig;
  }

  async put(userId: string, config: ConciergeConfig): Promise<void> {
    // TTL=0 意味着"不设置 EXPIRE" = 持久化（铁律 5 LL-048）
    await writeConciergeConfig(this.redis, userId, writePluginSettings(this.projectRoot, config));
  }

  async patch(userId: string, patch: Partial<ConciergeConfig>): Promise<void> {
    await writeConciergeConfig(this.redis, userId, writePluginSettings(this.projectRoot, patch), {
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
  async initializeWatcherCursor(userId: string, sequence: number): Promise<number> {
    const entry = this.store.get(userId) ?? {
      ...CONCIERGE_CONFIG_DEFAULTS,
      dutyCatProfileId: resolveDefaultDutyCatProfileId(),
    };
    const config = parseWatcherConfig(entry.watcher);
    if (config.startedAfterSequence !== undefined) return config.startedAfterSequence;
    this.store.set(userId, {
      ...entry,
      watcher: { ...config, startedAfterSequence: sequence, activatedAt: Date.now() },
    });
    return sequence;
  }
  private readonly store = new Map<string, ConciergeConfig>();
  /** Memory is ephemeral; the Host passes its project root when it runs without Redis. */
  constructor(private readonly projectRoot = mkdtempSync(join(tmpdir(), 'concierge-config-'))) {}
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
    const existing = this.store.get(userId) ?? {
      ...CONCIERGE_CONFIG_DEFAULTS,
      dutyCatProfileId: resolveDefaultDutyCatProfileId(),
    };
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
    const config = await this.getSaved(userId);
    if (!config.dutyCatProfileId || !catRegistry.has(config.dutyCatProfileId)) {
      config.dutyCatProfileId = resolveDefaultDutyCatProfileId();
    }
    return config;
  }

  async getSaved(userId: string): Promise<ConciergeConfig> {
    const entry = this.store.get(userId);
    const saved = entry ? { appAssistEnabled: false, ...entry } : CONCIERGE_CONFIG_DEFAULTS;
    return { ...saved, ...readPluginSettings(this.projectRoot) } as ConciergeConfig;
  }

  async put(userId: string, config: ConciergeConfig): Promise<void> {
    await this.keep(userId, writePluginSettings(this.projectRoot, config) as ConciergeConfig);
  }

  async patch(userId: string, patch: Partial<ConciergeConfig>): Promise<void> {
    const rest = writePluginSettings(this.projectRoot, patch);
    await this.keep(userId, { ...(this.store.get(userId) ?? CONCIERGE_CONFIG_DEFAULTS), ...rest } as ConciergeConfig);
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
