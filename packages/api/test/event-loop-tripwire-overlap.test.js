import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { harness, waitForElapsedGap } from './helpers/event-loop-tripwire-harness.js';

test('pair fixture waits the full elapsed gap when a timer returns early', async () => {
  let elapsed = 0;
  let firstTimer = true;
  await waitForElapsedGap(80, {
    now: () => elapsed,
    sleep: async (ms) => {
      elapsed += firstTimer ? ms - 1.5 : ms;
      firstTimer = false;
    },
  });
  assert.ok(elapsed >= 80, `fixture resumed after only ${elapsed}ms`);
});

for (const gap of [80, 95, 105, 115, 125]) {
  test(`two real API blockers separated by ${gap}ms remain application stall events`, { timeout: 10000 }, async (t) => {
    const h = await harness(t);
    h.child.send({ type: 'pair', gap });
    const observed = await h.wait((message) => message.type === 'pair-done');
    assert.ok(observed.work > 0);
    assert.ok(observed.secondStarted - observed.firstEnded >= gap - 1);
    const deadline = performance.now() + 1000;
    const completed = () =>
      h.messages
        .filter(
          (message) =>
            message.type === 'log' &&
            message.entry.phase === 'complete' &&
            ['event_loop_stall', 'event_loop_observer_self'].includes(message.entry.kind),
        )
        .map((message) => message.entry);
    while (completed().length < 2 && performance.now() < deadline) await delay(15);
    assert.equal(completed().length, 2);
    assert.ok(
      completed().every((entry) => entry.kind === 'event_loop_stall'),
      JSON.stringify(completed().map(({ kind, episode, durationMs }) => ({ kind, episode, durationMs }))),
    );
    for (const entry of completed()) {
      assert.ok(Number.isFinite(entry.controlOverlapMs) && entry.controlOverlapMs >= 0);
      assert.ok(entry.controlOverlapMs <= entry.durationMs + 0.002);
    }
    t.diagnostic(
      JSON.stringify({
        requestedGapMs: gap,
        actualGapMs: observed.secondStarted - observed.firstEnded,
        completed: completed().map(({ kind, episode, controlOverlapMs, durationMs }) => ({
          kind,
          episode,
          controlOverlapMs,
          durationMs,
        })),
        controlCommands: h.messages
          .filter((message) => message.entry?.kind === 'event_loop_profiler_control')
          .map((message) => ({ method: message.entry.method, controlMs: message.entry.controlMs })),
      }),
    );
  });
}
