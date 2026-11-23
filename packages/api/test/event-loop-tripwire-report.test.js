import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tripwireReport } from '../dist/infrastructure/telemetry/cpu/event-loop-tripwire-report.js';

function segment(start, end) {
  const profile = {
    startTime: 0,
    endTime: (end - start) * 1000,
    nodes: [
      {
        id: 1,
        callFrame: {
          scriptId: '1',
          functionName: 'blocker',
          url: new URL('../dist/infrastructure/telemetry/cpu/event-loop-tripwire-state.js', import.meta.url).href,
          lineNumber: 5,
          columnNumber: 0,
        },
      },
    ],
    samples: Array((end - start) / 10).fill(1),
    timeDeltas: Array((end - start) / 10).fill(10000),
  };
  return { profile, startRequestedMs: start, startAcknowledgedMs: start, stopAcknowledgedMs: end };
}

test('overlapping profile windows do not count the same sampled time twice', () => {
  const report = tripwireReport({ startMs: 0, endMs: 100 }, 100, 0, [segment(0, 60), segment(40, 100)], 250);
  assert.equal(report.sampleCount, 10);
  assert.equal(report.topFrames[0].selfSamples, 10);
});

test('invalid sample timing cannot supply apparently trustworthy coordinates', () => {
  const part = segment(0, 100);
  assert.ok(part.profile.timeDeltas);
  part.profile.timeDeltas[5] = -1;
  const report = tripwireReport({ startMs: 0, endMs: 100 }, 100, 0, [part], 250);
  assert.equal(report.attribution, 'unknown');
  assert.deepEqual(report.topFrames, []);
});

test('a whole-process observation gap suppresses all preceding coordinates', () => {
  const report = tripwireReport(
    { startMs: 0, endMs: 3500000, reason: 'observer_gap' },
    3500000,
    0,
    [segment(0, 100)],
    250,
  );
  assert.equal(report.attribution, 'unknown');
  assert.equal(report.reason, 'observer_gap');
  assert.deepEqual(report.topFrames, []);
});

test('a delayed profiler start has no trustworthy sample-to-heartbeat clock', () => {
  const part = segment(0, 100);
  part.startAcknowledgedMs = 250;
  part.stopAcknowledgedMs = 500;
  const report = tripwireReport({ startMs: 0, endMs: 500 }, 500, 0, [part], 250);
  assert.equal(report.sampleClockValid, false);
  assert.equal(report.attribution, 'unknown');
  assert.deepEqual(report.topFrames, []);
});
