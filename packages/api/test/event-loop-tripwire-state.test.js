import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectTripwireSegment } from '../dist/infrastructure/telemetry/cpu/event-loop-tripwire-profile.js';
import { EventLoopTripwireState } from '../dist/infrastructure/telemetry/cpu/event-loop-tripwire-state.js';

test('a healthy main loop can await slow work without being reported as blocked', () => {
  const state = new EventLoopTripwireState(25, 250);
  for (let now = 0; now <= 2000; now += 25) {
    assert.equal(state.poll(now, now, now), undefined);
    assert.equal(state.current, undefined);
  }
});

test('a main-only stall has one measured interval, completed by the next heartbeat', () => {
  const state = new EventLoopTripwireState(25, 250);
  for (let now = 0; now <= 400; now += 25) state.poll(now, now, 0);
  assert.equal(state.current?.startMs, 25);
  assert.deepEqual(state.poll(425, 425, 425), { startMs: 25, endMs: 425 });
  assert.equal(state.current, undefined);
});

test('whole-process suspension remains unknown even if the main heartbeat recovers before the observer', () => {
  const state = new EventLoopTripwireState(25, 250);
  state.poll(0, 0, 0);
  const result = state.poll(500, 500, 500);
  assert.equal(result?.reason, 'observer_gap');
  assert.equal(result?.workerGapMs, 500);
  assert.equal(state.current, undefined);
});

test('after a whole-process gap the old heartbeat cannot create a second stall', () => {
  const state = new EventLoopTripwireState(25, 250);
  state.poll(0, 0, 0);
  assert.equal(state.poll(3000, 3000, 0)?.reason, 'observer_gap');
  assert.equal(state.poll(3025, 3025, 0), undefined);
  assert.equal(state.current, undefined);
  assert.equal(state.poll(3050, 3050, 3050), undefined);
  assert.equal(state.current, undefined);
  for (let now = 3075; now <= 3350; now += 25) state.poll(now, now, 3050);
  assert.equal(state.current?.startMs, 3075, 'a later real stall is still detected');
});

test('a wall clock jump never turns the last pre-sleep function into an occupier', () => {
  const state = new EventLoopTripwireState(25, 250);
  state.poll(0, 0, 0);
  const result = state.poll(25, 3_500_025, 25);
  assert.equal(result?.reason, 'clock_change');
  assert.equal(state.current, undefined);
});

test('main-loop progress alone determines the stall, without asserting its cause', () => {
  const state = new EventLoopTripwireState(25, 250);
  for (let now = 0; now <= 450; now += 25) state.poll(now, now, 0);
  assert.equal(state.current?.reason, undefined);
  assert.deepEqual(state.poll(475, 475, 475), { startMs: 25, endMs: 475 });
});

function profileWithGap(gapUs) {
  return {
    startTime: 0,
    endTime: gapUs,
    nodes: [
      {
        id: 1,
        callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 },
        children: [2],
      },
      {
        id: 2,
        callFrame: {
          functionName: 'lastPreSleepFrame',
          scriptId: '1',
          url: new URL('../dist/infrastructure/telemetry/cpu/event-loop-tripwire-state.js', import.meta.url).href,
          lineNumber: 1,
          columnNumber: 0,
        },
      },
    ],
    samples: [2],
    timeDeltas: [gapUs],
  };
}

test('a cheap stop bounds the sample clock even when profiler start acknowledged late', () => {
  const profile = profileWithGap(10000);
  profile.endTime = 300000;
  const segment = {
    profile,
    startRequestedMs: 0,
    startAcknowledgedMs: 200,
    stopRequestedMs: 310,
    stopAcknowledgedMs: 320,
  };
  const result = projectTripwireSegment(segment, 0, 320);
  assert.equal(result.sampleClockValid, true);
  assert.ok(result.sampleClockUncertaintyMs <= 10);
  assert.equal(result.topFrames[0]?.function, 'lastPreSleepFrame');
  assert.equal(
    projectTripwireSegment({ ...segment, stopRequestedMs: 1000, stopAcknowledgedMs: 1010 }, 0, 1010).sampleClockValid,
    false,
  );
});

test('an unsampled interval is not charged to its next named sample', () => {
  const result = projectTripwireSegment(
    { profile: profileWithGap(3_500_000), startRequestedMs: 0, startAcknowledgedMs: 0, stopAcknowledgedMs: 3500 },
    0,
    3500,
  );
  assert.equal(result.retainedSamples, 0);
  assert.deepEqual(result.topFrames, []);
  assert.equal(result.uncoveredMs, 3500);
});

test('GC and native samples without a trustworthy API parent stay unattributed', () => {
  const profile = profileWithGap(10_000);
  profile.nodes[1].callFrame = {
    functionName: '(garbage collector)',
    scriptId: '0',
    url: '',
    lineNumber: -1,
    columnNumber: -1,
  };
  const gc = projectTripwireSegment(
    { profile, startRequestedMs: 0, startAcknowledgedMs: 0, stopAcknowledgedMs: 10 },
    0,
    10,
  );
  assert.equal(gc.categories.gc, 1);
  assert.deepEqual(gc.topFrames, []);
  profile.nodes = [profile.nodes[1]];
  profile.nodes[0].callFrame.functionName = '';
  const native = projectTripwireSegment(
    { profile, startRequestedMs: 0, startAcknowledgedMs: 0, stopAcknowledgedMs: 10 },
    0,
    10,
  );
  assert.equal(native.nativeSamplesWithoutApiCaller, 1);
  assert.deepEqual(native.topFrames, []);
});
