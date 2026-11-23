import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  acquireCpuProfiler,
  registerBackgroundCpuProfiler,
  tryAcquireCpuProfiler,
} from '../dist/infrastructure/telemetry/cpu/cpu-profiler-lease.js';

test('foreground admission waits for background stop, excludes siblings, then resumes once', async () => {
  const events = [];
  let stopped;
  const background = registerBackgroundCpuProfiler({
    pause: () =>
      new Promise((resolve) => {
        events.push('pause');
        stopped = resolve;
      }),
    resume: () => {
      events.push('resume');
    },
  });
  try {
    assert.equal(background.paused, false);
    assert.equal(tryAcquireCpuProfiler(), undefined);
    const admission = acquireCpuProfiler();
    assert.deepEqual(events, ['pause']);
    assert.equal(await acquireCpuProfiler(), undefined);
    stopped();
    const release = await admission;
    assert.ok(release);
    release();
    release();
    assert.deepEqual(events, ['pause', 'resume']);
  } finally {
    background.unregister();
  }
});

test('a background installed during a foreground capture starts paused', async () => {
  const release = tryAcquireCpuProfiler();
  assert.ok(release);
  let resumes = 0;
  const background = registerBackgroundCpuProfiler({
    pause: async () => {},
    resume: () => {
      resumes++;
    },
  });
  try {
    assert.equal(background.paused, true);
    release();
    assert.equal(resumes, 1);
  } finally {
    release();
    background.unregister();
  }
});

test('a failed background stop refuses the foreground and releases its reservation', async () => {
  const background = registerBackgroundCpuProfiler({
    pause: async () => {
      throw Error('private');
    },
    resume() {},
  });
  try {
    assert.equal(await acquireCpuProfiler(), undefined);
  } finally {
    background.unregister();
  }
  const release = tryAcquireCpuProfiler();
  assert.ok(release);
  release();
});

test('closing the background during a foreground capture cannot resurrect it', async () => {
  let resumes = 0;
  const background = registerBackgroundCpuProfiler({
    pause: async () => {},
    resume: () => {
      resumes++;
    },
  });
  const release = await acquireCpuProfiler();
  assert.ok(release);
  background.unregister();
  release();
  assert.equal(resumes, 0);
});

test('a broken observer resume cannot reject foreground cleanup or retain its lease', async () => {
  const background = registerBackgroundCpuProfiler({
    pause: async () => {},
    resume: () => {
      throw Error('broken observer');
    },
  });
  try {
    const release = await acquireCpuProfiler();
    assert.ok(release);
    assert.doesNotThrow(release);
  } finally {
    background.unregister();
  }
  const after = tryAcquireCpuProfiler();
  assert.ok(after);
  after();
});
