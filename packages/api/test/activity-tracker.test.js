import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { ActivityTracker } from '../dist/domains/health/ActivityTracker.js';

describe('ActivityTracker', () => {
  /** @type {ActivityTracker} */
  let tracker;
  const USER = 'user-1';
  const THRESHOLD = 90 * 60_000; // 90 minutes in ms

  beforeEach(async () => {
    tracker = new ActivityTracker();
    // Phase 6: default is enabled=false (AC2). Most legacy tests assumed enabled=true,
    // so we explicitly enable for the default test user to avoid false negatives.
    await tracker.updateSettings(USER, { enabled: true });
  });

  // Base timestamp (never 0 — lastActivityTs > 0 guard needs real timestamps)
  const T0 = 1_000_000;
  const TICK = 60_000; // 1min intervals (within 5min gap)

  /** Simulate continuous work for `minutes` by ticking every 1min from startMs */
  function simulateWork(userId, startMs, minutes) {
    for (let i = 0; i <= minutes; i++) {
      tracker.recordActivity(userId, startMs + i * TICK);
    }
  }

  describe('recordActivity', () => {
    it('initializes state for new user', () => {
      tracker.recordActivity(USER, T0);
      const s = tracker.getState(USER);
      assert.equal(s.lastActivityTs, T0);
      assert.equal(s.activeWorkMs, 0); // first ping = baseline, no elapsed
    });

    it('accumulates time within 5min gap', () => {
      tracker.recordActivity(USER, T0);
      tracker.recordActivity(USER, T0 + 60_000); // +1min
      tracker.recordActivity(USER, T0 + 180_000); // +2min more
      const s = tracker.getState(USER);
      assert.equal(s.activeWorkMs, 180_000); // 3 min total
    });

    it('resets gap if > 5min since last activity', () => {
      tracker.recordActivity(USER, T0);
      tracker.recordActivity(USER, T0 + 60_000); // +1min accumulated
      tracker.recordActivity(USER, T0 + 400_000); // +5:40 gap → no add
      const s = tracker.getState(USER);
      assert.equal(s.activeWorkMs, 60_000); // stayed at 1min
    });

    it('resumes accumulation after a gap', () => {
      tracker.recordActivity(USER, T0);
      tracker.recordActivity(USER, T0 + 60_000); // +1min
      tracker.recordActivity(USER, T0 + 400_000); // gap — no add
      tracker.recordActivity(USER, T0 + 430_000); // +30s within new window
      const s = tracker.getState(USER);
      assert.equal(s.activeWorkMs, 90_000); // 60s + 30s
    });
  });

  describe('shouldTrigger', () => {
    it('returns 0 when under threshold', () => {
      simulateWork(USER, T0, 89); // 89 min < 90 min threshold
      assert.equal(tracker.shouldTrigger(USER, THRESHOLD), 0);
    });

    it('returns 1 at threshold (90min)', () => {
      simulateWork(USER, T0, 90);
      assert.equal(tracker.shouldTrigger(USER, THRESHOLD), 1);
    });

    it('returns 2 at 2x threshold (180min)', () => {
      simulateWork(USER, T0, 180);
      assert.equal(tracker.shouldTrigger(USER, THRESHOLD), 2);
    });

    it('returns 3 at 3x threshold (270min)', () => {
      simulateWork(USER, T0, 270);
      assert.equal(tracker.shouldTrigger(USER, THRESHOLD), 3);
    });

    it('returns 0 when dismissed', () => {
      simulateWork(USER, T0, 180);
      tracker.handleCheckin(USER, 'rest', undefined, T0 + 180 * TICK);
      assert.equal(tracker.shouldTrigger(USER, THRESHOLD), 0);
    });
  });

  describe('handleCheckin', () => {
    it('rest resets timer and dismisses with short cooldown', () => {
      simulateWork(USER, T0, 90);
      tracker.handleCheckin(USER, 'rest', undefined, T0 + 90 * TICK);
      const s = tracker.getState(USER);
      assert.equal(s.activeWorkMs, 0);
      assert.equal(s.dismissed, true);
      assert.equal(s.dismissCooldownMs, 5 * 60_000);
      assert.equal(s.triggerLevel, 0);
    });

    it('wrap_up dismisses with 10min cooldown', () => {
      simulateWork(USER, T0, 90);
      tracker.handleCheckin(USER, 'wrap_up', undefined, T0 + 90 * TICK);
      const s = tracker.getState(USER);
      assert.equal(s.dismissed, true);
      assert.equal(s.dismissCooldownMs, 10 * 60_000);
    });

    it('continue records bypass with escalating cooldown', () => {
      simulateWork(USER, T0, 90);
      const r1 = tracker.handleCheckin(USER, 'continue', 'fixing bug', T0 + 90 * TICK);
      assert.equal(r1.nextCheckMinutes, 30);
      assert.equal(tracker.getState(USER).bypassCount, 1);

      tracker._setDismissed(USER, false);
      const r2 = tracker.handleCheckin(USER, 'continue', 'still fixing', T0 + 120 * TICK);
      assert.equal(r2.nextCheckMinutes, 45);
      assert.equal(tracker.getState(USER).bypassCount, 2);

      tracker._setDismissed(USER, false);
      const r3 = tracker.handleCheckin(USER, 'continue', 'almost done', T0 + 165 * TICK);
      assert.equal(r3.nextCheckMinutes, -1);
      assert.equal(tracker.getState(USER).bypassCount, 3);
    });
  });

  describe('auto-reset dismissed after cooldown', () => {
    it('dismissed resets after cooldown expires', () => {
      simulateWork(USER, T0, 90);
      const checkinTs = T0 + 90 * TICK;
      tracker.handleCheckin(USER, 'rest', undefined, checkinTs);
      assert.equal(tracker.getState(USER).dismissed, true);

      // Within 5min cooldown — still dismissed
      tracker.recordActivity(USER, checkinTs + 4 * 60_000);
      assert.equal(tracker.getState(USER).dismissed, true);

      // After cooldown — auto un-dismiss
      tracker.recordActivity(USER, checkinTs + 6 * 60_000);
      assert.equal(tracker.getState(USER).dismissed, false);
    });

    it('resets lastTriggeredLevel on cooldown expiry so same level can re-trigger', () => {
      simulateWork(USER, T0, 90);
      // Trigger L1 and mark
      const level = tracker.shouldTrigger(USER, THRESHOLD);
      assert.equal(level, 1);
      tracker.markTriggered(USER, 1);

      // wrap_up — 10min cooldown
      const checkinTs = T0 + 90 * TICK;
      tracker.handleCheckin(USER, 'wrap_up', undefined, checkinTs);

      // After 10min cooldown, continue working — same level should trigger again
      const afterCooldown = checkinTs + 11 * 60_000;
      tracker.recordActivity(USER, afterCooldown);
      assert.equal(tracker.shouldTrigger(USER, THRESHOLD), 1);
    });
  });

  describe('isNightMode', () => {
    it('returns true for 23:00-05:59 hours', () => {
      // We test the static method with injected hour
      assert.equal(ActivityTracker.isNightModeForHour(23), true);
      assert.equal(ActivityTracker.isNightModeForHour(0), true);
      assert.equal(ActivityTracker.isNightModeForHour(3), true);
      assert.equal(ActivityTracker.isNightModeForHour(5), true);
    });

    it('returns false for 06:00-22:59 hours', () => {
      assert.equal(ActivityTracker.isNightModeForHour(6), false);
      assert.equal(ActivityTracker.isNightModeForHour(12), false);
      assert.equal(ActivityTracker.isNightModeForHour(22), false);
    });
  });

  describe('bypass 4h window (AC13)', () => {
    it('resets bypass count after 4h window expires', () => {
      simulateWork(USER, T0, 90);
      const t1 = T0 + 90 * TICK;
      tracker.handleCheckin(USER, 'continue', 'urgent', t1);
      assert.equal(tracker.getState(USER).bypassCount, 1);

      // 4h later — bypass count should reset
      const t2 = t1 + 4 * 60 * 60_000 + 1;
      tracker._setDismissed(USER, false);
      simulateWork(USER, t2, 90);
      const r = tracker.handleCheckin(USER, 'continue', 'urgent again', t2 + 90 * TICK);
      // Should be treated as 1st bypass again (30min), not 2nd (45min)
      assert.equal(r.nextCheckMinutes, 30);
    });

    it('counts only bypasses within 4h window', () => {
      simulateWork(USER, T0, 90);
      const t1 = T0 + 90 * TICK;
      // 1st bypass
      tracker.handleCheckin(USER, 'continue', 'fix1', t1);
      // 2nd bypass 1h later (within 4h)
      const t2 = t1 + 60 * 60_000;
      tracker._setDismissed(USER, false);
      const r2 = tracker.handleCheckin(USER, 'continue', 'fix2', t2);
      assert.equal(r2.nextCheckMinutes, 45); // 2nd within window
    });
  });

  describe('bypassDisabled in response', () => {
    it('returns bypassDisabled: true on 3rd bypass', () => {
      simulateWork(USER, T0, 90);
      const t1 = T0 + 90 * TICK;
      tracker.handleCheckin(USER, 'continue', 'fix1', t1);
      tracker._setDismissed(USER, false);
      tracker.handleCheckin(USER, 'continue', 'fix2', t1 + 10 * TICK);
      tracker._setDismissed(USER, false);
      const r3 = tracker.handleCheckin(USER, 'continue', 'fix3', t1 + 20 * TICK);
      assert.equal(r3.nextCheckMinutes, -1);
      assert.equal(r3.bypassDisabled, true);
    });

    it('returns bypassDisabled: undefined on normal bypass', () => {
      simulateWork(USER, T0, 90);
      const r1 = tracker.handleCheckin(USER, 'continue', 'fix1', T0 + 90 * TICK);
      assert.equal(r1.bypassDisabled, undefined);
    });
  });

  describe('forced-nag after 3rd bypass resets dedup', () => {
    it('shouldTrigger returns level after 3rd bypass (nag mode)', () => {
      simulateWork(USER, T0, 90);
      const t1 = T0 + 90 * TICK;
      // Trigger and mark L1
      tracker.markTriggered(USER, 1);

      // 3 bypasses within 4h
      tracker.handleCheckin(USER, 'continue', 'fix1', t1);
      tracker._setDismissed(USER, false);
      tracker.handleCheckin(USER, 'continue', 'fix2', t1 + 10 * TICK);
      tracker._setDismissed(USER, false);
      tracker.handleCheckin(USER, 'continue', 'fix3', t1 + 20 * TICK);
      // After 3rd bypass: dismissed=false, should be able to re-trigger
      assert.equal(tracker.shouldTrigger(USER, THRESHOLD), 1);
    });
  });

  describe('trigger dedup', () => {
    it('shouldTrigger returns 0 if same level already triggered', () => {
      simulateWork(USER, T0, 90);
      const level1 = tracker.shouldTrigger(USER, THRESHOLD);
      assert.equal(level1, 1);

      // Mark as triggered
      tracker.markTriggered(USER, 1);

      // Same level should not re-trigger
      assert.equal(tracker.shouldTrigger(USER, THRESHOLD), 0);
    });

    it('shouldTrigger returns new level when escalated', () => {
      simulateWork(USER, T0, 90);
      tracker.markTriggered(USER, 1);

      // Work more to reach L2
      simulateWork(USER, T0 + 90 * TICK, 90);
      assert.equal(tracker.shouldTrigger(USER, THRESHOLD), 2);
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 6: default OFF + mode + Redis persistence (AC1–AC6)
  // ---------------------------------------------------------------------------

  describe('settings — Phase 6 defaults (AC2)', () => {
    it('returns default settings with enabled=false and mode=gentle for new user', () => {
      // Use a user that was NOT enabled in beforeEach
      const s = tracker.getSettings('community-newcomer');
      assert.deepEqual(s, { enabled: false, thresholdMinutes: 90, mode: 'gentle' });
    });

    it('shouldTrigger returns 0 for new user (default disabled)', () => {
      // Use a fresh user — default enabled=false means no brake triggers
      simulateWork('community-newcomer', T0, 120);
      assert.equal(tracker.shouldTrigger('community-newcomer'), 0);
    });
  });

  describe('settings — update + validation', () => {
    it('updates enabled flag', async () => {
      await tracker.updateSettings(USER, { enabled: true });
      assert.equal(tracker.getSettings(USER).enabled, true);
    });

    it('updates threshold', async () => {
      await tracker.updateSettings(USER, { thresholdMinutes: 60 });
      assert.equal(tracker.getSettings(USER).thresholdMinutes, 60);
    });

    it('updates mode to hardcore', async () => {
      await tracker.updateSettings(USER, { mode: 'hardcore' });
      assert.equal(tracker.getSettings(USER).mode, 'hardcore');
    });

    it('updates mode to gentle', async () => {
      await tracker.updateSettings(USER, { mode: 'hardcore' });
      await tracker.updateSettings(USER, { mode: 'gentle' });
      assert.equal(tracker.getSettings(USER).mode, 'gentle');
    });

    it('shouldTrigger returns 0 when disabled', async () => {
      // Explicitly enable then disable
      await tracker.updateSettings(USER, { enabled: true });
      await tracker.updateSettings(USER, { enabled: false });
      simulateWork(USER, T0, 120);
      assert.equal(tracker.shouldTrigger(USER), 0);
    });

    it('shouldTrigger uses custom threshold from settings', async () => {
      await tracker.updateSettings(USER, { enabled: true, thresholdMinutes: 60 });
      simulateWork(USER, T0, 60);
      assert.equal(tracker.shouldTrigger(USER), 1);
      // Would be 0 at default 90min threshold
    });

    it('rejects threshold below 30', async () => {
      const result = await tracker.updateSettings(USER, { thresholdMinutes: 10 });
      assert.equal('error' in result, true);
    });

    it('rejects threshold above 240', async () => {
      const result = await tracker.updateSettings(USER, { thresholdMinutes: 300 });
      assert.equal('error' in result, true);
    });

    it('rejects non-number threshold', async () => {
      const result = await tracker.updateSettings(USER, { thresholdMinutes: /** @type {any} */ ('abc') });
      assert.equal('error' in result, true);
    });

    it('rejects non-boolean enabled (P1: string "false" must not coerce to true)', async () => {
      const result = await tracker.updateSettings(USER, { enabled: /** @type {any} */ ('false') });
      assert.equal('error' in result, true);
      // Ensure settings unchanged (beforeEach set enabled=true)
      const settings = tracker.getSettings(USER);
      assert.equal(settings.enabled, true);
    });

    it('rejects invalid mode value', async () => {
      const result = await tracker.updateSettings(USER, { mode: /** @type {any} */ ('turbo') });
      assert.equal('error' in result, true);
      assert.equal(tracker.getSettings(USER).mode, 'gentle');
    });
  });

  describe('settings — Redis persistence (AC1, TD110)', () => {
    /** Create a mock Redis that stores hash fields properly */
    function createHashMockRedis() {
      /** @type {Map<string, Map<string, string>>} */
      const hashes = new Map();
      return {
        hashes,
        client: {
          async hgetall(key) {
            const hash = hashes.get(key);
            if (!hash) return {};
            return Object.fromEntries(hash.entries());
          },
          async hset(key, field, value) {
            let hash = hashes.get(key);
            if (!hash) {
              hash = new Map();
              hashes.set(key, hash);
            }
            hash.set(field, value);
            return 1;
          },
        },
      };
    }

    it('updateSettings persists to Redis', async () => {
      const { hashes, client } = createHashMockRedis();
      const t = new ActivityTracker({ redis: client });

      await t.updateSettings('alice', { enabled: true, mode: 'hardcore', thresholdMinutes: 60 });

      const hash = hashes.get('brake:settings');
      assert.ok(hash, 'Redis hash should exist');
      const raw = hash.get('alice');
      assert.ok(raw, 'Alice settings should be persisted');
      const parsed = JSON.parse(raw);
      assert.equal(parsed.enabled, true);
      assert.equal(parsed.mode, 'hardcore');
      assert.equal(parsed.thresholdMinutes, 60);
    });

    it('init() loads persisted settings from Redis', async () => {
      const { client } = createHashMockRedis();
      // Pre-populate Redis with settings
      await client.hset(
        'brake:settings',
        'bob',
        JSON.stringify({
          enabled: true,
          thresholdMinutes: 120,
          mode: 'hardcore',
        }),
      );

      const t = new ActivityTracker({ redis: client });
      await t.init();

      const s = t.getSettings('bob');
      assert.equal(s.enabled, true);
      assert.equal(s.thresholdMinutes, 120);
      assert.equal(s.mode, 'hardcore');
    });

    it('init() merges defaults for schema evolution (old settings without mode)', async () => {
      const { client } = createHashMockRedis();
      // Simulate old-format settings without 'mode' field
      await client.hset(
        'brake:settings',
        'legacy',
        JSON.stringify({
          enabled: true,
          thresholdMinutes: 90,
        }),
      );

      const t = new ActivityTracker({ redis: client });
      await t.init();

      const s = t.getSettings('legacy');
      assert.equal(s.enabled, true);
      assert.equal(s.mode, 'gentle'); // Default mode applied
    });

    it('init() survives corrupt Redis entries', async () => {
      const { client } = createHashMockRedis();
      await client.hset('brake:settings', 'corrupt', 'not-json!!!');
      await client.hset(
        'brake:settings',
        'good',
        JSON.stringify({
          enabled: true,
          thresholdMinutes: 45,
          mode: 'gentle',
        }),
      );

      const t = new ActivityTracker({ redis: client });
      await t.init(); // Should not throw

      assert.deepEqual(t.getSettings('corrupt'), { enabled: false, thresholdMinutes: 90, mode: 'gentle' }); // Falls back to default
      assert.equal(t.getSettings('good').enabled, true);
    });

    it('works without Redis (pure in-memory)', async () => {
      const t = new ActivityTracker();
      await t.init(); // No-op

      await t.updateSettings(USER, { enabled: true, mode: 'hardcore' });
      assert.equal(t.getSettings(USER).enabled, true);
      assert.equal(t.getSettings(USER).mode, 'hardcore');
    });

    it('settings survive across init() calls (simulating restart)', async () => {
      const { client } = createHashMockRedis();

      // Session 1: save settings
      const t1 = new ActivityTracker({ redis: client });
      await t1.init();
      await t1.updateSettings('default-user', { enabled: true, mode: 'hardcore', thresholdMinutes: 90 });

      // Session 2: new tracker with same Redis — settings should load
      const t2 = new ActivityTracker({ redis: client });
      await t2.init();

      const s = t2.getSettings('default-user');
      assert.equal(s.enabled, true);
      assert.equal(s.mode, 'hardcore');
      assert.equal(s.thresholdMinutes, 90);
    });

    it('updateSettings rejects when Redis write fails (no false success, TD110)', async () => {
      const { client } = createHashMockRedis();
      const failing = {
        hgetall: client.hgetall,
        async hset() {
          throw new Error('Redis unavailable');
        },
      };
      const t = new ActivityTracker({ redis: failing });

      const result = await t.updateSettings('alice', { enabled: true });

      assert.ok('error' in result, 'must fail the request instead of reporting success');
      assert.equal(result.code, 'PERSIST_FAILED');
      // In-memory must NOT be mutated — otherwise getSettings would lie about the
      // durable state until restart
      assert.equal(t.getSettings('alice').enabled, false);
    });

    it('failed disable does not survive restart as stale enabled (RED→GREEN, TD110)', async () => {
      // Reproduces the reported bug: enabled=true persisted → disable returns
      // success despite failed write → restart reloads enabled=true.
      const { client } = createHashMockRedis();
      let writesFail = false;
      const flaky = {
        hgetall: client.hgetall,
        async hset(key, field, value) {
          if (writesFail) throw new Error('Redis unavailable');
          return client.hset(key, field, value);
        },
      };

      // Session 1: enable persists fine
      const t1 = new ActivityTracker({ redis: flaky });
      await t1.init();
      await t1.updateSettings('default-user', { enabled: true, mode: 'hardcore' });

      // Redis goes down; disable attempt must be rejected, not fake-succeed
      writesFail = true;
      const r = await t1.updateSettings('default-user', { enabled: false });
      assert.ok('error' in r, 'disable must fail when the write cannot persist');
      assert.equal(t1.getSettings('default-user').enabled, true, 'in-memory must keep last durable value');

      // Session 2 (restart): still enabled=true — and now that is the HONEST state,
      // because the disable was rejected instead of silently dropped
      const t2 = new ActivityTracker({ redis: flaky });
      await t2.init();
      assert.equal(t2.getSettings('default-user').enabled, true);
      assert.equal(t2.getSettings('default-user').mode, 'hardcore');
    });
  });

  describe('AC3: default-user hardcore behavior unchanged', () => {
    it('default-user with hardcore mode preserves typed check-in + bypass escalation', async () => {
      // Simulate co-creator setup: enabled=true, mode=hardcore
      await tracker.updateSettings('default-user', { enabled: true, mode: 'hardcore' });

      simulateWork('default-user', T0, 90);
      assert.equal(tracker.shouldTrigger('default-user', THRESHOLD), 1);

      // Typed check-in behavior unchanged
      const r1 = tracker.handleCheckin('default-user', 'continue', 'fixing P0', T0 + 90 * TICK);
      assert.equal(r1.nextCheckMinutes, 30);
      assert.equal(r1.ok, true);
    });
  });

  describe('isolation between users', () => {
    it('tracks users independently', async () => {
      // Phase 6: must enable brake first (default is OFF)
      await tracker.updateSettings('user-a', { enabled: true });
      await tracker.updateSettings('user-b', { enabled: true });

      simulateWork('user-a', T0, 90);
      simulateWork('user-b', T0, 1); // only 1 min

      assert.equal(tracker.shouldTrigger('user-a', THRESHOLD), 1);
      assert.equal(tracker.shouldTrigger('user-b', THRESHOLD), 0);
    });
  });
});
