/**
 * F160 Phase C — Achievement Service
 *
 * Checks achievement conditions against current state and unlocks achievements.
 * Integrates with GrowthService for attribute/title/bond data and Redis counters
 * for event-based achievements (task_count, review_count, session_count).
 */

import type {
  AchievementCondition,
  AchievementDefinition,
  BondLevel,
  CatAttributes,
  UnlockedAchievement,
} from '@cat-cafe/shared';
import { ACHIEVEMENT_DEFINITIONS } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { createModuleLogger } from '../../../../infrastructure/logger.js';
import { achievementCountersKey, achievementUnlockedKey } from '../stores/redis-keys/achievement-keys.js';
import type { GrowthService } from './GrowthService.js';

const log = createModuleLogger('achievement');

const BOND_LEVEL_ORDER: Record<BondLevel, number> = { acquaintance: 1, partner: 2, soulmate: 3 };

/** Callback invoked when achievements are newly unlocked (AC-C5). */
export type AchievementUnlockHandler = (
  memberId: string,
  unlocked: UnlockedAchievement[],
  definitions: AchievementDefinition[],
) => void;

export class AchievementService {
  /** Optional handler called on new unlocks — set from outside to avoid circular deps. */
  onUnlock?: AchievementUnlockHandler;

  constructor(
    private readonly redis: RedisClient,
    private readonly growthService: GrowthService,
  ) {}

  // ── Counter increment (fire-and-forget) ───────────────────────────

  /** Increment an event counter. Called from trigger points. */
  incrementCounter(memberId: string, counter: 'tasks' | 'reviews' | 'sessions'): void {
    this.redis
      .pipeline()
      .hincrby(achievementCountersKey(memberId), counter, 1)
      .exec()
      .then(() => this.checkAndUnlock(memberId))
      .catch((err: unknown) => log.warn({ err, memberId, counter }, 'Counter increment failed'));
  }

  // ── Check + unlock ────────────────────────────────────────────────

  /** Check all achievements for a member and unlock newly qualified ones. */
  async checkAndUnlock(memberId: string): Promise<UnlockedAchievement[]> {
    const existing = await this.getUnlocked(memberId);
    const existingIds = new Set(existing.map((a) => a.achievementId));
    const attrs = await this.growthService.getAttributes(memberId);
    const counters = await this.getCounters(memberId);
    const titleCount = (await this.growthService.getUnlockedTitles(memberId)).length;
    const bonds = await this.growthService.getBonds(memberId);

    const newlyUnlocked: UnlockedAchievement[] = [];

    for (const def of ACHIEVEMENT_DEFINITIONS) {
      if (existingIds.has(def.id)) continue;
      if (def.conditions.length === 0) continue; // event-driven only
      if (!this.allConditionsMet(def, attrs, counters, titleCount, bonds.length, bonds)) continue;

      const unlock: UnlockedAchievement = {
        achievementId: def.id,
        memberId,
        unlockedAt: Date.now(),
      };
      await this.redis.zadd(achievementUnlockedKey(memberId), unlock.unlockedAt, JSON.stringify(unlock));
      newlyUnlocked.push(unlock);
      log.info({ memberId, achievementId: def.id }, 'Achievement unlocked');
    }
    if (newlyUnlocked.length > 0 && this.onUnlock) {
      const defMap = new Map(ACHIEVEMENT_DEFINITIONS.map((d) => [d.id, d]));
      const defs = newlyUnlocked.map((u) => defMap.get(u.achievementId)!).filter(Boolean);
      this.onUnlock(memberId, newlyUnlocked, defs);
    }
    return newlyUnlocked;
  }

  /** Manually unlock an event-driven achievement (hidden, etc). */
  async unlockManual(memberId: string, achievementId: string, triggerRef?: string): Promise<boolean> {
    const existing = await this.getUnlocked(memberId);
    if (existing.some((a) => a.achievementId === achievementId)) return false;

    const def = ACHIEVEMENT_DEFINITIONS.find((d) => d.id === achievementId);
    if (!def) return false;

    const unlock: UnlockedAchievement = {
      achievementId,
      memberId,
      unlockedAt: Date.now(),
      triggerRef,
    };
    await this.redis.zadd(achievementUnlockedKey(memberId), unlock.unlockedAt, JSON.stringify(unlock));
    log.info({ memberId, achievementId, triggerRef }, 'Achievement manually unlocked');
    if (this.onUnlock && def) {
      this.onUnlock(memberId, [unlock], [def]);
    }
    return true;
  }

  // ── Read ──────────────────────────────────────────────────────────

  async getUnlocked(memberId: string): Promise<UnlockedAchievement[]> {
    const raw = await this.redis.zrevrange(achievementUnlockedKey(memberId), 0, -1);
    return raw.map((s) => JSON.parse(s) as UnlockedAchievement);
  }

  async getCounters(memberId: string): Promise<Record<string, number>> {
    const raw = await this.redis.hgetall(achievementCountersKey(memberId));
    if (!raw) return {};
    const result: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) {
      result[k] = parseInt(v, 10) || 0;
    }
    return result;
  }

  // ── Condition evaluation ──────────────────────────────────────────

  private allConditionsMet(
    def: AchievementDefinition,
    attrs: CatAttributes,
    counters: Record<string, number>,
    titleCount: number,
    bondCount: number,
    bonds: { level: BondLevel }[],
  ): boolean {
    return def.conditions.every((c) => this.conditionMet(c, attrs, counters, titleCount, bondCount, bonds));
  }

  private conditionMet(
    cond: AchievementCondition,
    attrs: CatAttributes,
    counters: Record<string, number>,
    titleCount: number,
    bondCount: number,
    bonds: { level: BondLevel }[],
  ): boolean {
    switch (cond.type) {
      case 'total_xp':
        return attrs.totalXp >= cond.minXp;
      case 'overall_level':
        return attrs.overallLevel >= cond.minLevel;
      case 'dimension_level':
        return (attrs.stats[cond.dimension]?.level ?? 0) >= cond.minLevel;
      case 'title_count':
        return titleCount >= cond.minCount;
      case 'bond_count':
        return bondCount >= cond.minCount;
      case 'bond_level':
        return bonds.some((b) => BOND_LEVEL_ORDER[b.level] >= BOND_LEVEL_ORDER[cond.minLevel]);
      case 'task_count':
        return (counters.tasks ?? 0) >= cond.minCount;
      case 'review_count':
        return (counters.reviews ?? 0) >= cond.minCount;
      case 'session_count':
        return (counters.sessions ?? 0) >= cond.minCount;
    }
  }
}
