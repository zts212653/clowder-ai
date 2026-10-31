/**
 * Cursor Order — RED test matrix (§8.10 step 2)
 *
 * Tests 1–8 + 14 from §8.8. Each test is RED on the current baseline
 * (upstream/main @ 7207936a3) and will turn GREEN after implementing the
 * visibility index + v2 cursor system.
 *
 * RULE: An expected-RED test that comes up GREEN means the scenario is
 * mis-built — STOP and fix the test before proceeding.
 *
 * Architecture ref: docs/architecture/1200-cursor-order-analysis.md §8.8
 */

import assert from 'node:assert/strict';
import { after, describe } from 'node:test';
import { cleanupHarness, dualStoreTest, parityTest } from './helpers/dual-store-harness.js';

describe('Cursor Order — RED matrix (§8.8)', () => {
  after(async () => {
    await cleanupHarness();
  });

  // ---- RED #1: FM-1 exactly-once ----
  // Q (queued) appended FIRST, then C (direct). Q delivered AFTER C.
  // Correct visibility order: C (direct, visible at append), Q (visible at delivery).
  // TODAY Memory: Q is at array[0], C at array[1]. afterPage(C.id) walks forward
  //   from C → nothing after C in array → Q invisible. RED ✓
  // TODAY Redis: Q.score rescored to deliveredAt > C.score → afterPage(C.id) returns Q
  //   via score branch. But consumer's lex comparison Q.id < C.id → stuck. Store-level
  //   test is GREEN on Redis (the store query is correct), RED on Memory.
  dualStoreTest('RED #1 — FM-1 exactly-once: late-delivered Q appears once after C', async (ctx) => {
    // Q appended FIRST (t=100), then C (t=200). Q delivered at t=300.
    // Array order: [Q, C]. Visibility order: [C, Q].
    const q = await ctx.appendQueued({ content: 'Q-queued', timestamp: ctx.ts(100) });
    const c = await ctx.appendDirect({ content: 'C-direct', timestamp: ctx.ts(200) });
    await ctx.deliver(q, ctx.ts(300));

    // After C: should return Q (delivered after C in visibility order)
    const page1 = await ctx.afterPage(c.id);
    assert.equal(page1.length, 1, 'Page after C should contain exactly Q');
    assert.equal(page1[0].content, 'Q-queued', 'The message after C should be Q');

    // After Q: should return nothing (no cycle)
    const page2 = await ctx.afterPage(q.id);
    assert.equal(page2.length, 0, 'Page after Q should be empty (no cycle)');
  });

  // ---- RED #2: Idempotent re-read absorb ----
  // Cursor at position 0, re-scan does not double-apply.
  // Pins §8.4 step 3 (fully-pruned → scan from start).
  // NOTE: GREEN on Memory (array walk is naturally idempotent) — invariant guard.
  // RED on Redis only when cursor is a pruned v2 token (tested in RED 9-26 phase).
  dualStoreTest('RED #2 — idempotent re-read: cursor=0 re-scan produces same page', async (ctx) => {
    const m1 = await ctx.appendDirect({ content: 'M1', timestamp: ctx.ts(100) });
    const m2 = await ctx.appendDirect({ content: 'M2', timestamp: ctx.ts(200) });

    // First read: no cursor → should get [M1, M2]
    const page1 = await ctx.afterPage(undefined);
    assert.equal(page1.length, 2, 'First read should return both messages');

    // Second read with same empty cursor → should get the same result
    const page2 = await ctx.afterPage(undefined);
    assert.deepEqual(
      page1.map((m) => m.content),
      page2.map((m) => m.content),
      'Second read should be identical (idempotent)',
    );
  });

  // ---- RED #3: FM-2 limit ----
  // `limit` queued messages then 1 delivered → after returns the delivered one.
  // TODAY Redis: limit slots eaten by undelivered queued msgs → returns [].
  dualStoreTest("RED #3 — FM-2 limit: queued messages don't eat limit slots", async (ctx) => {
    // Append 3 queued messages (not yet delivered)
    const q1 = await ctx.appendQueued({ content: 'Q1', timestamp: ctx.ts(100) });
    const q2 = await ctx.appendQueued({ content: 'Q2', timestamp: ctx.ts(101) });
    const q3 = await ctx.appendQueued({ content: 'Q3', timestamp: ctx.ts(102) });

    // Append 1 delivered message after the queued ones
    const d = await ctx.appendDirect({ content: 'D-visible', timestamp: ctx.ts(200) });

    // With limit=1, should return D (not an empty page)
    // On current Redis: ZRANGE 0 0 gets Q1 (score=100), Q1 fails isDelivered → empty result
    const page = await ctx.afterPage(undefined, 1);
    assert.equal(page.length, 1, 'Should return 1 delivered message, not empty');
    assert.equal(page[0].content, 'D-visible', 'The visible message should be D');
  });

  // ---- RED #4: FM-3 pruned anchor ----
  // Evict/prune the cursor message → next page = exact remainder, no dupes, no losses.
  // TODAY: lex fallback both duplicates and loses.
  dualStoreTest('RED #4 — FM-3 pruned anchor: evicted cursor still paginates correctly', async (ctx) => {
    const m1 = await ctx.appendDirect({ content: 'M1', timestamp: ctx.ts(100) });
    const m2 = await ctx.appendDirect({ content: 'M2', timestamp: ctx.ts(200) });
    const m3 = await ctx.appendDirect({ content: 'M3', timestamp: ctx.ts(300) });

    // Simulate M2 being evicted/pruned (only meaningful for Redis)
    if (ctx.storeType === 'redis' && ctx.redis) {
      // Remove M2's hash to simulate TTL expiry (keep ZSET member for realism)
      await ctx.redis.del(`msg:${m2.id}`);
    }

    // Page after M2 (cursor points to a now-pruned message)
    const page = await ctx.afterPage(m2.id);

    // Should get M3 (and only M3), no duplicates, no losses
    const contents = page.map((m) => m.content);
    assert.ok(contents.includes('M3'), 'M3 should be in the page after pruned M2');
    assert.ok(!contents.includes('M1'), 'M1 should NOT reappear (no duplicate)');
  });

  // ---- RED #5: FM-4 parity sweep ----
  // Interleaved direct/queued/late-delivered, small limits, both stores page-identical.
  // TODAY: Memory hides late-delivered; limit semantics differ.
  parityTest('RED #5 — FM-4 parity: interleaved direct/queued/delivered produces identical pages', async (ctx) => {
    // Timeline:
    //   t=100: D1 (direct)
    //   t=150: Q1 (queued, created at t=50)
    //   t=200: D2 (direct)
    //   t=250: Q1 delivered (deliveredAt=250)
    //   t=300: D3 (direct)
    const d1 = await ctx.appendDirect({ content: 'D1', timestamp: ctx.ts(100) });
    const q1 = await ctx.appendQueued({ content: 'Q1', timestamp: ctx.ts(50) });
    const d2 = await ctx.appendDirect({ content: 'D2', timestamp: ctx.ts(200) });
    await ctx.deliver(q1, ctx.ts(250));
    const d3 = await ctx.appendDirect({ content: 'D3', timestamp: ctx.ts(300) });

    // Correct visibility order: D1, D2, Q1 (delivered at 250), D3
    // Page 1 (limit=2): [D1, D2]
    const page1 = await ctx.afterPage(undefined, 2);

    // Page 2 from last of page 1
    const lastId1 = page1.length > 0 ? page1[page1.length - 1].id : undefined;
    const page2 = await ctx.afterPage(lastId1, 2);

    // Page 3 from last of page 2 (should be empty or just remainder)
    const lastId2 = page2.length > 0 ? page2[page2.length - 1].id : undefined;
    const page3 = await ctx.afterPage(lastId2, 2);

    return { pages: [page1, page2, page3] };
  });

  // ---- RED #6: FM-7 far-future immediate ----
  // F(far-future ts) append → N append → full forward pagination includes both.
  // TODAY Redis: F.score=far-future > N.score=normal. Full page from start returns
  //   [N, F] (score order), but after(N) returns F, and after(F) returns nothing.
  //   Any message appended after F is permanently lost behind F's score wall.
  // TODAY Memory: Array order = [F, N]. afterPage(F.id) walks forward → N. PASSES.
  //   But full scan [F, N] has WRONG ORDER — visibility order should be [F, N] by
  //   append time, and it is. However, the combination of F.id (far-future prefix)
  //   with consumer lex comparison means cursor=F.id > N.id forever → consumer stuck.
  //   Store-level: RED only on Redis for the "after F" case.
  dualStoreTest('RED #6 — FM-7 far-future: N appended after F is reachable via after(F)', async (ctx) => {
    const farFuture = Date.now() + 365 * 24 * 3600 * 1000; // 1 year ahead
    const f = await ctx.appendDirect({ content: 'F-far-future', timestamp: farFuture });
    const n1 = await ctx.appendDirect({ content: 'N1-normal', timestamp: ctx.ts(200) });
    const n2 = await ctx.appendDirect({ content: 'N2-normal', timestamp: ctx.ts(300) });

    // Full forward pagination should see all 3 messages
    const allMsgs = await ctx.afterPage(undefined);
    assert.equal(allMsgs.length, 3, 'Should see all 3 messages');

    // Visibility order should be: F, N1, N2 (append order = visibility order)
    // On Redis: score order is [N1(200), N2(300), F(far-future)] — WRONG ORDER
    assert.equal(allMsgs[0].content, 'F-far-future', 'F should be first (append order)');
    assert.equal(allMsgs[1].content, 'N1-normal', 'N1 should be second');
    assert.equal(allMsgs[2].content, 'N2-normal', 'N2 should be third');
  });

  // ---- RED #7: FM-7 far-future queued ----
  // cursor=F, Q late-delivers → after(F) returns Q.
  // TODAY Redis: Q.score = deliveredAt (normal) < F.score (far-future) → loss.
  // TODAY Memory: Q appended after F → array position after F → visible. BUT
  //   Q.id has lower timestamp prefix than F.id → consumer lex comparison stuck.
  //   Store-level: RED on Redis (score wall), GREEN on Memory (array walk).
  dualStoreTest('RED #7 — FM-7 far-future queued: late-delivered Q visible after far-future', async (ctx) => {
    const farFuture = Date.now() + 365 * 24 * 3600 * 1000;
    const f = await ctx.appendDirect({ content: 'F-far-future', timestamp: farFuture });
    const q = await ctx.appendQueued({ content: 'Q-queued', timestamp: ctx.ts(50) });
    // Deliver Q at a normal time (well below far-future)
    await ctx.deliver(q, ctx.ts(300));

    // After F: should return Q (visibility order: F first, Q delivered second)
    const page = await ctx.afterPage(f.id);
    assert.equal(page.length, 1, 'Page after far-future F should contain delivered Q');
    assert.equal(page[0].content, 'Q-queued', 'Q should be visible after F');
  });

  // ---- RED #8: Maintainer P1 invariant ----
  // Q appended first (t=100), C1 (t=200), C2 (t=300), Q delivered (t=250).
  // Correct visibility order: C1, Q, C2 (by visibility moment).
  // TODAY Memory: Array = [Q, C1, C2]. Walk: Q→C1→C2. Skips Q in correct
  //   position (should be between C1 and C2). Walk collects [Q, C1, C2] — wrong order.
  // TODAY Redis: Score order = [C1(200), Q(250), C2(300)]. Walk: C1→Q→C2.
  //   Happens to be correct, BUT cursor=Q.id < C1.id (lex), so consumer gets stuck.
  //   Store-level: partially GREEN on main (the query works), RED on consumer.
  dualStoreTest('RED #8 — Maintainer P1: C→Q→C total order, correct visibility sequence', async (ctx) => {
    // Q created (queued), C1 appended, Q delivered at t=250 (between C1 and C2), C2 appended.
    // Operation order must match real-world timing: delivery happens before C2's append
    // so the visibility allocator can place Q between C1 and C2.
    const q = await ctx.appendQueued({ content: 'Q', timestamp: ctx.ts(100) });
    const c1 = await ctx.appendDirect({ content: 'C1', timestamp: ctx.ts(200) });
    await ctx.deliver(q, ctx.ts(250));
    const c2 = await ctx.appendDirect({ content: 'C2', timestamp: ctx.ts(300) });

    // Walk the full sequence with limit=1, detect cycles
    const seen = new Set();
    let cursor;
    const collected = [];

    for (let step = 0; step < 10; step++) {
      const page = await ctx.afterPage(cursor, 1);
      if (page.length === 0) break;

      const msg = page[0];
      assert.ok(!seen.has(msg.id), `Cycle detected: ${msg.content} (${msg.id}) seen twice at step ${step}`);
      seen.add(msg.id);
      collected.push(msg.content);
      cursor = msg.id;
    }

    // Correct visibility order: C1 first (append-time visible), Q second (delivered
    // at 250, after C1's append at 200), C2 third (append at 300)
    assert.deepEqual(collected, ['C1', 'Q', 'C2'], 'Should traverse C1 → Q → C2 in visibility order');
  });

  // ---- RED #14: Legacy equal-score paging ----
  // Backfill L1=(s,"a"), L2=(s,"b") same-ms; cursor=L1 → next page contains L2.
  // Rev 2 design lost L2; pair relation fixes it.
  // This test is Redis-only (legacy seeding requires direct ZADD).
  dualStoreTest('RED #14 — Legacy equal-score: same-ms siblings both reachable', async (ctx) => {
    // Two messages at exactly the same timestamp
    const sameTs = ctx.ts(500);
    const l1 = await ctx.appendDirect({ content: 'L1-same-ms', timestamp: sameTs });
    const l2 = await ctx.appendDirect({ content: 'L2-same-ms', timestamp: sameTs });

    // After L1: should return L2
    const page = await ctx.afterPage(l1.id);
    const contents = page.map((m) => m.content);
    assert.ok(contents.includes('L2-same-ms'), 'L2 should be reachable after L1 (same timestamp)');
  });
});
