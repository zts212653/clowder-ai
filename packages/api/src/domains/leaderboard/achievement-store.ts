/**
 * F075 Phase C — In-memory achievement store
 * Tracks unlocked achievements per user and computes operator level.
 */
import type { Achievement, CvoLevel } from '@cat-cafe/shared';
import { ALL_ACHIEVEMENTS, computeCvoLevel } from './achievement-defs.js';

export class AchievementStore {
  /** userId → achievementId → unlock time; display definitions stay live. */
  private unlocked = new Map<string, Map<string, number>>();

  unlock(userId: string, achievementId: string): Achievement | undefined {
    const def = ALL_ACHIEVEMENTS.get(achievementId);
    if (!def) return undefined;

    let userMap = this.unlocked.get(userId);
    if (!userMap) {
      userMap = new Map();
      this.unlocked.set(userId, userMap);
    }

    const unlockedAt = userMap.get(achievementId) ?? Date.now();
    userMap.set(achievementId, unlockedAt);
    return { ...def, unlockedAt };
  }

  getUnlocked(userId: string): Achievement[] {
    const userMap = this.unlocked.get(userId);
    if (!userMap) return [];
    return [...userMap].flatMap(([id, unlockedAt]) => {
      const def = ALL_ACHIEVEMENTS.get(id);
      return def ? [{ ...def, unlockedAt }] : [];
    });
  }

  getCvoLevel(userId: string): CvoLevel {
    const cvoCount = this.getUnlocked(userId).filter((achievement) => achievement.category === 'cvo').length;
    return computeCvoLevel(cvoCount);
  }
}
