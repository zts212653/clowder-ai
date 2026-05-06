/**
 * F183 Phase C2/C3 — BroadcastRateMonitor unit tests.
 *
 * Pure utility class. Verify sliding window math, threshold trigger,
 * dedup window, per-thread isolation, and admin reset.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BroadcastRateMonitor } from '../dist/infrastructure/websocket/BroadcastRateMonitor.js';

function makeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

describe('BroadcastRateMonitor (F183 Phase C2/C3)', () => {
  it('does not warn under threshold', () => {
    const warns = [];
    const clock = makeClock();
    const m = new BroadcastRateMonitor({
      rateThreshold: 5,
      windowMs: 1000,
      onWarn: (e) => warns.push(e),
      now: clock.now,
    });
    for (let i = 0; i < 5; i++) m.record('thread-A');
    assert.equal(warns.length, 0);
  });

  it('warns when rate exceeds threshold within window', () => {
    const warns = [];
    const clock = makeClock();
    const m = new BroadcastRateMonitor({
      rateThreshold: 5,
      windowMs: 1000,
      onWarn: (e) => warns.push(e),
      now: clock.now,
    });
    for (let i = 0; i < 6; i++) m.record('thread-A');
    assert.equal(warns.length, 1);
    assert.equal(warns[0].threadId, 'thread-A');
    assert.equal(warns[0].windowCount, 6);
    assert.equal(warns[0].threshold, 5);
    assert.equal(warns[0].windowMs, 1000);
  });

  it('expires entries outside sliding window', () => {
    const warns = [];
    const clock = makeClock();
    const m = new BroadcastRateMonitor({
      rateThreshold: 5,
      windowMs: 1000,
      onWarn: (e) => warns.push(e),
      now: clock.now,
    });
    for (let i = 0; i < 5; i++) m.record('thread-A');
    clock.advance(1500); // older than window
    for (let i = 0; i < 4; i++) m.record('thread-A'); // 4 in current window
    assert.equal(warns.length, 0);
    assert.equal(m.getStats('thread-A').windowCount, 4);
  });

  it('dedup: warns at most once per warnDedupMs per thread', () => {
    const warns = [];
    const clock = makeClock();
    const m = new BroadcastRateMonitor({
      rateThreshold: 2,
      windowMs: 1000,
      warnDedupMs: 5000,
      onWarn: (e) => warns.push(e),
      now: clock.now,
    });
    for (let i = 0; i < 3; i++) m.record('thread-A'); // 1st warn
    for (let i = 0; i < 3; i++) m.record('thread-A'); // would warn again, but dedup
    assert.equal(warns.length, 1);
    clock.advance(5001); // past dedup window
    for (let i = 0; i < 3; i++) m.record('thread-A'); // 2nd warn allowed
    assert.equal(warns.length, 2);
  });

  it('per-thread isolation', () => {
    const warns = [];
    const clock = makeClock();
    const m = new BroadcastRateMonitor({
      rateThreshold: 5,
      windowMs: 1000,
      onWarn: (e) => warns.push(e),
      now: clock.now,
    });
    for (let i = 0; i < 6; i++) m.record('thread-A'); // warns
    for (let i = 0; i < 3; i++) m.record('thread-B'); // does not warn
    assert.equal(warns.length, 1);
    assert.equal(warns[0].threadId, 'thread-A');
    assert.equal(m.getStats('thread-A').windowCount, 6);
    assert.equal(m.getStats('thread-B').windowCount, 3);
  });

  it('getStats reports current window count after expiry', () => {
    const clock = makeClock();
    const m = new BroadcastRateMonitor({ rateThreshold: 100, windowMs: 1000, now: clock.now });
    m.record('thread-A');
    m.record('thread-A');
    m.record('thread-A');
    assert.equal(m.getStats('thread-A').windowCount, 3);
    clock.advance(1500);
    assert.equal(m.getStats('thread-A').windowCount, 0);
  });

  it('reset clears single thread', () => {
    const warns = [];
    const clock = makeClock();
    const m = new BroadcastRateMonitor({
      rateThreshold: 2,
      onWarn: (e) => warns.push(e),
      now: clock.now,
    });
    for (let i = 0; i < 3; i++) m.record('thread-A');
    assert.equal(warns.length, 1);
    m.reset('thread-A');
    assert.equal(m.getStats('thread-A').windowCount, 0);
    assert.equal(m.getStats('thread-A').lastWarnAt, 0);
    // After reset, fresh threshold trigger works again
    for (let i = 0; i < 3; i++) m.record('thread-A');
    assert.equal(warns.length, 2);
  });

  it('resetAll clears every thread', () => {
    const clock = makeClock();
    const m = new BroadcastRateMonitor({ rateThreshold: 100, windowMs: 1000, now: clock.now });
    m.record('thread-A');
    m.record('thread-B');
    m.resetAll();
    assert.equal(m.getStats('thread-A').windowCount, 0);
    assert.equal(m.getStats('thread-B').windowCount, 0);
  });

  it('default threshold is 200 events / 1000ms', () => {
    const m = new BroadcastRateMonitor();
    const stats = m.getStats('thread-A');
    assert.equal(stats.threshold, 200);
    assert.equal(stats.windowMs, 1000);
  });

  it('warn event includes timestamp from injected clock', () => {
    const warns = [];
    const clock = makeClock(2_500_000);
    const m = new BroadcastRateMonitor({
      rateThreshold: 1,
      onWarn: (e) => warns.push(e),
      now: clock.now,
    });
    m.record('thread-A');
    m.record('thread-A');
    assert.equal(warns.length, 1);
    assert.equal(warns[0].timestamp, 2_500_000);
  });

  // 砚砚 R1 P1 — onWarn callback throw must NOT abort record() / broadcast.
  // Otherwise observability would cause the symptom it's there to detect.
  it('砚砚 R1 P1: onWarn throw does not propagate (best-effort observability)', () => {
    const m = new BroadcastRateMonitor({
      rateThreshold: 0,
      onWarn: () => {
        throw new Error('logger transport down');
      },
    });
    // Must not throw — the broadcast pipeline depends on this.
    assert.doesNotThrow(() => m.record('thread-A'));
    // Subsequent record calls also must not throw (warn debounce + idempotency)
    assert.doesNotThrow(() => m.record('thread-A'));
  });

  // 砚砚 R1 P2 — sliding window must be amortized O(1), not O(n) shift.
  // Cloud R2 P2: behavioral assertion (window count bounded), NOT wall-clock —
  // CI noise / host CPU contention made the prior `< 1000ms` assertion flaky.
  // O(n²) shift wouldn't fail this assertion either; it would fail by never
  // completing under node:test default timeout. So the assertion focuses on
  // proving head-index advanced (windowCount « N) rather than measuring time.
  it('砚砚 R1 P2: 10000 records keep window bounded (head-index, not shift)', () => {
    const clock = makeClock();
    const m = new BroadcastRateMonitor({
      rateThreshold: 100_000, // never warns; just measure record() throughput
      windowMs: 1000,
      now: clock.now,
    });
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      m.record('thread-A');
      // advance clock so half the entries expire continuously
      if (i % 2 === 0) clock.advance(2);
    }
    // 2ms cadence × 1000ms window ≈ 1000 live entries (NOT 10_000).
    // Head-index advancing means most stamps expired and got compacted.
    const stats = m.getStats('thread-A');
    assert.ok(
      stats.windowCount > 0 && stats.windowCount < 2000,
      `head-index should bound window count; got ${stats.windowCount} of ${N}`,
    );
  });

  it('砚砚 R1 P2: head-index compaction bounds memory under continuous traffic', () => {
    const clock = makeClock();
    const m = new BroadcastRateMonitor({
      rateThreshold: 100_000,
      windowMs: 100, // small window to maximize expiry
      now: clock.now,
    });
    // 5000 records over 50 seconds — most entries expire continuously.
    for (let i = 0; i < 5000; i++) {
      m.record('thread-A');
      clock.advance(10);
    }
    // After all this churn, live window count should still be small (not 5000).
    // Memory invariant: stamps array stays bounded by compaction.
    const stats = m.getStats('thread-A');
    assert.ok(
      stats.windowCount <= 11, // at most ~10 records in a 100ms window with 10ms cadence
      `live window count should stay bounded, got ${stats.windowCount}`,
    );
  });

  // Cloud R1 P2-B — boundary entries at exactly `cutoff` must expire.
  // Otherwise burst at t=0 + burst at t=windowMs → t=0 entries still counted
  // → false threshold trigger at boundary.
  it('cloud R1 P2-B: entries at exactly cutoff timestamp expire (no boundary overcount)', () => {
    const warns = [];
    const clock = makeClock(1000);
    const m = new BroadcastRateMonitor({
      rateThreshold: 5,
      windowMs: 1000,
      onWarn: (e) => warns.push(e),
      now: clock.now,
    });
    // Burst at t=1000
    for (let i = 0; i < 5; i++) m.record('thread-A');
    assert.equal(m.getStats('thread-A').windowCount, 5);
    // Advance by exactly windowMs (cutoff = 1000) — t=1000 entries should expire
    clock.advance(1000);
    // Burst at t=2000 — must NOT count old t=1000 entries
    for (let i = 0; i < 5; i++) m.record('thread-A');
    assert.equal(warns.length, 0, 'no false threshold trigger from boundary entries');
    assert.equal(m.getStats('thread-A').windowCount, 5);
  });

  // Cloud R1 P2-A — long-running API with many transient threadIds shouldn't
  // grow threadEmits map indefinitely.
  it('cloud R1 P2-A: opportunistic eviction sweeps expired thread state', () => {
    const clock = makeClock();
    const m = new BroadcastRateMonitor({
      rateThreshold: 100_000,
      windowMs: 100,
      now: clock.now,
    });
    // Create many transient threads (high-cardinality scenario)
    for (let i = 0; i < 1100; i++) {
      m.record(`transient-${i}`);
    }
    // Advance past window — all transients are expired
    clock.advance(200);
    // Trigger sweep by recording on a fresh thread
    m.record('fresh-thread');
    // After sweep: all transient threads' state is gone (only 'fresh-thread' remains)
    for (let i = 0; i < 1100; i++) {
      assert.equal(m.getStats(`transient-${i}`).windowCount, 0);
    }
  });

  it('cloud R1 P2-A: eviction skips active threads', () => {
    const clock = makeClock();
    const m = new BroadcastRateMonitor({
      rateThreshold: 100_000,
      windowMs: 1000,
      now: clock.now,
    });
    // Active thread keeps recording within window
    for (let i = 0; i < 1100; i++) {
      m.record(`expired-${i}`);
    }
    clock.advance(2000); // expire all
    m.record('active-thread'); // active before sweep trigger
    // Trigger sweep
    for (let i = 0; i < 50; i++) m.record('active-thread');
    // active-thread state preserved; expired-* gone
    assert.ok(m.getStats('active-thread').windowCount > 0);
    assert.equal(m.getStats('expired-0').windowCount, 0);
  });

  // Cloud R4 P2 — low-cardinality eviction. Prior code gated eviction on
  // `threadEmits.size >= 1024`, leaving low-cardinality deployments (e.g.,
  // a single noisy thread that bursts then idles) with their stamps retained
  // for the life of the process. Fix: drop the size threshold; throttle
  // (1 sweep per window) keeps cost bounded.
  it('cloud R4 P2: idle thread state evicted below 1024-thread threshold', () => {
    const clock = makeClock();
    const m = new BroadcastRateMonitor({
      rateThreshold: 100_000,
      windowMs: 1000,
      now: clock.now,
    });
    // Single noisy thread bursts then goes idle (low-cardinality scenario)
    for (let i = 0; i < 500; i++) m.record('noisy-thread');
    // Advance past window — noisy-thread now has all-expired stamps but
    // would have stayed in the map under the prior `size >= 1024` gate.
    clock.advance(2000);
    // Any subsequent record (even on a fresh thread) triggers eviction
    m.record('observer');
    // Behavioral verification: noisy-thread state is gone
    assert.equal(
      m.getStats('noisy-thread').windowCount,
      0,
      'noisy thread should report no live entries after window expires',
    );
    assert.ok(m.sweepCount >= 1, 'eviction should run even in low-cardinality (< 1024 threads)');
  });

  // Cloud R2 P1 — eviction sweep must NOT run on every record() past 1024
  // threads. Prior code ran a full O(n) map walk per emit once threshold was
  // crossed → broadcast pipeline becomes the bottleneck it's there to detect.
  // Throttle: at most one sweep per windowMs.
  it('cloud R2 P1: eviction sweep throttled to once per window', () => {
    const clock = makeClock();
    const m = new BroadcastRateMonitor({
      rateThreshold: 100_000,
      windowMs: 1000,
      now: clock.now,
    });
    // Fill above threshold — first crossing triggers sweep #1
    for (let i = 0; i < 1100; i++) m.record(`thread-${i}`);
    const sweepsAfterFill = m.sweepCount;
    assert.ok(sweepsAfterFill >= 1, 'expected at least one sweep after crossing threshold');
    // 200 more records within same window must NOT trigger more sweeps
    for (let i = 0; i < 200; i++) m.record('thread-0');
    assert.equal(
      m.sweepCount,
      sweepsAfterFill,
      `no additional sweeps within same window; got ${m.sweepCount - sweepsAfterFill} extra`,
    );
    // Advance past window — next record may trigger another sweep
    clock.advance(1001);
    m.record('thread-0');
    assert.equal(m.sweepCount, sweepsAfterFill + 1, 'one additional sweep after window elapsed');
  });

  // 砚砚 R5 P2 — switching default to `performance.now()` changed the time
  // base from epoch ms (~1.78e12) to process-relative ms (starts at 0). The
  // `0` sentinel for "never warned/swept" no longer falls below the time
  // axis — early process state `ts < windowMs / warnDedupMs` would falsely
  // gate the first sweep / first warn. Sentinel must be `-Infinity` so
  // `ts - sentinel >= window` is always true on first call.
  it('砚砚 R5 P2: first warn fires even when ts < warnDedupMs (process start)', () => {
    const warns = [];
    const clock = makeClock(100); // simulate process started 100ms ago
    const m = new BroadcastRateMonitor({
      rateThreshold: 1,
      warnDedupMs: 5000,
      onWarn: (e) => warns.push(e),
      now: clock.now,
    });
    m.record('thread-A');
    m.record('thread-A'); // 2 records → over rateThreshold=1
    // With `?? 0` sentinel: ts=100, lastWarn=0; 100-0=100 < 5000 → suppressed
    // With `undefined` check: lastWarn undefined → bypass dedup → warn fires
    assert.equal(warns.length, 1, 'first warn must not be gated by sentinel collision');
  });

  it('砚砚 R5 P2: first sweep triggers when ts < windowMs (process start)', () => {
    const clock = makeClock(100); // simulate early process
    const m = new BroadcastRateMonitor({
      rateThreshold: 100_000,
      windowMs: 1000,
      now: clock.now,
    });
    for (let i = 0; i < 1100; i++) m.record(`thread-${i}`);
    // With `lastEvictAt = 0`: ts=100, 100-0=100 < 1000 → sweep gated forever
    // With `lastEvictAt = -Infinity`: bypass throttle → sweep fires once
    assert.ok(m.sweepCount >= 1, 'first eviction sweep must not be gated by sentinel collision');
  });

  it('high-frequency burst stress (200 events/sec sustained)', () => {
    const warns = [];
    const clock = makeClock();
    const m = new BroadcastRateMonitor({
      rateThreshold: 100,
      windowMs: 1000,
      warnDedupMs: 1000,
      onWarn: (e) => warns.push(e),
      now: clock.now,
    });
    // Simulate 5 seconds of 200 events/sec → 1000 events total
    for (let s = 0; s < 5; s++) {
      for (let i = 0; i < 200; i++) m.record('thread-A');
      clock.advance(1000);
    }
    // Each second window exceeds threshold; dedup=1000ms allows 1 warn per second
    // (5 windows + at-least 1 from initial trigger). 5 sustained warns.
    assert.ok(warns.length >= 4 && warns.length <= 6, `expected 4-6 warns, got ${warns.length}`);
  });
});
