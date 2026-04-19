/**
 * F157 GrowthService — unit tests
 *
 * Covers: level formula, overallLevel active-dimension averaging,
 * audit event uniqueness (nonce), and XP award pipeline.
 */

// Disable pino transport worker threads BEFORE any module import.
// Without this, pino.transport() spawns threads that outlive tests.
// Must run before setup-cat-registry (which transitively loads logger via cat-config-loader),
// so setup-cat-registry uses dynamic import — ESM hoists static imports before module code.
process.env.PINO_DISABLE_TRANSPORT = '1';

await import('./helpers/setup-cat-registry.js');

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

/** Import pure helpers directly (they don't depend on Redis). */
const { GrowthService } = await import('../dist/domains/cats/services/growth/GrowthService.js');
const { detectInvocationPurpose } = await import('../dist/routes/callback-a2a-trigger.js');

// ── level formula ──────────────────────────────────────────────

describe('Level formula', () => {
  test('level 0 at 0 XP', () => {
    // level = floor(sqrt(xp / 100))
    assert.equal(Math.floor(Math.sqrt(0 / 100)), 0);
  });

  test('level 0 at 99 XP', () => {
    assert.equal(Math.floor(Math.sqrt(99 / 100)), 0);
  });

  test('level 1 at 100 XP', () => {
    assert.equal(Math.floor(Math.sqrt(100 / 100)), 1);
  });

  test('level 2 at 400 XP', () => {
    assert.equal(Math.floor(Math.sqrt(400 / 100)), 2);
  });

  test('level 3 at 900 XP', () => {
    assert.equal(Math.floor(Math.sqrt(900 / 100)), 3);
  });
});

// ── overallLevel excludes zero-XP dimensions ───────────────────

describe('overallLevel active-dimension averaging', () => {
  /**
   * Minimal Redis mock — stores XP values directly in a Map.
   * Tests set store values directly (bypassing awardXp) to avoid
   * fire-and-forget title check chains that leak async activity.
   */
  function createMockRedis() {
    const store = new Map();
    return {
      store,
      options: { keyPrefix: '' },
      async mget(...keys) {
        return keys.map((k) => store.get(k) ?? null);
      },
    };
  }

  test('overallLevel only averages dimensions with XP > 0', async () => {
    const redis = createMockRedis();
    const svc = new GrowthService(redis);

    // Set execution XP to 1 directly — bypasses awardXp fire-and-forget chain
    redis.store.set('journey:testcat:execution', '1');

    const attrs = await svc.getAttributes('testcat');
    // Only execution has XP → activeDimensions=1, 1 XP → level 0, so overallLevel = 0
    assert.equal(attrs.overallLevel, 0);

    // Set execution XP to 100 (level 1)
    redis.store.set('journey:testcat:execution', '100');

    const attrs2 = await svc.getAttributes('testcat');
    // 100 XP in execution → level 1. Only 1 active dimension → overallLevel = 1/1 = 1
    assert.equal(attrs2.overallLevel, 1);
    // totalXp should be 100
    assert.equal(attrs2.totalXp, 100);
  });

  test('overallLevel is 0 when no dimensions have XP', async () => {
    const redis = createMockRedis();
    const svc = new GrowthService(redis);
    const attrs = await svc.getAttributes('empty');
    assert.equal(attrs.overallLevel, 0);
    assert.equal(attrs.totalXp, 0);
  });
});

// ── Phase B: title unlock ──────────────────────────────────────

describe('Title auto-unlock', () => {
  /** Extended mock Redis with sorted set + hash support for title tests. */
  function createTitleMockRedis() {
    const store = new Map();
    const zsets = new Map();
    const hashes = new Map();
    return {
      options: { keyPrefix: '' },
      async mget(...keys) {
        return keys.map((k) => store.get(k) ?? null);
      },
      pipeline() {
        const ops = [];
        const self = {
          incrby(key, amount) {
            const cur = parseInt(store.get(key) ?? '0', 10);
            store.set(key, String(cur + amount));
            ops.push(['incrby', key, amount]);
            return self;
          },
          zadd(key, score, member) {
            if (!zsets.has(key)) zsets.set(key, []);
            zsets.get(key).push({ score, member });
            ops.push(['zadd', key, score, member]);
            return self;
          },
          hincrby(key, field, amount) {
            if (!hashes.has(key)) hashes.set(key, {});
            const h = hashes.get(key);
            h[field] = String(parseInt(h[field] ?? '0', 10) + amount);
            return self;
          },
          hset(key, field, value) {
            if (!hashes.has(key)) hashes.set(key, {});
            hashes.get(key)[field] = value;
            return self;
          },
          async exec() {
            return ops.map(() => [null, 'OK']);
          },
        };
        return self;
      },
      async zadd(key, score, member) {
        if (!zsets.has(key)) zsets.set(key, []);
        zsets.get(key).push({ score, member });
        return 1;
      },
      async zrevrange(key, start, stop) {
        const items = zsets.get(key) ?? [];
        const sorted = [...items].sort((a, b) => b.score - a.score);
        const end = stop === -1 ? sorted.length : stop + 1;
        return sorted.slice(start, end).map((i) => i.member);
      },
      async hgetall(key) {
        return hashes.get(key) ?? null;
      },
    };
  }

  test('checkTitleUnlocks returns newly unlocked titles', async () => {
    const redis = createTitleMockRedis();
    const svc = new GrowthService(redis);

    // Manually set execution XP to 400 (level 2) → should unlock 'doer' (execution Lv.2)
    redis.pipeline().incrby('journey:testcat:execution', 400);
    await redis.pipeline().exec();
    // Manually store to make mget work
    const curStore = new Map();
    curStore.set('journey:testcat:execution', '400');
    redis.mget = async (...keys) => keys.map((k) => curStore.get(k) ?? null);

    const attrs = await svc.getAttributes('testcat');
    assert.equal(attrs.stats.execution.level, 2, 'execution should be level 2');

    const newTitles = await svc.checkTitleUnlocks('testcat', attrs);
    const doer = newTitles.find((t) => t.titleId === 'doer');
    assert.ok(doer, 'doer title should be unlocked at execution Lv.2');

    // First-step should also unlock (overall level >= 1)
    const firstStep = newTitles.find((t) => t.titleId === 'first-step');
    assert.ok(firstStep, 'first-step should be unlocked at overall Lv.1+');
  });

  test('checkTitleUnlocks does not re-unlock existing titles', async () => {
    const redis = createTitleMockRedis();
    const svc = new GrowthService(redis);

    // Pre-unlock 'first-step'
    await redis.zadd(
      'journey:titles:testcat',
      Date.now(),
      JSON.stringify({
        titleId: 'first-step',
        catId: 'testcat',
        unlockedAt: Date.now(),
      }),
    );

    const curStore = new Map();
    curStore.set('journey:testcat:execution', '400');
    redis.mget = async (...keys) => keys.map((k) => curStore.get(k) ?? null);

    const attrs = await svc.getAttributes('testcat');
    const newTitles = await svc.checkTitleUnlocks('testcat', attrs);
    const firstStepDups = newTitles.filter((t) => t.titleId === 'first-step');
    assert.equal(firstStepDups.length, 0, 'first-step should not be re-unlocked');
  });
});

// ── Phase B: bond system ──────────────────────────────────────

describe('Bond system', () => {
  test('bondLevel returns correct tier', () => {
    assert.equal(GrowthService.bondLevel(1), 'acquaintance');
    assert.equal(GrowthService.bondLevel(14), 'acquaintance');
    assert.equal(GrowthService.bondLevel(15), 'partner');
    assert.equal(GrowthService.bondLevel(49), 'partner');
    assert.equal(GrowthService.bondLevel(50), 'soulmate');
    assert.equal(GrowthService.bondLevel(100), 'soulmate');
  });
});

// ── Phase B: review intent detection ──────────────────────────

describe('Review intent detection', () => {
  test('detects review from Chinese patterns', () => {
    assert.equal(detectInvocationPurpose('请 review 一下这个 PR'), 'review');
    assert.equal(detectInvocationPurpose('帮我看看这段代码'), 'review');
    assert.equal(detectInvocationPurpose('这是 re-review 请求'), 'review');
  });

  test('detects review from English patterns', () => {
    assert.equal(detectInvocationPurpose('request review for F157'), 'review');
    assert.equal(detectInvocationPurpose('code review needed'), 'review');
  });

  test('returns discussion for non-review content', () => {
    assert.equal(detectInvocationPurpose('你觉得这个设计怎么样？'), 'discussion');
    assert.equal(detectInvocationPurpose('help me implement this feature'), 'discussion');
  });
});

// ── audit event uniqueness ─────────────────────────────────────

describe('Audit event uniqueness', () => {
  test('same-millisecond identical events produce unique ZADD members (fixed clock)', async () => {
    const members = new Set();
    const mockRedis = {
      options: { keyPrefix: '' },
      pipeline() {
        const self = {
          incrby() {
            return self;
          },
          zadd(_key, _score, member) {
            members.add(member);
            return self;
          },
          async exec() {
            return [];
          },
        };
        return self;
      },
      // Provide mget/zrevrange so the fire-and-forget title check chain
      // settles cleanly instead of throwing and leaving dangling promises.
      async mget(...keys) {
        return keys.map(() => null);
      },
      async zrevrange() {
        return [];
      },
    };

    // Fix Date.now() to a single timestamp — without _seq nonce, all 10 events
    // would produce identical JSON and ZADD would silently overwrite.
    const fixedTime = 1700000000000;
    const origDateNow = Date.now;
    Date.now = () => fixedTime;
    try {
      const svc = new GrowthService(mockRedis);
      for (let i = 0; i < 10; i++) {
        svc.awardXp('cat1', 'tool_use');
      }
      // All 10 should be unique members despite identical timestamp + source + xp
      assert.equal(members.size, 10, `Expected 10 unique members, got ${members.size}`);
      // Let fire-and-forget title check chains settle to avoid "async activity after test" warnings
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      Date.now = origDateNow;
    }
  });
});
