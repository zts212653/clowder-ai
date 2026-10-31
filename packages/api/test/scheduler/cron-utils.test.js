import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('cron-utils — getNextCronMs (backward compat)', () => {
  it('returns positive ms for valid expression', async () => {
    const { getNextCronMs } = await import('../../dist/infrastructure/scheduler/cron-utils.js');
    const ms = getNextCronMs('0 9 * * *');
    assert.ok(typeof ms === 'number');
    assert.ok(ms > 0, 'next cron occurrence should be in the future');
    assert.ok(ms <= 24 * 60 * 60 * 1000, 'daily cron should fire within 24h');
  });

  it('throws for invalid expression', async () => {
    const { getNextCronMs } = await import('../../dist/infrastructure/scheduler/cron-utils.js');
    assert.throws(() => getNextCronMs('not a cron'), /invalid|parse|validation|resolve/i);
  });
});

// ─── Cron boundary-race guard (F167 verdict 2026-05-29 fix) ──────────
//
// Bug: TaskRunnerV2 fires the same cron slot twice when wall-clock divergence
//      from the monotonic timer (NTP step-back, VM pause, container clock drift)
//      causes Date.now() to be before the target slot at callback time, and
//      `.finally` reschedules the same slot. See vhp_eval_a2a_2026_05_29T03_11_28Z_double_cron_fire.
//
// Fix: computeNextCronSlot accepts `lastFiredSlotMs` and advances past it so
//      the same slot can never be returned twice.

describe('cron-utils — computeNextCronSlot (boundary-race guard)', () => {
  it('returns next cron slot when no prior fire', async () => {
    const { computeNextCronSlot } = await import('../../dist/infrastructure/scheduler/cron-utils.js');
    // 2026-05-29 02:00:00 UTC → next "0 3 * * *" slot = 2026-05-29 03:00:00 UTC
    const now = Date.UTC(2026, 4, 29, 2, 0, 0, 0);
    const next = computeNextCronSlot('0 3 * * *', 'UTC', now, undefined);
    assert.equal(next, Date.UTC(2026, 4, 29, 3, 0, 0, 0));
  });

  it('BOUNDARY RACE: now is before slot, lastFired equals that slot → advance to next day', async () => {
    // Repro the production bug:
    //   - setTimeout fires at 02:59:59.860 UTC (wall clock behind monotonic due to NTP/clock adjustment)
    //   - executePipeline marks cronSlotFired = 03:00:00.000
    //   - executePipeline returns fast (~90ms); .finally runs at 02:59:59.95X
    //   - Without guard: parsed.next() with currentDate=02:59:59.95X returns
    //     03:00:00.000 again → second fire in the same slot.
    //   - With guard: advance past lastFired → next day's 03:00:00.000.
    const { computeNextCronSlot } = await import('../../dist/infrastructure/scheduler/cron-utils.js');
    const now = Date.UTC(2026, 4, 29, 2, 59, 59, 950); // .finally running, still before slot
    const lastFired = Date.UTC(2026, 4, 29, 3, 0, 0, 0); // today's 03:00 already fired
    const next = computeNextCronSlot('0 3 * * *', 'UTC', now, lastFired);
    assert.equal(next, Date.UTC(2026, 4, 30, 3, 0, 0, 0), 'must skip the already-fired slot and land on the next day');
  });

  it('returns next slot when lastFired is older than current next (normal case)', async () => {
    const { computeNextCronSlot } = await import('../../dist/infrastructure/scheduler/cron-utils.js');
    // Now is 04:00 today, yesterday's 03:00 already fired → next is tomorrow 03:00.
    const now = Date.UTC(2026, 4, 29, 4, 0, 0, 0);
    const lastFired = Date.UTC(2026, 4, 28, 3, 0, 0, 0); // yesterday's slot
    const next = computeNextCronSlot('0 3 * * *', 'UTC', now, lastFired);
    assert.equal(next, Date.UTC(2026, 4, 30, 3, 0, 0, 0));
  });

  it('advances multiple slots when lastFired is in the future (defensive against clock skew)', async () => {
    const { computeNextCronSlot } = await import('../../dist/infrastructure/scheduler/cron-utils.js');
    const now = Date.UTC(2026, 4, 29, 2, 0, 0, 0);
    // Pretend tomorrow's slot was already fired (e.g., manual triggerNow + retroactive marking).
    const lastFired = Date.UTC(2026, 4, 30, 3, 0, 0, 0);
    const next = computeNextCronSlot('0 3 * * *', 'UTC', now, lastFired);
    assert.equal(next, Date.UTC(2026, 4, 31, 3, 0, 0, 0));
  });

  it('handles per-minute cron with sub-minute boundary race', async () => {
    // Same race shape but on a per-minute cron.
    const { computeNextCronSlot } = await import('../../dist/infrastructure/scheduler/cron-utils.js');
    const now = Date.UTC(2026, 4, 29, 12, 0, 59, 980); // 12:00:59.980, before 12:01 slot
    const lastFired = Date.UTC(2026, 4, 29, 12, 1, 0, 0); // 12:01 already fired
    const next = computeNextCronSlot('* * * * *', 'UTC', now, lastFired);
    assert.equal(next, Date.UTC(2026, 4, 29, 12, 2, 0, 0));
  });

  it('respects timezone option (Asia/Shanghai)', async () => {
    const { computeNextCronSlot } = await import('../../dist/infrastructure/scheduler/cron-utils.js');
    // Cron "0 11 * * *" in Asia/Shanghai (UTC+8) = 03:00 UTC.
    // Now is 2026-05-29 02:59:59.950 UTC → next slot today = 03:00 UTC.
    const now = Date.UTC(2026, 4, 29, 2, 59, 59, 950);
    const next = computeNextCronSlot('0 11 * * *', 'Asia/Shanghai', now, undefined);
    assert.equal(next, Date.UTC(2026, 4, 29, 3, 0, 0, 0));
  });

  it('throws for invalid expression (same contract as getNextCronMs)', async () => {
    const { computeNextCronSlot } = await import('../../dist/infrastructure/scheduler/cron-utils.js');
    assert.throws(
      () => computeNextCronSlot('not a cron', 'UTC', Date.UTC(2026, 4, 29, 0, 0, 0, 0), undefined),
      /invalid|parse|validation|resolve/i,
    );
  });

  it('severely late trigger (cross-slot): timer lag beyond one full cron period', async () => {
    // When event-loop lag causes setTimeout to fire well past the target slot,
    // cronSlotFired records the *expected* slot (nextSlotMs), not the actual
    // trigger time. The next computeNextCronSlot must still advance correctly.
    const { computeNextCronSlot } = await import('../../dist/infrastructure/scheduler/cron-utils.js');
    // Target was 03:00 today, but timer fired at 04:30 (1.5h late, past the slot).
    // lastFired = 03:00 (the expected slot that was marked synchronously).
    const now = Date.UTC(2026, 4, 29, 4, 30, 0, 0);
    const lastFired = Date.UTC(2026, 4, 29, 3, 0, 0, 0);
    const next = computeNextCronSlot('0 3 * * *', 'UTC', now, lastFired);
    // Next slot is tomorrow 03:00 — same as if the timer had fired on time.
    assert.equal(next, Date.UTC(2026, 4, 30, 3, 0, 0, 0), 'late trigger must still advance to the next future slot');
  });

  it('throws when max iterations exceeded (dirty far-future lastFiredSlotMs)', async () => {
    const { computeNextCronSlot } = await import('../../dist/infrastructure/scheduler/cron-utils.js');
    const now = Date.UTC(2026, 4, 29, 2, 0, 0, 0);
    // lastFired set to ~3 years in the future — per-minute cron would need
    // >1.5M iterations to advance past it, exceeding the 1440 cap.
    const lastFired = Date.UTC(2029, 4, 29, 3, 0, 0, 0);
    assert.throws(() => computeNextCronSlot('* * * * *', 'UTC', now, lastFired), /exceeded 1440 iterations/);
  });

  it('undefined lastFiredSlotMs is treated as no guard (initial scheduling)', async () => {
    const { computeNextCronSlot } = await import('../../dist/infrastructure/scheduler/cron-utils.js');
    const now = Date.UTC(2026, 4, 29, 2, 59, 59, 950);
    // Without lastFired guard, returns today's 03:00 even though we're milliseconds before it.
    const next = computeNextCronSlot('0 3 * * *', 'UTC', now, undefined);
    assert.equal(next, Date.UTC(2026, 4, 29, 3, 0, 0, 0));
  });
});
