/**
 * Canonical test helpers for guard-rejection test suites.
 *
 * Single source for: fake Redis (ZSET-aware + LIMIT), event factory, trigger mock.
 * Used by: guard-threshold-escalation, guard-episode-coalescing, guard-rejection-r3-regression.
 *
 * sol R7 P1-1: extracted to prevent fake-divergence causing repeat false greens.
 *
 * [opus/claude-opus-4-6]
 */

/** Base timestamp for all guard-rejection tests. */
export const T = 1700000000000;

/**
 * Canonical fake Redis: key-value (set/get/del) + ZSET (zrangebyscore with LIMIT).
 *
 * This is the ONLY fake Redis for guard-rejection tests — do not create
 * per-file copies (sol R7 P1-1 root cause: stale copies without ZSET break
 * when production switches to pagewise reads).
 *
 * @param seedEvents - Events to pre-populate the ZSET with (sorted by timestamp).
 */
export function createFakeRedis(seedEvents = []) {
  const store = new Map();
  const zset = seedEvents
    .map((e) => ({ score: e.timestamp, member: JSON.stringify(e) }))
    .sort((a, b) => a.score - b.score);
  return {
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
    zrangebyscore: async (_key, min, max, ...args) => {
      let offset = 0;
      let count = zset.length;
      for (let i = 0; i < args.length; i++) {
        if (String(args[i]).toUpperCase() === 'LIMIT') {
          offset = Number(args[i + 1]);
          count = Number(args[i + 2]);
          break;
        }
      }
      return zset
        .filter((m) => m.score >= Number(min) && m.score <= Number(max))
        .slice(offset, offset + count)
        .map((m) => m.member);
    },
    _store: store,
    _zset: zset,
  };
}

/**
 * Standard guard-rejection event factory (HttpRateLimitEvent shape).
 * Override any field via `over` parameter.
 */
export function rawEvent(over = {}) {
  return {
    eventId: `evt-${over.timestamp ?? T}-${over.seq ?? 0}`,
    kind: 'http_rate_limit',
    threadId: 'thread_1',
    catId: 'cat_1',
    guardId: 'hold_ball_rate_limit',
    timestamp: T,
    correlationConfidence: 'window',
    currentCount: 5,
    maxAllowed: 5,
    windowMs: 3600000,
    ...over,
  };
}

/** Lazy-loaded EventLog class for createFakeEventSource. */
let _EventLogClass = null;

/**
 * Create a fake event source (PagewiseEventSource) backed by canonical fake Redis.
 * Uses real GuardRejectionEventLog so iterateWindow() matches production.
 *
 * Fable ruling: every checkGuardThreshold call needs { redis, guardRejectionLog }.
 *
 * @param seedEvents - Events to pre-populate the ZSET with.
 * @returns {{ redis, guardRejectionLog }} — pass both to checkGuardThreshold deps.
 */
export async function createFakeEventSource(seedEvents = []) {
  if (!_EventLogClass) {
    const mod = await import('../../dist/infrastructure/harness-eval/GuardRejectionEventLog.js');
    _EventLogClass = mod.GuardRejectionEventLog;
  }
  const redis = createFakeRedis(seedEvents);
  return { redis, guardRejectionLog: new _EventLogClass(redis) };
}

/** TriggerNowSuccess mock — claim is kept only for this shape. */
export function triggerSuccess(domainId = 'eval:harness-ledger') {
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
