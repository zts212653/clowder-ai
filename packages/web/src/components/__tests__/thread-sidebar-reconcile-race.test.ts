/**
 * Regression test: toggle-with-reconcile seq guard prevents stale GET from
 * overwriting a newer user intent.
 *
 * Imports the PRODUCTION createToggleWithReconcile module — not a copy.
 *
 * Scenario 1 (stale reconcile):
 *   1. User pins thread → PATCH fails (500)
 *   2. reconcile GET fires to fetch server truth
 *   3. Before GET returns, user unpins → new PATCH in flight (seq increments)
 *   4. GET returns with { pinned: true } — but seq has moved → must NOT apply
 *
 * Scenario 2 (normal reconcile):
 *   1. Toggle → PATCH fails → reconcile GET fires
 *   2. No newer toggle → GET result SHOULD apply
 */

import { describe, expect, it } from 'vitest';
import { createToggleWithReconcile, type FetchFn } from '../ThreadSidebar/toggle-with-reconcile';

// ---------- controlled promise helpers ----------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function mockResponse(ok: boolean, body: Record<string, unknown> = {}): Response {
  return {
    ok,
    json: () => Promise.resolve(body),
  } as Response;
}

// ---------- tests ----------

describe('createToggleWithReconcile (race regression)', () => {
  it('stale reconcile GET does not overwrite newer toggle intent', async () => {
    const updates: { id: string; val: boolean }[] = [];

    // Intercept fetch calls — we control when they resolve
    const fetchQueue: Deferred<Response>[] = [];
    const fakeFetch: FetchFn = () => {
      const d = deferred<Response>();
      fetchQueue.push(d);
      return d.promise;
    };

    const { toggle } = createToggleWithReconcile({
      fetch: fakeFetch,
      onUpdate: (id, val) => updates.push({ id, val }),
      field: 'pinned',
      siblingSeqMap: new Map(),
    });

    // Step 1: User pins thread → fires PATCH (fetchQueue[0])
    const toggle1 = toggle('t1', true);

    // Step 1a: PATCH returns 500 → reconcile fires GET (fetchQueue[1])
    fetchQueue[0].resolve(mockResponse(false));
    await toggle1; // toggle1 settles, reconcile GET is in flight

    // Step 2: User unpins → fires new PATCH (fetchQueue[2]), seq increments to 2
    const toggle2 = toggle('t1', false);

    // Step 3: Reconcile GET from step 1 returns { pinned: true }
    // But seq was 1 when reconcile started, now seq=2 → must NOT apply
    fetchQueue[1].resolve(mockResponse(true, { pinned: true }));
    await new Promise((r) => setTimeout(r, 0)); // let reconcile microtask run

    // Assert: stale GET should NOT have written pinned=true
    expect(updates.filter((u) => u.val === true)).toHaveLength(0);

    // Step 4: Second PATCH succeeds
    fetchQueue[2].resolve(mockResponse(true, { pinned: false }));
    await toggle2;

    // Final: store has exactly one update — pinned=false from the latest toggle
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({ id: 't1', val: false });
  });

  it('reconcile GET applies when no newer toggle has fired', async () => {
    const updates: { id: string; val: boolean }[] = [];

    const fetchQueue: Deferred<Response>[] = [];
    const fakeFetch: FetchFn = () => {
      const d = deferred<Response>();
      fetchQueue.push(d);
      return d.promise;
    };

    const { toggle } = createToggleWithReconcile({
      fetch: fakeFetch,
      onUpdate: (id, val) => updates.push({ id, val }),
      field: 'pinned',
      siblingSeqMap: new Map(),
    });

    // Toggle → PATCH fails → reconcile fires
    const t = toggle('t1', true);
    fetchQueue[0].resolve(mockResponse(false)); // PATCH 500
    await t;

    // Reconcile GET returns — no newer toggle, seq still 1 → APPLY
    fetchQueue[1].resolve(mockResponse(true, { pinned: false }));
    await new Promise((r) => setTimeout(r, 0));

    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({ id: 't1', val: false });
  });

  it('sibling field is reconciled with correct seq guard', async () => {
    const pinUpdates: { id: string; val: boolean }[] = [];
    const favUpdates: { id: string; val: boolean }[] = [];

    const fetchQueue: Deferred<Response>[] = [];
    const fakeFetch: FetchFn = () => {
      const d = deferred<Response>();
      fetchQueue.push(d);
      return d.promise;
    };

    const favSeqMap = new Map<string, number>();

    const { toggle } = createToggleWithReconcile({
      fetch: fakeFetch,
      onUpdate: (id, val) => pinUpdates.push({ id, val }),
      field: 'pinned',
      siblingSeqMap: favSeqMap,
      onUpdateSibling: (id, val) => favUpdates.push({ id, val }),
      siblingField: 'favorited',
    });

    // Toggle pin → PATCH fails → reconcile fires
    const t = toggle('t1', true);
    fetchQueue[0].resolve(mockResponse(false));
    await t;

    // Reconcile GET returns both pinned and favorited
    // favSeqMap has no entry for 't1' (=== 0) and expectedSiblingSeq was 0 → sibling APPLIES
    fetchQueue[1].resolve(mockResponse(true, { pinned: false, favorited: true }));
    await new Promise((r) => setTimeout(r, 0));

    expect(pinUpdates).toHaveLength(1);
    expect(pinUpdates[0]).toEqual({ id: 't1', val: false });
    expect(favUpdates).toHaveLength(1);
    expect(favUpdates[0]).toEqual({ id: 't1', val: true });
  });

  it('sibling field skipped when sibling seq has moved', async () => {
    const pinUpdates: { id: string; val: boolean }[] = [];
    const favUpdates: { id: string; val: boolean }[] = [];

    const fetchQueue: Deferred<Response>[] = [];
    const fakeFetch: FetchFn = () => {
      const d = deferred<Response>();
      fetchQueue.push(d);
      return d.promise;
    };

    const favSeqMap = new Map<string, number>();

    const { toggle } = createToggleWithReconcile({
      fetch: fakeFetch,
      onUpdate: (id, val) => pinUpdates.push({ id, val }),
      field: 'pinned',
      siblingSeqMap: favSeqMap,
      onUpdateSibling: (id, val) => favUpdates.push({ id, val }),
      siblingField: 'favorited',
    });

    // Toggle pin → PATCH fails → reconcile fires
    const t = toggle('t1', true);
    fetchQueue[0].resolve(mockResponse(false));
    await t;

    // Simulate: fav toggle happened while reconcile is in flight → favSeqMap moves
    favSeqMap.set('t1', 1);

    // Reconcile GET returns — pin seq matches (applies), but fav seq moved (skips)
    fetchQueue[1].resolve(mockResponse(true, { pinned: false, favorited: true }));
    await new Promise((r) => setTimeout(r, 0));

    expect(pinUpdates).toHaveLength(1);
    expect(favUpdates).toHaveLength(0); // sibling skipped because favSeqMap moved
  });
});
