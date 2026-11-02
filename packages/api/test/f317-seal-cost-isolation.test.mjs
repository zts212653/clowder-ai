import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { ObservationDiagnostics } from '../src/domains/plugin/desktop-window-runtime/observation-diagnostics.js';
import { sealStaticPackage } from '../src/domains/plugin/external-runtime/static-package-seal.js';

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'f317-cost-isolation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(join(root, 'asset'), 'immutable');
  return { root, check: await sealStaticPackage(root, async () => {}) };
}

test('per-call summaries reset on the next round and another generation sees no earlier caller', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  const original = fs.lstat;
  fs.lstat = async (...args) => {
    await turn();
    return original(...args);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.lstat = original;
    syncBuiltinESMExports();
  });
  const observer = new ObservationDiagnostics('observer');
  const presence = new ObservationDiagnostics('presence');
  await Promise.all([first.check(presence.packageDiagnostics), first.check(observer.packageDiagnostics)]);
  const before = observer.snapshot().costs.seal;
  assert.deepEqual(before.callers, ['observer', 'presence']);
  assert.equal(before.consumerPeak, 2);
  assert.equal(before.lstatCalls, 3);
  const next = new ObservationDiagnostics('observer');
  await first.check(next.packageDiagnostics);
  assert.deepEqual(next.snapshot().costs.seal.callers, ['observer']);
  assert.equal(next.snapshot().costs.seal.consumerPeak, 1);
  assert.equal(next.snapshot().costs.seal.lstatCalls, 3, 'complete new scan without earlier counters');
  const other = new ObservationDiagnostics('presence');
  await second.check(other.packageDiagnostics);
  assert.deepEqual(other.snapshot().costs.seal.callers, ['presence']);
  assert.equal(other.snapshot().costs.seal.consumerPeak, 1);
  assert.deepEqual(observer.snapshot().costs.seal, before, 'completed evidence is not mutated by later scans');
  const diagnosed = new ObservationDiagnostics('observer');
  await Promise.all([first.check(diagnosed.packageDiagnostics), first.check()]);
  assert.deepEqual(diagnosed.snapshot().costs.seal.callers, ['observer', 'other']);
  assert.equal(diagnosed.snapshot().costs.seal.consumerPeak, 2);
});

test('bounded IO counts and totals stay finite and a throwing consumer cannot replace the original error', async (t) => {
  const f = await fixture(t);
  let mono = 0;
  t.mock.method(performance, 'now', () => mono);
  const original = fs.lstat;
  fs.lstat = async (...args) => {
    mono += 90_000_000;
    return original(...args);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.lstat = original;
    syncBuiltinESMExports();
  });
  const diagnostic = new ObservationDiagnostics('observer');
  await f.check(diagnostic.packageDiagnostics);
  const cost = diagnostic.snapshot().costs.seal;
  assert.equal(cost.capped, true);
  for (const field of ['queueWaitMs', 'maxQueueWaitMs', 'ioAwaitMs', 'maxIoAwaitMs'])
    assert.ok(Number.isFinite(cost[field]) && cost[field] >= 0 && cost[field] <= 86_400_000);
  assert.ok(cost.ioPeak <= 4);
  const other = await fixture(t);
  const fault = Object.assign(new Error('private error stays the cause'), { code: 'EIO' });
  fs.lstat = async () => {
    throw fault;
  };
  syncBuiltinESMExports();
  const failedRead = new ObservationDiagnostics('observer');
  await assert.rejects(f.check(failedRead.packageDiagnostics), (error) => error === fault);
  assert.equal(failedRead.snapshot().costs.seal.caller, 'observer');
  assert.equal(failedRead.snapshot().costs.seal.lstatCalls, 1, 'a failed walk still records dispatched IO');
  await assert.rejects(
    other.check({
      caller: 'presence',
      record: () => {
        throw new Error('reporter');
      },
    }),
    (e) => e === fault,
  );
  await assert.rejects(f.check(), /damaged/);
});

test('clock caps are explicit and drift is computed from the original paired samples', (t) => {
  let mono = 0;
  t.mock.method(performance, 'now', () => mono);
  const d = new ObservationDiagnostics('observer');
  d.costs.receive(2_000);
  mono = 90_000_000;
  d.costs.publish(90_002_037);
  const clock = d.snapshot().costs.clock;
  assert.equal(clock.capped, true);
  assert.equal(clock.wallMinusMonotonicMs, 37, 'independent caps must not erase real wall drift');
  assert.equal(clock.wallElapsedMs, 86_400_000);
  assert.equal(clock.monotonicElapsedMs, 86_400_000);
});
