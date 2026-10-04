import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createGitHubSelfLoginResolver } from '../dist/infrastructure/github/self-login-resolver.js';

test('one cancelled login waiter leaves the shared probe and another caller intact', async () => {
  let finish;
  let calls = 0;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const resolver = createGitHubSelfLoginResolver({
    getTokenFingerprint: () => 'credential-a',
    resolveLogin: () => {
      calls++;
      return pending;
    },
  });
  const controller = new AbortController();
  let cancelled = false;
  const first = resolver.refreshIfNeeded(controller.signal).catch(() => {
    cancelled = true;
  });
  const second = resolver.refreshIfNeeded();
  controller.abort(new Error('caller deadline'));
  await setImmediate();
  try {
    assert.equal(cancelled, true, 'caller must not wait for the shared upstream timeout');
    const third = resolver.refreshIfNeeded();
    assert.equal(calls, 1, 'abort must not release ownership of the shared in-flight probe');
    finish('maintainer');
    assert.equal(await second, 'maintainer');
    assert.equal(await third, 'maintainer');
    assert.equal(resolver.getCurrent(), 'maintainer');
  } finally {
    finish('maintainer');
    await first;
    await second;
  }
});
test('a late exhausted old credential cannot clear a newer credential login', async () => {
  let token = 'old';
  let fail;
  const old = new Promise((_resolve, reject) => {
    fail = reject;
  });
  const resolver = createGitHubSelfLoginResolver({
    getTokenFingerprint: () => token,
    resolveLogin: () => (token === 'old' ? old : Promise.resolve('new-owner')),
  });
  const first = resolver.refreshIfNeeded();
  token = 'new';
  assert.equal(await resolver.refreshIfNeeded(), 'new-owner');
  fail(new Error('old credential quota exhausted'));
  await first;
  assert.equal(resolver.getCurrent(), 'new-owner');
});
