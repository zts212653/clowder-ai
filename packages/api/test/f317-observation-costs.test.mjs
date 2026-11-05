import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observationCostFailure } from './f317-observation-costs.fixture.mjs';

for (const [snapshotMode, expectedMs] of [
  ['queue', 25],
  ['read', 35],
  ['parse', 45],
  ['clone', 55],
]) {
  test(`${snapshotMode}: actual runtime loss separates snapshot waiting, file await and synchronous work`, async (t) => {
    const observation = await observationCostFailure(t, { snapshotMode });
    const snapshot = observation.costs?.snapshot;
    assert.ok(snapshot, 'snapshot costs must survive the actual runtime failure outlet');
    assert.equal(snapshot[`${snapshotMode}Ms`], expectedMs);
    for (const other of ['queue', 'read', 'parse', 'clone'].filter((v) => v !== snapshotMode))
      assert.equal(snapshot[`${other}Ms`], 0, `${other} cannot inherit the injected ${snapshotMode} delay`);
  });
}

test('actual observer and overlapping owner presence share the seal budget but retain caller evidence', async (t) => {
  const observation = await observationCostFailure(t, { overlap: true });
  const seal = observation.costs?.seal;
  assert.ok(seal, 'per-consumer seal costs must survive the actual runtime failure outlet');
  assert.equal(seal.caller, 'observer');
  assert.equal(seal.consumerPeak, 2);
  assert.deepEqual(seal.callers, ['observer', 'presence']);
  assert.ok(seal.lstatCalls > 0 && seal.readdirCalls > 0);
  assert.ok(seal.ioPeak > 0 && seal.ioPeak <= 4);
});

test('actual received and rejected publication clocks distinguish wall drift from elapsed work', async (t) => {
  const observation = await observationCostFailure(t, { clockJump: 37 });
  const clock = observation.costs?.clock;
  assert.ok(clock, 'paired clocks must survive the actual runtime failure outlet');
  assert.equal(clock.wallElapsedMs, 15_038);
  assert.equal(clock.monotonicElapsedMs, 15_001);
  assert.equal(clock.wallMinusMonotonicMs, 37);
  assert.equal(clock.capped, false);
  assert.equal(clock.published.wallMs - clock.received.wallMs, clock.wallElapsedMs);
  assert.equal(clock.published.monotonicMs - clock.received.monotonicMs, clock.monotonicElapsedMs);
});
