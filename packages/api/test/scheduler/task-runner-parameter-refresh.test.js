import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { applyMigrations } from '../../dist/domains/memory/schema.js';
import { RunLedger } from '../../dist/infrastructure/scheduler/RunLedger.js';
import { TaskRunnerV2 } from '../../dist/infrastructure/scheduler/TaskRunnerV2.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
function spec(trigger, execute) {
  return {
    id: 'recurring',
    profile: 'poller',
    trigger,
    admission: { gate: async () => ({ run: true, workItems: [{ signal: 'go', subjectKey: 'k' }] }) },
    run: { overlap: 'skip', timeoutMs: 300_000, execute },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'drop' },
    enabled: () => true,
  };
}
describe('dynamic parameter refresh', () => {
  let db, runner, ledger;
  beforeEach(() => {
    db = new Database(':memory:');
    applyMigrations(db);
    ledger = new RunLedger(db);
    runner = new TaskRunnerV2({ logger: { info() {}, error() {} }, ledger });
  });
  afterEach(() => {
    runner.stop();
    db.close();
  });

  it('keeps the interval deadline and in-flight overlap while future ticks use the new spec', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_000_000 });
    const calls = [];
    let release;
    const trigger = { type: 'interval', ms: 60_000 };
    runner.start();
    runner.registerDynamic(
      spec(trigger, async () => {
        calls.push('old');
        await new Promise((resolve) => {
          release = resolve;
        });
      }),
      'recurring',
    );
    t.mock.timers.tick(60_000);
    await flush();
    assert.deepEqual(calls, ['old']);
    runner.refreshDynamic(
      spec(trigger, async () => {
        calls.push('new');
      }),
      'recurring',
    );
    t.mock.timers.tick(60_000);
    await flush();
    assert.deepEqual(calls, ['old'], 'refresh must not clear the running guard');
    assert.ok(ledger.query('recurring', 10).some((row) => row.outcome === 'SKIP_OVERLAP'));
    release();
    await flush();
    t.mock.timers.tick(30_000);
    runner.refreshDynamic(
      spec(trigger, async () => {
        calls.push('newest');
      }),
      'recurring',
    );
    t.mock.timers.tick(30_000);
    await flush();
    assert.deepEqual(calls, ['old', 'newest'], 'refresh must not postpone the existing next deadline');
    assert.equal(ledger.query('recurring', 10).filter((row) => row.outcome === 'RUN_DELIVERED').length, 2);
  });

  it('cron timer and misfire recovery consume the refreshed spec without duplicating a slot', async (t) => {
    const now = Date.parse('2026-11-05T10:00:00Z');
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now });
    const calls = [];
    const trigger = { type: 'cron', expression: '* * * * *', timezone: 'UTC' };
    runner.start();
    runner.registerDynamic(
      spec(trigger, async () => {
        calls.push('old');
      }),
      'recurring',
    );
    t.mock.timers.tick(30_000);
    runner.refreshDynamic(
      spec(trigger, async () => {
        calls.push('new');
      }),
      'recurring',
    );
    t.mock.timers.tick(30_000);
    await flush();
    await runner.checkCronMisfires();
    assert.deepEqual(calls, ['new']);
    t.mock.timers.tick(60_000);
    await flush();
    assert.deepEqual(calls, ['new', 'new']);
  });
});
