import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProfilerControlTimeline } from '../dist/infrastructure/telemetry/cpu/event-loop-tripwire-controls.js';

test('control overlap is clipped to the queried interval and pruned after publication', () => {
  const controls = new ProfilerControlTimeline();
  controls.begin(100);
  controls.finish(106);
  assert.equal(controls.overlap(105, 450), 1);
  assert.equal(controls.overlap(106, 450), 0);
  controls.begin(300);
  controls.finish(310);
  assert.equal(controls.overlap(0, 1000), 16);
  assert.equal(controls.overlap(0, 105) + controls.overlap(105, 1000), 16);
  controls.prune(106);
  assert.equal(controls.overlap(0, 1000), 10);
});

test('an in-flight native wait is overlap evidence, without classifying its cause', () => {
  const controls = new ProfilerControlTimeline();
  controls.begin(275);
  assert.equal(controls.overlap(25, 1000), 725);
  controls.finish(3000);
  assert.equal(controls.overlap(1000, 3000), 2000);
  assert.throws(() => controls.finish(3001), /not_started/);
});
