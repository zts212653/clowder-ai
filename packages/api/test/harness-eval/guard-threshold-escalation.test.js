import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import {
  checkGuardThreshold,
  createThresholdEscalationHook,
  ESCALATION_THRESHOLD,
  ESCALATION_WINDOW_DAYS,
} from '../../dist/infrastructure/harness-eval/guard-threshold-escalation.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fake Redis that stores data in a Map.
 * Supports atomic SET NX EX (P1-B: codebase prior art in RedisProposalStore).
 */
function createFakeRedis() {
  const store = new Map();
  return {
    get: async (key) => store.get(key) ?? null,
    /**
     * Supports: set(key, value) and set(key, value, 'EX', ttl, 'NX').
     * NX = set-if-not-exists → returns 'OK' on claim, null if key exists.
     */
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
    _store: store,
  };
}

/**
 * Fake GuardRejectionEventLog exposing N SEPARATED events (10 min apart —
 * far beyond EPISODE_GAP_MS 60s, so each event is its own episode).
 *
 * PR #41 episode accounting: the threshold counts episodes, not raw events.
 * Pre-episode tests asserted on raw counts; separated events keep
 * rawEventCount == episodeCount, preserving those assertions' semantics.
 * Burst-specific behavior is covered in guard-episode-coalescing.test.js.
 */
function createFakeLog(eventCount) {
  const events = Array.from({ length: eventCount }, (_, i) => ({
    eventId: `evt-fake-${i}`,
    kind: 'http_rate_limit',
    threadId: 'thread_1',
    catId: 'cat_1',
    guardId: 'fake-guard',
    timestamp: 1700000000000 + i * 600_000,
    correlationConfidence: 'window',
    currentCount: 5,
    maxAllowed: 5,
    windowMs: 3600000,
  }));
  return {
    countByGuard: mock.fn(async () => events.length),
    queryWindow: mock.fn(async () => events),
    queryWindowStrict: mock.fn(async () => events),
    queryWindowComplete: mock.fn(async () => ({ events, truncated: false })),
    queryWindowStrictComplete: mock.fn(async () => ({ events, truncated: false })),
    append: async () => {},
  };
}

function makeEvent(guardId = 'hold_ball_rate_limit', timestamp = Date.now()) {
  return {
    eventId: `evt-${timestamp}`,
    kind: 'http_rate_limit',
    threadId: 'thread_1',
    catId: 'cat_1',
    guardId,
    timestamp,
    correlationConfidence: 'window',
    currentCount: 5,
    maxAllowed: 5,
    windowMs: 3600000,
  };
}

/** TriggerNowSuccess mock — claim is kept only for this shape. */
function triggerSuccess(domainId = 'eval:harness-ledger') {
  return {
    ok: true,
    domainId,
    threadId: 't1',
    messageId: 'm1',
    evalCatId: 'c1',
    invocationTriggered: true,
    triggerOutcome: 'dispatched',
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
    const redis = createFakeRedis();
    const log = createFakeLog(2); // below threshold of 3
    const triggerEval = mock.fn(async () => ({ ok: true }));

    const result = await checkGuardThreshold(makeEvent(), { redis, guardRejectionLog: log, triggerEval });

    assert.equal(result.checked, true);
    assert.equal(result.thresholdMet, false);
    assert.equal(result.escalated, false);
    assert.equal(triggerEval.mock.callCount(), 0, 'should NOT trigger eval');
  });

  it('escalates when count >= threshold (first time)', async () => {
    const redis = createFakeRedis();
    const log = createFakeLog(3); // exactly at threshold
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(makeEvent('guard-x'), { redis, guardRejectionLog: log, triggerEval });

    assert.equal(result.checked, true);
    assert.equal(result.thresholdMet, true);
    assert.equal(result.alreadyEscalated, false);
    assert.equal(result.escalated, true);
    assert.equal(result.count, 3);

    // triggerEval called with eval:harness-ledger
    assert.equal(triggerEval.mock.callCount(), 1);
    const triggerInput = triggerEval.mock.calls[0].arguments[0];
    assert.equal(triggerInput.domainId, 'eval:harness-ledger');
    assert.ok(triggerInput.userId.includes('guard-x'), 'userId should contain guardId');
  });

  it('does NOT re-escalate same guard (dedup key exists)', async () => {
    const redis = createFakeRedis();
    const log = createFakeLog(5); // above threshold
    const triggerEval = mock.fn(async () => triggerSuccess());

    // First call: escalates
    const event = makeEvent('guard-y');
    const first = await checkGuardThreshold(event, { redis, guardRejectionLog: log, triggerEval });
    assert.equal(first.escalated, true);

    // Second call: dedup key exists → should NOT re-escalate
    const second = await checkGuardThreshold(event, { redis, guardRejectionLog: log, triggerEval });
    assert.equal(second.thresholdMet, true);
    assert.equal(second.alreadyEscalated, true);
    assert.equal(second.escalated, false);

    // triggerEval called only ONCE (first time)
    assert.equal(triggerEval.mock.callCount(), 1, 'should only trigger once per dedup window');
  });

  it('dedup key is set in Redis with correct prefix', async () => {
    const redis = createFakeRedis();
    const log = createFakeLog(3);
    const triggerEval = mock.fn(async () => triggerSuccess());

    await checkGuardThreshold(makeEvent('guard-z'), { redis, guardRejectionLog: log, triggerEval });

    // Check Redis store for dedup key
    const dedupKey = 'guard-rejection:escalated:guard-z';
    const stored = redis._store.get(dedupKey);
    assert.ok(stored, 'dedup key should exist in Redis');
    const parsed = JSON.parse(stored);
    assert.equal(parsed.count, 3);
    assert.ok(parsed.escalatedAt, 'should record escalation timestamp');
    assert.ok(parsed.triggeredBy, 'should record triggering event ID');
  });

  it('different guards escalate independently', async () => {
    const redis = createFakeRedis();
    const log = createFakeLog(4);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const r1 = await checkGuardThreshold(makeEvent('guard-a'), { redis, guardRejectionLog: log, triggerEval });
    const r2 = await checkGuardThreshold(makeEvent('guard-b'), { redis, guardRejectionLog: log, triggerEval });

    assert.equal(r1.escalated, true, 'guard-a should escalate');
    assert.equal(r2.escalated, true, 'guard-b should escalate independently');
    assert.equal(triggerEval.mock.callCount(), 2, 'both guards should trigger eval');
  });

  it('queryWindow receives correct window parameters (episode accounting reads full events)', async () => {
    const redis = createFakeRedis();
    const log = createFakeLog(1); // below threshold
    const triggerEval = mock.fn(async () => ({}));
    const now = 1700000000000;

    await checkGuardThreshold(makeEvent('guard-q', now), { redis, guardRejectionLog: log, triggerEval });

    // Episode coalescing needs full events, so the check queries the window
    // via the completeness-preserving variant (sol P2-1: no silent limit slice).
    assert.equal(log.queryWindowComplete.mock.callCount(), 1);
    const [opts] = log.queryWindowComplete.mock.calls[0].arguments;
    assert.equal(opts.guardId, 'guard-q');
    const expectedWindowMs = ESCALATION_WINDOW_DAYS * 24 * 3600 * 1000;
    assert.equal(opts.since, now - expectedWindowMs, 'since should be event.timestamp - 7 days');
    assert.equal(opts.until, now + 1, 'until should be event.timestamp + 1 (half-open interval includes self)');
    assert.equal(opts.limit, undefined, 'complete query has no limit — completeness-preserving');
  });

  it('concurrent threshold checks only trigger once (atomic SET NX)', async () => {
    const redis = createFakeRedis();
    const log = createFakeLog(4); // above threshold
    const triggerEval = mock.fn(async () => triggerSuccess());

    const event = makeEvent('guard-race');
    // Simulate two concurrent checks — both see threshold met,
    // but only one wins the atomic SET NX claim.
    const [r1, r2] = await Promise.all([
      checkGuardThreshold(event, { redis, guardRejectionLog: log, triggerEval }),
      checkGuardThreshold(event, { redis, guardRejectionLog: log, triggerEval }),
    ]);

    const escalated = [r1, r2].filter((r) => r.escalated);
    const deduped = [r1, r2].filter((r) => r.alreadyEscalated);
    assert.equal(escalated.length, 1, 'exactly one should win the claim');
    assert.equal(deduped.length, 1, 'exactly one should be deduped');
    assert.equal(triggerEval.mock.callCount(), 1, 'triggerEval called exactly once');
  });

  it('atomic claim sets TTL via SET EX (no separate expire call)', async () => {
    const redis = createFakeRedis();
    const log = createFakeLog(3);
    // Track the set call args to verify EX and NX are passed
    const setCalls = [];
    const originalSet = redis.set.bind(redis);
    redis.set = async (key, value, ...args) => {
      setCalls.push({ key, args });
      return originalSet(key, value, ...args);
    };
    const triggerEval = mock.fn(async () => triggerSuccess());

    await checkGuardThreshold(makeEvent('guard-ttl'), { redis, guardRejectionLog: log, triggerEval });

    const dedupSet = setCalls.find((c) => c.key.startsWith('guard-rejection:escalated:'));
    assert.ok(dedupSet, 'should SET dedup key');
    assert.ok(dedupSet.args.includes('EX'), 'should include EX for TTL');
    assert.ok(dedupSet.args.includes('NX'), 'should include NX for atomic claim');
    assert.ok(dedupSet.args.includes(604800), 'TTL should be 7 days in seconds');
  });

  it('releases claim when triggerEval returns 503 invokeTrigger not ready', async () => {
    const redis = createFakeRedis();
    const log = createFakeLog(3);
    const callCount = { n: 0 };
    // First call: simulate early-boot 503 (resolved, not thrown).
    // Second call: simulate ready trigger (dispatched).
    const triggerEval = mock.fn(async () => {
      callCount.n++;
      if (callCount.n === 1) {
        return { status: 503, error: 'invokeTrigger not ready' };
      }
      return {
        ok: true,
        domainId: 'eval:harness-ledger',
        threadId: 't1',
        messageId: 'm1',
        evalCatId: 'c1',
        invocationTriggered: true,
        triggerOutcome: 'dispatched',
      };
    });

    // First threshold check: claim + trigger 503 → claim released
    const first = await checkGuardThreshold(makeEvent('guard-503'), { redis, guardRejectionLog: log, triggerEval });
    assert.equal(first.thresholdMet, true);
    assert.equal(first.escalated, false, 'should NOT report escalated on 503');
    assert.equal(first.claimReleased, true, 'claim should be released');
    assert.equal(redis._store.has('guard-rejection:escalated:guard-503'), false, 'dedup key should be deleted');

    // Second threshold check: claim succeeds (key was released) → trigger dispatched
    const second = await checkGuardThreshold(makeEvent('guard-503'), { redis, guardRejectionLog: log, triggerEval });
    assert.equal(second.escalated, true, 'should escalate on retry');
    assert.equal(second.claimReleased, undefined, 'no claim release on success');
    assert.equal(triggerEval.mock.callCount(), 2, 'triggerEval called twice (503 + success)');
  });

  it('releases claim when triggerEval returns queue full', async () => {
    const redis = createFakeRedis();
    const log = createFakeLog(5);
    const triggerEval = mock.fn(async () => ({
      status: 503,
      error: 'invocation_queue_full',
      detail: 'queue at capacity',
    }));

    const result = await checkGuardThreshold(makeEvent('guard-full'), { redis, guardRejectionLog: log, triggerEval });
    assert.equal(result.thresholdMet, true);
    assert.equal(result.escalated, false, 'should NOT report escalated on queue full');
    assert.equal(result.claimReleased, true);
    assert.equal(redis._store.has('guard-rejection:escalated:guard-full'), false, 'claim released');
  });

  it('releases claim when triggerEval returns TriggerNowSkipped (zero events)', async () => {
    const redis = createFakeRedis();
    const log = createFakeLog(3);
    const triggerEval = mock.fn(async () => ({
      ok: true,
      domainId: 'eval:harness-ledger',
      skipped: true,
      reason: 'zero_events_in_window',
      evalRunId: 'hlr-123-abcd1234',
      windowSummary: '168h window, 0 events',
    }));

    const result = await checkGuardThreshold(makeEvent('guard-skip'), { redis, guardRejectionLog: log, triggerEval });
    assert.equal(result.escalated, false, 'skipped is not escalated');
    assert.equal(result.claimReleased, true, 'claim released on skip');
  });

  it('keeps claim when triggerEval returns dispatched success', async () => {
    const redis = createFakeRedis();
    const log = createFakeLog(3);
    const triggerEval = mock.fn(async () => ({
      ok: true,
      domainId: 'eval:harness-ledger',
      threadId: 't1',
      messageId: 'm1',
      evalCatId: 'c1',
      invocationTriggered: true,
      triggerOutcome: 'dispatched',
    }));

    const result = await checkGuardThreshold(makeEvent('guard-ok'), { redis, guardRejectionLog: log, triggerEval });
    assert.equal(result.escalated, true);
    assert.equal(result.claimReleased, undefined, 'claim should NOT be released on success');
    assert.ok(redis._store.has('guard-rejection:escalated:guard-ok'), 'dedup key retained');
  });

  // ---- Round 4 regression: triggerEval reject + DEL reject paths ----

  it('releases claim when triggerEval rejects (throw) → next event retries successfully', async () => {
    const redis = createFakeRedis();
    const log = createFakeLog(3);
    const callCount = { n: 0 };
    const triggerEval = mock.fn(async () => {
      callCount.n++;
      if (callCount.n === 1) {
        throw new Error('messageStore.append ECONNRESET');
      }
      return triggerSuccess();
    });

    // First call: triggerEval throws → catch releases claim via DEL
    const first = await checkGuardThreshold(makeEvent('guard-throw'), {
      redis,
      guardRejectionLog: log,
      triggerEval,
    });
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
    const second = await checkGuardThreshold(makeEvent('guard-throw'), {
      redis,
      guardRejectionLog: log,
      triggerEval,
    });
    assert.equal(second.escalated, true, 'retry succeeds after claim release');
    assert.equal(triggerEval.mock.callCount(), 2, 'triggerEval called twice (reject + success)');
  });

  it('reports claimReleased=false when redis.del rejects (7d TTL backstop)', async () => {
    const redis = createFakeRedis();
    const log = createFakeLog(3);
    // triggerEval returns 503 (resolved, not throw) to enter non-dispatch path
    const triggerEval = mock.fn(async () => ({
      status: 503,
      error: 'invokeTrigger not ready',
    }));

    // Sabotage redis.del to reject
    const originalDel = redis.del;
    redis.del = async () => {
      throw new Error("READONLY You can't write against a read only replica");
    };

    // Capture console.warn
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args);

    try {
      const result = await checkGuardThreshold(makeEvent('guard-del-fail'), {
        redis,
        guardRejectionLog: log,
        triggerEval,
      });

      assert.equal(result.thresholdMet, true);
      assert.equal(result.escalated, false);
      assert.equal(result.claimReleased, false, 'must NOT report true when DEL failed');

      // Key survives — 7d TTL backstop is active
      assert.ok(redis._store.has('guard-rejection:escalated:guard-del-fail'), 'dedup key still exists (TTL backstop)');

      // console.warn was called with F257 prefix
      assert.ok(warnings.length >= 1, 'console.warn should fire on DEL failure');
      assert.ok(warnings[0][0].includes('[F257]'), 'warning should include [F257] prefix');
    } finally {
      console.warn = originalWarn;
      redis.del = originalDel;
    }
  });
});

describe('createThresholdEscalationHook', () => {
  it('returns a synchronous function (fire-and-forget pattern)', () => {
    const hook = createThresholdEscalationHook({
      redis: createFakeRedis(),
      guardRejectionLog: createFakeLog(0),
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
      zrangebyscore: async (key, min, max) => {
        const s = sorted.get(key);
        if (!s) return [];
        return [...s.entries()]
          .filter(([, sc]) => sc >= min && sc <= max)
          .sort((a, b) => a[1] - b[1])
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
    const triggerEval = mock.fn(async () => ({
      ok: true,
      domainId: 'eval:harness-ledger',
      threadId: 't1',
      messageId: 'm1',
      evalCatId: 'c1',
      invocationTriggered: true,
      triggerOutcome: 'dispatched',
    }));

    // Wire hook — mirrors index.ts bootstrap pattern
    const hook = createThresholdEscalationHook({ redis, guardRejectionLog: log, triggerEval });
    log.setPostAppendHook(hook);

    const now = 1700000000000;

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

    // Verify trigger input
    const input = triggerEval.mock.calls[0].arguments[0];
    assert.equal(input.domainId, 'eval:harness-ledger');
    assert.ok(input.userId.includes('guard-boot'));
  });

  it('real append: 4th event does NOT re-trigger (dedup)', async () => {
    const redis = createFullFakeRedis();
    const log = new GuardRejectionEventLog(redis);
    const triggerEval = mock.fn(async () => ({
      ok: true,
      domainId: 'eval:harness-ledger',
      threadId: 't1',
      messageId: 'm1',
      evalCatId: 'c1',
      invocationTriggered: true,
      triggerOutcome: 'dispatched',
    }));

    const hook = createThresholdEscalationHook({ redis, guardRejectionLog: log, triggerEval });
    log.setPostAppendHook(hook);

    const now = 1700000000000;
    // Append 4 SEPARATED events (>60s gaps → 4 distinct episodes) —
    // 3rd triggers, 4th deduped by the escalation claim (PR #41 accounting).
    for (let i = 0; i < 4; i++) {
      await log.append(makeEvent('guard-dedup', now + i * 100_000));
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(triggerEval.mock.callCount(), 1, 'dedup: only one trigger despite 4 events');
  });
});
