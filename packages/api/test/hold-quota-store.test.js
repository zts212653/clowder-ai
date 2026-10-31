/**
 * F167 #1449 Slice 2 — SqliteHoldQuotaStore: durable hold quota with true sliding window.
 *
 * Defect #2: holdCounts lived in process memory → cleared on restart.
 * Defect #3: burst semantics ≠ documented rolling window.
 *
 * This test file validates:
 * - Atomic admission (tryAdmit): check+insert in a single transaction
 * - True sliding window (not burst): spaced holds don't accumulate unfairly
 * - Durability: a new store instance reads the same SQLite and sees prior events
 * - retryAt accuracy for the sliding window
 * - Independent (threadId, catId) pairs
 * - Lazy pruning of expired events
 * - Concurrent admission barrier (two callers, one slot)
 *
 * Note: all IHoldQuotaStore methods are async (return Promises).
 * eventId is a string (SQLite uses String(rowid), Redis uses UUID).
 */

import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

const WINDOW_MS = 3_600_000; // 1 hour
const MAX_HOLDS = 3;

describe('SqliteHoldQuotaStore — durable sliding window (#1449 Slice 2)', () => {
  /** @type {import('../dist/domains/ball-custody/hold-quota-store.js').IHoldQuotaStore | null} */
  let store = null;

  async function createStore(dbPath = ':memory:') {
    const { SqliteHoldQuotaStore } = await import('../dist/domains/ball-custody/hold-quota-store.js');
    return new SqliteHoldQuotaStore({ dbPath });
  }

  afterEach(async () => {
    await store?.close();
    store = null;
  });

  // ─── Basic counting via tryAdmit ───

  test('getCount returns 0 for unseen (threadId, catId)', async () => {
    store = await createStore();
    assert.equal(await store.getCount('t-new', 'cat-new', WINDOW_MS), 0);
  });

  test('tryAdmit climbs 1→2→3 within window', async () => {
    store = await createStore();
    const base = 1_000_000_000;
    const r1 = await store.tryAdmit('t1', 'cat-a', MAX_HOLDS, WINDOW_MS, base);
    assert.equal(r1.admitted, true);
    assert.equal(r1.count, 1);
    assert.ok(typeof r1.eventId === 'string' && r1.eventId.length > 0, 'admitted result must include string eventId');

    const r2 = await store.tryAdmit('t1', 'cat-a', MAX_HOLDS, WINDOW_MS, base + 1_000);
    assert.equal(r2.admitted, true);
    assert.equal(r2.count, 2);

    const r3 = await store.tryAdmit('t1', 'cat-a', MAX_HOLDS, WINDOW_MS, base + 2_000);
    assert.equal(r3.admitted, true);
    assert.equal(r3.count, 3);

    assert.equal(await store.getCount('t1', 'cat-a', WINDOW_MS, base + 3_000), 3);
  });

  test('distinct (threadId, catId) pairs are independent', async () => {
    store = await createStore();
    const base = 1_000_000_000;
    await store.tryAdmit('tA', 'cat-x', MAX_HOLDS, WINDOW_MS, base);
    await store.tryAdmit('tA', 'cat-x', MAX_HOLDS, WINDOW_MS, base + 100);
    await store.tryAdmit('tB', 'cat-x', MAX_HOLDS, WINDOW_MS, base + 200);
    assert.equal(await store.getCount('tA', 'cat-x', WINDOW_MS, base + 300), 2);
    assert.equal(await store.getCount('tB', 'cat-x', WINDOW_MS, base + 300), 1);
    assert.equal(await store.getCount('tA', 'cat-y', WINDOW_MS, base + 300), 0);
  });

  // ─── TRUE SLIDING WINDOW (defect #3 fix) ───

  test('true sliding window: hold at T=0, T=50min, T=100min — third is admitted', async () => {
    store = await createStore();
    const T0 = 1_000_000_000;
    const T50 = T0 + 50 * 60_000; // +50 minutes
    const T100 = T0 + 100 * 60_000; // +100 minutes

    await store.tryAdmit('t-slide', 'cat-s', MAX_HOLDS, WINDOW_MS, T0);
    await store.tryAdmit('t-slide', 'cat-s', MAX_HOLDS, WINDOW_MS, T50);

    // At T=100min, window is [T100 - 1h, T100) = [T40min, T100min)
    // T0 (=0min) is OUTSIDE the window (0 < 40)
    // T50 (=50min) is INSIDE the window (50 > 40)
    // So count = 1, NOT 2 — the old burst counter would say 2
    const countAtT100 = await store.getCount('t-slide', 'cat-s', WINDOW_MS, T100);
    assert.equal(countAtT100, 1, 'only T=50min is in the 1h window at T=100min');

    // Third hold should be admitted (count = 1 < MAX_HOLDS)
    const r3 = await store.tryAdmit('t-slide', 'cat-s', MAX_HOLDS, WINDOW_MS, T100);
    assert.equal(r3.admitted, true, 'third hold admitted — true sliding window, not burst');
    assert.equal(r3.count, 2);
  });

  test('burst of 3 rapid holds blocks 4th via tryAdmit', async () => {
    store = await createStore();
    const base = 1_000_000_000;
    await store.tryAdmit('t-burst', 'cat-b', MAX_HOLDS, WINDOW_MS, base);
    await store.tryAdmit('t-burst', 'cat-b', MAX_HOLDS, WINDOW_MS, base + 1_000);
    await store.tryAdmit('t-burst', 'cat-b', MAX_HOLDS, WINDOW_MS, base + 2_000);

    // 4th should be rejected
    const r4 = await store.tryAdmit('t-burst', 'cat-b', MAX_HOLDS, WINDOW_MS, base + 3_000);
    assert.equal(r4.admitted, false, '4th hold rejected');
    assert.equal(r4.count, MAX_HOLDS);
    assert.ok(r4.retryAtMs !== undefined, 'retryAtMs is set on rejection');
  });

  test('events expire individually — each hold has its own expiry', async () => {
    store = await createStore();
    const base = 1_000_000_000;
    // Hold at 0, +20min, +40min
    await store.tryAdmit('t-exp', 'cat-e', MAX_HOLDS, WINDOW_MS, base);
    await store.tryAdmit('t-exp', 'cat-e', MAX_HOLDS, WINDOW_MS, base + 20 * 60_000);
    await store.tryAdmit('t-exp', 'cat-e', MAX_HOLDS, WINDOW_MS, base + 40 * 60_000);

    // At base + 61min: first hold (at base) has expired, others still in window
    const at61min = base + 61 * 60_000;
    assert.equal(await store.getCount('t-exp', 'cat-e', WINDOW_MS, at61min), 2, 'first hold expired at +61min');

    // At base + 81min: first two expired
    const at81min = base + 81 * 60_000;
    assert.equal(await store.getCount('t-exp', 'cat-e', WINDOW_MS, at81min), 1, 'first two expired at +81min');

    // At base + 101min: all three expired
    const at101min = base + 101 * 60_000;
    assert.equal(await store.getCount('t-exp', 'cat-e', WINDOW_MS, at101min), 0, 'all expired at +101min');
  });

  // ─── retryAt accuracy (via tryAdmit rejection) ───

  test('tryAdmit returns no retryAtMs when below limit', async () => {
    store = await createStore();
    const base = 1_000_000_000;
    const r = await store.tryAdmit('t-retry', 'cat-r', MAX_HOLDS, WINDOW_MS, base);
    assert.equal(r.admitted, true);
    assert.equal(r.retryAtMs, undefined);
  });

  test('tryAdmit rejection retryAt points to oldest event + windowMs', async () => {
    store = await createStore();
    const base = 1_000_000_000;
    await store.tryAdmit('t-retry2', 'cat-r', MAX_HOLDS, WINDOW_MS, base);
    await store.tryAdmit('t-retry2', 'cat-r', MAX_HOLDS, WINDOW_MS, base + 10_000);
    await store.tryAdmit('t-retry2', 'cat-r', MAX_HOLDS, WINDOW_MS, base + 20_000);

    const r4 = await store.tryAdmit('t-retry2', 'cat-r', MAX_HOLDS, WINDOW_MS, base + 30_000);
    assert.equal(r4.admitted, false);
    // 3 holds, max 3 → offset 0 → oldest event (base) determines retry
    assert.equal(r4.retryAtMs, base + WINDOW_MS);
  });

  test('retryAt advances as oldest events expire naturally', async () => {
    store = await createStore();
    const base = 1_000_000_000;
    // 3 holds: at base, +10s, +20s
    await store.tryAdmit('t-retry3', 'cat-r', MAX_HOLDS, WINDOW_MS, base);
    await store.tryAdmit('t-retry3', 'cat-r', MAX_HOLDS, WINDOW_MS, base + 10_000);
    await store.tryAdmit('t-retry3', 'cat-r', MAX_HOLDS, WINDOW_MS, base + 20_000);

    // At +30s, all 3 still in window — 4th rejected
    const r4 = await store.tryAdmit('t-retry3', 'cat-r', MAX_HOLDS, WINDOW_MS, base + 30_000);
    assert.equal(r4.admitted, false);
    // Pivotal event is at base → retry at base + WINDOW_MS
    assert.equal(r4.retryAtMs, base + WINDOW_MS);

    // After oldest expires, next attempt at retryAt succeeds
    const r5 = await store.tryAdmit('t-retry3', 'cat-r', MAX_HOLDS, WINDOW_MS, r4.retryAtMs);
    assert.equal(r5.admitted, true, 'admitted at exactly retryAt');
  });

  test('retryAt boundary: rejected 1ms before, admitted at retryAt', async () => {
    store = await createStore();
    const base = 1_000_000_000;
    await store.tryAdmit('t-exact', 'cat-e', MAX_HOLDS, WINDOW_MS, base);
    await store.tryAdmit('t-exact', 'cat-e', MAX_HOLDS, WINDOW_MS, base + 5_000);
    await store.tryAdmit('t-exact', 'cat-e', MAX_HOLDS, WINDOW_MS, base + 10_000);

    const r4 = await store.tryAdmit('t-exact', 'cat-e', MAX_HOLDS, WINDOW_MS, base + 15_000);
    assert.equal(r4.admitted, false);
    const retryAt = r4.retryAtMs;
    assert.ok(retryAt !== undefined);

    // One ms before retryAt: still rejected
    const rBefore = await store.tryAdmit('t-exact', 'cat-e', MAX_HOLDS, WINDOW_MS, retryAt - 1);
    assert.equal(rBefore.admitted, false, 'still rejected 1ms before retryAt');

    // At retryAt: admitted
    const rAt = await store.tryAdmit('t-exact', 'cat-e', MAX_HOLDS, WINDOW_MS, retryAt);
    assert.equal(rAt.admitted, true, 'admitted at exactly retryAt');
  });

  // ─── Durability (defect #2 fix) ───

  test('durable: new store instance reads events written by previous instance', async () => {
    const testDir = join(tmpdir(), `hold-quota-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(testDir, { recursive: true });
    const dbPath = join(testDir, 'hold-quota.sqlite');

    try {
      const { SqliteHoldQuotaStore } = await import('../dist/domains/ball-custody/hold-quota-store.js');
      const base = 1_000_000_000;

      // Instance 1: admit two holds
      const store1 = new SqliteHoldQuotaStore({ dbPath });
      await store1.tryAdmit('t-durable', 'cat-d', MAX_HOLDS, WINDOW_MS, base);
      await store1.tryAdmit('t-durable', 'cat-d', MAX_HOLDS, WINDOW_MS, base + 1_000);
      assert.equal(await store1.getCount('t-durable', 'cat-d', WINDOW_MS, base + 2_000), 2);
      await store1.close();

      // Instance 2 (simulates process lifecycle): reads same file, sees both events
      const store2 = new SqliteHoldQuotaStore({ dbPath });
      assert.equal(
        await store2.getCount('t-durable', 'cat-d', WINDOW_MS, base + 2_000),
        2,
        'new instance sees events from previous instance — durable!',
      );

      // Can admit from where it left off
      const r3 = await store2.tryAdmit('t-durable', 'cat-d', MAX_HOLDS, WINDOW_MS, base + 3_000);
      assert.equal(r3.admitted, true);
      assert.equal(r3.count, 3);
      await store2.close();
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // ─── Lazy pruning ───

  test('lazy prune removes events older than 2× window', async () => {
    store = await createStore();
    const base = 1_000_000_000;

    // Insert events at base
    await store.tryAdmit('t-prune', 'cat-p', MAX_HOLDS, WINDOW_MS, base);
    await store.tryAdmit('t-prune', 'cat-p', MAX_HOLDS, WINDOW_MS, base + 1_000);

    // Fast-forward past 2× window — tryAdmit triggers lazy prune
    const farFuture = base + WINDOW_MS * 2 + 1_000;
    await store.tryAdmit('t-prune', 'cat-p', MAX_HOLDS, WINDOW_MS, farFuture);

    // Only the latest event should remain (old ones pruned)
    assert.equal(await store.getCount('t-prune', 'cat-p', WINDOW_MS, farFuture), 1);
  });

  // ─── ATOMIC ADMISSION (P1 fix: concurrent barrier) ───

  test('atomic: two callers with one slot remaining — only one admitted', async () => {
    const testDir = join(tmpdir(), `hold-quota-atomic-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(testDir, { recursive: true });
    const dbPath = join(testDir, 'hold-quota.sqlite');

    try {
      const { SqliteHoldQuotaStore } = await import('../dist/domains/ball-custody/hold-quota-store.js');
      const base = 1_000_000_000;

      // Use two store instances pointing at the same SQLite file
      // (simulates two concurrent request handlers on the same node)
      const storeA = new SqliteHoldQuotaStore({ dbPath });
      const storeB = new SqliteHoldQuotaStore({ dbPath });

      // Fill to MAX_HOLDS - 1 (one slot remaining)
      await storeA.tryAdmit('t-race', 'cat-r', MAX_HOLDS, WINDOW_MS, base);
      await storeA.tryAdmit('t-race', 'cat-r', MAX_HOLDS, WINDOW_MS, base + 1_000);

      // Both try to grab the last slot at the same time
      const [rA, rB] = await Promise.all([
        storeA.tryAdmit('t-race', 'cat-r', MAX_HOLDS, WINDOW_MS, base + 2_000),
        storeB.tryAdmit('t-race', 'cat-r', MAX_HOLDS, WINDOW_MS, base + 2_000),
      ]);

      // Exactly one should be admitted (SQLite serializes the transactions)
      const admittedCount = [rA, rB].filter((r) => r.admitted).length;
      assert.equal(admittedCount, 1, 'exactly one of two concurrent callers admitted');

      // Total count should be exactly MAX_HOLDS
      assert.equal(await storeA.getCount('t-race', 'cat-r', WINDOW_MS, base + 3_000), MAX_HOLDS);

      await storeA.close();
      await storeB.close();
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // ─── Reservation compensation (releaseByEventId) ───

  test('releaseByEventId deletes the exact event by eventId', async () => {
    store = await createStore();
    const base = 1_000_000_000;
    await store.tryAdmit('t-rel', 'cat-r', MAX_HOLDS, WINDOW_MS, base);
    const r2 = await store.tryAdmit('t-rel', 'cat-r', MAX_HOLDS, WINDOW_MS, base + 1_000);
    await store.tryAdmit('t-rel', 'cat-r', MAX_HOLDS, WINDOW_MS, base + 2_000);
    assert.equal(await store.getCount('t-rel', 'cat-r', WINDOW_MS, base + 3_000), 3);

    // Release the SECOND event specifically → count drops to 2
    const released = await store.releaseByEventId(r2.eventId, 't-rel', 'cat-r');
    assert.equal(released, true, 'should return true when event was deleted');
    assert.equal(await store.getCount('t-rel', 'cat-r', WINDOW_MS, base + 3_000), 2);

    // The released slot can be re-admitted
    const r4 = await store.tryAdmit('t-rel', 'cat-r', MAX_HOLDS, WINDOW_MS, base + 4_000);
    assert.equal(r4.admitted, true);
    assert.equal(r4.count, 3);
  });

  test('releaseByEventId returns false when eventId does not exist', async () => {
    store = await createStore();
    const released = await store.releaseByEventId('nonexistent-id', 't-nope', 'cat-nope');
    assert.equal(released, false, 'non-existent eventId should return false');
    assert.equal(await store.getCount('t-nope', 'cat-nope', WINDOW_MS), 0);
  });

  test('releaseByEventId pair-fence: wrong (threadId, catId) prevents deletion', async () => {
    store = await createStore();
    const base = 1_000_000_000;
    const r1 = await store.tryAdmit('t-a', 'cat-1', MAX_HOLDS, WINDOW_MS, base);
    assert.ok(r1.eventId, 'admitted event must have eventId');

    // Try to release with wrong threadId
    const wrongThread = await store.releaseByEventId(r1.eventId, 't-b', 'cat-1');
    assert.equal(wrongThread, false, 'wrong threadId must not delete');
    assert.equal(await store.getCount('t-a', 'cat-1', WINDOW_MS, base + 100), 1, 'event still present');

    // Try to release with wrong catId
    const wrongCat = await store.releaseByEventId(r1.eventId, 't-a', 'cat-2');
    assert.equal(wrongCat, false, 'wrong catId must not delete');
    assert.equal(await store.getCount('t-a', 'cat-1', WINDOW_MS, base + 100), 1, 'event still present');

    // Correct pair succeeds
    const correct = await store.releaseByEventId(r1.eventId, 't-a', 'cat-1');
    assert.equal(correct, true);
    assert.equal(await store.getCount('t-a', 'cat-1', WINDOW_MS, base + 100), 0);
  });

  test('releaseByEventId only affects the target event, not cross-pair', async () => {
    store = await createStore();
    const base = 1_000_000_000;
    const ra = await store.tryAdmit('t-a', 'cat-1', MAX_HOLDS, WINDOW_MS, base);
    await store.tryAdmit('t-b', 'cat-1', MAX_HOLDS, WINDOW_MS, base + 100);
    await store.tryAdmit('t-a', 'cat-2', MAX_HOLDS, WINDOW_MS, base + 200);

    await store.releaseByEventId(ra.eventId, 't-a', 'cat-1');
    assert.equal(await store.getCount('t-a', 'cat-1', WINDOW_MS, base + 300), 0, 'released pair');
    assert.equal(await store.getCount('t-b', 'cat-1', WINDOW_MS, base + 300), 1, 'different thread untouched');
    assert.equal(await store.getCount('t-a', 'cat-2', WINDOW_MS, base + 300), 1, 'different cat untouched');
  });

  // ─── retryAfterMs same-clock-domain (Sol R6 P1 fix) ───

  test('retryAfterMs is computed from same now as retryAtMs', async () => {
    store = await createStore();
    const base = 1_000_000_000;
    const now = base + 500_000; // 500s after first hold

    await store.tryAdmit('t-retryafter', 'cat-ra', MAX_HOLDS, WINDOW_MS, base);
    await store.tryAdmit('t-retryafter', 'cat-ra', MAX_HOLDS, WINDOW_MS, base + 100_000);
    await store.tryAdmit('t-retryafter', 'cat-ra', MAX_HOLDS, WINDOW_MS, base + 200_000);

    // 4th attempt rejected
    const r4 = await store.tryAdmit('t-retryafter', 'cat-ra', MAX_HOLDS, WINDOW_MS, now);
    assert.equal(r4.admitted, false);
    assert.ok(r4.retryAtMs > 0, 'retryAtMs must be set');

    // Critical: retryAfterMs === retryAtMs - now (same clock domain, no Date.now())
    const expectedRetryAfterMs = r4.retryAtMs - now;
    assert.equal(
      r4.retryAfterMs,
      expectedRetryAfterMs,
      `retryAfterMs must equal retryAtMs - now: got ${r4.retryAfterMs}, expected ${expectedRetryAfterMs}`,
    );
    assert.ok(r4.retryAfterMs > 0, 'retryAfterMs must be positive when still within window');
  });

  test('A/B interleaving: A compensation does not delete B reservation', async () => {
    // Reproducer for the releaseOne bug: when A and B both admit for the same
    // (threadId, catId), A failing post-admission should compensate only A's
    // reservation, not B's. releaseOne() would delete B's (most recent) instead.
    store = await createStore();
    const base = 1_000_000_000;

    // Pre-existing event (baseline)
    await store.tryAdmit('t-ab', 'cat-x', MAX_HOLDS, WINDOW_MS, base);

    // A admits at t=200
    const admitA = await store.tryAdmit('t-ab', 'cat-x', MAX_HOLDS, WINDOW_MS, base + 200);
    assert.equal(admitA.admitted, true);
    assert.ok(admitA.eventId, 'A must have eventId');

    // B admits at t=300 (A is still in flight — not yet registered)
    const admitB = await store.tryAdmit('t-ab', 'cat-x', MAX_HOLDS, WINDOW_MS, base + 300);
    assert.equal(admitB.admitted, true);
    assert.ok(admitB.eventId, 'B must have eventId');
    assert.notEqual(admitA.eventId, admitB.eventId, 'distinct event IDs');

    // Count is now 3 (baseline + A + B)
    assert.equal(await store.getCount('t-ab', 'cat-x', WINDOW_MS, base + 400), 3);

    // A's downstream logic fails → compensate A's exact reservation
    await store.releaseByEventId(admitA.eventId, 't-ab', 'cat-x');

    // Correct result: baseline + B remain (count=2). A's slot released.
    assert.equal(
      await store.getCount('t-ab', 'cat-x', WINDOW_MS, base + 400),
      2,
      'must be 2: baseline + B. A compensated, B untouched.',
    );

    // Double-release of A's eventId is a no-op
    const secondRelease = await store.releaseByEventId(admitA.eventId, 't-ab', 'cat-x');
    assert.equal(secondRelease, false, 'double release must be no-op');
    assert.equal(
      await store.getCount('t-ab', 'cat-x', WINDOW_MS, base + 400),
      2,
      'count unchanged after double release',
    );
  });
});
