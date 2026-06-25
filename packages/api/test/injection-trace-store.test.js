/**
 * F237 Phase 2-E: InjectionTraceStore tests (AC-P2-8/8a/9)
 *
 * Tests dual-layer persistence (summary TTL=0 + detail TTL=7d),
 * summary building from TraceEvents, and query APIs.
 * Uses FakeRedis (Map-backed) — no real Redis connection needed.
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { FakeRedis, makeDetail, makeTraceEvents } from './helpers/fake-redis.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InjectionTraceStore (P2-E)', () => {
  /** @type {typeof import('../dist/domains/prompt-hooks/InjectionTraceStore.js')} */
  let mod;
  /** Compact summary builder for tests. */
  const bts = (turnId, threadId, overrides = {}) =>
    mod.buildTraceSummary({
      turnId,
      sessionId: 's1',
      threadId,
      catId: 'opus',
      events: [],
      delivery: [],
      durationMs: 0,
      ...overrides,
    });

  before(async () => {
    mod = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
  });

  // -- Pure helpers (buildTraceSummary / toSummaryEntries) -------------------

  describe('buildTraceSummary (pure)', () => {
    it('converts TraceEvents to InjectionTraceSummary', () => {
      const events = makeTraceEvents();
      const summary = mod.buildTraceSummary({
        turnId: 'turn-1',
        sessionId: 'sess-1',
        threadId: 'thread-1',
        catId: 'opus',
        events,
        delivery: [{ stage: 'session-init', delivered: true, channel: 'message-prepend', reason: 'injected' }],
        durationMs: 42,
      });

      assert.equal(summary.turnId, 'turn-1');
      assert.equal(summary.catId, 'opus');
      assert.equal(summary.totalHooksFired, 2, 'S1 + D1 fired');
      assert.equal(summary.totalHooksSkipped, 1, 'S2 skipped');
      assert.equal(summary.totalTokens, 230, '150 + 80');
      assert.equal(summary.totalDurationMs, 42);
      assert.equal(summary.hooks.length, 5);
      assert.ok(summary.timestamp > 0);
    });

    it('toSummaryEntries preserves correct fields per status', () => {
      const events = makeTraceEvents();
      const entries = mod.toSummaryEntries(events);

      // fired: version + tokenEstimate
      const s1 = entries.find((e) => e.hookId === 'S1');
      assert.ok(s1);
      assert.equal(s1.status, 'fired');
      assert.equal(s1.version, 1);
      assert.equal(s1.tokenEstimate, 150);
      assert.equal(s1.reasonCode, undefined);

      // skipped: reasonCode
      const s2 = entries.find((e) => e.hookId === 'S2');
      assert.ok(s2);
      assert.equal(s2.status, 'skipped');
      assert.equal(s2.reasonCode, 'no_pack');
      assert.equal(s2.version, undefined);

      // disabled: minimal
      const s3 = entries.find((e) => e.hookId === 'S3');
      assert.ok(s3);
      assert.equal(s3.status, 'disabled');

      // observed: tokenEstimate
      const n2 = entries.find((e) => e.hookId === 'N2');
      assert.ok(n2);
      assert.equal(n2.status, 'observed');
      assert.equal(n2.tokenEstimate, 200);
    });
  });

  // -- Dual-layer persistence (AC-P2-8) ------------------------------------

  describe('Dual-layer persistence (AC-P2-8)', () => {
    it('persists summary without TTL and detail with TTL', async () => {
      const redis = new FakeRedis();
      const store = new mod.InjectionTraceStore(/** @type {any} */ (redis));
      const summary = mod.buildTraceSummary({
        turnId: 'turn-1',
        sessionId: 'sess-1',
        threadId: 'thread-1',
        catId: 'opus',
        events: makeTraceEvents(),
        delivery: [],
        durationMs: 10,
      });
      const detail = {
        turnId: 'turn-1',
        threadId: 'thread-1',
        catId: 'opus',
        timestamp: Date.now(),
        hooks: makeTraceEvents(),
      };

      await store.persist(summary, detail);

      // Summary: persisted without TTL
      const sRaw = await redis.get('injection-trace-summary:thread-1:turn-1');
      assert.ok(sRaw, 'Summary should be persisted');
      const sTtl = redis._ttls?.get('injection-trace-summary:thread-1:turn-1');
      assert.equal(sTtl, undefined, 'Summary should have no TTL (persistent)');

      // Detail: persisted with 7-day TTL
      const dRaw = await redis.get('injection-trace-detail:thread-1:turn-1');
      assert.ok(dRaw, 'Detail should be persisted');
      const dTtl = redis._ttls?.get('injection-trace-detail:thread-1:turn-1');
      assert.equal(dTtl, 604800, 'Detail should have 7-day TTL');
    });

    it('respects custom detail TTL', async () => {
      const redis = new FakeRedis();
      const store = new mod.InjectionTraceStore(/** @type {any} */ (redis), { detailTtlSeconds: 3600 });
      await store.persist(bts('t1', 'th1'), makeDetail('t1', 'th1', 'opus', []));
      const dTtl = redis._ttls?.get('injection-trace-detail:th1:t1');
      assert.equal(dTtl, 3600);
    });

    it('getSummary + getDetail round-trip', async () => {
      const store = new mod.InjectionTraceStore(/** @type {any} */ (new FakeRedis()));
      const summary = bts('t1', 'th1', { events: makeTraceEvents(), durationMs: 5 });
      const detail = makeDetail('t1', 'th1', 'opus', makeTraceEvents());

      await store.persist(summary, detail);

      const gotSummary = await store.getSummary('th1', 't1');
      assert.ok(gotSummary);
      assert.equal(gotSummary.totalHooksFired, 2);
      assert.equal(gotSummary.totalTokens, 230);

      const gotDetail = await store.getDetail('th1', 't1');
      assert.ok(gotDetail);
      assert.equal(gotDetail.hooks.length, 5);
      assert.equal(gotDetail.hooks[0].hookId, 'S1');
    });

    it('returns null for non-existent trace', async () => {
      const store = new mod.InjectionTraceStore(/** @type {any} */ (new FakeRedis()));
      assert.equal(await store.getSummary('th1', 'nope'), null);
      assert.equal(await store.getDetail('th1', 'nope'), null);
    });
  });

  // -- Query API (AC-P2-9) -------------------------------------------------

  describe('Query API (AC-P2-9)', () => {
    it('listTurnIds returns turns in reverse chronological order', async () => {
      const store = new mod.InjectionTraceStore(/** @type {any} */ (new FakeRedis()));
      for (let i = 1; i <= 5; i++) {
        const s = bts(`turn-${i}`, 'th1');
        s.timestamp = i * 1000;
        await store.persist(s, makeDetail(`turn-${i}`, 'th1', 'opus', []));
      }
      const { turnIds, total } = await store.listTurnIds('th1');
      assert.equal(total, 5);
      assert.equal(turnIds[0], 'turn-5', 'Newest first');
      assert.equal(turnIds[4], 'turn-1', 'Oldest last');
    });

    it('listTurnIds supports pagination', async () => {
      const store = new mod.InjectionTraceStore(/** @type {any} */ (new FakeRedis()));
      for (let i = 1; i <= 10; i++) {
        const s = bts(`t-${i}`, 'th1');
        s.timestamp = i * 1000;
        await store.persist(s, makeDetail(`t-${i}`, 'th1', 'opus', []));
      }
      const page1 = await store.listTurnIds('th1', { limit: 3, offset: 0 });
      assert.equal(page1.total, 10);
      assert.equal(page1.turnIds.length, 3);
      assert.equal(page1.turnIds[0], 't-10');
      const page2 = await store.listTurnIds('th1', { limit: 3, offset: 3 });
      assert.equal(page2.turnIds.length, 3);
      assert.equal(page2.turnIds[0], 't-7');
    });

    it('listSummaries returns full summary objects', async () => {
      const store = new mod.InjectionTraceStore(/** @type {any} */ (new FakeRedis()));
      const events = makeTraceEvents();
      for (let i = 1; i <= 3; i++) {
        const s = bts(`t-${i}`, 'th1', { events, durationMs: i });
        s.timestamp = i * 1000;
        await store.persist(s, makeDetail(`t-${i}`, 'th1', 'opus', events));
      }

      const { summaries, total } = await store.listSummaries('th1', { limit: 2 });
      assert.equal(total, 3);
      assert.equal(summaries.length, 2);
      assert.equal(summaries[0].turnId, 't-3', 'Newest first');
      assert.equal(summaries[0].totalHooksFired, 2);
    });
  });

  // -- Delivery decisions (AC-P2-8a) ---------------------------------------

  describe('Delivery decisions (AC-P2-8a)', () => {
    it('summary includes StageDeliveryDecision array', () => {
      const delivery = [
        {
          stage: /** @type {const} */ ('session-init'),
          delivered: true,
          channel: /** @type {const} */ ('message-prepend'),
          reason: 'injectSystemPrompt=true',
        },
        {
          stage: /** @type {const} */ ('per-turn'),
          delivered: true,
          channel: /** @type {const} */ ('always-delivered'),
          reason: 'transport layer',
        },
      ];
      const summary = bts('t1', 'th1', { events: makeTraceEvents(), delivery, durationMs: 1 });
      assert.equal(summary.delivery.length, 2);
      assert.equal(summary.delivery[0].channel, 'message-prepend');
      assert.equal(summary.delivery[1].channel, 'always-delivered');
    });
  });

  // -- Cleanup --------------------------------------------------------------

  describe('deleteTurn', () => {
    it('removes summary, detail, and index entry', async () => {
      const store = new mod.InjectionTraceStore(/** @type {any} */ (new FakeRedis()));
      await store.persist(bts('t1', 'th1'), makeDetail('t1', 'th1', 'opus', []));

      assert.ok(await store.getSummary('th1', 't1'));
      await store.deleteTurn('th1', 't1');
      assert.equal(await store.getSummary('th1', 't1'), null);
      assert.equal(await store.getDetail('th1', 't1'), null);
      const { total } = await store.listTurnIds('th1');
      assert.equal(total, 0);
    });
  });
});
