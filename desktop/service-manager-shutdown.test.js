/**
 * Integration tests for ordered shutdown in ServiceManager.
 *
 * shutdown-plan.test.js covers the pure ordering policy. This file drives the
 * real stopAll() against real child processes, so it proves the ordering is
 * actually enforced rather than merely computed.
 *
 * The children are plain `node -e` loops rather than the real services: the
 * property under test is the teardown sequence, not what the services do.
 */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { after, describe, it } = require('node:test');

// Keep the module-level log directory out of the real install.
const moduleHome = path.join(tmpdir(), `service-manager-shutdown-${process.pid}`);
fs.mkdirSync(moduleHome, { recursive: true });
process.env.HOME = moduleHome;
process.env.LOCALAPPDATA = moduleHome;
process.env.USERPROFILE = moduleHome;

const ServiceManager = require('./service-manager');

const tmpDirs = [];
const spawned = [];

after(async () => {
  for (const child of spawned) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
  }
  while (tmpDirs.length > 0) await rm(tmpDirs.pop(), { recursive: true, force: true });
  await rm(moduleHome, { recursive: true, force: true });
});

function spawnFakeService() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  spawned.push(child);
  return child;
}

const hasExited = (child) => child.exitCode !== null || child.signalCode !== null;

async function makeManager(procs) {
  const root = await mkdtemp(path.join(tmpdir(), 'cc-shutdown-root-'));
  tmpDirs.push(root);
  const sm = new ServiceManager(root, { frontendPort: 0, apiPort: 0 });
  sm.procs = procs;
  return sm;
}

/** Record the order in which _killProcessTree is entered, then delegate. */
function recordKillOrder(sm) {
  const order = [];
  const real = ServiceManager.prototype._killProcessTree;
  sm._killProcessTree = async function tracked(name, proc, timeoutMs) {
    order.push(name);
    return real.call(this, name, proc, timeoutMs);
  };
  return order;
}

describe('ServiceManager: ordered shutdown', () => {
  it('tears down web, then api, then redis and leaves none running', async () => {
    const api = spawnFakeService();
    const redis = spawnFakeService();
    const web = spawnFakeService();
    const sm = await makeManager({ api, redis, web });
    const order = recordKillOrder(sm);

    await sm.stopAll();

    assert.deepEqual(order, ['web', 'api', 'redis']);
    assert.ok(hasExited(web), 'web should be gone');
    assert.ok(hasExited(api), 'api should be gone');
    assert.ok(hasExited(redis), 'redis should be gone');
    assert.deepEqual(sm.procs, {}, 'tracked processes should be cleared');
  });

  it('skips children that already exited on their own', async () => {
    const web = spawnFakeService();
    const api = spawnFakeService();
    const alreadyGone = spawnFakeService();
    await new Promise((resolve) => {
      alreadyGone.once('exit', resolve);
      alreadyGone.kill('SIGKILL');
    });

    const sm = await makeManager({ web, api, redis: alreadyGone });
    const order = recordKillOrder(sm);

    await sm.stopAll();

    // Redis exited beforehand, so it is not killed again (its PID could have
    // been reused by Windows by then).
    assert.deepEqual(order, ['web', 'api']);
    assert.ok(hasExited(web) && hasExited(api));
  });

  it('is a no-op when nothing was ever started', async () => {
    const sm = await makeManager({});
    const order = recordKillOrder(sm);

    await sm.stopAll();

    assert.deepEqual(order, []);
    assert.deepEqual(sm.procs, {});
  });

  it('stops the services it knows even when an unknown one is present', async () => {
    const web = spawnFakeService();
    const worker = spawnFakeService();
    const sm = await makeManager({ web, worker });
    const order = recordKillOrder(sm);

    await sm.stopAll();

    assert.deepEqual(order, ['web', 'worker']);
    assert.ok(hasExited(web) && hasExited(worker));
  });
});
