import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import inspector, { Session } from 'node:inspector';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

const { createProcessCpuCapture } = await import('../dist/infrastructure/telemetry/cpu/process-cpu-capture.js');
const profile = {
  nodes: [
    {
      id: 1,
      callFrame: {
        url: 'file:///private-canary.js',
        functionName: 'private-canary',
        scriptId: 'private-script-canary',
        lineNumber: 0,
        columnNumber: 0,
      },
    },
  ],
  samples: [1],
  startTime: 0,
  endTime: 60000000,
};

async function harness(t, enabled = true) {
  assert.equal(typeof createProcessCpuCapture, 'function', 'boot-only process capture is absent');
  let clock = 0;
  let cpuRatio = 0.8;
  let stops = 0;
  let disconnected = 0;
  const entries = [],
    commands = [];
  const dataDir = await mkdtemp(join(tmpdir(), 'task229-capture-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  t.mock.method(performance, 'now', () => clock);
  t.mock.method(process, 'cpuUsage', () => ({ user: clock * cpuRatio * 1000, system: 0 }));
  t.mock.method(performance, 'eventLoopUtilization', () => ({
    active: clock * cpuRatio,
    idle: clock * (1 - cpuRatio),
    utilization: cpuRatio,
  }));
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.mock.method(Session.prototype, 'connect', () => {});
  t.mock.method(Session.prototype, 'post', (method, params, callback) => {
    commands.push({ method, params: typeof params === 'function' ? undefined : params });
    const cb = typeof params === 'function' ? params : callback;
    if (method === 'Profiler.stop') stops++;
    cb(null, { profile });
  });
  t.mock.method(Session.prototype, 'disconnect', () => {
    disconnected++;
  });
  const install = createProcessCpuCapture();
  const options = { enabled, dataDir, logger: { info: (entry) => entries.push(entry) } };
  const handle = install(options);
  t.after(() => handle.close());
  return {
    handle,
    entries,
    commands,
    dataDir,
    install,
    options,
    async advance(ms) {
      clock += ms;
      t.mock.timers.tick(ms);
      await setImmediate();
    },
    low() {
      cpuRatio = 0;
    },
    high() {
      cpuRatio = 0.8;
    },
    get stops() {
      return stops;
    },
    get disconnected() {
      return disconnected;
    },
  };
}

test('default-off process capture creates no timer, session, log or file', async (t) => {
  const h = await harness(t, false);
  await h.advance(60 * 60 * 1000);
  await h.handle.close();
  assert.deepEqual(h.commands, []);
  assert.deepEqual(h.entries, []);
  assert.deepEqual(await readdir(h.dataDir), []);
});

test('two high windows admit exactly one 60s/1ms private capture; close is idempotent', async (t) => {
  const h = await harness(t);
  assert.equal(h.install(h.options), h.handle, 'duplicate bootstrap cannot install another timer');
  await h.advance(3000);
  assert.equal(h.commands.length, 0);
  await h.advance(3000);
  assert.equal(h.commands.filter((x) => x.method === 'Profiler.start').length, 1);
  assert.deepEqual(h.commands.find((x) => x.method === 'Profiler.setSamplingInterval').params, { interval: 1000 });
  await h.advance(60000);
  await h.handle.close();
  await h.handle.close();
  assert.equal(h.stops, 1);
  assert.equal(h.disconnected, 1);
  const report = h.entries.find((x) => x.status === 'sampled');
  assert.equal(report.requestedWindowMs, 60000);
  assert.equal(report.samplingIntervalUs, 1000);
  assert.equal(report.stopReason, 'window');
  const base = join(h.dataDir, 'private-cpu-profiles');
  const captures = await readdir(base);
  assert.equal(captures.length, 1);
  const folder = join(base, captures[0]);
  assert.equal((await stat(folder)).mode & 0o777, 0o700);
  const raw = join(folder, 'process.cpuprofile');
  assert.equal((await stat(raw)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(raw, 'utf8')), profile);
  await h.advance(60 * 60 * 1000);
  assert.equal(h.stops, 1);
  assert.equal(h.install(h.options), h.handle, 'completed one-shot cannot rearm');
  assert.equal(inspector.url(), undefined);
});

test('low utilization expires without recording and cannot record after expiry', async (t) => {
  const h = await harness(t);
  h.low();
  for (let i = 0; i < 300; i++) await h.advance(3000);
  assert.equal(h.commands.length, 0);
  assert.ok(h.entries.some((x) => x.status === 'expired'));
  h.high();
  await h.advance(6000);
  assert.equal(h.commands.length, 0);
});

test('shutdown stops an admitted session once without publishing private data', async (t) => {
  const h = await harness(t);
  await h.advance(3000);
  await h.advance(3000);
  await h.handle.close();
  assert.equal(h.stops, 1);
  assert.equal(h.entries.find((x) => x.status === 'sampled').stopReason, 'shutdown');
  assert.doesNotMatch(JSON.stringify(h.entries), /file:\/\/|private-canary|ws:\/\//);
});

test('an existing debugger is left alone and its address never reaches logs', async (t) => {
  const h = await harness(t);
  const replacement = t.mock.method(inspector, 'url', () => 'ws://private-canary');
  syncBuiltinESMExports();
  try {
    await h.advance(3000);
    await h.advance(3000);
    await h.handle.close();
    assert.equal(h.commands.length, 0);
    assert.equal(h.entries.find((x) => x.status === 'unavailable').reason, 'debugger_active');
    assert.doesNotMatch(JSON.stringify(h.entries), /private-canary|ws:\/\//);
  } finally {
    replacement.mock.restore();
    syncBuiltinESMExports();
  }
});

test('process and route profilers share a lease and neither stops the other session', async (t) => {
  const { tryAcquireCpuProfiler } = await import('../dist/infrastructure/telemetry/cpu/cpu-profiler-lease.js');
  const { createSlowReadCpuObserver } = await import('../dist/infrastructure/telemetry/cpu/slow-read-cpu-observer.js');
  const h = await harness(t);
  const release = tryAcquireCpuProfiler();
  assert.equal(typeof release, 'function');
  t.after(release);
  await h.advance(3000);
  await h.advance(3000);
  assert.equal(h.commands.length, 0);
  release();
  await h.advance(3000);
  assert.equal(h.commands.filter((x) => x.method === 'Profiler.start').length, 1);
  const observe = createSlowReadCpuObserver();
  const finish = observe({ info() {} });
  await h.advance(2000);
  finish();
  assert.equal(h.stops, 0, 'route settlement cannot stop process capture');
  await h.handle.close();
  const after = observe({ info() {} });
  await h.advance(2000);
  after();
  await setImmediate();
  assert.equal(h.commands.filter((x) => x.method === 'Profiler.start').length, 2);
  assert.equal(h.stops, 2);
});

test('preparation failure and throwing logger release the shared lease without retry', async (t) => {
  const { tryAcquireCpuProfiler } = await import('../dist/infrastructure/telemetry/cpu/cpu-profiler-lease.js');
  const h = await harness(t);
  t.mock.method(Session.prototype, 'connect', () => {
    throw new Error('private-connect-canary');
  });
  await h.advance(3000);
  await h.advance(3000);
  await h.handle.close();
  assert.equal(h.entries.find((x) => x.status === 'unavailable').reason, 'profiler_failed');
  assert.equal(h.disconnected, 1);
  assert.doesNotMatch(JSON.stringify(h.entries), /private-connect-canary/);
  const release = tryAcquireCpuProfiler();
  assert.equal(typeof release, 'function');
  release();
  const other = createProcessCpuCapture()({
    enabled: true,
    dataDir: h.dataDir,
    logger: {
      info() {
        throw Error('private-logger-canary');
      },
    },
  });
  await h.advance(3000);
  await h.advance(3000);
  await other.close();
  const after = tryAcquireCpuProfiler();
  assert.equal(typeof after, 'function');
  after();
});

test('invalid internal window arguments cannot open a session or bypass the maximum', async (t) => {
  const h = await harness(t, false);
  const { recordProcessCpuProfile } = await import('../dist/infrastructure/telemetry/cpu/process-cpu-session.js');
  for (const window of [0, -1, 60001, Infinity, NaN, 1.5]) {
    assert.deepEqual(await recordProcessCpuProfile(new AbortController().signal, window), {
      status: 'unavailable',
      reason: 'invalid_window',
    });
  }
  assert.deepEqual(h.commands, []);
});
