/**
 * F075 Phase C — In-memory achievement store
 * Tracks unlocked achievements per user and computes operator level.
 */
import type { Achievement, CvoLevel } from '@cat-cafe/shared';
import { ALL_ACHIEVEMENTS, computeCvoLevel } from './achievement-defs.js';

export class AchievementStore {
  /** userId → Set of achievementIds */
  private unlocked = new Map<string, Map<string, Achievement>>();

  unlock(userId: string, achievementId: string): Achievement | undefined {
    const def = ALL_ACHIEVEMENTS.get(achievementId);
    if (!def) return undefined;

    let userMap = this.unlocked.get(userId);
    if (!userMap) {
      userMap = new Map();
      this.unlocked.set(userId, userMap);
    }

    // Idempotent — return existing if already unlocked
    const existing = userMap.get(achievementId);
    if (existing) return existing;

    const achievement: Achievement = { ...def, unlockedAt: Date.now() };
    userMap.set(achievementId, achievement);
    return achievement;
  }

  getUnlocked(userId: string): Achievement[] {
    const userMap = this.unlocked.get(userId);
    if (!userMap) return [];
    return [...userMap.values()];
  }

  getCvoLevel(userId: string): CvoLevel {
    const userMap = this.unlocked.get(userId);
    const cvoCount = userMap ? [...userMap.values()].filter((a) => a.category === 'cvo').length : 0;
    return computeCvoLevel(cvoCount);
  }
}
