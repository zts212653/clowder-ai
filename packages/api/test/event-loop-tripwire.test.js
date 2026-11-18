import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { get } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { block, harness } from './helpers/event-loop-tripwire-harness.js';

test(
  'the source entry used by dev starts its source worker and records a real stall',
  { timeout: 10000 },
  async (t) => {
    const h = await harness(t, undefined, true);
    await block(h, 'source', 430, true);
    assert.ok(h.reports().some((report) => report.topFrames.some((frame) => frame.file.endsWith('/fixture.js'))));
  },
);

test('an immediate long native startup block cannot disable later observation', { timeout: 15000 }, async (t) => {
  const h = await harness(t, 'blocked-install');
  await block(h, 'after-delayed-ready', 700, true);
  assert.ok(h.reports().length > 0);
  assert.ok(!h.messages.some((message) => message.type === 'log' && message.entry.status === 'unavailable'));
});

test(
  'default-on worker locates real JS, native waits and a blocker crossing profile rotations',
  { timeout: 15000 },
  async (t) => {
    const h = await harness(t);
    await block(h, 'js', 430);
    assert.ok(h.reports().some((report) => report.topFrames.some((frame) => frame.function === 'occupyEventLoopSpin')));
    const oldEpisodes = new Set(h.reports().map((report) => report.episode));
    await block(h, 'native', 430, true);
    // V8 may report the wait's JS caller directly or through a native child; both retain its real location.
    await h.wait(
      (message) =>
        message.type === 'log' &&
        !oldEpisodes.has(message.entry.episode) &&
        message.entry.topFrames?.some(
          (frame) => frame.function === 'nativeBlockingWait' && frame.selfSamples + frame.nativeSamples > 0,
        ),
    );
    await block(h, 'rollover', 1600);
    const entered = h.messages.find((message) => message.type === 'entered' && message.id === 'rollover');
    const done = h.messages.find((message) => message.type === 'done' && message.id === 'rollover');
    const starts = h.messages.filter((message) => message.entry?.method === 'Profiler.start');
    assert.ok(starts.length > 0);
    assert.ok(
      starts.every((message) => message.entry.requestedAtMs < entered.atMs || message.entry.requestedAtMs > done.atMs),
      'a stall must not start a successor profile',
    );
    const final = await h.wait(
      (message) =>
        message.type === 'log' && message.entry.phase === 'complete' && message.entry.episodeElapsedMs > 1300,
    );
    const windows = h.reports().filter((report) => report.episode === final.entry.episode);
    const timed = windows.filter((report) => report.durationMs !== undefined);
    assert.ok(timed.some((report) => report.topFrames.length > 0));
    // A new V8 session can omit a function already executing, and JIT can inline it.
    // Demand a real source coordinate for this episode, rather than inventing that missing function.
    assert.ok(
      windows.some((report) => report.topFrames.some((frame) => frame.file.endsWith('/fixture.js'))),
      JSON.stringify(windows),
    );
    for (let i = 1; i < timed.length; i++)
      assert.ok(timed[i].attributedRangeMs.from >= timed[i - 1].attributedRangeMs.to);
    assert.ok(
      Math.abs(timed.reduce((sum, report) => sum + report.durationMs, 0) - final.entry.episodeElapsedMs) <
        0.002 * timed.length,
    );
    assert.doesNotMatch(JSON.stringify(h.reports()), /file:\/\/|scriptId|callFrame|nodes|ws:\/\//);
  },
);

test('slow awaited HTTP work keeps responding and does not accuse a JS function', { timeout: 10000 }, async (t) => {
  const h = await harness(t);
  const request = (path) =>
    new Promise((resolve, reject) =>
      get(`http://127.0.0.1:${h.port}${path}`, (res) => {
        res.resume();
        res.on('end', resolve);
      }).on('error', reject),
    );
  const slow = request('/await');
  const started = performance.now();
  await request('/health');
  assert.ok(performance.now() - started < 250);
  await slow;
  assert.deepEqual(h.reports(), []);
});

test('the existing foreground profiler can record, then the tripwire resumes', { timeout: 10000 }, async (t) => {
  const h = await harness(t);
  h.child.send({ type: 'foreground' });
  assert.equal((await h.wait((message) => message.type === 'foreground')).status, 'sampled');
  await delay(100);
  await block(h, 'resumed', 450);
  assert.ok(h.reports().some((report) => report.topFrames.some((frame) => frame.function === 'occupyEventLoopSpin')));
});

test(
  'a whole-process pause reports unknown with no stale pre-pause function',
  {
    timeout: 10000,
    skip:
      process.platform === 'win32' ? 'SIGSTOP is POSIX-only; injected-clock suspension is covered separately' : false,
  },
  async (t) => {
    const h = await harness(t);
    await delay(100);
    h.child.kill('SIGSTOP');
    try {
      await delay(550);
    } finally {
      h.child.kill('SIGCONT');
    }
    const { entry } = await h.wait(
      (message) => message.type === 'log' && message.entry.kind === 'event_loop_observer_gap',
    );
    assert.equal(entry.attribution, 'unknown');
    assert.deepEqual(entry.topFrames, []);
    assert.ok(entry.workerGapMs > 400);
    await delay(400);
    assert.deepEqual(h.reports(), [], 'the stale heartbeat after resuming must not create a second stall');
  },
);

test('the observer alone cannot keep an otherwise finished process alive', { timeout: 10000 }, async (t) => {
  const h = await harness(t);
  h.child.send({ type: 'natural-exit' });
  const [code, signal] = await h.exited;
  assert.equal(code, 0);
  assert.equal(signal, null);
});

test('a profiler already active at startup is preserved, then the observer resumes', { timeout: 10000 }, async (t) => {
  const h = await harness(t, 'foreground-first');
  h.child.send({ type: 'release-initial' });
  assert.equal((await h.wait((message) => message.type === 'initial-foreground')).status, 'sampled');
  await delay(50);
  await block(h, 'after-initial', 430);
  assert.ok(h.reports().some((report) => report.topFrames.length > 0));
});

test('closing stops the real profiler and a failing log sink cannot break cleanup', { timeout: 10000 }, async (t) => {
  const h = await harness(t);
  h.child.send({ type: 'sink-failure' });
  await h.wait((message) => message.type === 'sink-failure');
  h.child.send({ type: 'block', id: 'sink', ms: 430 });
  await h.wait((message) => message.type === 'done' && message.id === 'sink');
  h.child.send({ type: 'close-observer' });
  await h.wait((message) => message.type === 'closed-observer');
  h.child.send({ type: 'foreground' });
  assert.equal((await h.wait((message) => message.type === 'foreground')).status, 'sampled');
});

test('foreground admission cannot race ahead of the observer actual shutdown', { timeout: 10000 }, async (t) => {
  const h = await harness(t);
  h.child.send({ type: 'close-race' });
  assert.equal((await h.wait((message) => message.type === 'close-race')).admittedEarly, false);
});

for (const native of [false, true]) {
  test(
    `the first ${native ? 'native' : 'JS'} stall record reaches disk while the main loop is still blocked`,
    { timeout: 10000 },
    async (t) => {
      const h = await harness(t);
      h.child.send({ type: 'block', id: 'durable', ms: 1600, native });
      await h.wait((message) => message.type === 'entered' && message.id === 'durable');
      let record;
      const deadline = performance.now() + 1100;
      while (performance.now() < deadline && !record) {
        const files = (await readdir(h.folder)).filter((file) => /^event-loop-tripwire\..*\.ndjson$/.test(file));
        for (const file of files) {
          const body = await readFile(`${h.folder}/${file}`, 'utf8');
          const lines = body
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line));
          record = lines.find((entry) => entry.kind === 'event_loop_stall' && entry.phase === 'ongoing');
        }
        if (!record) await delay(15);
      }
      assert.ok(record, 'a main-thread log callback cannot persist a still-blocked interval');
      assert.ok(record.topFrames.some((frame) => frame.file.endsWith('/fixture.js')));
      assert.equal(
        h.messages.some((message) => message.type === 'done' && message.id === 'durable'),
        false,
      );
    },
  );
}
