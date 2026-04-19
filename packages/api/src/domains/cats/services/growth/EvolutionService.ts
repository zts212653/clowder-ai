/**
 * F160 Phase E — Evolution Event Service (AC-E1)
 *
 * Records narrative milestone events for the growth timeline:
 *   - Level-up (dimension or overall)
 *   - First XP in a new dimension
 *   - Achievement/moment unlocked
 *   - Title unlocked
 *
 * Redis: evolution:{catId} → sorted set (score = timestamp, member = JSON)
 */

import type { EvolutionEvent, EvolutionEventType, TraitDimension } from '@cat-cafe/shared';
import { DIMENSION_LABELS } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { createModuleLogger } from '../../../../infrastructure/logger.js';
import { evolutionEventKey } from '../stores/redis-keys/growth-keys.js';

const log = createModuleLogger('evolution');

/** Max events stored per cat (sorted set trimmed after insert). */
const MAX_EVENTS_PER_CAT = 200;

export class EvolutionService {
  constructor(private readonly redis: RedisClient) {}

  /** Record a level-up event. */
  recordLevelUp(catId: string, dimension: TraitDimension, oldLevel: number, newLevel: number): void {
    const dimLabel = DIMENSION_LABELS[dimension];
    this.record(catId, {
      type: 'level_up',
      catId,
      narrative: {
        zh: `${dimLabel.zh}从 Lv.${oldLevel} 升级到 Lv.${newLevel}！`,
        en: `${dimLabel.en} leveled up from Lv.${oldLevel} to Lv.${newLevel}!`,
      },
      details: { dimension, oldLevel, newLevel },
      timestamp: Date.now(),
    });
  }

  /** Record first XP earned in a dimension. */
  recordFirstDimension(catId: string, dimension: TraitDimension): void {
    const dimLabel = DIMENSION_LABELS[dimension];
    this.record(catId, {
      type: 'first_dim',
      catId,
      narrative: {
        zh: `首次获得${dimLabel.zh}经验！旅程开启`,
        en: `First ${dimLabel.en} experience earned! Journey begins`,
      },
      details: { dimension },
      timestamp: Date.now(),
    });
  }

  /** Record achievement unlock (called from AchievementService.onUnlock). */
  recordAchievement(catId: string, achievementId: string, label: { zh: string; en: string }): void {
    this.record(catId, {
      type: 'achievement_unlocked',
      catId,
      narrative: {
        zh: `解锁成就「${label.zh}」！`,
        en: `Achievement "${label.en}" unlocked!`,
      },
      details: { achievementId },
      timestamp: Date.now(),
    });
  }

  /** Record title unlock. */
  recordTitleUnlock(catId: string, titleId: string, label: { zh: string; en: string }): void {
    this.record(catId, {
      type: 'title_unlocked',
      catId,
      narrative: {
        zh: `获得称号「${label.zh}」！`,
        en: `Title "${label.en}" earned!`,
      },
      details: { titleId },
      timestamp: Date.now(),
    });
  }

  /** Read evolution events, newest first. */
  async getEvents(catId: string, limit = 50, offset = 0): Promise<EvolutionEvent[]> {
    const raw = await this.redis.zrevrange(evolutionEventKey(catId), offset, offset + limit - 1);
    return raw.map((s) => JSON.parse(s) as EvolutionEvent);
  }

  /** Fire-and-forget: write event + trim oldest. */
  private record(catId: string, event: EvolutionEvent): void {
    const member = JSON.stringify({ ...event, _seq: Math.random().toString(36).slice(2, 8) });
    this.redis
      .pipeline()
      .zadd(evolutionEventKey(catId), event.timestamp, member)
      .zremrangebyrank(evolutionEventKey(catId), 0, -(MAX_EVENTS_PER_CAT + 1))
      .exec()
      .catch((err: unknown) => {
        log.warn({ err, catId, type: event.type }, 'Failed to record evolution event');
      });
  }
}
