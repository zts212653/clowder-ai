import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForNativeReady } from './native-team-startup-ready.mjs';

function fixture(states) {
  let time = 0;
  const seen = [];
  return {
    seen,
    now: () => time,
    timeoutMs: 500,
    sleep: async () => {
      time += 100;
    },
    read: async () => {
      const state = states[Math.min(seen.length, states.length - 1)];
      seen.push(state);
      return state;
    },
  };
}

test('a product URL or stale ready report cannot authorize navigation before current ready', async () => {
  const options = fixture([
    { pid: 9, phase: 'ready' },
    { pid: 10, phase: 'starting' },
    { pid: 10, phase: 'ready' },
  ]);
  assert.deepEqual(await waitForNativeReady('fixture', 10, options), { pid: 10, phase: 'ready' });
  assert.equal(options.seen.length, 3);
});

test('current native failure is surfaced instead of waiting for browser locators', async () => {
  await assert.rejects(
    waitForNativeReady('fixture', 10, fixture([{ pid: 10, phase: 'failed', message: 'API exit 42' }])),
    /API exit 42/,
  );
});

test('a starting window or unrelated PID times out without becoming ready', async () => {
  for (const state of [
    { pid: 10, phase: 'starting' },
    { pid: 9, phase: 'ready' },
  ])
    await assert.rejects(waitForNativeReady('fixture', 10, fixture([state])), /never reported startup ready/);
});

test('missing files may appear later, but unreadable evidence cannot be bypassed', async () => {
  let reads = 0;
  const options = fixture([]);
  options.read = async () => {
    if (!reads++) throw Object.assign(new Error('not created'), { code: 'ENOENT' });
    return { pid: 10, phase: 'ready' };
  };
  assert.equal((await waitForNativeReady('fixture', 10, options)).phase, 'ready');
  options.read = async () => {
    throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
  };
  await assert.rejects(waitForNativeReady('fixture', 10, options), /unreadable/);
});
