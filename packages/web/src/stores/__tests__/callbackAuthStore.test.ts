/**
 * F174 D2b-2 — global callback-auth store (砚砚 P1 #1403 fix).
 *
 * Asserts applySnapshot mutates byCatStatus/aggregate/isAvailable correctly,
 * and selectors reflect the new state. Covers: success, error, multi-cat,
 * topReasons/topTools sort + cap.
 */

import { describe, expect, it } from 'vitest';
import type { CallbackAuthSnapshot } from '@/hooks/useCallbackAuthSnapshot';
import { buildAggregate, useCallbackAuthStore } from '../callbackAuthStore';

const baseSnapshot: CallbackAuthSnapshot = {
  reasonCounts: { expired: 0, invalid_token: 0, unknown_invocation: 0, stale_invocation: 0, missing_creds: 0 },
  toolCounts: {},
  byCat: {},
  recentSamples: [],
  totalFailures: 0,
  startedAt: 0,
  uptimeMs: 0,
  recent24h: { totalFailures: 0, byReason: {}, byTool: {}, byCat: {} },
};

function resetStore() {
  useCallbackAuthStore.setState({
    snapshot: null,
    byCatStatus: {},
    aggregate: {
      byReason: {},
      byTool: {},
      totalFailures24h: 0,
      unviewedFailures24h: 0,
      topReasons: [],
      topTools: [],
    },
    isAvailable: false,
    lastError: null,
    pendingMarkViewedCutoff: null,
  });
}

describe('callbackAuthStore (F174 D2b-2)', () => {
  it('applySnapshot(null, error) marks isAvailable=false and leaves prior state', () => {
    resetStore();
    useCallbackAuthStore.getState().applySnapshot(null, 'forbidden');
    expect(useCallbackAuthStore.getState().isAvailable).toBe(false);
  });

  it('applySnapshot(snapshot) populates byCatStatus and aggregate', () => {
    resetStore();
    useCallbackAuthStore.getState().applySnapshot({
      ...baseSnapshot,
      recent24h: {
        totalFailures: 8,
        byReason: { expired: 5, invalid_token: 3 },
        byTool: { register_pr_tracking: 4, post_message: 4 },
        byCat: { opus: 8 },
      },
    });
    const s = useCallbackAuthStore.getState();
    expect(s.isAvailable).toBe(true);
    expect(s.byCatStatus.opus.status).toBe('broken');
    expect(s.byCatStatus.opus.failures24h).toBe(8);
    expect(s.aggregate.totalFailures24h).toBe(8);
  });

  it('applySnapshot replaces previous state on each call', () => {
    resetStore();
    useCallbackAuthStore.getState().applySnapshot({
      ...baseSnapshot,
      recent24h: { totalFailures: 10, byReason: { expired: 10 }, byTool: {}, byCat: { opus: 10 } },
    });
    expect(useCallbackAuthStore.getState().byCatStatus.opus.status).toBe('broken');
    useCallbackAuthStore.getState().applySnapshot({
      ...baseSnapshot,
      recent24h: { totalFailures: 0, byReason: {}, byTool: {}, byCat: {} },
    });
    expect(useCallbackAuthStore.getState().byCatStatus.opus).toBeUndefined();
    expect(useCallbackAuthStore.getState().aggregate.totalFailures24h).toBe(0);
  });
});

describe('Cloud P2 #1403 (round 6): unified snapshot source', () => {
  it('applySnapshot stores raw snapshot for HubCallbackAuthPanel to read', () => {
    resetStore();
    const snap: CallbackAuthSnapshot = {
      ...baseSnapshot,
      recent24h: { totalFailures: 7, byReason: { expired: 7 }, byTool: {}, byCat: { opus: 7 } },
      recentSamples: [{ at: 1234, reason: 'expired', tool: 'register_pr_tracking', catId: 'opus' }],
      legacyFallbackHits: { byTool: {}, total: 2 },
    };
    useCallbackAuthStore.getState().applySnapshot(snap);
    const stored = useCallbackAuthStore.getState().snapshot;
    expect(stored).not.toBeNull();
    expect(stored?.recent24h.totalFailures).toBe(7);
    expect(stored?.recentSamples[0].reason).toBe('expired');
    expect(stored?.legacyFallbackHits?.total).toBe(2);
    // byCat used by panel + byCatStatus used by dot are derived from SAME snapshot
    expect(stored?.recent24h.byCat.opus).toBe(7);
    expect(useCallbackAuthStore.getState().byCatStatus.opus.failures24h).toBe(7);
  });

  it('error path keeps lastError so panel can render banner', () => {
    resetStore();
    useCallbackAuthStore.getState().applySnapshot(null, 'forbidden');
    expect(useCallbackAuthStore.getState().lastError).toBe('forbidden');
    expect(useCallbackAuthStore.getState().isAvailable).toBe(false);
  });

  it('success after error clears lastError', () => {
    resetStore();
    useCallbackAuthStore.getState().applySnapshot(null, 'forbidden');
    expect(useCallbackAuthStore.getState().lastError).toBe('forbidden');
    useCallbackAuthStore.getState().applySnapshot({
      ...baseSnapshot,
      recent24h: { totalFailures: 0, byReason: {}, byTool: {}, byCat: {} },
    });
    expect(useCallbackAuthStore.getState().lastError).toBeNull();
    expect(useCallbackAuthStore.getState().isAvailable).toBe(true);
  });
});

// Cloud Codex P2 #1425 round 2: store.markViewed must reconcile its
// optimistic local update with server-authoritative `lastViewedAt` returned
// in the POST response, instead of blindly zeroing aggregate. Failures
// already in the snapshot but with `at > server.lastViewedAt` (i.e. arrived
// after viewedUpTo cutoff) must remain in the unviewed count.
describe('markViewed — Cloud P2 #1425 round 2 reconcile-from-snapshot', () => {
  const fetchOk = (json: unknown) =>
    ({
      ok: true,
      status: 200,
      json: async () => json,
    }) as Response;

  it('after POST, optimistic unviewed = count of recentSamples with at > server.lastViewedAt', async () => {
    resetStore();
    const snap: CallbackAuthSnapshot = {
      ...baseSnapshot,
      startedAt: 1_000,
      uptimeMs: 9_000, // snapshot's effective "as of" = 10_000
      recentSamples: [
        { at: 5_000, reason: 'expired', tool: 't', catId: 'opus' }, // pre-cutoff
        { at: 7_000, reason: 'expired', tool: 't', catId: 'opus' }, // pre-cutoff
        { at: 12_000, reason: 'expired', tool: 't', catId: 'opus' }, // post-cutoff (arrived after snapshot was fetched but before next poll)
      ],
      recent24h: { totalFailures: 3, byReason: { expired: 3 }, byTool: { t: 3 }, byCat: { opus: 3 } },
      unviewedFailures24h: 3, // server's value at snapshot time
    };
    useCallbackAuthStore.getState().applySnapshot(snap);
    expect(useCallbackAuthStore.getState().aggregate.unviewedFailures24h).toBe(3);

    // Stub apiFetch — server returns lastViewedAt = 10_000 (snapshot's uptime end)
    const originalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    (globalThis as { fetch?: typeof fetch }).fetch = (async () =>
      fetchOk({ ok: true, viewedAt: 10_000, lastViewedAt: 10_000 })) as typeof fetch;

    try {
      await useCallbackAuthStore.getState().markViewed();
    } finally {
      (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
    }

    // The post-cutoff sample (at=12_000) survives the optimistic clear:
    // failures present in snapshot but arriving after viewedUpTo stay unviewed.
    expect(useCallbackAuthStore.getState().aggregate.unviewedFailures24h).toBe(1);
  });

  it('zero recentSamples post-cutoff → optimistic clear to 0', async () => {
    resetStore();
    const snap: CallbackAuthSnapshot = {
      ...baseSnapshot,
      startedAt: 0,
      uptimeMs: 100_000,
      recentSamples: [
        { at: 50_000, reason: 'expired', tool: 't', catId: 'opus' },
        { at: 80_000, reason: 'expired', tool: 't', catId: 'opus' },
      ],
      recent24h: { totalFailures: 2, byReason: { expired: 2 }, byTool: { t: 2 }, byCat: { opus: 2 } },
      unviewedFailures24h: 2,
    };
    useCallbackAuthStore.getState().applySnapshot(snap);

    const originalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    (globalThis as { fetch?: typeof fetch }).fetch = (async () =>
      fetchOk({ ok: true, viewedAt: 100_000, lastViewedAt: 100_000 })) as typeof fetch;

    try {
      await useCallbackAuthStore.getState().markViewed();
    } finally {
      (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
    }

    expect(useCallbackAuthStore.getState().aggregate.unviewedFailures24h).toBe(0);
  });

  it('Cloud P2 round 3: uses LATEST snapshot (not captured) when POST is in flight', async () => {
    // Scenario: panel opens with snapshot A (2 samples), POST in flight.
    // While POST awaits, a poll applies snapshot B (4 samples — 2 new failures).
    // After POST returns, optimistic clear must use snapshot B (latest) not A
    // (captured), otherwise the 2 new failures get hidden until next poll.
    resetStore();
    const snapA: CallbackAuthSnapshot = {
      ...baseSnapshot,
      startedAt: 0,
      uptimeMs: 10_000, // viewedUpTo = 10_000
      recentSamples: [
        { at: 5_000, reason: 'expired', tool: 't', catId: 'opus' },
        { at: 7_000, reason: 'expired', tool: 't', catId: 'opus' },
      ],
      recent24h: { totalFailures: 2, byReason: { expired: 2 }, byTool: { t: 2 }, byCat: { opus: 2 } },
      unviewedFailures24h: 2,
    };
    useCallbackAuthStore.getState().applySnapshot(snapA);

    const originalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    // Mock fetch: while in flight, simulate a poll that applies snapshot B
    (globalThis as { fetch?: typeof fetch }).fetch = (async () => {
      // Snapshot B arrives mid-flight: same viewedUpTo cutoff but now 4 samples
      // (2 original + 2 new at=12_000, 15_000 — which are POST-cutoff = unviewed)
      const snapB: CallbackAuthSnapshot = {
        ...baseSnapshot,
        startedAt: 0,
        uptimeMs: 16_000,
        recentSamples: [
          { at: 5_000, reason: 'expired', tool: 't', catId: 'opus' },
          { at: 7_000, reason: 'expired', tool: 't', catId: 'opus' },
          { at: 12_000, reason: 'expired', tool: 't', catId: 'opus' },
          { at: 15_000, reason: 'expired', tool: 't', catId: 'opus' },
        ],
        recent24h: { totalFailures: 4, byReason: { expired: 4 }, byTool: { t: 4 }, byCat: { opus: 4 } },
        unviewedFailures24h: 4,
      };
      useCallbackAuthStore.getState().applySnapshot(snapB);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, viewedAt: 10_000, lastViewedAt: 10_000 }),
      } as Response;
    }) as typeof fetch;

    try {
      await useCallbackAuthStore.getState().markViewed();
    } finally {
      (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
    }

    // CORRECT: 2 (samples at 12_000 and 15_000 are post-cutoff)
    // Without round-3 fix: would compute from snapshot A → 0 → hides new failures
    expect(useCallbackAuthStore.getState().aggregate.unviewedFailures24h).toBe(2);
  });

  it('Cloud P2 round 4: stale poll response after markViewed does NOT regress badge', async () => {
    // Race scenario:
    //   T0: poll starts (server returns snapshot with lastViewedAt=0, unviewed=5)
    //   T1: panel opens → markViewed POST → server lastViewedAt = 100
    //   T2: markViewed resolves → store.pendingMarkViewedCutoff = 100, badge cleared
    //   T3: original T0 poll resolves → applySnapshot with snapshot.lastViewedAt=0
    //        Without round-4 fix: badge re-appears as 5 (server pre-view value)
    //        With round-4 fix: applySnapshot detects snap.lastViewedAt(0) < cutoff(100),
    //                          patches unviewedFailures24h from local recentSamples
    resetStore();
    // Initial snapshot the panel rendered
    useCallbackAuthStore.getState().applySnapshot({
      ...baseSnapshot,
      startedAt: 0,
      uptimeMs: 50,
      recentSamples: [
        { at: 30, reason: 'expired', tool: 't', catId: 'opus' },
        { at: 40, reason: 'expired', tool: 't', catId: 'opus' },
      ],
      recent24h: { totalFailures: 2, byReason: { expired: 2 }, byTool: { t: 2 }, byCat: { opus: 2 } },
      unviewedFailures24h: 2,
      lastViewedAt: 0,
    });
    expect(useCallbackAuthStore.getState().aggregate.unviewedFailures24h).toBe(2);

    // markViewed: server returns lastViewedAt = 50 (cutoff watermark)
    const originalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    (globalThis as { fetch?: typeof fetch }).fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, viewedAt: 50, lastViewedAt: 50 }),
      }) as Response) as typeof fetch;
    try {
      await useCallbackAuthStore.getState().markViewed();
    } finally {
      (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
    }
    expect(useCallbackAuthStore.getState().aggregate.unviewedFailures24h).toBe(0);
    expect(useCallbackAuthStore.getState().pendingMarkViewedCutoff).toBe(50);

    // STALE poll resolves with pre-mark server state (lastViewedAt=0, unviewed=2)
    useCallbackAuthStore.getState().applySnapshot({
      ...baseSnapshot,
      startedAt: 0,
      uptimeMs: 60,
      recentSamples: [
        { at: 30, reason: 'expired', tool: 't', catId: 'opus' },
        { at: 40, reason: 'expired', tool: 't', catId: 'opus' },
      ],
      recent24h: { totalFailures: 2, byReason: { expired: 2 }, byTool: { t: 2 }, byCat: { opus: 2 } },
      unviewedFailures24h: 2, // stale!
      lastViewedAt: 0, // stale — server hadn't seen our mark yet when this poll started
    });
    // CRITICAL: badge stays 0, not 2 — local recompute filters out pre-cutoff samples
    expect(useCallbackAuthStore.getState().aggregate.unviewedFailures24h).toBe(0);
    expect(useCallbackAuthStore.getState().pendingMarkViewedCutoff).toBe(50); // still pending

    // FRESH poll resolves with snapshot reflecting our mark (lastViewedAt=50)
    useCallbackAuthStore.getState().applySnapshot({
      ...baseSnapshot,
      startedAt: 0,
      uptimeMs: 70,
      recentSamples: [
        { at: 30, reason: 'expired', tool: 't', catId: 'opus' },
        { at: 40, reason: 'expired', tool: 't', catId: 'opus' },
      ],
      recent24h: { totalFailures: 2, byReason: { expired: 2 }, byTool: { t: 2 }, byCat: { opus: 2 } },
      unviewedFailures24h: 0, // server-authoritative now
      lastViewedAt: 50, // server caught up
    });
    expect(useCallbackAuthStore.getState().aggregate.unviewedFailures24h).toBe(0);
    expect(useCallbackAuthStore.getState().pendingMarkViewedCutoff).toBeNull(); // cleared
  });

  it('Cloud P1 round 6: optimisticUnviewed uses effectiveCutoff (max), not raw serverCutoff', async () => {
    // Race scenario: overlapping markViewed responses out of order.
    //   T0: snapshot loaded with samples at [50, 150, 250]
    //   T1: markViewed #1 starts → server cutoff = 200 (newer)
    //   T2: markViewed #1 resolves → cutoff=200, optimistic: filter(at >= 200) = 1 (just 250)
    //   T3: markViewed #2 (older) resolves → server cutoff=100
    //   Without round-6 fix: cutoff stays at 200 (Math.max) BUT optimistic uses
    //                        serverCutoff=100 → filter(at >= 100) = 2 (150 + 250)
    //                        → badge re-inflates from 1 to 2
    //   With round-6 fix: optimistic also uses effectiveCutoff = max(200, 100) = 200
    //                     → filter(at >= 200) = 1 → badge stays at 1
    resetStore();
    useCallbackAuthStore.getState().applySnapshot({
      ...baseSnapshot,
      startedAt: 0,
      uptimeMs: 300,
      recentSamples: [
        { at: 50, reason: 'expired', tool: 't', catId: 'opus' },
        { at: 150, reason: 'expired', tool: 't', catId: 'opus' },
        { at: 250, reason: 'expired', tool: 't', catId: 'opus' },
      ],
      recent24h: { totalFailures: 3, byReason: { expired: 3 }, byTool: { t: 3 }, byCat: { opus: 3 } },
      unviewedFailures24h: 3,
      lastViewedAt: 0,
    });

    // markViewed #1: server cutoff = 200 (newer)
    let originalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    (globalThis as { fetch?: typeof fetch }).fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, viewedAt: 200, lastViewedAt: 200 }),
      }) as Response) as typeof fetch;
    try {
      await useCallbackAuthStore.getState().markViewed();
    } finally {
      (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
    }
    expect(useCallbackAuthStore.getState().aggregate.unviewedFailures24h).toBe(1); // only 250
    expect(useCallbackAuthStore.getState().pendingMarkViewedCutoff).toBe(200);

    // markViewed #2: server cutoff = 100 (older, response-order race)
    originalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    (globalThis as { fetch?: typeof fetch }).fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, viewedAt: 100, lastViewedAt: 100 }),
      }) as Response) as typeof fetch;
    try {
      await useCallbackAuthStore.getState().markViewed();
    } finally {
      (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
    }
    // CRITICAL: badge stays at 1 (effectiveCutoff = max(200, 100) = 200)
    // Without round-6 fix: badge would re-inflate to 2 (filter against 100)
    expect(useCallbackAuthStore.getState().aggregate.unviewedFailures24h).toBe(1);
    expect(useCallbackAuthStore.getState().pendingMarkViewedCutoff).toBe(200); // stays monotonic
  });

  it('Cloud P2 round 5: pendingMarkViewedCutoff is monotonic across overlapping markViewed calls', async () => {
    // Race: two markViewed POSTs in flight (panel quick close → reopen on slow network).
    //   T0: markViewed #1 starts → server cutoff = 100
    //   T1: markViewed #2 starts → server cutoff = 200
    //   T2: markViewed #2 resolves first → store.pendingMarkViewedCutoff = 200
    //   T3: markViewed #1 resolves last → without monotonic, would regress to 100
    //   With monotonic Math.max, stays at 200 → previously-acked failures (101-200) stay acked
    resetStore();
    useCallbackAuthStore.getState().applySnapshot({
      ...baseSnapshot,
      startedAt: 0,
      uptimeMs: 50,
      recentSamples: [
        { at: 30, reason: 'expired', tool: 't', catId: 'opus' },
        { at: 150, reason: 'expired', tool: 't', catId: 'opus' }, // would re-appear if cutoff regressed to 100
      ],
      recent24h: { totalFailures: 2, byReason: { expired: 2 }, byTool: { t: 2 }, byCat: { opus: 2 } },
      unviewedFailures24h: 2,
      lastViewedAt: 0,
    });

    // First markViewed (newer cutoff = 200)
    let originalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    (globalThis as { fetch?: typeof fetch }).fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, viewedAt: 200, lastViewedAt: 200 }),
      }) as Response) as typeof fetch;
    try {
      await useCallbackAuthStore.getState().markViewed();
    } finally {
      (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
    }
    expect(useCallbackAuthStore.getState().pendingMarkViewedCutoff).toBe(200);

    // Second markViewed completes with OLDER cutoff = 100 (race, response-order issue)
    originalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    (globalThis as { fetch?: typeof fetch }).fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, viewedAt: 100, lastViewedAt: 100 }),
      }) as Response) as typeof fetch;
    try {
      await useCallbackAuthStore.getState().markViewed();
    } finally {
      (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
    }
    // Cutoff stays at 200 (Math.max), NOT regressed to 100
    expect(useCallbackAuthStore.getState().pendingMarkViewedCutoff).toBe(200);
  });

  it('Cloud P2 round 5: same-ms failure counts as unviewed (>=) — safe-side bias', async () => {
    resetStore();
    const snap: CallbackAuthSnapshot = {
      ...baseSnapshot,
      startedAt: 0,
      uptimeMs: 1_000_000, // viewedUpTo = 1_000_000
      recentSamples: [
        { at: 999_999, reason: 'expired', tool: 't', catId: 'opus' }, // pre-cutoff
        { at: 1_000_000, reason: 'expired', tool: 't', catId: 'opus' }, // EXACT cutoff — must count
        { at: 1_000_001, reason: 'expired', tool: 't', catId: 'opus' }, // post-cutoff
      ],
      recent24h: { totalFailures: 3, byReason: { expired: 3 }, byTool: { t: 3 }, byCat: { opus: 3 } },
      unviewedFailures24h: 3,
    };
    useCallbackAuthStore.getState().applySnapshot(snap);

    const originalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    (globalThis as { fetch?: typeof fetch }).fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, viewedAt: 1_000_000, lastViewedAt: 1_000_000 }),
      }) as Response) as typeof fetch;
    try {
      await useCallbackAuthStore.getState().markViewed();
    } finally {
      (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
    }

    // 2: the exact-cutoff sample (at=1_000_000) AND the post-cutoff (at=1_000_001) both unviewed
    // Without round-5 fix (strict `>`): 1 (only the post-cutoff one) — same-ms failure dropped
    expect(useCallbackAuthStore.getState().aggregate.unviewedFailures24h).toBe(2);
  });

  it('alpha #6 fix: panel mount markViewed clears all 24h failures (offline cat scenario)', async () => {
    // 铲屎官 alpha #6 root case: cat went offline after generating 60 failures,
    // user opens panel, badge should clear. Original viewedUpTo=snapshot 设计
    // didn't reliably clear (over-cautious). 新设计 markViewed POSTs without
    // body → server uses now() → lastViewedAt > all sample.at → optimistic
    // clear filters to 0.
    resetStore();
    const samples = Array.from({ length: 60 }, (_, i) => ({
      at: 1_000 + i * 10, // 60 samples at 1000-1590ms (all old)
      reason: 'expired',
      tool: 'register_pr_tracking',
      catId: 'opus',
    }));
    useCallbackAuthStore.getState().applySnapshot({
      ...baseSnapshot,
      startedAt: 0,
      uptimeMs: 2_000, // server snapshot fetched at 2_000
      recentSamples: samples,
      recent24h: {
        totalFailures: 60,
        byReason: { expired: 60 },
        byTool: { register_pr_tracking: 60 },
        byCat: { opus: 60 },
      },
      unviewedFailures24h: 60,
    });
    expect(useCallbackAuthStore.getState().aggregate.unviewedFailures24h).toBe(60);

    // Panel mounts → markViewed POSTs without body → server returns
    // lastViewedAt = "now" (e.g. 100_000, much later than all sample.at)
    const originalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    (globalThis as { fetch?: typeof fetch }).fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, viewedAt: 100_000, lastViewedAt: 100_000 }),
      }) as Response) as typeof fetch;
    try {
      await useCallbackAuthStore.getState().markViewed();
    } finally {
      (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
    }

    // CRITICAL: badge clears to 0 (all 60 samples have at < 100_000 cutoff)
    expect(useCallbackAuthStore.getState().aggregate.unviewedFailures24h).toBe(0);
    expect(useCallbackAuthStore.getState().pendingMarkViewedCutoff).toBe(100_000);
  });

  it('non-ok response: aggregate unchanged (badge surface remains)', async () => {
    resetStore();
    useCallbackAuthStore.getState().applySnapshot({
      ...baseSnapshot,
      recent24h: { totalFailures: 5, byReason: { expired: 5 }, byTool: {}, byCat: { opus: 5 } },
      unviewedFailures24h: 5,
    });
    expect(useCallbackAuthStore.getState().aggregate.unviewedFailures24h).toBe(5);

    const originalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    (globalThis as { fetch?: typeof fetch }).fetch = (async () =>
      ({
        ok: false,
        status: 500,
        json: async () => ({ error: 'server error' }),
      }) as Response) as typeof fetch;

    try {
      await useCallbackAuthStore.getState().markViewed();
    } finally {
      (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
    }

    expect(useCallbackAuthStore.getState().aggregate.unviewedFailures24h).toBe(5);
  });
});

describe('buildAggregate (topReasons/topTools sort + cap)', () => {
  it('sorts top reasons descending and caps to 5', () => {
    const agg = buildAggregate({
      ...baseSnapshot,
      recent24h: {
        totalFailures: 21,
        byReason: { expired: 10, invalid_token: 1, unknown_invocation: 5, stale_invocation: 2, missing_creds: 3 },
        byTool: {},
        byCat: {},
      },
    });
    expect(agg.topReasons).toEqual([
      { name: 'expired', count: 10 },
      { name: 'unknown_invocation', count: 5 },
      { name: 'missing_creds', count: 3 },
      { name: 'stale_invocation', count: 2 },
      { name: 'invalid_token', count: 1 },
    ]);
  });

  it('skips zero-count entries', () => {
    const agg = buildAggregate({
      ...baseSnapshot,
      recent24h: {
        totalFailures: 1,
        byReason: { expired: 1, invalid_token: 0 },
        byTool: { register_pr_tracking: 1 },
        byCat: {},
      },
    });
    expect(agg.topReasons.map((r) => r.name)).toEqual(['expired']);
    expect(agg.topTools.map((t) => t.name)).toEqual(['register_pr_tracking']);
  });
});
