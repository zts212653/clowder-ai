import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runModuleWorker } from '../dist/utils/run-module-worker.js';

const moduleUrl = new URL('./helpers/module-process-fixture.mjs', import.meta.url);
async function measured(exportName, input) {
  const reports = [];
  const value = await runModuleWorker({
    moduleUrl,
    exportName,
    input,
    isolation: 'process',
    onTiming: (r) => reports.push(r),
  });
  for (let n = 0; n < 100 && reports.length < 2; n++) await delay(5);
  return { value, reports, processMetrics: reports.find((r) => r.phase === 'settled')?.processMetrics };
}

test('unobserved child performs no process CPU probes after loading the fixture', async () => {
  assert.equal(await runModuleWorker({ moduleUrl, exportName: 'processCpuCallCount', isolation: 'process' }), 0);
});

test('real child import and operation measurements distinguish waiting from process CPU', async () => {
  const waiting = await measured('waiting', { milliseconds: 200, id: 'private-timing-canary' });
  const burning = await measured('burnProcessCpu', { cpuMs: 100, id: 'private-timing-canary' });
  assert.equal(waiting.value.id, 'private-timing-canary');
  assert.equal(burning.value.id, 'private-timing-canary');
  assert.ok(waiting.processMetrics, 'actual child load and work must be measured');
  assert.ok(burning.processMetrics);
  assert.equal(waiting.processMetrics.operationStarted, true);
  assert.ok(waiting.processMetrics.operationWallMs >= 180);
  assert.ok(waiting.processMetrics.operationProcessCpuMs < 100, 'a timer wait cannot be reported as process CPU');
  assert.ok(
    burning.processMetrics.operationProcessCpuMs >= 90,
    'fixture burns a CPU-time budget independent of host scheduling',
  );
  for (const run of [waiting, burning]) {
    assert.ok(run.processMetrics.moduleLoadWallMs > 0);
    assert.ok(run.processMetrics.moduleLoadProcessCpuMs >= 0);
    const settled = run.reports.find((r) => r.phase === 'settled');
    assert.ok(settled.runMs >= run.processMetrics.moduleLoadWallMs + run.processMetrics.operationWallMs - 5);
    assert.deepEqual(run.reports.find((r) => r.phase === 'released').processMetrics, run.processMetrics);
    assert.equal(JSON.stringify(run.reports).includes('private-timing-canary'), false);
    assert.equal(JSON.stringify(run.reports).includes('module-process-fixture'), false);
  }
});

test('CPU probe failure preserves the child result and missing measurement stays unknown', async () => {
  const { value, reports, processMetrics } = await measured('breakCpuProbe', undefined);
  assert.equal(value, 'probe-fault-result');
  assert.equal(processMetrics, undefined);
  assert.equal(reports[0].outcome, 'success');
  const next = await measured('waiting', { milliseconds: 1, id: 'after' });
  assert.equal(next.value.id, 'after');
  assert.ok(next.processMetrics, 'new process and released slot remain usable');
});

test('operation errors retain their message while measured work is still reported', async () => {
  const reports = [];
  await assert.rejects(
    runModuleWorker({ moduleUrl, exportName: 'fail', isolation: 'process', onTiming: (r) => reports.push(r) }),
    /fixture failure/,
  );
  assert.equal(reports[0].outcome, 'failed');
  assert.ok(reports[0].processMetrics);
  assert.equal(reports[0].processMetrics.operationStarted, true);
});

test('a missing export reports import work without inventing an operation', async () => {
  const reports = [];
  await assert.rejects(
    runModuleWorker({ moduleUrl, exportName: 'absentExport', isolation: 'process', onTiming: (r) => reports.push(r) }),
    /Missing worker export: absentExport/,
  );
  const metrics = reports[0].processMetrics;
  assert.ok(metrics.moduleLoadWallMs > 0);
  assert.equal(metrics.operationStarted, false);
  assert.equal(metrics.operationWallMs, 0);
  assert.equal(metrics.operationProcessCpuMs, 0);
});

test('terminating a started process keeps the exact abort and leaves child CPU unknown', async () => {
  const reports = [];
  const controller = new AbortController();
  const reason = new Error('exact process abort');
  const pending = runModuleWorker({
    moduleUrl,
    exportName: 'waiting',
    input: { milliseconds: 20_000 },
    isolation: 'process',
    signal: controller.signal,
    onTiming: (r) => reports.push(r),
  });
  const rejected = assert.rejects(pending, (error) => error === reason);
  controller.abort(reason);
  await rejected;
  for (let n = 0; n < 100 && reports.length < 2; n++) await delay(5);
  assert.equal(reports[0].started, true);
  assert.equal(reports[0].outcome, 'aborted');
  assert.equal(reports[0].processMetrics, undefined);
  assert.equal(reports[1].phase, 'released');
  assert.equal(reports[1].processMetrics, undefined);
});
