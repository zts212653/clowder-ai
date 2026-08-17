import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexAppServerHostPool } from '../dist/domains/cats/services/agents/providers/CodexAppServerHostPool.js';
import { createHarness, FakeConnection, FakeHost, sessionOptions } from './helpers/codex-host-pool-harness.js';

test('shutdown fences a host whose spawn completes after closeAll begins', async () => {
  let releaseSpawn;
  let markSpawnStarted;
  const spawnStarted = new Promise((resolve) => {
    markSpawnStarted = resolve;
  });
  const spawnGate = new Promise((resolve) => {
    releaseSpawn = resolve;
  });
  const host = new FakeHost('late-host', null);
  const pool = new CodexAppServerHostPool(
    { idleTtlMs: 60_000, maxWarmHosts: 16 },
    {
      createSocketDirectory: () => '/private/tmp/codex-host-late-spawn',
      removeSocketDirectory: async () => {},
      spawnHost: async (launch) => {
        host.launch = launch;
        markSpawnStarted();
        await spawnGate;
        return host;
      },
      connectHost: async () => new FakeConnection(host),
    },
  );

  const acquiring = pool.createSession(sessionOptions());
  const rejected = assert.rejects(acquiring, /pool is closed/);
  await spawnStarted;
  const shutdown = pool.closeAll();
  releaseSpawn();

  await shutdown;
  await rejected;
  assert.equal(host.closeCalls, 1);
  assert.equal(pool.getMetrics().liveHostCount, 0);
});

test('shutdown rejects and closes a connection that finishes after its host was closed', async () => {
  let releaseConnect;
  let markConnectStarted;
  const connectStarted = new Promise((resolve) => {
    markConnectStarted = resolve;
  });
  const connectGate = new Promise((resolve) => {
    releaseConnect = resolve;
  });
  const connection = new FakeConnection(null);
  const host = new FakeHost('late-connection-host', null);
  const pool = new CodexAppServerHostPool(
    { idleTtlMs: 60_000, maxWarmHosts: 16 },
    {
      createSocketDirectory: () => '/private/tmp/codex-host-late-connect',
      removeSocketDirectory: async () => {},
      spawnHost: async (launch) => {
        host.launch = launch;
        return host;
      },
      connectHost: async () => {
        markConnectStarted();
        await connectGate;
        return connection;
      },
    },
  );

  const acquiring = pool.createSession(sessionOptions());
  const rejected = assert.rejects(acquiring, /pool is closed/);
  await connectStarted;
  const shutdown = pool.closeAll();
  releaseConnect();

  await shutdown;
  await rejected;
  assert.equal(host.closeCalls, 1);
  assert.equal(connection.closeCalls, 1);
  assert.equal(pool.getMetrics().activeLeaseCount, 0);
});

test('concurrent shutdown callers both wait for the same in-flight host close', async () => {
  const { pool, hosts } = createHarness();
  await pool.createSession(sessionOptions());
  let releaseClose;
  let markCloseStarted;
  const closeStarted = new Promise((resolve) => {
    markCloseStarted = resolve;
  });
  const closeGate = new Promise((resolve) => {
    releaseClose = resolve;
  });
  hosts[0].close = async () => {
    hosts[0].closeCalls++;
    markCloseStarted();
    await closeGate;
    hosts[0].alive = false;
  };

  const first = pool.closeAll();
  await closeStarted;
  let secondSettled = false;
  const second = pool.closeAll().finally(() => {
    secondSettled = true;
  });
  await delay(0);
  assert.equal(secondSettled, false, 'a concurrent shutdown must not return before host cleanup finishes');

  releaseClose();
  await Promise.all([first, second]);
  assert.equal(hosts[0].closeCalls, 1);
});

test('pool shutdown releases active leases once even when a session closes late', async () => {
  const { pool, hosts } = createHarness();
  const session = await pool.createSession(sessionOptions());

  await pool.closeAll();
  assert.equal(hosts[0].closeCalls, 1);
  assert.deepEqual(pool.getMetrics(), {
    liveHostCount: 0,
    activeLeaseCount: 0,
    warmHostCount: 0,
    coldStartCount: 1,
    warmHitCount: 0,
    evictionCount: 0,
  });

  await session.close();
  assert.equal(hosts[0].closeCalls, 1);
  assert.equal(pool.getMetrics().activeLeaseCount, 0);
  assert.equal(pool.getMetrics().warmHostCount, 0);
});

test('forced replacement waits until the superseded host finishes closing', async () => {
  let releaseClose;
  let markCloseStarted;
  const closeStarted = new Promise((resolve) => {
    markCloseStarted = resolve;
  });
  const closeGate = new Promise((resolve) => {
    releaseClose = resolve;
  });
  const hosts = [];
  const pool = new CodexAppServerHostPool(
    { idleTtlMs: 60_000, maxWarmHosts: 16 },
    {
      createSocketDirectory: () => `/private/tmp/codex-host-replacement-${hosts.length + 1}`,
      removeSocketDirectory: async () => {},
      spawnHost: async (launch) => {
        const host = new FakeHost(`replacement-${hosts.length + 1}`, launch);
        if (hosts.length === 0) {
          host.close = async () => {
            host.closeCalls++;
            markCloseStarted();
            await closeGate;
            host.alive = false;
          };
        }
        hosts.push(host);
        return host;
      },
      connectHost: async (host) => new FakeConnection(host),
    },
  );

  const first = await pool.createSession(sessionOptions());
  first.rememberSession('thread-a');
  const terminating = first.terminate();
  await closeStarted;

  let replacementSettled = false;
  const acquiring = pool.createSession(sessionOptions({ sessionId: 'thread-a' })).then((session) => {
    replacementSettled = true;
    return session;
  });
  await delay(0);
  assert.equal(replacementSettled, false, 'the native session must not migrate while its source host is alive');
  assert.equal(hosts.length, 1);

  releaseClose();
  await terminating;
  const replacement = await acquiring;
  assert.equal(hosts.length, 2);
  assert.equal(replacement.reusedSessionHost, false);
  await replacement.close();
  await pool.closeAll();
});

test('failed source-host close keeps migration fenced and never spawns a replacement', async () => {
  const { pool, hosts } = createHarness();
  const first = await pool.createSession(sessionOptions());
  first.rememberSession('thread-a');
  await first.close();
  hosts[0].close = async () => {
    hosts[0].closeCalls++;
    throw new Error('source host refused to close');
  };

  await assert.rejects(
    pool.createSession(sessionOptions({ sessionId: 'thread-a', cwd: '/workspace/different-project' })),
    /source host refused to close/,
  );
  assert.equal(hosts.length, 1, 'migration must fail closed while the source process may still be alive');
  assert.equal(hosts[0].closeCalls, 1);
  hosts[0].alive = false;
  const replacement = await pool.createSession(
    sessionOptions({ sessionId: 'thread-a', cwd: '/workspace/different-project' }),
  );
  assert.equal(hosts.length, 2, 'migration may proceed after independent evidence shows the source process exited');
  await replacement.close();
  await pool.closeAll();
});
