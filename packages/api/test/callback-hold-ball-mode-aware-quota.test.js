/**
 * F167: mode-aware hold_ball quota — wakeWhen bypasses timer frequency cap.
 *
 * Root cause (eval:harness-ledger verdict C5/C6):
 * holdCounts Map was mode-blind — both wakeAfterMs (timer) and wakeWhen
 * (command custody) shared the same 3/~1h frequency counter. A cat that
 * used 3 timer holds exhausted the quota, then a legitimate wakeWhen
 * command-custody request got 429'd before ManagedRunner could register —
 * the completion callback never fired, leaving the cat in limbo.
 *
 * Fix: frequency counter only gates wakeAfterMs. wakeWhen is bounded by
 * single-active-runner + timeout (already enforced), not by call frequency.
 *
 * Safety invariant: single-active registry owner + bounded eventual cleanup
 * (≤5s overlap). Not strict single-live-process.
 *
 * [宪宪/claude-opus-4-6🐾]
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('hold-ball mode-aware quota (F167)', () => {
  async function loadModule() {
    return import('../dist/routes/callback-hold-ball-routes.js');
  }

  test('getTimerHoldCount returns 0 for unseen (threadId, catId)', async () => {
    const m = await loadModule();
    assert.equal(typeof m.getTimerHoldCount, 'function', 'getTimerHoldCount must be exported');
    assert.equal(m.getTimerHoldCount('t-mode-unseen', 'c-mode-unseen'), 0);
  });

  test('incrementTimerHoldCount climbs for timer mode only', async () => {
    const m = await loadModule();
    assert.equal(typeof m.incrementTimerHoldCount, 'function', 'incrementTimerHoldCount must be exported');
    const base = Date.now();
    assert.equal(m.incrementTimerHoldCount('t-mode-1', 'cat-timer', base), 1);
    assert.equal(m.incrementTimerHoldCount('t-mode-1', 'cat-timer', base + 1_000), 2);
    assert.equal(m.incrementTimerHoldCount('t-mode-1', 'cat-timer', base + 2_000), 3);
    assert.equal(m.getTimerHoldCount('t-mode-1', 'cat-timer', base + 3_000), 3);
  });

  test('timer count resets after HOLD_WINDOW_MS (same window semantic as before)', async () => {
    const m = await loadModule();
    const base = Date.now();
    m.incrementTimerHoldCount('t-mode-reset', 'cat-r', base);
    m.incrementTimerHoldCount('t-mode-reset', 'cat-r', base + 1_000);
    assert.equal(m.getTimerHoldCount('t-mode-reset', 'cat-r', base + 2_000), 2);
    const afterWindow = base + 1_000 + m.HOLD_WINDOW_MS + 1;
    assert.equal(m.getTimerHoldCount('t-mode-reset', 'cat-r', afterWindow), 0);
  });

  test('3 timer holds → wakeWhen still allowed (command bypasses timer quota)', async () => {
    const m = await loadModule();
    const base = Date.now();
    // Exhaust timer quota
    m.incrementTimerHoldCount('t-bypass-1', 'cat-bypass', base);
    m.incrementTimerHoldCount('t-bypass-1', 'cat-bypass', base + 1_000);
    m.incrementTimerHoldCount('t-bypass-1', 'cat-bypass', base + 2_000);
    assert.equal(m.getTimerHoldCount('t-bypass-1', 'cat-bypass', base + 3_000), 3);
    // Timer quota exhausted — but this should NOT affect wakeWhen
    assert.equal(
      m.getTimerHoldCount('t-bypass-1', 'cat-bypass', base + 3_000) >= m.MAX_HOLDS_PER_WINDOW,
      true,
      'timer quota should be exhausted',
    );
    // wakeWhen mode does NOT check timer count — it relies on single-active-runner
    // This is verified at the route level; at the counter level, we just confirm
    // there is no "command hold count" gate function that blocks
    assert.equal(
      typeof m.isCommandHoldAllowed,
      'function',
      'isCommandHoldAllowed must be exported for route-level gating',
    );
    // Command hold is always allowed (bounded by single-runner, not frequency)
    assert.equal(m.isCommandHoldAllowed('t-bypass-1', 'cat-bypass'), true);
  });

  test('4th timer hold is rejected (timer cap still enforced)', async () => {
    const m = await loadModule();
    const base = Date.now();
    m.incrementTimerHoldCount('t-cap-1', 'cat-cap', base);
    m.incrementTimerHoldCount('t-cap-1', 'cat-cap', base + 1_000);
    m.incrementTimerHoldCount('t-cap-1', 'cat-cap', base + 2_000);
    const count = m.getTimerHoldCount('t-cap-1', 'cat-cap', base + 3_000);
    assert.equal(count >= m.MAX_HOLDS_PER_WINDOW, true, '4th timer should be blocked');
  });

  test('backward compat: getHoldCount/incrementHoldCount still exported', async () => {
    const m = await loadModule();
    // Legacy names should still work (they delegate to timer variants)
    assert.equal(typeof m.getHoldCount, 'function', 'getHoldCount must remain exported');
    assert.equal(typeof m.incrementHoldCount, 'function', 'incrementHoldCount must remain exported');
  });

  test('holdMode appears in response shape constants', async () => {
    // This tests that the HOLD_MODE constant is exported for response building
    const m = await loadModule();
    assert.ok(m.HOLD_MODE_TIMER, 'HOLD_MODE_TIMER constant must be exported');
    assert.ok(m.HOLD_MODE_COMMAND, 'HOLD_MODE_COMMAND constant must be exported');
    assert.equal(m.HOLD_MODE_TIMER, 'timer');
    assert.equal(m.HOLD_MODE_COMMAND, 'command');
  });
});
