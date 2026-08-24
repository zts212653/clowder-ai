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

test('live interleaving keeps each native session pinned to its original host', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { pool, hosts } = createHarness({ idleTtlMs: 300_000 });
  try {
    const firstB = await pool.createSession(sessionOptions({ invocationId: 'invocation-b1' }));
    firstB.rememberSession('thread-b');
    await firstB.close();

    t.mock.timers.tick(73_815);
    const firstA = await pool.createSession(sessionOptions({ invocationId: 'invocation-a1' }));
    firstA.rememberSession('thread-a');
    assert.equal(hosts.length, 2, 'a new native session must not borrow a host owned by thread-b');
    assert.equal(firstA.reusedSessionHost, false);

    t.mock.timers.tick(207_795);
    await firstA.close();

    t.mock.timers.tick(119_989);
    const resumedB = await pool.createSession(sessionOptions({ invocationId: 'invocation-b2', sessionId: 'thread-b' }));

    t.mock.timers.tick(104_517);
    const resumedA = await pool.createSession(sessionOptions({ invocationId: 'invocation-a2', sessionId: 'thread-a' }));

    assert.equal(hosts.length, 2, 'the interleaving must not cold-spawn a third host');
    assert.equal(resumedB.reusedSessionHost, true);
    assert.equal(resumedA.reusedSessionHost, true);
    assert.equal(hosts[0].connections.length, 2, 'thread-b must resume on H1');
    assert.equal(hosts[1].connections.length, 2, 'thread-a must resume on H2');

    await resumedA.close();
    await resumedB.close();
  } finally {
    await pool.closeAll();
  }
});

test('legacy multi-affinity waits for the active lease, retires the host, then resumes', async () => {
  const { pool, hosts } = createHarness({ idleTtlMs: 300_000 });
  try {
    const legacy = await pool.createSession(sessionOptions({ invocationId: 'invocation-legacy' }));
    legacy.rememberSession('thread-b');
    await legacy.close();

    const resumedB = await pool.createSession(sessionOptions({ invocationId: 'invocation-b2', sessionId: 'thread-b' }));
    pool.sessionOwners.set('thread-a', pool.sessionOwners.get('thread-b'));
    let aSettled = false;
    const acquiringA = pool
      .createSession(sessionOptions({ invocationId: 'invocation-a2', sessionId: 'thread-a' }))
      .then((session) => {
        aSettled = true;
        return session;
      });

    await delay(0);
    assert.equal(aSettled, false, 'thread-a must not migrate while H1 still carries thread-b');
    assert.equal(hosts.length, 1, 'no replacement host may start before H1 is retired');
    assert.equal(hosts[0].closeCalls, 0, 'the active lease must reach terminal before retirement starts');

    await resumedB.close();
    const resumedA = await acquiringA;
    assert.equal(hosts[0].closeCalls, 1, 'legacy multi-affinity must retire the entire shared host');
    assert.equal(hosts.length, 2);
    assert.equal(resumedA.reusedSessionHost, false);
    await resumedA.close();
  } finally {
    await pool.closeAll();
  }
});

test('legacy multi-affinity retirement wait is cancelled by the invocation signal', async () => {
  const { pool, hosts } = createHarness({ idleTtlMs: 300_000 });
  const controller = new AbortController();
  try {
    const legacy = await pool.createSession(sessionOptions({ invocationId: 'invocation-legacy' }));
    legacy.rememberSession('thread-b');
    await legacy.close();

    const resumedB = await pool.createSession(sessionOptions({ invocationId: 'invocation-b2', sessionId: 'thread-b' }));
    pool.sessionOwners.set('thread-a', pool.sessionOwners.get('thread-b'));
    const acquiringA = pool.createSession(
      sessionOptions({ invocationId: 'invocation-a2', sessionId: 'thread-a', signal: controller.signal }),
    );
    await delay(0);
    controller.abort(new Error('invocation cancelled'));

    await assert.rejects(acquiringA, /invocation cancelled/);
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].closeCalls, 0, 'cancelling the waiter must not terminate another session lease');
    await resumedB.close();
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

test('an aborted lease cannot return its host warm when cooperative close wins the grace race', async () => {
  const { pool, hosts } = createHarness({ abortGraceMs: 60_000 });
  const abortController = new AbortController();
  try {
    const cancelled = await pool.createSession(
      sessionOptions({ invocationId: 'invocation-cancelled', signal: abortController.signal }),
    );
    cancelled.rememberSession('thread-cancelled');

    abortController.abort('user_cancel');
    await cancelled.close();

    assert.equal(hosts[0].closeCalls, 1, 'an abort-observed lease must evict its exact host immediately on close');
    assert.equal(pool.getMetrics().warmHostCount, 0, 'the cancelled host must never become a warm candidate');

    const resumed = await pool.createSession(
      sessionOptions({ invocationId: 'invocation-resumed', sessionId: 'thread-cancelled' }),
    );
    assert.equal(hosts.length, 2, 'same-session recovery must acquire a fresh host after cancellation');
    assert.equal(hosts[0].connections.length, 1, 'the cancelled host must never accept successor work');
    assert.equal(hosts[1].connections.length, 1, 'the successor must run on the replacement host only');
    assert.equal(resumed.reusedSessionHost, false, 'the cancelled provider session host must not be reused');
    await resumed.close();
  } finally {
    await pool.closeAll();
  }
});

test('tracker lease-age reads do not abort or reap an active provider host', async (t) => {
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
    assert.equal(tracker.has('cafe-thread-a', 'codex'), true, 'lease age alone must not retire the owner');
    assert.equal(tracker.listStaleSlots().length, 1, 'age should only surface an explicit reaper candidate');
    assert.equal(controller.signal.aborted, false, 'liveness reads must not become a provider cancel path');
    await delay(20);

    assert.equal(hosts[0].closeCalls, 0, 'candidate enumeration must not reach the pool abort fallback');
    assert.equal(pool.getMetrics().activeLeaseCount, 1);
    await abandoned.close();
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

test('concurrent cold resumes for the same native session serialize before host selection', async () => {
  const { pool, hosts } = createHarness();
  try {
    const firstAcquisition = pool.createSession(
      sessionOptions({ invocationId: 'invocation-first', sessionId: 'thread-a' }),
    );
    const duplicateAcquisition = pool.createSession(
      sessionOptions({ invocationId: 'invocation-duplicate', sessionId: 'thread-a' }),
    );

    const first = await firstAcquisition;
    await assert.rejects(duplicateAcquisition, /already has an active host lease/);
    assert.equal(hosts.length, 1, 'duplicate cold resume must not spawn a competing writer host');
    await first.close();
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

test('signature mismatch closes the old host completely before resuming on a replacement', async () => {
  const { pool, hosts } = createHarness();
  let releaseClose;
  const closeGate = new Promise((resolve) => {
    releaseClose = resolve;
  });
  try {
    const first = await pool.createSession(sessionOptions());
    first.rememberSession('thread-a');
    await first.close();

    hosts[0].close = async () => {
      hosts[0].closeCalls++;
      await closeGate;
      hosts[0].alive = false;
    };
    let replacementSettled = false;
    const acquiring = pool
      .createSession(sessionOptions({ sessionId: 'thread-a', cwd: '/workspace/different-project' }))
      .then((session) => {
        replacementSettled = true;
        return session;
      });

    await delay(0);
    assert.equal(hosts[0].closeCalls, 1, 'signature mismatch must retire the source host');
    assert.equal(replacementSettled, false, 'resume must wait for source host close completion');
    assert.equal(hosts.length, 1, 'no new host may start while the source host is still alive');

    releaseClose();
    const replacement = await acquiring;
    assert.equal(hosts.length, 2);
    assert.equal(replacement.reusedSessionHost, false);
    await replacement.close();
  } finally {
    releaseClose?.();
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
