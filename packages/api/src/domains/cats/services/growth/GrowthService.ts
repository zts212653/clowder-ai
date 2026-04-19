/**
 * F160 Cat Journey RPG — Journey Service
 * Reads/writes XP counters in Redis, computes attributes and profiles.
 *
 * XP is stored as simple Redis integers: growth:{catId}:{dimension} → total XP.
 * Level formula: level = floor(sqrt(xp / 100))  (quadratic curve)
 * XP to next: (level+1)^2 * 100 - xp
 */

import type {
  BondLevel,
  CatAttributes,
  CatBond,
  CatGrowthProfile,
  CatTitle,
  DimensionStat,
  GrowthDimension,
  GrowthOverview,
  TitleCondition,
  TitleDefinition,
  UnlockedTitle,
  XpEvent,
  XpSource,
} from '@cat-cafe/shared';
import { catRegistry, GROWTH_DIMENSIONS, TITLE_DEFINITIONS } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { createModuleLogger } from '../../../../infrastructure/logger.js';
import { growthAuditKey, growthBondKey, growthTitleKey, growthXpKey } from '../stores/redis-keys/growth-keys.js';

const log = createModuleLogger('growth');

/** XP per source type, mapped to the dimension it feeds. */
const XP_RULES: Record<XpSource, { dimension: GrowthDimension; xp: number }> = {
  task_complete: { dimension: 'execution', xp: 50 },
  session_seal: { dimension: 'execution', xp: 20 },
  review_given: { dimension: 'review', xp: 40 },
  review_received: { dimension: 'collaboration', xp: 15 },
  tool_use: { dimension: 'execution', xp: 1 },
  tool_use_mcp: { dimension: 'insight', xp: 3 },
  tool_use_skill: { dimension: 'aesthetics', xp: 3 },
  mention_collab: { dimension: 'collaboration', xp: 10 },
  deep_collab: { dimension: 'collaboration', xp: 20 },
  discussion: { dimension: 'architecture', xp: 15 },
  pr_merged: { dimension: 'execution', xp: 80 },
  bug_caught: { dimension: 'review', xp: 60 },
  design_feedback: { dimension: 'aesthetics', xp: 30 },
  rich_block_create: { dimension: 'aesthetics', xp: 20 },
  evidence_cite: { dimension: 'insight', xp: 25 },
  cache_efficiency: { dimension: 'insight', xp: 15 },
  ideate_discussion: { dimension: 'architecture', xp: 25 },
  error_recovery: { dimension: 'execution', xp: 30 },
  fast_execution: { dimension: 'execution', xp: 20 },
};

function levelFromXp(xp: number): number {
  return Math.floor(Math.sqrt(xp / 100));
}

function xpForLevel(level: number): number {
  return level * level * 100;
}

function buildDimensionStat(dimension: GrowthDimension, xp: number): DimensionStat {
  const level = levelFromXp(xp);
  return { dimension, xp, level, xpToNext: xpForLevel(level + 1) - xp };
}

/** XP sources that map to achievement counters. */
const SOURCE_TO_COUNTER: Partial<Record<XpSource, string>> = {
  task_complete: 'tasks',
  review_given: 'reviews',
  session_seal: 'sessions',
};

export class GrowthService {
  /** Phase C: Optional AchievementService — set after construction to avoid circular deps. */
  achievementService?: { incrementCounter(memberId: string, counter: string): void };
  /** Phase E: Optional EvolutionService — records milestone narrative events. */
  evolutionService?: import('./EvolutionService.js').EvolutionService;

  constructor(private readonly redis: RedisClient) {}

  /** Resolve ioredis keyPrefix for SCAN operations. */
  private get keyPrefix(): string {
    return (this.redis as { options?: { keyPrefix?: string } }).options?.keyPrefix ?? '';
  }

  /** Award XP + record audit event. Fire-and-forget — caller should not await. */
  awardXp(catId: string, source: XpSource, multiplier = 1): void {
    const rule = XP_RULES[source];
    if (!rule) return;
    const amount = Math.max(1, Math.round(rule.xp * multiplier));
    const key = growthXpKey(catId, rule.dimension);
    const ts = Date.now();

    // Increment total + append audit entry (pipelined, single RTT)
    const pipeline = this.redis.pipeline();
    pipeline.incrby(key, amount);
    const event: XpEvent = { catId, dimension: rule.dimension, xp: amount, source, timestamp: ts };
    // Nonce ensures uniqueness when identical events fire in the same millisecond (e.g. tool_use bursts)
    const member = JSON.stringify({ ...event, _seq: Math.random().toString(36).slice(2, 8) });
    pipeline.zadd(growthAuditKey(catId), ts, member);
    pipeline
      .exec()
      .then((results) => {
        // Phase E (AC-E1): Detect level transitions from INCRBY result
        if (this.evolutionService && results) {
          const newXp = results[0]?.[1] as number | undefined;
          if (newXp != null) {
            const oldXp = newXp - amount;
            if (oldXp === 0) this.evolutionService.recordFirstDimension(catId, rule.dimension);
            const oldLevel = levelFromXp(oldXp);
            const newLevel = levelFromXp(newXp);
            if (newLevel > oldLevel) this.evolutionService.recordLevelUp(catId, rule.dimension, oldLevel, newLevel);
          }
        }

        // Phase B: Check title unlocks after XP change (fire-and-forget)
        this.getAttributes(catId)
          .then((attrs) => this.checkTitleUnlocks(catId, attrs))
          .catch((err: unknown) => log.warn({ err, catId }, 'Title check failed'));
      })
      .catch((err: unknown) => {
        log.warn({ err, catId, source }, 'Failed to award XP');
      });

    // Phase C: Increment achievement counter if applicable (fire-and-forget)
    const counter = SOURCE_TO_COUNTER[source];
    if (counter && this.achievementService) {
      this.achievementService.incrementCounter(catId, counter);
    }
  }

  /** AC-A5: Fetch recent XP events for a cat, newest first. */
  async getXpEvents(catId: string, limit = 50, offset = 0): Promise<XpEvent[]> {
    const raw = await this.redis.zrevrange(growthAuditKey(catId), offset, offset + limit - 1);
    return raw.map((s) => JSON.parse(s) as XpEvent);
  }

  /** Read one cat's attributes from Redis. */
  async getAttributes(catId: string): Promise<CatAttributes> {
    const keys = GROWTH_DIMENSIONS.map((d) => growthXpKey(catId, d));
    const values = await this.redis.mget(...keys);

    const stats = {} as Record<GrowthDimension, DimensionStat>;
    let totalXp = 0;
    let levelSum = 0;
    let activeDimensions = 0;

    for (let i = 0; i < GROWTH_DIMENSIONS.length; i++) {
      const dim = GROWTH_DIMENSIONS[i]!;
      const xp = parseInt(values[i] ?? '0', 10) || 0;
      stats[dim] = buildDimensionStat(dim, xp);
      totalXp += xp;
      levelSum += stats[dim].level;
      if (xp > 0) activeDimensions++;
    }

    return {
      catId,
      stats,
      // Only average over dimensions that have XP — avoids inactive review dragging level down
      overallLevel: activeDimensions > 0 ? Math.floor(levelSum / activeDimensions) : 0,
      totalXp,
      updatedAt: Date.now(),
    };
  }

  // ── Phase B: Title System ──────────────────────────────────────────

  /** Check if a single title condition is met. */
  private conditionMet(cond: TitleCondition, attrs: CatAttributes): boolean {
    switch (cond.type) {
      case 'dimension_level':
        return (attrs.stats[cond.dimension]?.level ?? 0) >= cond.minLevel;
      case 'overall_level':
        return attrs.overallLevel >= cond.minLevel;
      case 'total_xp':
        return attrs.totalXp >= cond.minXp;
    }
  }

  /** Check all title definitions against current attributes. Returns newly unlocked titles. */
  async checkTitleUnlocks(catId: string, attrs: CatAttributes): Promise<UnlockedTitle[]> {
    const existing = await this.getUnlockedTitles(catId);
    const existingIds = new Set(existing.map((t) => t.titleId));
    const newlyUnlocked: UnlockedTitle[] = [];

    for (const def of TITLE_DEFINITIONS) {
      if (existingIds.has(def.id)) continue;
      const allMet = def.conditions.every((c) => this.conditionMet(c, attrs));
      if (!allMet) continue;

      const unlock: UnlockedTitle = { titleId: def.id, catId, unlockedAt: Date.now() };
      await this.redis.zadd(growthTitleKey(catId), unlock.unlockedAt, JSON.stringify(unlock));
      newlyUnlocked.push(unlock);
      log.info({ catId, titleId: def.id }, 'Title unlocked');
    }
    return newlyUnlocked;
  }

  /** Get all unlocked titles for a cat, newest first. */
  async getUnlockedTitles(catId: string): Promise<UnlockedTitle[]> {
    const raw = await this.redis.zrevrange(growthTitleKey(catId), 0, -1);
    return raw.map((s) => JSON.parse(s) as UnlockedTitle);
  }

  /** Get the highest-rarity title for display in profile card. */
  async getCurrentTitle(catId: string): Promise<CatTitle | undefined> {
    const unlocked = await this.getUnlockedTitles(catId);
    if (unlocked.length === 0) return undefined;

    const RARITY_ORDER: Record<string, number> = { legendary: 4, epic: 3, rare: 2, common: 1 };
    const defMap = new Map<string, TitleDefinition>();
    for (const d of TITLE_DEFINITIONS) defMap.set(d.id, d);

    let best: { def: TitleDefinition; unlock: UnlockedTitle } | undefined;
    for (const u of unlocked) {
      const def = defMap.get(u.titleId);
      if (!def) continue;
      if (!best || (RARITY_ORDER[def.rarity] ?? 0) > (RARITY_ORDER[best.def.rarity] ?? 0)) {
        best = { def, unlock: u };
      }
    }
    if (!best) return undefined;
    return { id: best.def.id, label: best.def.label, unlockedAt: best.unlock.unlockedAt };
  }

  // ── Phase B: Bond System ────────────────────────────────────────────

  /** Record a collaboration event between two cats. Fire-and-forget. */
  recordBondEvent(catA: string, catB: string): void {
    if (catA === catB) return;
    const key = growthBondKey(catA, catB);
    const pipeline = this.redis.pipeline();
    pipeline.hincrby(key, 'score', 1);
    pipeline.hincrby(key, 'interactions', 1);
    pipeline.hset(key, 'lastInteractionAt', String(Date.now()));
    pipeline.hset(key, 'catA', catA < catB ? catA : catB);
    pipeline.hset(key, 'catB', catA < catB ? catB : catA);
    pipeline.exec().catch((err: unknown) => {
      log.warn({ err, catA, catB }, 'Failed to record bond event');
    });
  }

  /** Get bond level from score. */
  static bondLevel(score: number): BondLevel {
    if (score >= 50) return 'soulmate';
    if (score >= 15) return 'partner';
    return 'acquaintance';
  }

  /** Get all bonds for a cat by scanning Redis. */
  async getBonds(catId: string): Promise<(CatBond & { level: BondLevel })[]> {
    const allCatIds = catRegistry.getAllIds().map(String);
    const bonds: (CatBond & { level: BondLevel })[] = [];

    for (const otherId of allCatIds) {
      if (otherId === catId) continue;
      const key = growthBondKey(catId, otherId);
      const data = await this.redis.hgetall(key);
      if (!data || !data.score) continue;
      const score = parseInt(data.score, 10) || 0;
      if (score === 0) continue;
      bonds.push({
        catA: data.catA ?? (catId < otherId ? catId : otherId),
        catB: data.catB ?? (catId < otherId ? otherId : catId),
        score,
        interactions: parseInt(data.interactions ?? '0', 10) || 0,
        lastInteractionAt: parseInt(data.lastInteractionAt ?? '0', 10) || 0,
        level: GrowthService.bondLevel(score),
      });
    }
    return bonds.sort((a, b) => b.score - a.score);
  }

  /** AC-C6: Co-creator identity for growth tracking. */
  static readonly CO_CREATOR_ID = 'co-creator';

  /** Build full journey profile for a cat or the co-creator. */
  async getProfile(catId: string): Promise<CatGrowthProfile | null> {
    if (catId === GrowthService.CO_CREATOR_ID) {
      return this.getCoCreatorProfile();
    }
    const entry = catRegistry.tryGet(catId);
    if (!entry) return null;
    const config = entry.config;

    const attributes = await this.getAttributes(catId);
    const currentTitle = await this.getCurrentTitle(catId);
    return {
      catId,
      displayName: config.displayName ?? config.id,
      nickname: config.nickname,
      attributes,
      currentTitle,
      highlights: [],
    };
  }

  /** AC-C6: Build journey profile for the co-creator (not in catRegistry). */
  private async getCoCreatorProfile(): Promise<CatGrowthProfile> {
    const attributes = await this.getAttributes(GrowthService.CO_CREATOR_ID);
    const currentTitle = await this.getCurrentTitle(GrowthService.CO_CREATOR_ID);
    return {
      catId: GrowthService.CO_CREATOR_ID,
      displayName: '铲屎官',
      nickname: 'CVO',
      attributes,
      currentTitle,
      highlights: [],
    };
  }

  /** Build team journey overview across all registered cats + co-creator. */
  async getOverview(): Promise<GrowthOverview> {
    const catIds = catRegistry.getAllIds().map(String);

    const profiles = await Promise.all(catIds.map((id) => this.getProfile(id)));
    const valid = profiles.filter((p): p is CatGrowthProfile => p !== null);

    // AC-C6: Include co-creator if they have any XP
    const coCreatorProfile = await this.getCoCreatorProfile();
    if (coCreatorProfile.attributes.totalXp > 0) {
      valid.unshift(coCreatorProfile);
    }

    const teamTotalXp = valid.reduce((s, p) => s + p.attributes.totalXp, 0);
    const teamLevel =
      valid.length > 0 ? Math.floor(valid.reduce((s, p) => s + p.attributes.overallLevel, 0) / valid.length) : 0;

    return {
      profiles: valid,
      teamLevel,
      teamTotalXp,
      fetchedAt: new Date().toISOString(),
    };
  }
}
