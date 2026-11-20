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

function lateProfile(native) {
  const part = segment(0, 100);
  const frame = part.profile.nodes[0].callFrame;
  part.profile.nodes = Array.from({ length: 5000 }, (_, index) => ({
    id: index + 1,
    callFrame: { ...frame, url: 'node:timers', functionName: `unused${index}` },
  }));
  part.profile.nodes[0].children = Array.from({ length: 5000 }, (_, index) => index + 2);
  part.profile.nodes.push({
    id: 5001,
    callFrame: { ...frame, functionName: 'lateBlocker' },
    children: native ? [5002] : [],
  });
  if (native) part.profile.nodes.push({ id: 5002, callFrame: { ...frame, url: '', functionName: '' } });
  part.profile.samples.fill(native ? 5002 : 5001);
  return part;
}

for (const native of [false, true]) {
  test(`sampled late ${native ? 'native caller' : 'API frame'} survives irrelevant earlier profile nodes`, () => {
    const report = tripwireReport({ startMs: 0, endMs: 100 }, 100, 0, [lateProfile(native)], 250);
    assert.equal(report.attribution, 'sampled');
    assert.equal(report.topFrames[0].function, 'lateBlocker');
    assert.equal(native ? report.topFrames[0].nativeSamples : report.topFrames[0].selfSamples, 10);
    assert.ok(report.omittedNodes > 0, 'irrelevant nodes remain honestly omitted');
  });
}

for (const invalid of ['ambiguous-parent', 'cycle', 'duplicate-id']) {
  test(`a large profile with a ${invalid} never invents a sampled API caller`, () => {
    const part = lateProfile(true);
    const caller = part.profile.nodes.find((node) => node.id === 5001);
    const native = part.profile.nodes.find((node) => node.id === 5002);
    assert.ok(caller && native);
    if (invalid === 'ambiguous-parent') part.profile.nodes[1].children = [5002];
    if (invalid === 'cycle') native.children = [5001];
    if (invalid === 'duplicate-id') part.profile.nodes.push({ ...caller });
    const report = tripwireReport({ startMs: 0, endMs: 100 }, 100, 0, [part], 250);
    assert.equal(report.attribution, 'unknown');
    assert.deepEqual(report.topFrames, []);
    assert.ok(report.omittedNodes > 0);
  });
}
