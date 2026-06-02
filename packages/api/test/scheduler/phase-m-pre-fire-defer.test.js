/**
 * F167 Phase M — pre-fire defer policy (scheduler-generic mechanism, hold_ball activates it)
 *
 * Problem: a hold wake fires on schedule, but if the target thread is busy (cat
 * mid-work / active invocation), the wake currently enqueues a STALE message
 * (frozen reason/nextStep) → "history replay". Root insight (codex/gpt-5.5):
 * reminder.execute is already too late (deliver-or-fail, then once-task retire),
 * so the defer must happen PRE-FIRE — before executePipeline, in scheduleOnceTick.
 *
 * Mechanism is generic (TaskSpec.firePolicy.deferWhileThreadBusy); activation is
 * hold_ball-specific (set in the reminder task params at registration). The busy
 * signal is the scheduler's own mechanical occupancy check — NOT PR-tracking
 * subject binding (KD-27 safe).
 *
 * NOTE: register() only pushes; start() schedules. So register-then-start.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('TaskRunnerV2 — Phase M pre-fire defer policy', () => {
  let db, ledger, TaskRunnerV2;
  const silentLogger = { info: () => {}, error: () => {} };

  beforeEach(async () => {
    db = new Database(':memory:');
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    const { RunLedger } = await import('../../dist/infrastructure/scheduler/RunLedger.js');
    ({ TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js'));
    applyMigrations(db);
    ledger = new RunLedger(db);
  });

  function makeDeferTask(executedRef, overrides = {}) {
    return {
      id: 'defer-once',
      profile: 'awareness',
      trigger: { type: 'once', fireAt: Date.now() + 25 },
      firePolicy: { deferWhileThreadBusy: true, threadId: 't1', deferIntervalMs: 25, maxDefers: 5, ...overrides },
      admission: { gate: async () => ({ run: true, workItems: [{ signal: 's', subjectKey: 'thread-t1' }] }) },
      run: {
        overlap: 'skip',
        timeoutMs: 5000,
        execute: async () => {
          executedRef.n++;
          executedRef.at = Date.now();
        },
      },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
    };
  }

  it('defers (no execute) while thread is busy', async () => {
    const busy = true;
    const runner = new TaskRunnerV2({ logger: silentLogger, ledger, isThreadBusy: () => busy });
    const executed = { n: 0, at: 0 };
    runner.register(makeDeferTask(executed));
    runner.start();
    await sleep(120); // well past fireAt + several defer intervals
    assert.equal(executed.n, 0, 'busy thread → wake deferred, must NOT execute/deliver stale wake');
    runner.stop();
  });

  it('fires once thread becomes idle (catch-up)', async () => {
    let busy = true;
    const runner = new TaskRunnerV2({ logger: silentLogger, ledger, isThreadBusy: () => busy });
    const executed = { n: 0, at: 0 };
    runner.register(makeDeferTask(executed));
    runner.start();
    await sleep(70);
    assert.equal(executed.n, 0, 'still busy → deferred');
    busy = false;
    await sleep(70); // next defer re-arm finds thread idle → fires
    assert.equal(executed.n, 1, 'idle → catch-up fire exactly once');
    runner.stop();
  });

  it('force-fires after maxDefers to avoid infinite defer (bounded)', async () => {
    const runner = new TaskRunnerV2({ logger: silentLogger, ledger, isThreadBusy: () => true }); // always busy
    const executed = { n: 0, at: 0 };
    const t0 = Date.now();
    runner.register(makeDeferTask(executed, { maxDefers: 2, deferIntervalMs: 25 }));
    runner.start();
    await sleep(180); // fireAt(25) → defer1(+25) → defer2(+25) → force-fire (~75ms+)
    assert.equal(executed.n, 1, 'after maxDefers, force-fire even while busy (bounded, no infinite defer)');
    // force-fire must be DEFERRED, not an immediate fire — distinguishes from "no defer at all"
    assert.ok(
      executed.at - t0 >= 60,
      `force-fire should occur after ~maxDefers×interval of deferral, got ${executed.at - t0}ms`,
    );
    runner.stop();
  });
});
