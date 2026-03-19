import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeCvoLevel } from '../../dist/domains/leaderboard/achievement-defs.js';
import { AchievementStore } from '../../dist/domains/leaderboard/achievement-store.js';

describe('AchievementStore', () => {
  it('unlocks an achievement and returns it', () => {
    const store = new AchievementStore();
    const ach = store.unlock('user1', 'cvo-first-review');
    assert.ok(ach);
    assert.equal(ach.id, 'cvo-first-review');
    assert.equal(ach.icon, 'search');
    assert.equal(ach.emoji, undefined);
    assert.equal(ach.category, 'cvo');
    assert.ok(ach.unlockedAt);
  });

  it('returns undefined for unknown achievement id', () => {
    const store = new AchievementStore();
    const ach = store.unlock('user1', 'nonexistent');
    assert.equal(ach, undefined);
  });

  it('duplicate unlock is idempotent', () => {
    const store = new AchievementStore();
    const first = store.unlock('user1', 'daily-night-owl');
    const second = store.unlock('user1', 'daily-night-owl');
    assert.ok(first);
    assert.ok(second);
    assert.equal(first.unlockedAt, second.unlockedAt);
    assert.equal(store.getUnlocked('user1').length, 1);
  });

  it('getUnlocked returns all unlocked for a user', () => {
    const store = new AchievementStore();
    store.unlock('user1', 'cvo-first-review');
    store.unlock('user1', 'daily-streak-7');
    store.unlock('user2', 'cvo-first-merge');
    assert.equal(store.getUnlocked('user1').length, 2);
    assert.equal(store.getUnlocked('user2').length, 1);
    assert.equal(store.getUnlocked('user3').length, 0);
  });

  it('getCvoLevel starts at level 1', () => {
    const store = new AchievementStore();
    const lvl = store.getCvoLevel('user1');
    assert.equal(lvl.level, 1);
    assert.equal(lvl.title, '实习猫猫');
    assert.ok(lvl.nextTitle);
    assert.ok(lvl.needed);
  });

  it('getCvoLevel advances with CVO achievements', () => {
    const store = new AchievementStore();
    store.unlock('user1', 'cvo-first-review');
    store.unlock('user1', 'cvo-5-reviews');
    // 2 CVO achievements → level 2
    const lvl = store.getCvoLevel('user1');
    assert.equal(lvl.level, 2);
    assert.equal(lvl.title, '正式员工');
  });

  it('getCvoLevel ignores daily achievements', () => {
    const store = new AchievementStore();
    store.unlock('user1', 'daily-night-owl');
    store.unlock('user1', 'daily-streak-7');
    store.unlock('user1', 'daily-chatty');
    // Only daily achievements → still level 1
    const lvl = store.getCvoLevel('user1');
    assert.equal(lvl.level, 1);
  });
});

describe('computeCvoLevel', () => {
  it('level 1 at 0 CVO achievements', () => {
    const lvl = computeCvoLevel(0);
    assert.equal(lvl.level, 1);
    assert.equal(lvl.progress, 0); // 0/2
  });

  it('level 5 at max CVO achievements', () => {
    const lvl = computeCvoLevel(7);
    assert.equal(lvl.level, 5);
    assert.equal(lvl.title, '首席铲码官');
    assert.equal(lvl.progress, 1);
    assert.equal(lvl.nextTitle, undefined);
  });

  it('progress is fraction toward next level', () => {
    const lvl = computeCvoLevel(3); // level 2 (threshold 2), next level 3 (threshold 4)
    assert.equal(lvl.level, 2);
    assert.equal(lvl.progress, 3 / 4);
    assert.equal(lvl.needed, 1);
  });
});
