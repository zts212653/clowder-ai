import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createActiveExecutionService } from '../dist/domains/cats/services/agents/invocation/active-execution-service.js';
import { ManagedJobService } from '../dist/domains/managed-job/ManagedJobService.js';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'managed-active-reader-'));
  const service = new ManagedJobService(root);
  const principal = { userId: 'owner', threadId: 'owned-thread', catId: 'codex61-sol' };
  const job = await service.submit(principal, {
    command: 'node private-never-run.js',
    cwd: root,
    originTaskId: 'hold-ball-private',
    originInvocationId: 'private-fixture',
    idempotencyKey: 'fixture',
    executionSlaMs: 5000,
    wakeTarget: principal,
  });
  service.admit(principal, job.jobId, 'private-admission');
  const workers = [];
  const beforeStop = [];
  let active = 0;
  let peak = 0;
  const observe = (worker) => {
    workers.push(worker);
    active++;
    peak = Math.max(peak, active);
    worker.once('exit', () => {
      active--;
    });
  };
  process.on('worker', observe);
  t.after(async () => {
    for (const restore of beforeStop) restore();
    process.off('worker', observe);
    await Promise.all(workers.filter((worker) => worker.threadId !== -1).map((worker) => worker.terminate()));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, service, principal, job, workers, beforeStop, peak: () => peak };
}

test('one ledger shares a bounded reader across overlapping and sequential reads', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  f.service.cancel(f.principal, f.job.jobId);
  const holder = fork(
    new URL('./helpers/managed-job-lock-holder.mjs', import.meta.url),
    [join(f.root, 'managed-jobs/supervisor.sqlite'), '700'],
    {
      execArgv: [],
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    },
  );
  t.after(async () => {
    if (holder.exitCode === null && holder.signalCode === null) {
      holder.kill();
      await once(holder, 'close');
    }
  });
  await once(holder, 'message', { signal: AbortSignal.timeout(5000) });
  const results = await Promise.all(Array.from({ length: 6 }, () => new ManagedJobService(f.root).activeExecutions()));
  for (const rows of results) assert.deepEqual(rows, []);
  for (let i = 0; i < 3; i++) assert.deepEqual(await new ManagedJobService(f.root).activeExecutions(), []);
  t.diagnostic(
    JSON.stringify({
      workerStarts: f.workers.length,
      peakActiveWorkers: f.peak(),
      concurrentReads: 6,
      laterSequentialReads: 3,
    }),
  );
  assert.equal(f.peak(), 1, 'overlapping reads of the same ledger must not multiply active workers');
  assert.equal(
    f.workers.length,
    1,
    'successive reads must reuse the same live reader, not only serialize cold workers',
  );
});

test(
  'a read submitted after cancellation cannot join an older reply still in flight',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const ready = Promise.withResolvers();
    const delayed = [];
    let holding = true;
    const intercept = (worker) => {
      const emit = worker.emit;
      worker.emit = function (event, ...args) {
        if (
          holding &&
          ((event === 'message' && args[0]?.ok === true && Array.isArray(args[0].value)) || event === 'exit')
        ) {
          delayed.push(() => emit.call(this, event, ...args));
          if (event === 'message') ready.resolve();
          return true;
        }
        return emit.call(this, event, ...args);
      };
      f.beforeStop.push(() => {
        holding = false;
        worker.emit = emit;
      });
    };
    process.once('worker', intercept);
    t.after(() => process.off('worker', intercept));
    const first = f.service.activeExecutions();
    await ready.promise;
    // SQLite has already produced the old snapshot; only its parent delivery is delayed.
    f.service.cancel(f.principal, f.job.jobId);
    const afterCancellation = new ManagedJobService(f.root).activeExecutions();
    holding = false;
    for (const deliver of delayed) deliver();
    assert.equal((await first).length, 1, 'the original request may retain its pre-cancel snapshot');
    assert.deepEqual(await afterCancellation, [], 'a later request must read the committed cancellation');
    assert.equal(f.workers.length, 1);
  },
);

test('reader failure remains incomplete and its replacement waits for actual exit', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const previous = process.env.CAT_CAFE_DATA_DIR;
  process.env.CAT_CAFE_DATA_DIR = f.root;
  t.after(() => {
    if (previous === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = previous;
  });
  const projection = createActiveExecutionService({
    invocationTracker: { getActiveSlots: () => [], getUserId: () => null },
    dynamicTaskStore: { getAll: () => [] },
    log: { info() {}, warn() {} },
  });
  const started = Promise.withResolvers();
  process.once('worker', started.resolve);
  t.after(() => process.off('worker', started.resolve));
  const snapshot = projection.buildSnapshot(f.principal.userId);
  const worker = await started.promise;
  worker.emit('error', new Error('owned reader failure injection'));
  const replacement = f.service.activeExecutions();
  assert.equal((await snapshot).ownerTruthComplete, false);
  assert.equal((await snapshot).complete, false);
  assert.equal((await replacement).length, 1, 'a new read continues only after the failed worker exits');
  f.service.cancel(f.principal, f.job.jobId);
  assert.deepEqual(await f.service.activeExecutions(), []);
  assert.equal(f.peak(), 1, 'a replacement cannot overlap a worker that has not exited');
  assert.equal(f.workers.length, 2);
});
