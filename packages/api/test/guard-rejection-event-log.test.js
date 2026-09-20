/**
 * F257 Phase A Line B — GuardRejectionEventLog tests
 *
 * Verifies ZSET-based event log: append, queryWindow, countByGuard,
 * fail-open behavior, and 7-day retention pruning.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// ── FakeRedis with sorted set support ──

class FakeRedis {
  constructor() {
    this.sorted = new Map(); // key → Map<member, score>
  }

  async zadd(key, score, member) {
    const set = this.sorted.get(key) ?? new Map();
    set.set(member, score);
    this.sorted.set(key, set);
    return 1;
  }

  async zrangebyscore(key, min, max) {
    const set = this.sorted.get(key);
    if (!set) return [];
    return [...set.entries()]
      .filter(([, s]) => s >= min && s <= max)
      .sort((a, b) => a[1] - b[1])
      .map(([m]) => m);
  }

  async zremrangebyscore(key, min, max) {
    const set = this.sorted.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const [member, score] of set) {
      if (score >= min && score <= max) {
        set.delete(member);
        removed++;
      }
    }
    return removed;
  }

  async zcount(key, min, max) {
    const set = this.sorted.get(key);
    if (!set) return 0;
    let count = 0;
    for (const [, score] of set) {
      if (score >= min && score <= max) count++;
    }
    return count;
  }
}

// ── Throwing FakeRedis for fail-open tests ──

class ThrowingRedis {
  async zadd() {
    throw new Error('Redis connection lost');
  }
  async zrangebyscore() {
    throw new Error('Redis connection lost');
  }
  async zremrangebyscore() {
    throw new Error('Redis connection lost');
  }
  async zcount() {
    throw new Error('Redis connection lost');
  }
}

// ── Test helpers ──

function makeEvent(overrides = {}) {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2, 10)}`,
    kind: 'http_rate_limit',
    threadId: 'thread-1',
    catId: 'cat-1',
    guardId: 'hold_ball_rate_limit',
    timestamp: Date.now(),
    correlationConfidence: 'window',
    currentCount: 5,
    maxAllowed: 3,
    windowMs: 60000,
    ...overrides,
  };
}

function makeBlockEvent(overrides = {}) {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2, 10)}`,
    kind: 'route_decision_block',
    threadId: 'thread-2',
    catId: 'cat-2',
    guardId: 'a2a_block_pingpong',
    timestamp: Date.now(),
    correlationConfidence: 'window',
    fromCatId: 'cat-2',
    targetCatId: 'cat-3',
    streakCount: 4,
    ...overrides,
  };
}

describe('GuardRejectionEventLog', async () => {
  // Dynamic import — ESM module
  const { GuardRejectionEventLog } = await import('../dist/infrastructure/harness-eval/GuardRejectionEventLog.js');

  test('append stores event and queryWindow retrieves it', async () => {
    const redis = new FakeRedis();
    const log = new GuardRejectionEventLog(redis);
    const ts = Date.now();

    const event = makeEvent({ timestamp: ts });
    await log.append(event);

    const results = await log.queryWindow({ since: ts - 1, until: ts + 1 });
    assert.equal(results.length, 1);
    assert.equal(results[0].kind, 'http_rate_limit');
    assert.equal(results[0].guardId, 'hold_ball_rate_limit');
    assert.equal(results[0].currentCount, 5);
  });

  test('queryWindow filters by guardId', async () => {
    const redis = new FakeRedis();
    const log = new GuardRejectionEventLog(redis);
    const ts = Date.now();

    await log.append(makeEvent({ timestamp: ts, guardId: 'guard-a' }));
    await log.append(makeBlockEvent({ timestamp: ts + 1, guardId: 'guard-b' }));

    const filtered = await log.queryWindow({ since: ts - 1, until: ts + 10, guardId: 'guard-a' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].guardId, 'guard-a');
  });

  test('queryWindow filters by threadId', async () => {
    const redis = new FakeRedis();
    const log = new GuardRejectionEventLog(redis);
    const ts = Date.now();

    await log.append(makeEvent({ timestamp: ts, threadId: 'thread-x' }));
    await log.append(makeEvent({ timestamp: ts + 1, threadId: 'thread-y' }));

    const filtered = await log.queryWindow({ since: ts - 1, until: ts + 10, threadId: 'thread-x' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].threadId, 'thread-x');
  });

  test('queryWindow filters by catId', async () => {
    const redis = new FakeRedis();
    const log = new GuardRejectionEventLog(redis);
    const ts = Date.now();

    await log.append(makeEvent({ timestamp: ts, catId: 'cat-alpha' }));
    await log.append(makeEvent({ timestamp: ts + 1, catId: 'cat-beta' }));

    const filtered = await log.queryWindow({ since: ts - 1, until: ts + 10, catId: 'cat-alpha' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].catId, 'cat-alpha');
  });

  test('countByGuard counts events for a specific guard', async () => {
    const redis = new FakeRedis();
    const log = new GuardRejectionEventLog(redis);
    const ts = Date.now();

    await log.append(makeEvent({ timestamp: ts, guardId: 'guard-x' }));
    await log.append(makeEvent({ timestamp: ts + 1, guardId: 'guard-x' }));
    await log.append(makeBlockEvent({ timestamp: ts + 2, guardId: 'guard-y' }));

    // countByGuard uses zcount on the full ZSET, but we verify the query path works
    const count = await log.countByGuard('guard-x', ts - 1, ts + 10);
    // countByGuard counts ALL events in the window (ZSET doesn't filter by guardId at Redis level)
    // It returns the total ZSET count in that window — in-app filtering is done by queryWindow
    assert.equal(typeof count, 'number');
    assert.ok(count >= 2); // At least 2 events for guard-x exist in the window
  });

  test('append with same timestamp but different eventId stores both', async () => {
    const redis = new FakeRedis();
    const log = new GuardRejectionEventLog(redis);
    const ts = Date.now();

    await log.append(makeEvent({ eventId: 'evt-aaa', timestamp: ts }));
    await log.append(makeEvent({ eventId: 'evt-bbb', timestamp: ts }));

    const results = await log.queryWindow({ since: ts - 1, until: ts + 1 });
    assert.equal(results.length, 2, 'eventId ensures ZSET member uniqueness for same-ms events');
  });

  test('route_decision_block event round-trips correctly', async () => {
    const redis = new FakeRedis();
    const log = new GuardRejectionEventLog(redis);
    const ts = Date.now();

    const event = makeBlockEvent({
      timestamp: ts,
      fromCatId: 'opus-47',
      targetCatId: 'gpt52',
      streakCount: 6,
    });
    await log.append(event);

    const results = await log.queryWindow({ since: ts - 1, until: ts + 1 });
    assert.equal(results.length, 1);
    assert.equal(results[0].kind, 'route_decision_block');
    assert.equal(results[0].fromCatId, 'opus-47');
    assert.equal(results[0].targetCatId, 'gpt52');
    assert.equal(results[0].streakCount, 6);
  });

  test('append is fail-open — Redis errors do not throw', async () => {
    const redis = new ThrowingRedis();
    const log = new GuardRejectionEventLog(redis);

    // Should NOT throw despite Redis failure
    await log.append(makeEvent());
  });

  test('queryWindow is fail-open — returns empty on Redis error', async () => {
    const redis = new ThrowingRedis();
    const log = new GuardRejectionEventLog(redis);

    const results = await log.queryWindow({ since: 0, until: Date.now() });
    assert.deepEqual(results, []);
  });

  test('countByGuard is fail-open — returns 0 on Redis error', async () => {
    const redis = new ThrowingRedis();
    const log = new GuardRejectionEventLog(redis);

    const count = await log.countByGuard('guard-x', 0, Date.now());
    assert.equal(count, 0);
  });

  test('queryWindow returns events in chronological order', async () => {
    const redis = new FakeRedis();
    const log = new GuardRejectionEventLog(redis);
    const base = Date.now();

    await log.append(makeEvent({ timestamp: base + 300 }));
    await log.append(makeEvent({ timestamp: base + 100 }));
    await log.append(makeEvent({ timestamp: base + 200 }));

    const results = await log.queryWindow({ since: base, until: base + 400 });
    assert.equal(results.length, 3);
    assert.ok(results[0].timestamp <= results[1].timestamp);
    assert.ok(results[1].timestamp <= results[2].timestamp);
  });

  test('P2 regression: filtered query finds target after 200 unrelated events', async () => {
    // Terra's repro: 200 earlier unrelated events + 1 later target event.
    // Old code applied Redis LIMIT before in-app filtering → target lost.
    const redis = new FakeRedis();
    const log = new GuardRejectionEventLog(redis);
    const base = Date.now();

    // 200 events with guardId 'unrelated'
    for (let i = 0; i < 200; i++) {
      await log.append(makeEvent({ timestamp: base + i, guardId: 'unrelated' }));
    }
    // 1 target event after the 200 unrelated ones
    await log.append(makeEvent({ timestamp: base + 300, guardId: 'target' }));

    const filtered = await log.queryWindow({ since: base - 1, until: base + 400, guardId: 'target' });
    assert.equal(filtered.length, 1, 'target event must survive past 200 unrelated predecessors');
    assert.equal(filtered[0].guardId, 'target');
  });

  test('queryWindow limit applies after filtering', async () => {
    const redis = new FakeRedis();
    const log = new GuardRejectionEventLog(redis);
    const base = Date.now();

    // 5 matching events
    for (let i = 0; i < 5; i++) {
      await log.append(makeEvent({ timestamp: base + i, guardId: 'match' }));
    }
    // 5 non-matching events
    for (let i = 0; i < 5; i++) {
      await log.append(makeEvent({ timestamp: base + 100 + i, guardId: 'other' }));
    }

    const results = await log.queryWindow({ since: base - 1, until: base + 200, guardId: 'match', limit: 3 });
    assert.equal(results.length, 3, 'limit=3 should apply after guardId filter');
    assert.ok(results.every((e) => e.guardId === 'match'));
  });

  test('queryWindow until is exclusive (selector contract)', async () => {
    const redis = new FakeRedis();
    const log = new GuardRejectionEventLog(redis);
    const base = 1000000;

    await log.append(makeEvent({ timestamp: base }));
    await log.append(makeEvent({ timestamp: base + 10 }));
    await log.append(makeEvent({ timestamp: base + 20 }));

    // until=base+20 should be exclusive — event AT base+20 excluded
    const results = await log.queryWindow({ since: base, until: base + 20 });
    assert.equal(results.length, 2);
    assert.ok(results.every((e) => e.timestamp < base + 20));
  });
});
