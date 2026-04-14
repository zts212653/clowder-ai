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

describe('TaskRunnerV2 — dynamic task first-tick deferral', () => {
  let db, ledger;
  const noop = () => {};
  const silentLogger = { info: noop, error: noop };

  beforeEach(async () => {
    db = new Database(':memory:');
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    const { RunLedger } = await import('../../dist/infrastructure/scheduler/RunLedger.js');
    applyMigrations(db);
    ledger = new RunLedger(db);
  });

  it('registerDynamic while runner started does NOT fire immediately (interval task)', async () => {
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    const runner = new TaskRunnerV2({ logger: silentLogger, ledger });
    let executeCount = 0;

    // Start the runner first (no tasks yet)
    runner.start();

    // Now register a dynamic task with a long interval
    runner.registerDynamic(
      {
        id: 'deferred-test',
        profile: 'awareness',
        trigger: { type: 'interval', ms: 60_000 },
        admission: {
          gate: async () => ({ run: true, workItems: [{ signal: 'go', subjectKey: 'k' }] }),
        },
        run: {
          overlap: 'skip',
          timeoutMs: 5000,
          execute: async () => {
            executeCount++;
          },
        },
        state: { runLedger: 'sqlite' },
        outcome: { whenNoSignal: 'drop' },
        enabled: () => true,
      },
      'dyn-def-1',
    );

    // Wait enough for setTimeout(0) to fire if it were scheduled
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(executeCount, 0, 'dynamic task should NOT fire immediately upon registration');
    runner.stop();
  });

  it('start() still fires built-in tasks immediately (backwards compat)', async () => {
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    const runner = new TaskRunnerV2({ logger: silentLogger, ledger });
    let executeCount = 0;

    // Register task BEFORE start (simulates boot-time built-in registration)
    runner.register({
      id: 'builtin-test',
      profile: 'poller',
      trigger: { type: 'interval', ms: 60_000 },
      admission: {
        gate: async () => ({ run: true, workItems: [{ signal: 'go', subjectKey: 'k' }] }),
      },
      run: {
        overlap: 'skip',
        timeoutMs: 5000,
        execute: async () => {
          executeCount++;
        },
      },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
    });

    runner.start();

    // Wait for setTimeout(0) to fire
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(executeCount, 1, 'built-in task should fire immediately on start()');
    runner.stop();
  });
});

describe('TaskRunnerV2 — self-echo suppression (AC-D2)', () => {
  let db, ledger, emissionStore;
  const noop = () => {};
  const silentLogger = { info: noop, error: noop };

  beforeEach(async () => {
    db = new Database(':memory:');
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    const { RunLedger } = await import('../../dist/infrastructure/scheduler/RunLedger.js');
    const { EmissionStore } = await import('../../dist/infrastructure/scheduler/EmissionStore.js');
    applyMigrations(db);
    ledger = new RunLedger(db);
    emissionStore = new EmissionStore(db);
  });

  it('active emission on thread → workItem skipped with SKIP_SELF_ECHO', async () => {
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    const runner = new TaskRunnerV2({ logger: silentLogger, ledger, emissionStore });
    const executed = [];
    runner.register({
      id: 'echo-test',
      profile: 'poller',
      trigger: { type: 'interval', ms: 999999 },
      admission: {
        gate: async () => ({
          run: true,
          workItems: [
            { signal: 'go', subjectKey: 'thread-abc123' },
            { signal: 'go', subjectKey: 'thread-def456' },
          ],
        }),
      },
      run: {
        overlap: 'skip',
        timeoutMs: 5000,
        execute: async (_signal, key) => {
          executed.push(key);
        },
      },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
    });

    // Record emission: echo-test posted to thread-abc123 recently
    emissionStore.record({
      originTaskId: 'echo-test',
      threadId: 'abc123',
      messageId: 'msg-1',
      suppressionMs: 60_000,
    });

    await runner.triggerNow('echo-test');

    // thread-abc123 should be skipped, thread-def456 should execute
    assert.deepEqual(executed, ['thread-def456']);
    const rows = ledger.query('echo-test', 10);
    const echoSkip = rows.find((r) => r.outcome === 'SKIP_SELF_ECHO');
    assert.ok(echoSkip, 'should have SKIP_SELF_ECHO record');
    assert.equal(echoSkip.subject_key, 'thread-abc123');
    runner.stop();
  });

  it('no emissionStore → no suppression (backwards compat)', async () => {
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    const runner = new TaskRunnerV2({ logger: silentLogger, ledger });
    const executed = [];
    runner.register({
      id: 'no-echo',
      profile: 'poller',
      trigger: { type: 'interval', ms: 999999 },
      admission: {
        gate: async () => ({
          run: true,
          workItems: [{ signal: 'go', subjectKey: 'thread-abc123' }],
        }),
      },
      run: {
        overlap: 'skip',
        timeoutMs: 5000,
        execute: async (_signal, key) => {
          executed.push(key);
        },
      },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
    });

    await runner.triggerNow('no-echo');
    assert.deepEqual(executed, ['thread-abc123']);
    runner.stop();
  });

  it('P1-D2: successful RUN_DELIVERED on thread workItem records emission', async () => {
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    const runner = new TaskRunnerV2({ logger: silentLogger, ledger, emissionStore });
    runner.register({
      id: 'emit-record-test',
      profile: 'poller',
      trigger: { type: 'interval', ms: 120_000 },
      admission: {
        gate: async () => ({
          run: true,
          workItems: [{ signal: 'go', subjectKey: 'thread-abc123' }],
        }),
      },
      run: {
        overlap: 'skip',
        timeoutMs: 5000,
        execute: async () => {},
      },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
    });

    await runner.triggerNow('emit-record-test');

    // After successful execute, pipeline should have recorded an emission
    const active = emissionStore.listActive();
    assert.equal(active.length, 1, 'should record emission after thread-scoped RUN_DELIVERED');
    assert.equal(active[0].originTaskId, 'emit-record-test');
    assert.equal(active[0].threadId, 'abc123');
    runner.stop();
  });

  it('P1-D2: failed execute does NOT record emission', async () => {
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    const runner = new TaskRunnerV2({ logger: silentLogger, ledger, emissionStore });
    runner.register({
      id: 'emit-fail-test',
      profile: 'poller',
      trigger: { type: 'interval', ms: 120_000 },
      admission: {
        gate: async () => ({
          run: true,
          workItems: [{ signal: 'go', subjectKey: 'thread-xyz789' }],
        }),
      },
      run: {
        overlap: 'skip',
        timeoutMs: 5000,
        execute: async () => {
          throw new Error('boom');
        },
      },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
    });

    await runner.triggerNow('emit-fail-test');

    // Failed execute should NOT record emission
    const active = emissionStore.listActive();
    assert.equal(active.length, 0, 'should NOT record emission on RUN_FAILED');
    runner.stop();
  });

  it('P1-D2: non-thread workItems do NOT record emission', async () => {
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    const runner = new TaskRunnerV2({ logger: silentLogger, ledger, emissionStore });
    runner.register({
      id: 'emit-pr-test',
      profile: 'poller',
      trigger: { type: 'interval', ms: 120_000 },
      admission: {
        gate: async () => ({
          run: true,
          workItems: [{ signal: 'go', subjectKey: 'pr-42' }],
        }),
      },
      run: {
        overlap: 'skip',
        timeoutMs: 5000,
        execute: async () => {},
      },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
    });

    await runner.triggerNow('emit-pr-test');

    const active = emissionStore.listActive();
    assert.equal(active.length, 0, 'should NOT record emission for non-thread workItems');
    runner.stop();
  });

  it('non-thread subjectKeys are never suppressed', async () => {
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    const runner = new TaskRunnerV2({ logger: silentLogger, ledger, emissionStore });
    const executed = [];
    runner.register({
      id: 'pr-task',
      profile: 'poller',
      trigger: { type: 'interval', ms: 999999 },
      admission: {
        gate: async () => ({
          run: true,
          workItems: [{ signal: 'go', subjectKey: 'pr-42' }],
        }),
      },
      run: {
        overlap: 'skip',
        timeoutMs: 5000,
        execute: async (_signal, key) => {
          executed.push(key);
        },
      },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
    });

    // Even if there's somehow an emission for this task, pr- keys shouldn't be checked
    await runner.triggerNow('pr-task');
    assert.deepEqual(executed, ['pr-42']);
    runner.stop();
  });
});

describe('TaskRunnerV2 — governance controls (AC-D1)', () => {
  let db, ledger, globalControlStore;
  const noop = () => {};
  const silentLogger = { info: noop, error: noop };

  const makeTask = (id, overrides = {}) => ({
    id,
    profile: 'poller',
    trigger: { type: 'interval', ms: 999999 },
    admission: {
      gate: async () => ({ run: true, workItems: [{ signal: 'go', subjectKey: 'k' }] }),
    },
    run: { overlap: 'skip', timeoutMs: 5000, execute: async () => {} },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'drop' },
    enabled: () => true,
    ...overrides,
  });

  beforeEach(async () => {
    db = new Database(':memory:');
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    const { RunLedger } = await import('../../dist/infrastructure/scheduler/RunLedger.js');
    const { GlobalControlStore } = await import('../../dist/infrastructure/scheduler/GlobalControlStore.js');
    applyMigrations(db);
    ledger = new RunLedger(db);
    globalControlStore = new GlobalControlStore(db);
  });

  it('global pause → automatic tick records SKIP_GLOBAL_PAUSE', async () => {
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    const runner = new TaskRunnerV2({ logger: silentLogger, ledger, globalControlStore });
    let ran = false;
    runner.register(
      makeTask('gov-test', {
        run: {
          overlap: 'skip',
          timeoutMs: 5000,
          execute: async () => {
            ran = true;
          },
        },
      }),
    );

    globalControlStore.setGlobalEnabled(false, 'maintenance', 'test');
    await runner.triggerNow('gov-test');

    assert.ok(!ran, 'execute should NOT have run');
    const rows = ledger.query('gov-test', 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'SKIP_GLOBAL_PAUSE');
    runner.stop();
  });

  it('global pause → triggerNow with manual=true still executes', async () => {
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    const runner = new TaskRunnerV2({ logger: silentLogger, ledger, globalControlStore });
    let ran = false;
    runner.register(
      makeTask('gov-manual', {
        run: {
          overlap: 'skip',
          timeoutMs: 5000,
          execute: async () => {
            ran = true;
          },
        },
      }),
    );

    globalControlStore.setGlobalEnabled(false, 'maintenance', 'test');
    await runner.triggerNow('gov-manual', { manual: true });

    assert.ok(ran, 'execute SHOULD run for manual trigger');
    const rows = ledger.query('gov-manual', 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'RUN_DELIVERED');
    runner.stop();
  });

  it('task override disabled → automatic tick records SKIP_TASK_OVERRIDE', async () => {
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    const runner = new TaskRunnerV2({ logger: silentLogger, ledger, globalControlStore });
    let ran = false;
    runner.register(
      makeTask('task-override-test', {
        run: {
          overlap: 'skip',
          timeoutMs: 5000,
          execute: async () => {
            ran = true;
          },
        },
      }),
    );

    globalControlStore.setTaskOverride('task-override-test', false, 'test');
    await runner.triggerNow('task-override-test');

    assert.ok(!ran, 'execute should NOT have run');
    const rows = ledger.query('task-override-test', 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'SKIP_TASK_OVERRIDE');
    runner.stop();
  });

  it('task override disabled → triggerNow with manual=true still executes', async () => {
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    const runner = new TaskRunnerV2({ logger: silentLogger, ledger, globalControlStore });
    let ran = false;
    runner.register(
      makeTask('task-override-manual', {
        run: {
          overlap: 'skip',
          timeoutMs: 5000,
          execute: async () => {
            ran = true;
          },
        },
      }),
    );

    globalControlStore.setTaskOverride('task-override-manual', false, 'test');
    await runner.triggerNow('task-override-manual', { manual: true });

    assert.ok(ran, 'execute SHOULD run for manual trigger');
    const rows = ledger.query('task-override-manual', 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'RUN_DELIVERED');
    runner.stop();
  });

  it('no globalControlStore → pipeline runs normally (backwards compat)', async () => {
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    const runner = new TaskRunnerV2({ logger: silentLogger, ledger });
    let ran = false;
    runner.register(
      makeTask('no-store', {
        run: {
          overlap: 'skip',
          timeoutMs: 5000,
          execute: async () => {
            ran = true;
          },
        },
      }),
    );

    await runner.triggerNow('no-store');
    assert.ok(ran, 'should run when no globalControlStore');
    runner.stop();
  });

  it('P1-D1: getTaskSummaries() returns effectiveEnabled reflecting global pause', async () => {
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    const runner = new TaskRunnerV2({ logger: silentLogger, ledger, globalControlStore });
    runner.register(makeTask('sum-test'));

    // Global enabled → effectiveEnabled should be true
    let summaries = runner.getTaskSummaries();
    assert.equal(summaries[0].effectiveEnabled, true);

    // Global paused → effectiveEnabled should be false
    globalControlStore.setGlobalEnabled(false, 'test pause', 'test');
    summaries = runner.getTaskSummaries();
    assert.equal(summaries[0].effectiveEnabled, false);
    assert.equal(summaries[0].enabled, true, 'task.enabled itself unchanged');
    runner.stop();
  });

  it('P1-D1: getTaskSummaries() effectiveEnabled reflects task override', async () => {
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    const runner = new TaskRunnerV2({ logger: silentLogger, ledger, globalControlStore });
    runner.register(makeTask('override-sum'));

    // Task override disabled → effectiveEnabled false
    globalControlStore.setTaskOverride('override-sum', false, 'test');
    const summaries = runner.getTaskSummaries();
    assert.equal(summaries[0].effectiveEnabled, false);
    assert.equal(summaries[0].enabled, true, 'task.enabled itself unchanged');
    runner.stop();
  });
});

// ─── #415: once trigger ─────────────────────────────────────

describe('TaskRunnerV2 — once trigger (#415)', () => {
  let db, ledger, dynamicTaskStore;
  const noop = () => {};
  const silentLogger = { info: noop, error: noop };

  beforeEach(async () => {
    db = new Database(':memory:');
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    const { RunLedger } = await import('../../dist/infrastructure/scheduler/RunLedger.js');
    const { DynamicTaskStore } = await import('../../dist/infrastructure/scheduler/DynamicTaskStore.js');
    applyMigrations(db);
    ledger = new RunLedger(db);
    dynamicTaskStore = new DynamicTaskStore(db);
  });

  const makeOnceTask = (id, fireAt, overrides = {}) => ({
    id,
    profile: 'awareness',
    trigger: { type: 'once', fireAt },
    admission: {
      gate: async () => ({ run: true, workItems: [{ signal: 'go', subjectKey: 'once-k' }] }),
    },
    run: { overlap: 'skip', timeoutMs: 5000, execute: async () => {} },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'drop' },
    enabled: () => true,
    ...overrides,
  });

  it('once trigger fires after delay and records RUN_DELIVERED', async () => {
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    const runner = new TaskRunnerV2({ logger: silentLogger, ledger, dynamicTaskStore });
    let executed = false;

    runner.registerDynamic(
      makeOnceTask('once-fire', Date.now() + 80, {
        run: {
          overlap: 'skip',
          timeoutMs: 5000,
          execute: async () => {
            executed = true;
          },
        },
      }),
      'dyn-once-1',
    );
    runner.start();
    await new Promise((r) => setTimeout(r, 200));

    assert.ok(executed, 'once task should have fired');
    const rows = ledger.query('once-fire', 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'RUN_DELIVERED');
    runner.stop();
  });

  it('once trigger auto-retires: unregisters from runner + removes from store', async () => {
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    const runner = new TaskRunnerV2({ logger: silentLogger, ledger, dynamicTaskStore });

    // Seed the dynamic store so retire can clean it up
    dynamicTaskStore.insert({
      id: 'dyn-retire-1',
      templateId: 'reminder',
      trigger: { type: 'once', fireAt: Date.now() + 50 },
      params: { message: 'test' },
      display: { label: 'test', category: 'system' },
      deliveryThreadId: null,
      enabled: true,
      createdBy: 'test',
      createdAt: new Date().toISOString(),
    });

    runner.registerDynamic(makeOnceTask('dyn-retire-1', Date.now() + 50), 'dyn-retire-1');
    runner.start();
    await new Promise((r) => setTimeout(r, 250));

    // Should be unregistered from runner
    assert.ok(
      !runner.getRegisteredTasks().includes('dyn-retire-1'),
      'task should be unregistered after once execution',
    );
    // Should be removed from store
    assert.equal(
      dynamicTaskStore.getById('dyn-retire-1'),
      null,
      'task should be removed from DynamicTaskStore after once execution',
    );
    runner.stop();
  });

  it('live-registered once trigger with past fireAt fires immediately (processing delay)', async () => {
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    const runner = new TaskRunnerV2({ logger: silentLogger, ledger, dynamicTaskStore });
    let executed = false;

    // Live registration (not hydration) — should fire even if slightly past
    runner.registerDynamic(
      makeOnceTask('once-past', Date.now() - 5000, {
        run: {
          overlap: 'skip',
          timeoutMs: 5000,
          execute: async () => {
            executed = true;
          },
        },
      }),
      'dyn-past-1',
    );
    runner.start();
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(executed, 'live-registered once task with past fireAt should fire immediately');
    runner.stop();
  });

  it('hydrated once trigger with past fireAt is cancelled (missed window, not executed)', async () => {
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    const runner = new TaskRunnerV2({ logger: silentLogger, ledger, dynamicTaskStore });
    let executed = false;

    // Seed the store with a past-due once task (simulates restart scenario)
    const pastFireAt = Date.now() - 60_000;
    dynamicTaskStore.insert({
      id: 'dyn-missed-1',
      templateId: 'reminder',
      trigger: { type: 'once', fireAt: pastFireAt },
      params: { message: 'should not fire' },
      display: { label: '错过的提醒', category: 'system' },
      deliveryThreadId: null,
      enabled: true,
      createdBy: 'test',
      createdAt: new Date(pastFireAt - 60_000).toISOString(),
    });

    // Provide a template that tracks execution
    const templateGetter = {
      get: (id) => {
        if (id !== 'reminder') return null;
        return {
          templateId: 'reminder',
          label: 'Reminder',
          category: 'system',
          description: 'test',
          subjectKind: 'none',
          defaultTrigger: { type: 'cron', expression: '0 9 * * *' },
          paramSchema: {},
          createSpec: (instanceId, params) =>
            makeOnceTask(instanceId, params.trigger.fireAt, {
              run: {
                overlap: 'skip',
                timeoutMs: 5000,
                execute: async () => {
                  executed = true;
                },
              },
            }),
        };
      },
    };

    const loaded = runner.hydrateDynamic(dynamicTaskStore, templateGetter);

    // Should NOT have been loaded
    assert.equal(loaded, 0, 'past-due once task should not be hydrated');

    // Should be removed from store
    assert.equal(dynamicTaskStore.getById('dyn-missed-1'), null, 'past-due once task should be removed from store');

    // Should NOT be registered in runner
    assert.ok(!runner.getRegisteredTasks().includes('dyn-missed-1'), 'past-due once task should not be in runner');

    // Should have recorded SKIP_MISSED_WINDOW in ledger
    const rows = ledger.query('dyn-missed-1', 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'SKIP_MISSED_WINDOW');

    // Execute should never have been called
    assert.ok(!executed, 'past-due once task should NOT execute');
    runner.stop();
  });

  it('hydrated once trigger with past fireAt sends missed-window notification', async () => {
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    const notifyCalls = [];
    const runner = new TaskRunnerV2({
      logger: silentLogger,
      ledger,
      dynamicTaskStore,
      notifyLifecycle: (notice) => notifyCalls.push(notice),
    });

    const pastFireAt = Date.now() - 120_000;
    dynamicTaskStore.insert({
      id: 'dyn-notify-1',
      templateId: 'reminder',
      trigger: { type: 'once', fireAt: pastFireAt },
      params: { message: 'weather check', triggerUserId: 'user-42' },
      display: { label: '天气查询', category: 'system' },
      deliveryThreadId: 'thread-abc',
      enabled: true,
      createdBy: 'opus',
      createdAt: new Date(pastFireAt - 60_000).toISOString(),
    });

    const templateGetter = { get: () => null };
    runner.hydrateDynamic(dynamicTaskStore, templateGetter);

    assert.equal(notifyCalls.length, 1, 'should have sent missed-window notification');
    assert.equal(notifyCalls[0].threadId, 'thread-abc');
    assert.equal(notifyCalls[0].userId, 'user-42');
    assert.equal(notifyCalls[0].toast.lifecycleEvent, 'missed_window');
    assert.ok(notifyCalls[0].toast.title.includes('错过执行窗口'), 'notification title should mention missed window');
    assert.ok(notifyCalls[0].toast.message.includes('天气查询'), 'notification should include task label');
    assert.ok(notifyCalls[0].toast.message.includes('自动取消'), 'notification should explain auto-cancel');
    runner.stop();
  });

  it('once trigger does NOT fire before fireAt', async () => {
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    const runner = new TaskRunnerV2({ logger: silentLogger, ledger, dynamicTaskStore });
    let executed = false;

    runner.registerDynamic(
      makeOnceTask('once-future', Date.now() + 10_000, {
        run: {
          overlap: 'skip',
          timeoutMs: 5000,
          execute: async () => {
            executed = true;
          },
        },
      }),
      'dyn-future-1',
    );
    runner.start();
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(!executed, 'once task should NOT fire before fireAt');
    runner.stop();
  });

  it('getTaskSummaries includes once trigger info', async () => {
    const { TaskRunnerV2 } = await import('../../dist/infrastructure/scheduler/TaskRunnerV2.js');
    const runner = new TaskRunnerV2({ logger: silentLogger, ledger, dynamicTaskStore });
    const fireAt = Date.now() + 60_000;

    runner.registerDynamic(makeOnceTask('once-summary', fireAt), 'dyn-sum-1');

    const summaries = runner.getTaskSummaries();
    const s = summaries.find((t) => t.id === 'once-summary');
    assert.ok(s, 'should find once task in summaries');
    assert.equal(s.trigger.type, 'once');
    assert.equal(s.trigger.fireAt, fireAt);
    assert.equal(s.source, 'dynamic');
    runner.stop();
  });
});
