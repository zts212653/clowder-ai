import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runModuleWorker } from '../dist/utils/run-module-worker.js';

const moduleUrl = new URL('./helpers/module-worker-fixture.ts', import.meta.url);
test('queued work reports pool wait separately from its own execution and capacity release', async () => {
  const firstFlag = new SharedArrayBuffer(8);
  const secondFlag = new SharedArrayBuffer(8);
  const blocker = (startedFlag) =>
    runModuleWorker({
      moduleUrl,
      exportName: 'held',
      input: { flag: startedFlag },
    });
  const first = blocker(firstFlag);
  const second = blocker(secondFlag);
  while (!Atomics.load(new Int32Array(firstFlag), 0) || !Atomics.load(new Int32Array(secondFlag), 0)) await delay(5);
  const timings = [];
  const pending = runModuleWorker({
    moduleUrl,
    exportName: 'busy',
    input: { milliseconds: 1, id: 'payload-canary' },
    onTiming: (timing) => timings.push(timing),
  });
  await delay(200);
  assert.equal(timings.length, 0, 'no worker may finish while both pool slots are held');
  for (const flag of [firstFlag, secondFlag]) {
    Atomics.store(new Int32Array(flag), 1, 1);
    Atomics.notify(new Int32Array(flag), 1);
  }
  const value = await pending;
  await Promise.all([first, second]);
  for (let i = 0; i < 100 && timings.length < 2; ++i) await delay(5);
  assert.equal(value.id, 'payload-canary');
  assert.equal(timings.length, 2, 'settlement and actual capacity release must both be witnessed');
  const [settled, released] = timings;
  assert.equal(settled.phase, 'settled');
  assert.equal(settled.outcome, 'success');
  assert.equal(settled.started, true);
  assert.ok(Number(settled.queueMs) >= 150, 'two known running blockers must be counted as queue wait');
  assert.ok(Number(settled.runMs) > 0); // includes spawn/import; no claim it is smaller than queue wait
  assert.ok(Math.abs(Number(settled.elapsedMs) - Number(settled.queueMs) - Number(settled.runMs)) < 5);
  assert.equal(released.phase, 'released');
  assert.ok(Number(released.elapsedMs) >= Number(settled.elapsedMs));
  assert.equal(JSON.stringify(timings).includes('payload-canary'), false);
});
test('observer failures preserve process results, errors, aborts and pool reuse', async () => {
  const onTiming = () => {
    throw new Error('observer failure');
  };
  const result = await runModuleWorker({
    moduleUrl,
    exportName: 'busy',
    isolation: 'process',
    input: { milliseconds: 1, id: 'ok' },
    onTiming,
  });
  assert.equal(result.id, 'ok');
  await assert.rejects(
    runModuleWorker({ moduleUrl, exportName: 'fail', isolation: 'process', onTiming }),
    /fixture failure/,
  );
  const controller = new AbortController();
  const stopped = runModuleWorker({
    moduleUrl,
    exportName: 'busy',
    input: { milliseconds: 10_000 },
    signal: controller.signal,
    onTiming,
  });
  const abortError = new Error('exact abort');
  const rejected = assert.rejects(stopped, (error) => error === abortError);
  controller.abort(abortError);
  await rejected;
  const final = await runModuleWorker({
    moduleUrl,
    exportName: 'busy',
    input: { milliseconds: 1, id: 'after' },
    onTiming,
  });
  assert.equal(final.id, 'after');
});
test('cancelled queued and pre-aborted work cannot be reported as executed', async () => {
  const blockers = [1, 2].map(() => runModuleWorker({ moduleUrl, exportName: 'busy', input: { milliseconds: 100 } }));
  const controller = new AbortController();
  const timings = [];
  const pending = runModuleWorker({
    moduleUrl,
    exportName: 'fail',
    signal: controller.signal,
    onTiming: (timing) => timings.push(timing),
  });
  const rejected = assert.rejects(pending, /cancelled before start/);
  controller.abort(new Error('cancelled before start'));
  await rejected;
  assert.equal(timings.length, 1);
  assert.equal(timings[0].started, false);
  assert.equal(timings[0].runMs, 0);
  assert.equal(timings[0].outcome, 'aborted');
  await assert.rejects(
    runModuleWorker({
      moduleUrl,
      exportName: 'fail',
      signal: controller.signal,
      onTiming: (timing) => timings.push(timing),
    }),
    /cancelled before start/,
  );
  assert.equal(timings.at(-1)?.started, false);
  await Promise.all(blockers);
});
