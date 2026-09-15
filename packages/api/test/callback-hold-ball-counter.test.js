/**
 * F167 C1 — hold-ball counter window semantic tests
 *
 * Review finding (gpt52 on PR #1289): the original wording was
 *   `MAX_CONSECUTIVE_HOLDS` + `maxConsecutiveHolds reached`
 * but the implementation is a single-bucket sliding ~1h window counter, not a true
 * consecutive counter. These tests lock in the window semantic so
 * future code/wording cannot drift back to "consecutive".
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('hold-ball counter — window semantic (F167 C1)', () => {
  async function loadModule() {
    return import('../dist/routes/callback-hold-ball-routes.js');
  }

  test('exports renamed constants: MAX_HOLDS_PER_WINDOW=3, HOLD_WINDOW_MS=1h', async () => {
    const m = await loadModule();
    assert.equal(m.MAX_HOLDS_PER_WINDOW, 3);
    assert.equal(m.HOLD_WINDOW_MS, 3_600_000);
  });

  test('does NOT export dead resetHoldCount (removed)', async () => {
    const m = await loadModule();
    assert.equal(m.resetHoldCount, undefined);
  });

  test('getHoldCount returns 0 for unseen (threadId, catId)', async () => {
    const { getHoldCount } = await loadModule();
    assert.equal(getHoldCount('t-unseen-1', 'c-unseen'), 0);
  });

  test('incrementHoldCount climbs 1→2→3 within window', async () => {
    const { incrementHoldCount, getHoldCount } = await loadModule();
    const base = Date.now();
    assert.equal(incrementHoldCount('t-win-1', 'cat-a', base), 1);
    assert.equal(incrementHoldCount('t-win-1', 'cat-a', base + 1_000), 2);
    assert.equal(incrementHoldCount('t-win-1', 'cat-a', base + 2_000), 3);
    assert.equal(getHoldCount('t-win-1', 'cat-a', base + 3_000), 3);
  });

  test('count resets after HOLD_WINDOW_MS elapses (window semantic, not true consecutive)', async () => {
    const { incrementHoldCount, getHoldCount, HOLD_WINDOW_MS } = await loadModule();
    const base = Date.now();
    incrementHoldCount('t-reset-1', 'cat-b', base);
    incrementHoldCount('t-reset-1', 'cat-b', base + 1_000);
    assert.equal(getHoldCount('t-reset-1', 'cat-b', base + 2_000), 2);
    // window check is `now - lastAt > HOLD_WINDOW_MS`; lastAt is base+1_000
    // so we need now > base + 1_000 + HOLD_WINDOW_MS to trigger the reset path
    const afterWindow = base + 1_000 + HOLD_WINDOW_MS + 1;
    assert.equal(getHoldCount('t-reset-1', 'cat-b', afterWindow), 0);
    // first hold after window → fresh count
    assert.equal(incrementHoldCount('t-reset-1', 'cat-b', afterWindow + 1), 1);
  });

  test('window expiry anchored to last successful increment — retryAt semantic (3-instance friction fix)', async () => {
    const { incrementHoldCount, getHoldCount, HOLD_WINDOW_MS, MAX_HOLDS_PER_WINDOW } = await loadModule();
    const base = Date.now();
    // Three holds spaced 10 minutes apart
    incrementHoldCount('t-retry-1', 'cat-r', base);
    incrementHoldCount('t-retry-1', 'cat-r', base + 600_000); // +10min
    incrementHoldCount('t-retry-1', 'cat-r', base + 1_200_000); // +20min
    assert.equal(getHoldCount('t-retry-1', 'cat-r', base + 1_200_000), MAX_HOLDS_PER_WINDOW);

    // NOT anchored to first hold — base+1h+1ms is only 40min after lastAt(base+20min)
    // getHoldCount has a delete-on-expire side effect, so check this BEFORE the expiry assertion
    const afterFirstHoldWindow = base + HOLD_WINDOW_MS + 1;
    assert.equal(
      getHoldCount('t-retry-1', 'cat-r', afterFirstHoldWindow) > 0,
      true,
      'window slides forward with each successful hold — first hold + 1h does NOT clear',
    );

    // retryAt boundary: getHoldCount clears at strict >, so:
    //   lastAt + HOLD_WINDOW_MS     → still blocked (= not >)
    //   lastAt + HOLD_WINDOW_MS + 1 → cleared (first admit = retryAt)
    const lastAt = base + 1_200_000;

    // At lastAt + HOLD_WINDOW_MS → still 429 (retryAt - 1)
    assert.equal(
      getHoldCount('t-retry-1', 'cat-r', lastAt + HOLD_WINDOW_MS),
      MAX_HOLDS_PER_WINDOW,
      'strict > means lastAt + HOLD_WINDOW_MS is the LAST rejecting moment',
    );

    // At lastAt + HOLD_WINDOW_MS + 1 → cleared (this IS retryAt)
    assert.equal(
      getHoldCount('t-retry-1', 'cat-r', lastAt + HOLD_WINDOW_MS + 1),
      0,
      'lastAt + HOLD_WINDOW_MS + 1 is the first admit moment — retryAt must point here',
    );
  });

  test('distinct (threadId, catId) pairs are independent', async () => {
    const { incrementHoldCount, getHoldCount } = await loadModule();
    const base = Date.now();
    incrementHoldCount('t-iso-A', 'cat-x', base);
    incrementHoldCount('t-iso-A', 'cat-x', base + 100);
    incrementHoldCount('t-iso-B', 'cat-x', base + 200);
    assert.equal(getHoldCount('t-iso-A', 'cat-x', base + 300), 2);
    assert.equal(getHoldCount('t-iso-B', 'cat-x', base + 300), 1);
    assert.equal(getHoldCount('t-iso-A', 'cat-y', base + 300), 0);
  });
});
