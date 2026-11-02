import assert from 'node:assert/strict';
import { Session, url } from 'node:inspector';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { promisify } from 'node:util';

const { observeThreadArtifactRead } = await import(
  '../dist/domains/cats/services/agents/routing/thread-artifact-read-diagnostics.js'
);
const { projectMainThreadCpuProfile } = await import('../dist/infrastructure/telemetry/cpu/main-thread-cpu-profile.js');

test('a still-pending artifact read captures bounded process CPU evidence without holding its result', async (t) => {
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entries = [];
  const logger = { info: (entry, message) => entries.push({ entry, message }) };
  const payload = { body: 'private-result-canary', sourceRef: 'private-source-canary' };
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const pending = observeThreadArtifactRead(logger, async (measure) => {
    await measure('independentWorks', () => barrier);
    return payload;
  });
  try {
    clock = 2_000;
    t.mock.timers.tick(2_000);
    await setImmediate();
    const workload = {
      nodes: Array.from({ length: 128 }, (_, i) => ({
        id: i + 1,
        callFrame: {
          url: new URL(`../dist/infrastructure/fixture-${i}.js`, import.meta.url).href,
          functionName: `fixture${i}`,
          scriptId: '1',
          lineNumber: 0,
          columnNumber: 0,
        },
      })),
      samples: Array.from({ length: 10000 }, (_, i) => (i % 128) + 1),
      startTime: 0,
      endTime: 2000000,
    };
    const until = Date.now() + 120;
    while (Date.now() < until) projectMainThreadCpuProfile(workload);
    clock = 4_000;
    t.mock.timers.tick(2_000);
    await setImmediate();
    const samples = entries.filter(({ message }) => message === '[Task229] process CPU sample');
    assert.equal(samples.length, 1, 'one process-level profile is emitted while the real reader remains pending');
    const report = samples[0].entry;
    assert.equal(report.kind, 'main_thread_cpu_sample');
    assert.equal(report.status, 'sampled');
    assert.ok(report.sampleCount > 0, 'the native V8 profiler must actually collect samples');
    assert.ok(
      report.topFrames.some((frame) => frame.file === 'infrastructure/telemetry/cpu/main-thread-cpu-profile.js'),
      'a real hot API function is recovered from the native profile as a relative code coordinate',
    );
    assert.ok(report.topFrames.length <= 12);
    assert.equal(report.requestedWindowMs, 2_000);
    assert.equal(report.samplingIntervalUs, 10_000);
    assert.doesNotMatch(JSON.stringify(samples), /canary|sourceRef|body|file:\/\/|\/Users\//);
    release();
    assert.equal(await pending, payload, 'the original result is unchanged');
    assert.equal(entries.filter(({ message }) => message === '[Task229] process CPU sample').length, 1);
  } finally {
    release();
    await pending;
  }
});

test('pending profiler cleanup does not hold either the successful result or the original business error', async (t) => {
  let clock = 910000;
  t.mock.method(performance, 'now', () => clock);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stops = [];
  let disconnected = 0;
  t.mock.method(Session.prototype, 'connect', () => {});
  t.mock.method(Session.prototype, 'post', (method, params, callback) => {
    const cb = typeof params === 'function' ? params : callback;
    if (method === 'Profiler.stop') stops.push(cb);
    else cb(null, {});
  });
  t.mock.method(Session.prototype, 'disconnect', () => {
    disconnected++;
  });
  for (const rejectBusiness of [false, true]) {
    const entries = [];
    const failure = new Error('private-business-error-canary');
    const result = { content: 'private-result-canary' };
    let release;
    const barrier = new Promise((resolve) => {
      release = resolve;
    });
    const pending = observeThreadArtifactRead({ info: (entry) => entries.push(entry) }, async () => {
      await barrier;
      if (rejectBusiness) throw failure;
      return result;
    });
    clock += 2000;
    t.mock.timers.tick(2000);
    await setImmediate();
    release();
    if (rejectBusiness) await assert.rejects(pending, (error) => error === failure);
    else assert.equal(await pending, result);
    assert.equal(stops.length, 1, 'native cleanup is still pending after the business promise settles');
    assert.equal(entries.filter((entry) => entry.kind === 'main_thread_cpu_sample').length, 0);
    stops.shift()(null, { profile: { nodes: [], samples: [], startTime: 0, endTime: 1000 } });
    await setImmediate();
    assert.equal(entries.filter((entry) => entry.kind === 'main_thread_cpu_sample').length, 1);
    assert.doesNotMatch(JSON.stringify(entries), /canary/);
    clock += 15 * 60 * 1000;
  }
  assert.equal(disconnected, 2);
});

test('an independent in-process native profiling session keeps its own profile across our capture', async (t) => {
  const { createSlowReadCpuObserver } = await import('../dist/infrastructure/telemetry/cpu/slow-read-cpu-observer.js');
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const beforeUrl = url();
  const foreign = new Session();
  foreign.connect();
  const post = promisify(foreign.post.bind(foreign));
  const entries = [];
  try {
    await post('Profiler.enable');
    await post('Profiler.setSamplingInterval', { interval: 1000 });
    await post('Profiler.start');
    const until = Date.now() + 30;
    while (Date.now() < until) JSON.parse('{"value":42}');
    const finish = createSlowReadCpuObserver()({ info: (entry) => entries.push(entry) });
    clock += 2000;
    t.mock.timers.tick(2000);
    await setImmediate();
    const secondUntil = Date.now() + 40;
    while (Date.now() < secondUntil) JSON.parse('{"value":42}');
    finish();
    await setImmediate();
    const retained = await post('Profiler.stop');
    assert.ok(retained.profile.samples.length > 0);
    assert.equal(entries[0].status, 'sampled');
    assert.ok((retained.profile.endTime - retained.profile.startTime) / 1000 > entries[0].profileElapsedMs);
    assert.equal(url(), beforeUrl, 'in-process sessions do not create a debugger listener');
  } finally {
    foreign.disconnect();
  }
});
