import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runModuleWorker } from '../dist/utils/run-module-worker.js';

const moduleUrl = new URL('./helpers/module-worker-fixture.ts', import.meta.url);
test('isolated CPU work leaves a concurrent HTTP health request responsive', async () => {
  const server = createServer((_req, res) => res.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const startedFlag = new SharedArrayBuffer(4);
    const pending = runModuleWorker({ moduleUrl, exportName: 'busy', input: { milliseconds: 500, startedFlag } });
    while (!Atomics.load(new Int32Array(startedFlag), 0)) await delay(5);
    const started = performance.now();
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(await response.text(), 'ok');
    assert.ok(performance.now() - started < 200);
    await pending;
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
});
test('pool limits active work and can cancel a queued request without running it', async () => {
  const call = (id) =>
    runModuleWorker({
      moduleUrl,
      exportName: 'busy',
      input: { milliseconds: 150, id },
    });
  const first = call('1');
  const second = call('2');
  const controller = new AbortController();
  const cancelled = runModuleWorker({
    moduleUrl,
    exportName: 'busy',
    input: { milliseconds: 10 },
    signal: controller.signal,
  });
  controller.abort(new Error('queued cancellation'));
  await assert.rejects(cancelled, /queued cancellation/);
  const third = call('3');
  const [a, b, c] = await Promise.all([first, second, third]);
  assert.ok(c.started >= Math.min(a.ended, b.ended));
});
test('timeout, active CPU cancellation and operation errors remain observable', async () => {
  await assert.rejects(
    runModuleWorker({ moduleUrl, exportName: 'busy', input: { milliseconds: 10_000 }, timeoutMs: 50 }),
    /timed out/,
  );
  const startedFlag = new SharedArrayBuffer(4);
  const controller = new AbortController();
  const busy = runModuleWorker({
    moduleUrl,
    exportName: 'busy',
    input: { milliseconds: 10_000, startedFlag },
    signal: controller.signal,
  });
  while (!Atomics.load(new Int32Array(startedFlag), 0)) await delay(5);
  const stopped = assert.rejects(busy, /active cancellation/);
  controller.abort(new Error('active cancellation'));
  await stopped;
  await assert.rejects(runModuleWorker({ moduleUrl, exportName: 'fail' }), /fixture failure/);
});
test('source execution resolves a trusted relative .js module target to TypeScript', async () => {
  const value = await (await import('../src/utils/run-module-worker.ts')).runModuleWorker({
    moduleUrl: new URL('./helpers/module-worker-fixture.js', import.meta.url),
    exportName: 'busy',
    input: { milliseconds: 1, id: 'relative-target' },
  });
  assert.equal(value.id, 'relative-target');
});
