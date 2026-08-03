import assert from 'node:assert/strict';
import { realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import {
  createCodexSocketDirectory,
  removeCodexSocketDirectory,
} from '../dist/domains/cats/services/agents/providers/CodexUnixWebSocketSession.js';
import { createHarness, sessionOptions } from './helpers/codex-host-pool-harness.js';

test('sequential invocations reuse one warm host while opening isolated connections', async () => {
  const { pool, hosts } = createHarness();
  try {
    const first = await pool.createSession(sessionOptions());
    await first.close();

    const second = await pool.createSession(sessionOptions({ invocationId: 'invocation-2' }));

    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].connections.length, 2);
    assert.notEqual(hosts[0].connections[0], hosts[0].connections[1]);
    assert.equal(pool.getMetrics().coldStartCount, 1);
    assert.equal(pool.getMetrics().warmHitCount, 1);
    await second.close();
  } finally {
    await pool.closeAll();
  }
});

test('concurrent invocations never share an active host', async () => {
  const { pool, hosts } = createHarness();
  try {
    const first = await pool.createSession(sessionOptions({ invocationId: 'invocation-1' }));
    const second = await pool.createSession(sessionOptions({ invocationId: 'invocation-2' }));

    assert.equal(hosts.length, 2);
    assert.deepEqual(
      hosts.map((host) => host.connections.length),
      [1, 1],
    );
    assert.equal(pool.getMetrics().activeLeaseCount, 2);

    await first.close();
    await second.close();
  } finally {
    await pool.closeAll();
  }
});

test('session affinity returns a resumed thread to its original host', async () => {
  const { pool, hosts } = createHarness();
  try {
    const first = await pool.createSession(sessionOptions({ invocationId: 'invocation-a' }));
    const second = await pool.createSession(sessionOptions({ invocationId: 'invocation-b' }));
    first.rememberSession('thread-a');
    second.rememberSession('thread-b');
    await first.close();
    await second.close();

    const resumed = await pool.createSession(sessionOptions({ invocationId: 'invocation-b2', sessionId: 'thread-b' }));
    assert.equal(hosts.length, 2);
    assert.equal(hosts[0].connections.length, 1);
    assert.equal(hosts[1].connections.length, 2);
    assert.equal(resumed.reusedSessionHost, true);
    await resumed.close();
  } finally {
    await pool.closeAll();
  }
});

test('resume rotates away from an affinity host that is active for another session', async () => {
  const { pool, hosts } = createHarness();
  try {
    const first = await pool.createSession(sessionOptions({ invocationId: 'invocation-a1' }));
    first.rememberSession('thread-a');
    await first.close();

    const second = await pool.createSession(sessionOptions({ invocationId: 'invocation-b1' }));
    second.rememberSession('thread-b');

    const resumed = await pool.createSession(sessionOptions({ invocationId: 'invocation-a2', sessionId: 'thread-a' }));

    assert.equal(hosts.length, 2, 'thread-a must get a replacement instead of a false same-session conflict');
    assert.equal(resumed.reusedSessionHost, false);
    assert.equal(hosts[0].connections.length, 2, 'thread-b legitimately reused the original warm host');
    assert.equal(hosts[1].connections.length, 1, 'thread-a resumed on an isolated replacement host');

    await resumed.close();
    await second.close();
  } finally {
    await pool.closeAll();
  }
});

test('an aborted lease is force-reaped when cooperative cleanup is abandoned', async () => {
  const { pool, hosts } = createHarness({ abortGraceMs: 5 });
  const abortController = new AbortController();
  try {
    const abandoned = await pool.createSession(
      sessionOptions({ invocationId: 'invocation-abandoned', signal: abortController.signal }),
    );
    abandoned.rememberSession('thread-a');

    abortController.abort('user_cancel');
    await delay(20);

    assert.equal(hosts[0].closeCalls, 1, 'pool-side abort fallback must reap the abandoned host');
    assert.equal(pool.getMetrics().activeLeaseCount, 0);

    const resumed = await pool.createSession(
      sessionOptions({ invocationId: 'invocation-resumed', sessionId: 'thread-a' }),
    );
    assert.equal(hosts.length, 2);
    assert.equal(resumed.reusedSessionHost, false);
    await resumed.close();
  } finally {
    await pool.closeAll();
  }
});

test('tracker zombie expiry reaps an abandoned lease and permits the same session to resume', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  const { pool, hosts } = createHarness({ abortGraceMs: 5 });
  const tracker = new InvocationTracker({ maxSlotTtlMs: 1000 });
  const controller = tracker.start('cafe-thread-a', 'codex', 'user1', ['codex'], 'invocation-stuck');
  try {
    const abandoned = await pool.createSession(
      sessionOptions({ invocationId: 'invocation-stuck', signal: controller.signal }),
    );
    abandoned.rememberSession('codex-session-a');

    t.mock.timers.tick(1001);
    assert.equal(tracker.has('cafe-thread-a', 'codex'), false, 'tracker TTL should retire the stale slot');
    await delay(20);

    assert.equal(hosts[0].closeCalls, 1, 'tracker expiry must reach the pool abort fallback');
    assert.equal(pool.getMetrics().activeLeaseCount, 0);

    const resumed = await pool.createSession(
      sessionOptions({ invocationId: 'invocation-resumed', sessionId: 'codex-session-a' }),
    );
    assert.equal(hosts.length, 2, 'same-session resume should receive a fresh host after stale cleanup');
    await resumed.close();
  } finally {
    await pool.closeAll();
  }
});

test('a genuinely active lease for the same session remains fail-closed', async () => {
  const { pool } = createHarness();
  try {
    const active = await pool.createSession(
      sessionOptions({ invocationId: 'invocation-active', sessionId: 'thread-a' }),
    );
    active.rememberSession('thread-a');

    await assert.rejects(
      pool.createSession(sessionOptions({ invocationId: 'invocation-duplicate', sessionId: 'thread-a' })),
      /already has an active host lease/,
    );
    assert.equal(pool.getMetrics().activeLeaseCount, 1);
    await active.close();
  } finally {
    await pool.closeAll();
  }
});

test('warm cap bounds idle retention without rejecting active concurrency', async () => {
  const { pool, hosts } = createHarness({ maxWarmHosts: 1 });
  try {
    const first = await pool.createSession(sessionOptions({ invocationId: 'invocation-1' }));
    const second = await pool.createSession(sessionOptions({ invocationId: 'invocation-2' }));
    assert.equal(hosts.length, 2, 'active demand may exceed the warm retention cap');

    await first.close();
    await second.close();
    assert.equal(pool.getMetrics().liveHostCount, 1);
    assert.equal(hosts.filter((host) => host.closeCalls === 1).length, 1);
  } finally {
    await pool.closeAll();
  }
});

test('terminating a stuck invocation closes its host and drops session affinity', async () => {
  const { pool, hosts } = createHarness();
  try {
    const first = await pool.createSession(sessionOptions());
    first.rememberSession('thread-a');
    const firstHost = hosts[0];
    await first.terminate();

    assert.equal(firstHost.closeCalls, 1);
    assert.equal(pool.getMetrics().liveHostCount, 0);

    const replacement = await pool.createSession(sessionOptions({ sessionId: 'thread-a' }));
    assert.equal(hosts.length, 2);
    assert.notEqual(hosts[1].id, firstHost.id);
    await replacement.close();
  } finally {
    await pool.closeAll();
  }
});

test('an externally dead warm host is replaced without counting a warm hit', async () => {
  const { pool, hosts } = createHarness();
  try {
    const first = await pool.createSession(sessionOptions());
    first.rememberSession('thread-a');
    await first.close();
    hosts[0].alive = false;

    const replacement = await pool.createSession(sessionOptions({ sessionId: 'thread-a' }));
    assert.equal(hosts.length, 2);
    assert.equal(pool.getMetrics().coldStartCount, 2);
    assert.equal(pool.getMetrics().warmHitCount, 0);
    assert.equal(pool.getMetrics().warmHostCount, 0);
    assert.equal(replacement.reusedSessionHost, false);
    await replacement.close();
  } finally {
    await pool.closeAll();
  }
});

test('idle TTL closes the host once and forgets its affinity', async () => {
  const { pool, hosts } = createHarness({ idleTtlMs: 10 });
  const first = await pool.createSession(sessionOptions());
  first.rememberSession('thread-a');
  await first.close();
  await delay(30);

  assert.equal(hosts[0].closeCalls, 1);
  assert.equal(pool.getMetrics().liveHostCount, 0);

  const replacement = await pool.createSession(sessionOptions({ sessionId: 'thread-a' }));
  assert.equal(hosts.length, 2);
  await replacement.close();
  await pool.closeAll();
});

test('zero idle TTL closes the host before another same-turn lease can reuse it', async () => {
  const { pool, hosts } = createHarness({ idleTtlMs: 0 });
  try {
    const first = await pool.createSession(sessionOptions({ invocationId: 'invocation-1' }));
    await first.close();

    assert.equal(hosts[0].closeCalls, 1, 'closing the lease must synchronously recycle the host');
    assert.equal(pool.getMetrics().liveHostCount, 0);
    assert.equal(pool.getMetrics().warmHostCount, 0);

    const second = await pool.createSession(sessionOptions({ invocationId: 'invocation-2' }));
    assert.equal(hosts.length, 2);
    assert.equal(pool.getMetrics().warmHitCount, 0);
    await second.close();
  } finally {
    await pool.closeAll();
  }
});

test('resume rotates away from affinity when the host launch signature changed', async () => {
  const { pool, hosts } = createHarness();
  try {
    const first = await pool.createSession(sessionOptions());
    first.rememberSession('thread-a');
    await first.close();

    const replacement = await pool.createSession(
      sessionOptions({ sessionId: 'thread-a', cwd: '/workspace/different-project' }),
    );
    assert.equal(hosts.length, 2);
    assert.equal(replacement.reusedSessionHost, false);
    await replacement.close();
  } finally {
    await pool.closeAll();
  }
});

test('host launch strips invocation-scoped callback identity and uses a unix websocket listener', async () => {
  const { pool, hosts } = createHarness();
  try {
    const session = await pool.createSession(sessionOptions());
    const launch = hosts[0].launch;

    assert.equal(
      launch.env.CAT_CAFE_INVOCATION_ID,
      null,
      'a tombstone is required so the real spawn layer cannot re-inherit the API process value',
    );
    assert.equal(launch.env.CAT_CAFE_CALLBACK_TOKEN, null);
    assert.equal(launch.env.CAT_CAFE_THREAD_ID, null);
    assert.equal(launch.env.HOME, '/home/user');
    assert.equal(launch.args.includes('--stdio'), false);
    assert.equal(launch.args.includes('--listen'), true);
    assert.match(launch.args[launch.args.indexOf('--listen') + 1], /^unix:\/\/\/private\/tmp\/codex-host-test-/);
    assert.doesNotMatch(JSON.stringify(launch), /callback-secret-token|invocation-secret-id|thread-secret-id/);
    await session.close();
  } finally {
    await pool.closeAll();
  }
});

test('unix socket directories use the canonical private tmp parent with owner-only access', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Unix socket host pooling is intentionally disabled on Windows');
    return;
  }
  const directory = createCodexSocketDirectory();
  try {
    assert.equal(dirname(directory), realpathSync('/tmp'));
    assert.equal(statSync(directory).mode & 0o777, 0o700);
  } finally {
    await removeCodexSocketDirectory(directory);
  }
});
