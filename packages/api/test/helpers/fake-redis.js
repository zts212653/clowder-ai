/**
 * FakeRedis — Map-backed Redis stub for unit tests.
 *
 * Supports: get/set/del (strings), sadd/srem/smembers (sets),
 * zadd/zrevrange/zcard/zrem (sorted sets).
 * Tracks TTLs via _ttls Map when SET EX is used.
 *
 * Also exports trace event fixtures for injection trace tests.
 *
 * Used by: hook-override-store.test.js, injection-trace-store.test.js
 */

export class FakeRedis {
  /** @type {Map<string, string>} */
  store = new Map();
  /** @type {Map<string, Set<string>>} */
  sets = new Map();
  /** @type {Map<string, Array<{score: number, member: string}>>} */
  sortedSets = new Map();
  /** @type {Map<string, number>} */
  _ttls = new Map();

  // -- String ops -----------------------------------------------------------
  async get(key) {
    return this.store.get(key) ?? null;
  }
  async set(key, value, ...args) {
    this.store.set(key, value);
    if (args[0] === 'EX' && typeof args[1] === 'number') {
      this._ttls.set(key, args[1]);
    }
    return 'OK';
  }
  async del(key) {
    const had = this.store.has(key);
    this.store.delete(key);
    return had ? 1 : 0;
  }

  // -- Set ops --------------------------------------------------------------
  async sadd(key, member) {
    if (!this.sets.has(key)) this.sets.set(key, new Set());
    this.sets.get(key).add(member);
    return 1;
  }
  async srem(key, member) {
    const set = this.sets.get(key);
    if (!set) return 0;
    const had = set.has(member);
    set.delete(member);
    return had ? 1 : 0;
  }
  async smembers(key) {
    const set = this.sets.get(key);
    return set ? [...set] : [];
  }

  // -- Sorted set ops -------------------------------------------------------
  async zadd(key, score, member) {
    if (!this.sortedSets.has(key)) this.sortedSets.set(key, []);
    const set = this.sortedSets.get(key);
    const idx = set.findIndex((e) => e.member === member);
    if (idx >= 0) set.splice(idx, 1);
    set.push({ score, member });
    set.sort((a, b) => a.score - b.score);
    return 1;
  }
  async zrevrange(key, start, stop) {
    const set = this.sortedSets.get(key);
    if (!set) return [];
    const reversed = [...set].reverse();
    return reversed.slice(start, stop + 1).map((e) => e.member);
  }
  async zcard(key) {
    return this.sortedSets.get(key)?.length ?? 0;
  }
  async zrem(key, member) {
    const set = this.sortedSets.get(key);
    if (!set) return 0;
    const idx = set.findIndex((e) => e.member === member);
    if (idx >= 0) {
      set.splice(idx, 1);
      return 1;
    }
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Trace event fixtures (used by injection-trace-store.test.js)
// ---------------------------------------------------------------------------

/** @returns {import('@cat-cafe/shared').TraceEvent[]} */
export function makeTraceEvents() {
  return [
    {
      hookId: 'S1',
      stage: 'session-init',
      timestamp: 1000,
      status: 'fired',
      version: 1,
      contentHash: 'abc',
      tokenEstimate: 150,
    },
    {
      hookId: 'S2',
      stage: 'session-init',
      timestamp: 1001,
      status: 'skipped',
      reasonCode: 'no_pack',
      reason: 'No pack blocks',
    },
    { hookId: 'S3', stage: 'session-init', timestamp: 1002, status: 'disabled', disabledBy: 'operator' },
    {
      hookId: 'D1',
      stage: 'per-turn',
      timestamp: 2000,
      status: 'fired',
      version: 1,
      contentHash: 'def',
      tokenEstimate: 80,
    },
    { hookId: 'N2', stage: 'per-turn', timestamp: 2001, status: 'observed', contentHash: 'ghi', tokenEstimate: 200 },
  ];
}

/** Build minimal detail object for testing. */
export function makeDetail(turnId, threadId, catId, events) {
  return { turnId, threadId, catId, timestamp: Date.now(), hooks: events };
}
