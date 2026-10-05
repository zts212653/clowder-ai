import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runModuleWorker } from '../dist/utils/run-module-worker.js';

test('process isolation executes the trusted module in a different OS process', async () => {
  const result = await runModuleWorker({
    moduleUrl: new URL('./helpers/module-process-fixture.js', import.meta.url),
    exportName: 'identity',
    isolation: 'process',
    input: {},
  });
  assert.notEqual(
    result.pid,
    process.pid,
    'a native query needs a killable child process, not another thread in the API process',
  );
});

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const fixtureModule = new URL('./helpers/module-process-fixture.js', import.meta.url);
async function startedPid(path) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      return Number(await readFile(path, 'utf8'));
    } catch {
      await delay(5);
    }
  }
  throw new Error('isolated operation never entered its native/CPU section');
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function waitUntilExited(pid) {
  const deadline = Date.now() + 1000;
  while (alive(pid) && Date.now() < deadline) await delay(5);
  assert.equal(alive(pid), false, `child ${pid} was not reaped`);
}

test('native SQLite and CPU cancellation kill children, release the shared queue, and leave HTTP live', async () => {
  const root = await mkdtemp(join(tmpdir(), 'module-process-cancel-'));
  const first = new AbortController();
  const second = new AbortController();
  const server = createServer((_req, res) => res.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const nativeResult = runModuleWorker({
    moduleUrl: fixtureModule,
    exportName: 'nativeBusy',
    isolation: 'process',
    input: { startedPath: join(root, 'native') },
    signal: first.signal,
  }).then(
    () => null,
    (error) => error,
  );
  const cpuResult = runModuleWorker({
    moduleUrl: fixtureModule,
    exportName: 'cpuBusy',
    isolation: 'process',
    input: { startedPath: join(root, 'cpu') },
    signal: second.signal,
  }).then(
    () => null,
    (error) => error,
  );
  try {
    const [nativePid, cpuPid] = await Promise.all([startedPid(join(root, 'native')), startedPid(join(root, 'cpu'))]);
    await delay(30); // both calls have entered their long computation
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const healthStarted = performance.now();
    assert.equal(await (await fetch(`http://127.0.0.1:${address.port}/health`)).text(), 'ok');
    assert.ok(performance.now() - healthStarted < 200);
    let admitted = false;
    const queued = runModuleWorker({ moduleUrl: fixtureModule, exportName: 'identity' }).then((value) => {
      admitted = true;
      return value;
    });
    await delay(20);
    assert.equal(admitted, false, 'thread and process jobs must share the same two slots');
    first.abort(new Error('native cancellation'));
    second.abort(new Error('cpu cancellation'));
    assert.match((await nativeResult)?.message ?? '', /native cancellation/);
    assert.match((await cpuResult)?.message ?? '', /cpu cancellation/);
    assert.equal((await queued).pid, process.pid, 'queue resumes in default thread mode after child exits');
    await Promise.all([waitUntilExited(nativePid), waitUntilExited(cpuPid)]);
  } finally {
    first.abort();
    second.abort();
    await Promise.all([nativeResult, cpuResult]);
    await new Promise((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('deadline kills a child already executing native SQLite and allows the next request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'module-process-deadline-'));
  const result = runModuleWorker({
    moduleUrl: fixtureModule,
    exportName: 'nativeBusy',
    isolation: 'process',
    input: { startedPath: join(root, 'started') },
    timeoutMs: 2000,
  }).then(
    () => null,
    (error) => error,
  );
  try {
    const pid = await startedPid(join(root, 'started'));
    assert.match((await result)?.message ?? '', /timed out/);
    await waitUntilExited(pid);
    assert.ok(await runModuleWorker({ moduleUrl: fixtureModule, exportName: 'identity', isolation: 'process' }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
