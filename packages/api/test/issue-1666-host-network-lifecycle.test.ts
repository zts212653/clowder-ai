import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness, sessionOptions } from './helpers/codex-host-pool-harness.js';

function network(noProxy: string) {
  return {
    HOME: process.env.HOME,
    HTTPS_PROXY: 'http://proxy.fixture.invalid:3128',
    NO_PROXY: noProxy,
  };
}

test('changed NO_PROXY retires an idle owner and launches the new network snapshot', async () => {
  const { pool, hosts } = createHarness({ idleTtlMs: 300_000 });
  const before = network('internal.one,localhost,127.0.0.1,::1');
  const after = network('internal.two,localhost,127.0.0.1,::1');
  try {
    const first = await pool.createSession(sessionOptions({ env: before, inheritParentEnv: false }));
    first.rememberSession('network-session');
    await first.close();
    const resumed = await pool.createSession(
      sessionOptions({ env: after, inheritParentEnv: false, sessionId: 'network-session' }),
    );
    assert.equal(hosts.length, 2, 'changed network environment must not reuse the idle owner');
    assert.equal(hosts[0].closeCalls, 1);
    assert.equal(hosts[0].isAlive, false);
    assert.equal(hosts[0].launch.env.NO_PROXY, before.NO_PROXY);
    assert.equal(hosts[1].launch.env.NO_PROXY, after.NO_PROXY);
    assert.equal(hosts[1].launch.env.HTTPS_PROXY, after.HTTPS_PROXY);
    assert.equal(resumed.reusedSessionHost, false);
    await resumed.close();
  } finally {
    await pool.closeAll();
  }
});

test('a network refresh preserves a busy host and its snapshot until that lease finishes', async () => {
  const { pool, hosts } = createHarness({ idleTtlMs: 300_000 });
  const before = network('internal.one,localhost,127.0.0.1,::1');
  const after = network('internal.two,localhost,127.0.0.1,::1');
  try {
    const active = await pool.createSession(sessionOptions({ env: before, inheritParentEnv: false }));
    active.rememberSession('busy-network-session');
    const next = await pool.createSession(
      sessionOptions({ env: after, inheritParentEnv: false, invocationId: 'new-network-call' }),
    );
    assert.equal(hosts.length, 2);
    assert.equal(pool.getMetrics().activeLeaseCount, 2);
    assert.equal(hosts[0].closeCalls, 0, 'network refresh must not close the active host');
    assert.equal(hosts[0].isAlive, true);
    assert.equal(hosts[0].launch.env.NO_PROXY, before.NO_PROXY, 'active host snapshot stays immutable');
    assert.equal(hosts[1].launch.env.NO_PROXY, after.NO_PROXY);
    await next.close();
    await active.close();
    const resumed = await pool.createSession(
      sessionOptions({ env: after, inheritParentEnv: false, sessionId: 'busy-network-session' }),
    );
    assert.equal(hosts[0].closeCalls, 1, 'the obsolete owner retires after the active lease finishes');
    assert.equal(hosts[0].isAlive, false);
    assert.equal(resumed.reusedSessionHost, false);
    await resumed.close();
  } finally {
    await pool.closeAll();
  }
});
