import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';

describe('TaskRunnerV2', () => {
  let db, runner, ledger;
  const noop = () => {};
  const silentLogger = { info: noop, error: noop };

  beforeEach(async () => {
    db = new Database(':memory:');
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    const { RunLedger } = await import('../../dist/infrastructure/scheduler/RunLedger.js');
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    applyMigrations(db);
    ledger = new RunLedger(db);
    runner = new TaskRunnerV2({ logger: silentLogger, ledger });
  });

  afterEach(() => {
    if (runner) runner.stop();
  });

  it('registers and lists tasks', () => {
    runner.register({
      id: 'test-task',
      profile: 'awareness',
      trigger: { type: 'interval', ms: 60000 },
      admission: { gate: async () => ({ run: false, reason: 'test' }) },
      run: { overlap: 'skip', timeoutMs: 5000, execute: async () => {} },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
    });
    assert.deepEqual(runner.getRegisteredTasks(), ['test-task']);
  });

  it('rejects duplicate task ids', () => {
    const task = {
      id: 'dup',
      profile: 'poller',
      trigger: { type: 'interval', ms: 1000 },
      admission: { gate: async () => ({ run: false, reason: 'no' }) },
      run: { overlap: 'skip', timeoutMs: 5000, execute: async () => {} },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
    };
    runner.register(task);
    assert.throws(() => runner.register(task), /duplicate/i);
  });

  it('gate run:false → SKIP_NO_SIGNAL in ledger (whenNoSignal = record)', async () => {
    runner.register({
      id: 'skip-test',
      profile: 'poller',
      trigger: { type: 'interval', ms: 999999 },
      admission: { gate: async () => ({ run: false, reason: 'nothing new' }) },
      run: { overlap: 'skip', timeoutMs: 5000, execute: async () => {} },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'record' },
      enabled: () => true,
    });
    await runner.triggerNow('skip-test');
    const rows = ledger.query('skip-test', 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'SKIP_NO_SIGNAL');
  });

  it('gate run:false + whenNoSignal=drop → no ledger entry', async () => {
    runner.register({
      id: 'drop-test',
      profile: 'awareness',
      trigger: { type: 'interval', ms: 999999 },
      admission: { gate: async () => ({ run: false, reason: 'quiet' }) },
      run: { overlap: 'skip', timeoutMs: 5000, execute: async () => {} },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
    });
    await runner.triggerNow('drop-test');
    const rows = ledger.query('drop-test', 10);
    assert.equal(rows.length, 0);
  });

  it('gate run:true with workItems → execute per item → RUN_DELIVERED per subject', async () => {
    const calls = [];
    runner.register({
      id: 'run-test',
      profile: 'poller',
      trigger: { type: 'interval', ms: 999999 },
      admission: {
        gate: async () => ({
          run: true,
          workItems: [
            { signal: { count: 3 }, subjectKey: 'pr-42' },
            { signal: { count: 1 }, subjectKey: 'pr-99' },
          ],
        }),
      },
      run: {
        overlap: 'skip',
        timeoutMs: 5000,
        execute: async (signal, key) => {
          calls.push({ signal, key });
        },
      },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
    });
    await runner.triggerNow('run-test');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].signal, { count: 3 });
    assert.equal(calls[0].key, 'pr-42');
    assert.equal(calls[1].key, 'pr-99');
    const rows = ledger.query('run-test', 10);
    assert.equal(rows.length, 2);
    const subjects = rows.map((r) => r.subject_key).sort();
    assert.deepEqual(subjects, ['pr-42', 'pr-99']);
    assert.ok(rows.every((r) => r.outcome === 'RUN_DELIVERED'));
  });

  it('execute throws for one workItem → RUN_FAILED for that subject only', async () => {
    runner.register({
      id: 'partial-fail',
      profile: 'poller',
      trigger: { type: 'interval', ms: 999999 },
      admission: {
        gate: async () => ({
          run: true,
          workItems: [
            { signal: 'ok', subjectKey: 'a' },
            { signal: 'boom', subjectKey: 'b' },
          ],
        }),
      },
      run: {
        overlap: 'skip',
        timeoutMs: 5000,
        execute: async (signal) => {
          if (signal === 'boom') throw new Error('boom');
        },
      },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
    });
    await runner.triggerNow('partial-fail');
    const rows = ledger.query('partial-fail', 10);
    assert.equal(rows.length, 2);
    const bySubject = Object.fromEntries(rows.map((r) => [r.subject_key, r.outcome]));
    assert.equal(bySubject['a'], 'RUN_DELIVERED');
    assert.equal(bySubject['b'], 'RUN_FAILED');
  });

  it('disabled task → no execute, no ledger', async () => {
    let ran = false;
    runner.register({
      id: 'disabled-test',
      profile: 'awareness',
      trigger: { type: 'interval', ms: 999999 },
      admission: { gate: async () => ({ run: true, workItems: [{ signal: 'x', subjectKey: 'y' }] }) },
      run: {
        overlap: 'skip',
        timeoutMs: 5000,
        execute: async () => {
          ran = true;
        },
      },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'record' },
      enabled: () => false,
    });
    await runner.triggerNow('disabled-test');
    assert.ok(!ran);
  });

  it('overlap guard — concurrent tick skipped + SKIP_OVERLAP in ledger', async () => {
    let callCount = 0;
    runner.register({
      id: 'overlap-test',
      profile: 'poller',
      trigger: { type: 'interval', ms: 999999 },
      admission: {
        gate: async () => ({ run: true, workItems: [{ signal: 'go', subjectKey: 'k' }] }),
      },
      run: {
        overlap: 'skip',
        timeoutMs: 5000,
        execute: async () => {
          callCount++;
          await new Promise((r) => setTimeout(r, 100));
        },
      },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
    });
    const p1 = runner.triggerNow('overlap-test');
    const p2 = runner.triggerNow('overlap-test');
    await Promise.all([p1, p2]);
    assert.equal(callCount, 1, 'second trigger should be skipped');
    const rows = ledger.query('overlap-test', 10);
    const skipRows = rows.filter((r) => r.outcome === 'SKIP_OVERLAP');
    assert.equal(skipRows.length, 1);
  });

  it('triggerNow throws for unknown task', async () => {
    await assert.rejects(() => runner.triggerNow('nope'), /unknown/i);
  });

  it('gate throw does not produce unhandled rejection on interval tick', async () => {
    const errors = [];
    const handler = (err) => errors.push(err);
    process.on('unhandledRejection', handler);
    try {
      runner.register({
        id: 'gate-boom',
        profile: 'poller',
        trigger: { type: 'interval', ms: 50 },
        admission: {
          gate: async () => {
            throw new Error('gate boom');
          },
        },
        run: { overlap: 'skip', timeoutMs: 5000, execute: async () => {} },
        state: { runLedger: 'sqlite' },
        outcome: { whenNoSignal: 'drop' },
        enabled: () => true,
      });
      runner.start();
      // Wait for at least one tick to fire
      await new Promise((r) => setTimeout(r, 150));
      runner.stop();
      // Allow microtask queue to flush
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(errors.length, 0, 'should have no unhandled rejections');
    } finally {
      process.removeListener('unhandledRejection', handler);
    }
  });

  it('execute exceeding timeoutMs is aborted with RUN_FAILED', async () => {
    let started = false;
    runner.register({
      id: 'timeout-test',
      profile: 'poller',
      trigger: { type: 'interval', ms: 999999 },
      admission: {
        gate: async () => ({ run: true, workItems: [{ signal: 'slow', subjectKey: 'k' }] }),
      },
      run: {
        overlap: 'skip',
        timeoutMs: 30,
        execute: async () => {
          started = true;
          await new Promise((r) => setTimeout(r, 200));
        },
      },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
    });
    await runner.triggerNow('timeout-test');
    assert.ok(started, 'execute should have started');
    const rows = ledger.query('timeout-test', 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'RUN_FAILED');
  });

  it('timeout does not cause concurrent reentry — overlap guard holds until execute settles', async () => {
    let maxActive = 0;
    let active = 0;
    runner.register({
      id: 'reentry-test',
      profile: 'poller',
      trigger: { type: 'interval', ms: 999999 },
      admission: {
        gate: async () => ({ run: true, workItems: [{ signal: 'go', subjectKey: 'k' }] }),
      },
      run: {
        overlap: 'skip',
        timeoutMs: 30,
        execute: async () => {
          active++;
          if (active > maxActive) maxActive = active;
          await new Promise((r) => setTimeout(r, 200));
          active--;
        },
      },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
    });

    // First trigger: will timeout after 30ms but execute runs for 200ms
    const p1 = runner.triggerNow('reentry-test');
    // Wait just past timeout but before execute finishes
    await new Promise((r) => setTimeout(r, 60));
    // Second trigger: should be blocked by overlap guard (execute still running)
    const p2 = runner.triggerNow('reentry-test');
    await Promise.all([p1, p2]);

    assert.equal(maxActive, 1, 'should never have >1 concurrent execute for same task');
    const rows = ledger.query('reentry-test', 10);
    const skipRows = rows.filter((r) => r.outcome === 'SKIP_OVERLAP');
    assert.equal(skipRows.length, 1, 'second trigger should get SKIP_OVERLAP');
  });

  it('actor resolver sets assigned_cat_id in ledger when task has actor spec', async () => {
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    const runnerWithResolver = new TaskRunnerV2({
      logger: silentLogger,
      ledger,
      actorResolver: (role, costTier) => {
        if (role === 'repo-watcher' && costTier === 'cheap') return 'codex';
        return null;
      },
    });
    runnerWithResolver.register({
      id: 'actor-test',
      profile: 'poller',
      trigger: { type: 'interval', ms: 999999 },
      admission: {
        gate: async () => ({ run: true, workItems: [{ signal: 'go', subjectKey: 'pr-1' }] }),
      },
      run: { overlap: 'skip', timeoutMs: 5000, execute: async () => {} },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
      actor: { role: 'repo-watcher', costTier: 'cheap' },
    });
    await runnerWithResolver.triggerNow('actor-test');
    const rows = ledger.query('actor-test', 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].assigned_cat_id, 'codex');
    runnerWithResolver.stop();
  });

  it('no actor spec → assigned_cat_id is null', async () => {
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    const runnerWithResolver = new TaskRunnerV2({
      logger: silentLogger,
      ledger,
      actorResolver: () => 'opus',
    });
    runnerWithResolver.register({
      id: 'no-actor-test',
      profile: 'poller',
      trigger: { type: 'interval', ms: 999999 },
      admission: {
        gate: async () => ({ run: true, workItems: [{ signal: 'go', subjectKey: 'k' }] }),
      },
      run: { overlap: 'skip', timeoutMs: 5000, execute: async () => {} },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
      // no actor field
    });
    await runnerWithResolver.triggerNow('no-actor-test');
    const rows = ledger.query('no-actor-test', 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].assigned_cat_id, null);
    runnerWithResolver.stop();
  });
});
