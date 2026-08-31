import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import {
  checkGuardThreshold,
  createThresholdEscalationHook,
  ESCALATION_THRESHOLD,
  ESCALATION_WINDOW_DAYS,
} from '../../dist/infrastructure/harness-eval/guard-threshold-escalation.js';
import { createFakeEventSource, createFakeRedis, T, triggerSuccess } from './_guard-test-helpers.js';

// ---------------------------------------------------------------------------
// Helpers (test-specific — canonical fake Redis is in _guard-test-helpers.js)
// ---------------------------------------------------------------------------

/**
 * Create N SEPARATED events (10 min apart — far beyond EPISODE_GAP_MS 60s,
 * so each event forms its own episode). All share the same guardId.
 */
function createEvents(count, guardId = 'hold_ball_rate_limit', ownerUserId = 'user_1') {
  return Array.from({ length: count }, (_, i) => ({
    eventId: `evt-${guardId}-${i}`,
    kind: 'http_rate_limit',
    threadId: 'thread_1',
    catId: 'cat_1',
    guardId,
    ownerUserId,
    timestamp: T + i * 600_000,
    correlationConfidence: 'window',
    currentCount: 5,
    maxAllowed: 5,
    windowMs: 3600000,
  }));
}

function makeEvent(guardId = 'hold_ball_rate_limit', timestamp = T + 5_000_000, ownerUserId = 'user_1') {
  return {
    eventId: `evt-${timestamp}`,
    kind: 'http_rate_limit',
    threadId: 'thread_1',
    catId: 'cat_1',
    guardId,
    ownerUserId,
    timestamp,
    correlationConfidence: 'window',
    currentCount: 5,
    maxAllowed: 5,
    windowMs: 3600000,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('F257 sub-item 2: guard threshold escalation', () => {
  it('exports correct threshold constants', () => {
    assert.equal(ESCALATION_THRESHOLD, 3, 'threshold should be 3 events');
    assert.equal(ESCALATION_WINDOW_DAYS, 7, 'window should be 7 days');
  });

  it('does NOT escalate when count < threshold', async () => {
    const events = createEvents(2);
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => ({ ok: true }));

    const result = await checkGuardThreshold(makeEvent(), { redis, guardRejectionLog, triggerEval });

    assert.equal(result.checked, true);
    assert.equal(result.thresholdMet, false);
    assert.equal(result.escalated, false);
    assert.equal(triggerEval.mock.callCount(), 0, 'should NOT trigger eval');
  });

  it('escalates when count >= threshold (first time)', async () => {
    const guardId = 'guard-x';
    const events = createEvents(3, guardId);
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(makeEvent(guardId), { redis, guardRejectionLog, triggerEval });

    assert.equal(result.checked, true);
    assert.equal(result.thresholdMet, true);
    assert.equal(result.alreadyEscalated, false);
    assert.equal(result.escalated, true);
    assert.equal(result.episodeCount, 3);

    // triggerEval called with eval:harness-ledger and real ownerUserId (sol R9 P1-1)
    assert.equal(triggerEval.mock.callCount(), 1);
    const triggerInput = triggerEval.mock.calls[0].arguments[0];
    assert.equal(triggerInput.domainId, 'eval:harness-ledger');
    assert.equal(triggerInput.userId, 'user_1', 'userId must be real ownerUserId, not synthetic');
  });

  it('does NOT re-escalate same guard (dedup key exists)', async () => {
    const guardId = 'guard-y';
    const events = createEvents(5, guardId);
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => triggerSuccess());

    // First call: escalates
    const event = makeEvent(guardId);
    const first = await checkGuardThreshold(event, { redis, guardRejectionLog, triggerEval });
    assert.equal(first.escalated, true);

    // Second call: dedup key exists → should NOT re-escalate
    const second = await checkGuardThreshold(event, { redis, guardRejectionLog, triggerEval });
    assert.equal(second.thresholdMet, true);
    assert.equal(second.alreadyEscalated, true);
    assert.equal(second.escalated, false);

    // triggerEval called only ONCE (first time)
    assert.equal(triggerEval.mock.callCount(), 1, 'should only trigger once per dedup window');
  });

  it('dedup key is set in Redis with correct prefix', async () => {
    const guardId = 'guard-z';
    const events = createEvents(3, guardId);
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => triggerSuccess());

    await checkGuardThreshold(makeEvent(guardId), { redis, guardRejectionLog, triggerEval });

    // Check Redis store for dedup key (includes ownerUserId — sol R9 P1-1)
    const dedupKey = 'guard-rejection:escalated:user_1:guard-z';
    const stored = redis._store.get(dedupKey);
    assert.ok(stored, 'dedup key should exist in Redis');
    const parsed = JSON.parse(stored);
    assert.ok(parsed.count >= 0, 'count must be present');
    assert.ok(parsed.escalatedAt, 'should record escalation timestamp');
    assert.ok(parsed.triggeredBy, 'should record triggering event ID');
  });

  it('different guards escalate independently', async () => {
    // Seed events for BOTH guards into the same Redis
    const eventsA = createEvents(4, 'guard-a');
    const eventsB = createEvents(4, 'guard-b');
    const { redis, guardRejectionLog } = await createFakeEventSource([...eventsA, ...eventsB]);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const r1 = await checkGuardThreshold(makeEvent('guard-a'), { redis, guardRejectionLog, triggerEval });
    const r2 = await checkGuardThreshold(makeEvent('guard-b'), { redis, guardRejectionLog, triggerEval });

    assert.equal(r1.escalated, true, 'guard-a should escalate');
    assert.equal(r2.escalated, true, 'guard-b should escalate independently');
    assert.equal(triggerEval.mock.callCount(), 2, 'both guards should trigger eval');
  });

  it('pagewise counter queries correct window and filters by guardId', async () => {
    const guardId = 'guard-q';
    const events = createEvents(1, guardId);
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => ({}));
    const now = T + 5_000_000;

    // Spy on zrangebyscore to verify query parameters
    const zrangebyscoreCalls = [];
    const originalZrange = redis.zrangebyscore.bind(redis);
    redis.zrangebyscore = async (...args) => {
      zrangebyscoreCalls.push(args);
      return originalZrange(...args);
    };

    await checkGuardThreshold(makeEvent(guardId, now), { redis, guardRejectionLog, triggerEval });

    assert.ok(zrangebyscoreCalls.length >= 1, 'should call zrangebyscore');
    const [, min, max] = zrangebyscoreCalls[0];
    const expectedWindowMs = ESCALATION_WINDOW_DAYS * 24 * 3600 * 1000;
    assert.equal(min, now - expectedWindowMs, 'min should be event.timestamp - 7 days');
    assert.equal(max, now, 'max should be event.timestamp (half-open via until-1)');
  });

  it('concurrent threshold checks only trigger once (atomic SET NX)', async () => {
    const guardId = 'guard-race';
    const events = createEvents(4, guardId);
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const event = makeEvent(guardId);
    // Simulate two concurrent checks — both see threshold met,
    // but only one wins the atomic SET NX claim.
    const [r1, r2] = await Promise.all([
      checkGuardThreshold(event, { redis, guardRejectionLog, triggerEval }),
      checkGuardThreshold(event, { redis, guardRejectionLog, triggerEval }),
    ]);

    const escalated = [r1, r2].filter((r) => r.escalated);
    const deduped = [r1, r2].filter((r) => r.alreadyEscalated);
    assert.equal(escalated.length, 1, 'exactly one should win the claim');
    assert.equal(deduped.length, 1, 'exactly one should be deduped');
    assert.equal(triggerEval.mock.callCount(), 1, 'triggerEval called exactly once');
  });

  it('atomic claim sets TTL via SET EX (no separate expire call)', async () => {
    const guardId = 'guard-ttl';
    const events = createEvents(3, guardId);
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    // Track the set call args to verify EX and NX are passed
    const setCalls = [];
    const originalSet = redis.set.bind(redis);
    redis.set = async (key, value, ...args) => {
      setCalls.push({ key, args });
      return originalSet(key, value, ...args);
    };
    const triggerEval = mock.fn(async () => triggerSuccess());

    await checkGuardThreshold(makeEvent(guardId), { redis, guardRejectionLog, triggerEval });

    const dedupSet = setCalls.find((c) => c.key.startsWith('guard-rejection:escalated:'));
    assert.ok(dedupSet, 'should SET dedup key');
    assert.ok(dedupSet.args.includes('EX'), 'should include EX for TTL');
    assert.ok(dedupSet.args.includes('NX'), 'should include NX for atomic claim');
    assert.ok(dedupSet.args.includes(604800), 'TTL should be 7 days in seconds');
  });

  it('releases claim when triggerEval returns 503 invokeTrigger not ready', async () => {
    const guardId = 'guard-503';
    const events = createEvents(3, guardId);
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const callCount = { n: 0 };
    const triggerEval = mock.fn(async () => {
      callCount.n++;
      if (callCount.n === 1) {
        return { status: 503, error: 'invokeTrigger not ready' };
      }
      return triggerSuccess();
    });

    // First threshold check: claim + trigger 503 → claim released
    const first = await checkGuardThreshold(makeEvent(guardId), { redis, guardRejectionLog, triggerEval });
    assert.equal(first.thresholdMet, true);
    assert.equal(first.escalated, false, 'should NOT report escalated on 503');
    assert.equal(first.claimReleased, true, 'claim should be released');
    assert.equal(redis._store.has('guard-rejection:escalated:user_1:guard-503'), false, 'dedup key should be deleted');

    // Second threshold check: claim succeeds (key was released) → trigger dispatched
    const second = await checkGuardThreshold(makeEvent(guardId), { redis, guardRejectionLog, triggerEval });
    assert.equal(second.escalated, true, 'should escalate on retry');
    assert.equal(second.claimReleased, undefined, 'no claim release on success');
    assert.equal(triggerEval.mock.callCount(), 2, 'triggerEval called twice (503 + success)');
  });

  it('releases claim when triggerEval returns queue full', async () => {
    const guardId = 'guard-full';
    const events = createEvents(5, guardId);
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => ({
      status: 503,
      error: 'invocation_queue_full',
      detail: 'queue at capacity',
    }));

    const result = await checkGuardThreshold(makeEvent(guardId), { redis, guardRejectionLog, triggerEval });
    assert.equal(result.thresholdMet, true);
    assert.equal(result.escalated, false, 'should NOT report escalated on queue full');
    assert.equal(result.claimReleased, true);
    assert.equal(redis._store.has('guard-rejection:escalated:user_1:guard-full'), false, 'claim released');
  });

  it('releases claim when triggerEval returns TriggerNowSkipped (zero events)', async () => {
    const guardId = 'guard-skip';
    const events = createEvents(3, guardId);
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => ({
      ok: true,
      domainId: 'eval:harness-ledger',
      skipped: true,
      reason: 'zero_events_in_window',
      evalRunId: 'hlr-123-abcd1234',
      windowSummary: '168h window, 0 events',
    }));

    const result = await checkGuardThreshold(makeEvent(guardId), { redis, guardRejectionLog, triggerEval });
    assert.equal(result.escalated, false, 'skipped is not escalated');
    assert.equal(result.claimReleased, true, 'claim released on skip');
  });

  it('keeps claim when triggerEval returns dispatched success', async () => {
    const guardId = 'guard-ok';
    const events = createEvents(3, guardId);
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(makeEvent(guardId), { redis, guardRejectionLog, triggerEval });
    assert.equal(result.escalated, true);
    assert.equal(result.claimReleased, undefined, 'claim should NOT be released on success');
    assert.ok(redis._store.has('guard-rejection:escalated:user_1:guard-ok'), 'dedup key retained');
  });

  // ---- Round 4 regression: triggerEval reject + DEL reject paths ----

  it('releases claim when triggerEval rejects (throw) → next event retries successfully', async () => {
    const guardId = 'guard-throw';
    const events = createEvents(3, guardId);
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const callCount = { n: 0 };
    const triggerEval = mock.fn(async () => {
      callCount.n++;
      if (callCount.n === 1) {
        throw new Error('messageStore.append ECONNRESET');
      }
      return triggerSuccess();
    });

    // First call: triggerEval throws → catch releases claim via DEL
    const first = await checkGuardThreshold(makeEvent(guardId), { redis, guardRejectionLog, triggerEval });
    assert.equal(first.thresholdMet, true);
    assert.equal(first.escalated, false, 'reject path must NOT report escalated');
    assert.equal(first.claimReleased, true, 'claim released after triggerEval reject');
    assert.equal(first.triggerResult, undefined, 'no triggerResult on reject path');
    assert.equal(
      redis._store.has('guard-rejection:escalated:guard-throw'),
      false,
      'dedup key deleted — next event can retry',
    );

    // Second call: fresh claim succeeds → eval cat invoked
    const second = await checkGuardThreshold(makeEvent(guardId), { redis, guardRejectionLog, triggerEval });
    assert.equal(second.escalated, true, 'retry succeeds after claim release');
    assert.equal(triggerEval.mock.callCount(), 2, 'triggerEval called twice (reject + success)');
  });

  it('reports claimReleased=false when redis.del rejects (7d TTL backstop)', async () => {
    const guardId = 'guard-del-fail';
    const events = createEvents(3, guardId);
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    // triggerEval returns 503 (resolved, not throw) to enter non-dispatch path
    const triggerEval = mock.fn(async () => ({
      status: 503,
      error: 'invokeTrigger not ready',
    }));

    // Sabotage redis.del to reject
    redis.del = async () => {
      throw new Error("READONLY You can't write against a read only replica");
    };

    // Capture console.warn
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args);

    try {
      const result = await checkGuardThreshold(makeEvent(guardId), { redis, guardRejectionLog, triggerEval });

      assert.equal(result.thresholdMet, true);
      assert.equal(result.escalated, false);
      assert.equal(result.claimReleased, false, 'must NOT report true when DEL failed');

      // Key survives — 7d TTL backstop is active
      assert.ok(
        redis._store.has('guard-rejection:escalated:user_1:guard-del-fail'),
        'dedup key still exists (TTL backstop)',
      );

      // console.warn was called with F257 prefix
      assert.ok(warnings.length >= 1, 'console.warn should fire on DEL failure');
      assert.ok(warnings[0][0].includes('[F257]'), 'warning should include [F257] prefix');
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('createThresholdEscalationHook', () => {
  it('returns a synchronous function (fire-and-forget pattern)', async () => {
    const { redis, guardRejectionLog } = await createFakeEventSource();
    const hook = createThresholdEscalationHook({
      redis,
      guardRejectionLog,
      triggerEval: async () => ({ status: 503, error: 'test' }),
    });

    assert.equal(typeof hook, 'function');
    // Calling it should not throw (fire-and-forget)
    assert.doesNotThrow(() => hook(makeEvent()));
  });
});

// ---------------------------------------------------------------------------
// Bootstrap integration test: real GuardRejectionEventLog + hook wiring
// ---------------------------------------------------------------------------

describe('F257 bootstrap integration: append → threshold escalation', async () => {
  const { GuardRejectionEventLog } = await import('../../dist/infrastructure/harness-eval/GuardRejectionEventLog.js');

  /**
   * Combined FakeRedis that supports both ZSET ops (for GuardRejectionEventLog)
   * and key-value ops with SET NX EX (for threshold escalation dedup).
   */
  function createFullFakeRedis() {
    const store = new Map();
    const sorted = new Map();
    return {
      // Key-value (dedup)
      get: async (key) => store.get(key) ?? null,
      set: async (key, value, ...args) => {
        const hasNX = args.includes('NX');
        if (hasNX && store.has(key)) return null;
        store.set(key, value);
        return 'OK';
      },
      del: async (key) => {
        const existed = store.has(key);
        store.delete(key);
        return existed ? 1 : 0;
      },
      expire: async () => 1,
      // Sorted set (event log)
      zadd: async (key, score, member) => {
        const s = sorted.get(key) ?? new Map();
        s.set(member, score);
        sorted.set(key, s);
        return 1;
      },
      zrangebyscore: async (key, min, max, ...args) => {
        const s = sorted.get(key);
        if (!s) return [];
        let offset = 0;
        let count = s.size;
        for (let i = 0; i < args.length; i++) {
          if (String(args[i]).toUpperCase() === 'LIMIT') {
            offset = Number(args[i + 1]);
            count = Number(args[i + 2]);
            break;
          }
        }
        return [...s.entries()]
          .filter(([, sc]) => sc >= min && sc <= max)
          .sort((a, b) => a[1] - b[1])
          .slice(offset, offset + count)
          .map(([m]) => m);
      },
      zremrangebyscore: async (key, min, max) => {
        const s = sorted.get(key);
        if (!s) return 0;
        let removed = 0;
        for (const [member, score] of s) {
          if (score >= min && score <= max) {
            s.delete(member);
            removed++;
          }
        }
        return removed;
      },
      _store: store,
    };
  }

  it('real append fires hook → triggerEval called at threshold', async () => {
    const redis = createFullFakeRedis();
    const log = new GuardRejectionEventLog(redis);
    const triggerEval = mock.fn(async () => triggerSuccess());

    // Wire hook — mirrors index.ts bootstrap pattern
    const hook = createThresholdEscalationHook({ redis, guardRejectionLog: log, triggerEval });
    log.setPostAppendHook(hook);

    const now = T;

    // PR #41 episode accounting: appends are separated by >60s gaps so each
    // forms a distinct episode (a 1ms-apart burst would coalesce into ONE
    // episode and correctly NOT trigger — covered in the coalescing suite).
    // Append 2 separated events (below threshold) — no trigger
    await log.append(makeEvent('guard-boot', now));
    await log.append(makeEvent('guard-boot', now + 100_000));
    // Give fire-and-forget hooks time to settle
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(triggerEval.mock.callCount(), 0, 'below threshold: no trigger');

    // Append 3rd separated event (reaches 3 episodes) — triggers
    await log.append(makeEvent('guard-boot', now + 200_000));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(triggerEval.mock.callCount(), 1, 'at threshold: trigger fires');

    // Verify trigger input — userId is real ownerUserId (sol R9 P1-1)
    const input = triggerEval.mock.calls[0].arguments[0];
    assert.equal(input.domainId, 'eval:harness-ledger');
    assert.equal(input.userId, 'user_1', 'trigger userId must be real ownerUserId');
  });

  it('real append: trigger receives real ownerUserId, not synthetic', async () => {
    const redis = createFullFakeRedis();
    const log = new GuardRejectionEventLog(redis);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const hook = createThresholdEscalationHook({ redis, guardRejectionLog: log, triggerEval });
    log.setPostAppendHook(hook);

    const now = T;
    // 3 separated events from owner-real-owner
    for (let i = 0; i < 3; i++) {
      await log.append(makeEvent('guard-owner-test', now + i * 100_000, 'real-owner-id'));
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(triggerEval.mock.callCount(), 1);
    const input = triggerEval.mock.calls[0].arguments[0];
    assert.equal(input.userId, 'real-owner-id', 'must receive real ownerUserId');
  });

  it('real append: 4th event does NOT re-trigger (dedup)', async () => {
    const redis = createFullFakeRedis();
    const log = new GuardRejectionEventLog(redis);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const hook = createThresholdEscalationHook({ redis, guardRejectionLog: log, triggerEval });
    log.setPostAppendHook(hook);

    const now = T;
    // Append 4 SEPARATED events (>60s gaps → 4 distinct episodes) —
    // 3rd triggers, 4th deduped by the escalation claim (PR #41 accounting).
    for (let i = 0; i < 4; i++) {
      await log.append(makeEvent('guard-dedup', now + i * 100_000));
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(triggerEval.mock.callCount(), 1, 'dedup: only one trigger despite 4 events');
  });
});

// ---------------------------------------------------------------------------
// sol R9 P1-1: Multi-owner isolation — red-green regression suite
// ---------------------------------------------------------------------------

describe('F257 owner-scope isolation (sol R9 P1-1)', () => {
  it('A=2 B=1 episodes: neither owner triggers (below threshold individually)', async () => {
    // Owner A: 2 episodes, Owner B: 1 episode → total=3 but per-owner <3
    const eventsA = createEvents(2, 'guard-x', 'owner-a');
    const eventsB = createEvents(1, 'guard-x', 'owner-b');
    const { redis, guardRejectionLog } = await createFakeEventSource([...eventsA, ...eventsB]);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const resultA = await checkGuardThreshold(makeEvent('guard-x', T + 5_000_000, 'owner-a'), {
      redis,
      guardRejectionLog,
      triggerEval,
    });
    const resultB = await checkGuardThreshold(makeEvent('guard-x', T + 5_000_000, 'owner-b'), {
      redis,
      guardRejectionLog,
      triggerEval,
    });

    assert.equal(resultA.thresholdMet, false, 'owner-a with 2 episodes must NOT trigger');
    assert.equal(resultB.thresholdMet, false, 'owner-b with 1 episode must NOT trigger');
    assert.equal(triggerEval.mock.callCount(), 0, 'zero triggers when neither owner meets threshold');
  });

  it('A=3 B=3 episodes: both trigger independently, claims isolated', async () => {
    const eventsA = createEvents(3, 'guard-x', 'owner-a');
    const eventsB = createEvents(3, 'guard-x', 'owner-b');
    const { redis, guardRejectionLog } = await createFakeEventSource([...eventsA, ...eventsB]);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const resultA = await checkGuardThreshold(makeEvent('guard-x', T + 5_000_000, 'owner-a'), {
      redis,
      guardRejectionLog,
      triggerEval,
    });
    const resultB = await checkGuardThreshold(makeEvent('guard-x', T + 5_000_000, 'owner-b'), {
      redis,
      guardRejectionLog,
      triggerEval,
    });

    assert.equal(resultA.escalated, true, 'owner-a should escalate independently');
    assert.equal(resultB.escalated, true, 'owner-b should escalate independently');
    assert.equal(triggerEval.mock.callCount(), 2, 'both owners trigger eval');

    // Claims are independent — A's claim doesn't suppress B
    assert.ok(redis._store.has('guard-rejection:escalated:owner-a:guard-x'), 'owner-a claim exists');
    assert.ok(redis._store.has('guard-rejection:escalated:owner-b:guard-x'), 'owner-b claim exists');
  });

  it('trigger receives each owner real ownerUserId, not synthetic', async () => {
    const eventsA = createEvents(3, 'guard-y', 'owner-alpha');
    const eventsB = createEvents(3, 'guard-y', 'owner-beta');
    const { redis, guardRejectionLog } = await createFakeEventSource([...eventsA, ...eventsB]);
    const triggerEval = mock.fn(async () => triggerSuccess());

    await checkGuardThreshold(makeEvent('guard-y', T + 5_000_000, 'owner-alpha'), {
      redis,
      guardRejectionLog,
      triggerEval,
    });
    await checkGuardThreshold(makeEvent('guard-y', T + 5_000_000, 'owner-beta'), {
      redis,
      guardRejectionLog,
      triggerEval,
    });

    assert.equal(triggerEval.mock.callCount(), 2);
    assert.equal(triggerEval.mock.calls[0].arguments[0].userId, 'owner-alpha');
    assert.equal(triggerEval.mock.calls[1].arguments[0].userId, 'owner-beta');
  });

  it('A escalated does NOT suppress B for 7 days (independent dedup keys)', async () => {
    const eventsA = createEvents(4, 'guard-z', 'owner-a');
    const eventsB = createEvents(4, 'guard-z', 'owner-b');
    const { redis, guardRejectionLog } = await createFakeEventSource([...eventsA, ...eventsB]);
    const triggerEval = mock.fn(async () => triggerSuccess());

    // A escalates first
    const resultA = await checkGuardThreshold(makeEvent('guard-z', T + 5_000_000, 'owner-a'), {
      redis,
      guardRejectionLog,
      triggerEval,
    });
    assert.equal(resultA.escalated, true);

    // A's 2nd check should be deduped
    const resultA2 = await checkGuardThreshold(makeEvent('guard-z', T + 6_000_000, 'owner-a'), {
      redis,
      guardRejectionLog,
      triggerEval,
    });
    assert.equal(resultA2.alreadyEscalated, true, 'A deduped');

    // B should still escalate despite A's claim existing
    const resultB = await checkGuardThreshold(makeEvent('guard-z', T + 5_000_000, 'owner-b'), {
      redis,
      guardRejectionLog,
      triggerEval,
    });
    assert.equal(resultB.escalated, true, 'B must escalate independently of A');
    assert.equal(triggerEval.mock.callCount(), 2, 'exactly 2 triggers: A + B');
  });

  it('countEpisodesPagewise receives ownerUserId from event (sol R10 P2-1 spy)', async () => {
    // Spy on iterateWindow to verify the ownerUserId is passed through.
    const events = createEvents(3, 'guard-spy', 'spy-owner');
    const { redis, guardRejectionLog } = await createFakeEventSource(events);

    const iterateCalls = [];
    const originalIterateWindow = guardRejectionLog.iterateWindow.bind(guardRejectionLog);
    guardRejectionLog.iterateWindow = async function* (opts, stats) {
      iterateCalls.push(opts);
      yield* originalIterateWindow(opts, stats);
    };

    const triggerEval = mock.fn(async () => triggerSuccess());
    await checkGuardThreshold(makeEvent('guard-spy', T + 5_000_000, 'spy-owner'), {
      redis,
      guardRejectionLog,
      triggerEval,
    });

    assert.ok(iterateCalls.length >= 1, 'iterateWindow must be called');
    assert.equal(
      iterateCalls[0].ownerUserId,
      'spy-owner',
      'ownerUserId must be forwarded to iterateWindow (sol R10 P2-1)',
    );
  });
});
