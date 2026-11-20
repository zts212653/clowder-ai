import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { harness } from './helpers/event-loop-tripwire-harness.js';

async function records(h) {
  const files = (await readdir(h.folder)).filter((name) =>
    /^event-loop-(?:tripwire|resources)\..*\.ndjson$/.test(name),
  );
  return (await Promise.all(files.map((name) => readFile(`${h.folder}/${name}`, 'utf8')))).flatMap((text) =>
    text.split('\n').filter(Boolean).map(JSON.parse),
  );
}

for (const source of [false, true])
  test(
    `an over-budget real Profiler.start retires automatic profiling while the independent observer survives (${source ? 'source' : 'compiled'})`,
    { timeout: 10000 },
    async (t) => {
      const h = await harness(t, 'slow-start-budget', source);
      await delay(1300);
      const first = await records(h);
      assert.equal(
        first.filter((row) => row.kind === 'event_loop_profiler_control' && row.method === 'Profiler.start').length,
        1,
      );
      assert.ok(first.some((row) => row.status === 'profiler_suspended' && row.reason === 'start_budget_exceeded'));
      h.child.send({ type: 'block', id: 'after-suspension', ms: 650, native: true });
      await h.wait((message) => message.type === 'done' && message.id === 'after-suspension');
      await h.wait(
        (message) =>
          message.type === 'log' && message.entry.kind === 'event_loop_stall' && message.entry.phase === 'complete',
      );
      assert.ok((await records(h)).some((row) => row.kind === 'event_loop_stall' && row.phase === 'complete'));
      h.child.send({ type: 'foreground' });
      assert.equal((await h.wait((message) => message.type === 'foreground')).status, 'sampled');
    },
  );

test(
  'native reads refuse the API main thread; a failed worker read stays unavailable',
  { skip: process.platform !== 'darwin', timeout: 5000 },
  async () => {
    const native = createRequire(import.meta.url)('../dist/native/process-witness.node');
    assert.throws(() => native.snapshot(native.currentThreadId()), /process_witness_requires_worker/);
    const worker = new Worker(new URL('./helpers/process-witness-fixture.mjs', import.meta.url), {
      workerData: { mainThreadId: 'invalid' },
      execArgv: [],
    });
    const exit = once(worker, 'exit');
    const [record] = await once(worker, 'message');
    assert.deepEqual(record, { status: 'unavailable', reason: 'kernel_read_failed' });
    assert.equal(await exit.then(([code]) => code), 0);
  },
);

for (const source of [false, true])
  test(
    `a native wait leaves thread, page and host witnesses on disk before the main thread returns (${source ? 'source' : 'compiled'})`,
    { skip: process.platform !== 'darwin', timeout: 10000 },
    async (t) => {
      const h = await harness(t, 'long-window', source);
      h.child.send({ type: 'block', id: 'kernel-wait', ms: 2100, native: true });
      await h.wait((message) => message.type === 'entered' && message.id === 'kernel-wait');
      let witness;
      const until = performance.now() + 1850;
      while (performance.now() < until && !witness) {
        witness = (await records(h)).find((row) => row.kind === 'event_loop_resources' && row.phase === 'ongoing');
        if (!witness) await delay(15);
      }
      assert.ok(witness, 'independent resource evidence was written during the native wait');
      assert.equal(witness.resources?.status, 'ok', JSON.stringify(witness.resources));
      assert.notEqual(witness.resources.current.collectorThreadId, witness.resources.current.mainThreadId);
      assert.ok(witness.resources.current.threads.length > 0);
      assert.equal(typeof witness.resources.current.mainThread.userMs, 'number');
      assert.equal(typeof witness.resources.current.process.faults, 'number');
      assert.equal(typeof witness.resources.current.process.pageins, 'number');
      const counters = witness.resources.current;
      assert.ok(
        counters.process.userMs + counters.process.systemMs + 1 >=
          counters.mainThread.userMs + counters.mainThread.systemMs,
        'process lifetime CPU must include its main thread CPU (Mach absolute ticks need conversion)',
      );
      assert.equal(typeof witness.resources.current.host.memoryPressure, 'number');
      assert.equal(typeof witness.resources.current.host.swapouts, 'number');
      assert.ok(witness.resources.current.readCpuMs >= 0);
      t.diagnostic(JSON.stringify(witness));
      assert.equal(
        h.messages.some((message) => message.type === 'done' && message.id === 'kernel-wait'),
        false,
      );
    },
  );

for (const blocked of [false, true])
  test(`resource journal ${blocked ? 'failure' : 'exhaustion'} leaves the code journal usable`, async (t) => {
    const folder = await mkdtemp(join(tmpdir(), 'owned-tripwire-journals-'));
    t.after(() => rm(folder, { recursive: true, force: true }));
    if (blocked) {
      await writeFile(join(folder, 'preserved'), 'original');
      await symlink(
        join(folder, 'preserved'),
        join(folder, `event-loop-resources.${new Date().toISOString().slice(0, 10)}.ndjson`),
      );
    }
    const worker = new Worker(new URL('./helpers/process-witness-fixture.mjs', import.meta.url), {
      workerData: { journal: folder, blocked },
      execArgv: [],
    });
    t.after(() => worker.terminate());
    const exit = once(worker, 'exit');
    const [result] = await once(worker, 'message');
    assert.equal(result.codeStatus, 'written');
    assert.equal(result.failure, blocked);
    assert.equal(await exit.then(([code]) => code), 0);
    if (blocked) assert.equal(await readFile(join(folder, 'preserved'), 'utf8'), 'original');
    else {
      const file = (await readdir(folder)).find((name) => name.startsWith('event-loop-resources.'));
      const rows = (await readFile(join(folder, file), 'utf8')).trim().split('\n').map(JSON.parse);
      assert.ok(rows.some((row) => row.kind === 'event_loop_resource_suppressed' && row.droppedRecords > 0));
    }
  });
