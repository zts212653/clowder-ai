const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { fork } = require('node:child_process');
const { once } = require('node:events');

const instanceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-shutdown-order-'));
const isolatedEnvironment = {
  CAT_CAFE_DESKTOP_INSTANCE_ROOT: instanceRoot,
  FRONTEND_PORT: '5102',
  API_SERVER_PORT: '3102',
  REDIS_PORT: '6398',
};
const prior = Object.fromEntries(Object.keys(isolatedEnvironment).map((key) => [key, process.env[key]]));
Object.assign(process.env, isolatedEnvironment);
const ServiceManager = require('./service-manager');
for (const [key, value] of Object.entries(prior)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
after(() => fs.rmSync(instanceRoot, { recursive: true, force: true }));
assert.ok(
  ServiceManager.USER_DATA_DIR === instanceRoot || ServiceManager.USER_DATA_DIR.startsWith(instanceRoot + path.sep),
);

const processHandle = (pid, overrides = {}) => ({
  pid,
  killed: false,
  exitCode: null,
  signalCode: null,
  ...overrides,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
function manager(procs) {
  const value = Object.create(ServiceManager.prototype);
  value.procs = procs;
  value.startupAbort = new AbortController();
  value._stopPluginNetworkBridge = async () => {};
  return value;
}

for (const order of [
  ['redis', 'api', 'web'],
  ['api', 'web', 'redis'],
]) {
  test(`API teardown can persist while Redis stays alive (${order.join(',')})`, async () => {
    const value = manager(Object.fromEntries(order.map((name, index) => [name, processHandle(10001 + index)])));
    let redisOnline = true;
    const writes = [];
    value._killProcessTree = async (name, child) => {
      if (name === 'redis') redisOnline = false;
      if (name === 'api') {
        await nextTurn();
        if (redisOnline) writes.push('final API shutdown state');
        child.exitCode = redisOnline ? 0 : 1;
      } else child.exitCode = 0;
    };
    const api = value.procs.api;
    await value.stopAll();
    assert.deepEqual(writes, ['final API shutdown state']);
    assert.equal(api.exitCode, 0);
    assert.equal(redisOnline, false);
  });
}

test('API and Web start stopping together, with Redis alive until both settle', async () => {
  const value = manager({ redis: processHandle(10001), api: processHandle(10002), web: processHandle(10003) });
  const api = deferred(),
    web = deferred(),
    stopping = [];
  value._killProcessTree = async (name) => {
    stopping.push(name);
    if (name === 'api') await api.promise;
    if (name === 'web') await web.promise;
  };
  const closed = value.stopAll();
  try {
    await nextTurn();
    assert.deepEqual(stopping.slice().sort(), ['api', 'web']);
    api.resolve();
    await nextTurn();
    assert.equal(stopping.includes('redis'), false, 'Web is still using its runtime dependency');
  } finally {
    api.resolve();
    web.resolve();
    await closed;
  }
  assert.deepEqual(stopping, ['api', 'web', 'redis']);
});

test('a failed dependent stop still releases Redis after that stop settles', async () => {
  const value = manager({ redis: processHandle(10001), api: processHandle(10002) });
  const events = [];
  value._killProcessTree = async (name) => {
    if (name === 'api') {
      await nextTurn();
      events.push('api stop failed');
      throw new Error('controlled child stop failure');
    }
    events.push('redis stopped');
  };
  await value.stopAll();
  assert.deepEqual(events, ['api stop failed', 'redis stopped']);
  assert.deepEqual(value.procs, {});
});

test('preserves stale-PID exclusions, startup cancellation and per-child stop budget', async () => {
  const value = manager({
    api: processHandle(20001, { exitCode: 1 }),
    web: processHandle(20002, { signalCode: 'SIGTERM' }),
    cancelled: processHandle(20003, { killed: true, exitCode: 0 }),
    missing: null,
    redis: processHandle(20004),
  });
  const stopped = [];
  value._killProcessTree = async (name, child, timeout) => {
    assert.equal(value.startupAbort.signal.aborted, true);
    stopped.push({ name, pid: child.pid, timeout });
  };
  let bridgeStopped = false;
  value._stopPluginNetworkBridge = async () => {
    assert.deepEqual(value.procs, {});
    bridgeStopped = true;
  };
  await value.stopAll();
  assert.deepEqual(stopped, [{ name: 'redis', pid: 20004, timeout: 5000 }]);
  assert.equal(bridgeStopped, true);
});

test('empty owned process set still cancels startup and releases its bridge', async () => {
  const value = manager({});
  let released = 0;
  value._killProcessTree = async () => assert.fail('No owned child exists');
  value._stopPluginNetworkBridge = async () => {
    released += 1;
  };
  await value.stopAll();
  assert.equal(value.startupAbort.signal.aborted, true);
  assert.equal(released, 1);
});

for (const alreadySignalled of [false, true])
  test(
    `real POSIX children persist before dependency exit (API already signalled: ${alreadySignalled})`,
    {
      skip: process.platform === 'win32',
    },
    async () => {
      const root = fs.mkdtempSync(path.join(instanceRoot, 'children-'));
      const online = path.join(root, 'dependency-online');
      const committed = path.join(root, 'api-final-write');
      const redisScript = path.join(root, 'dependency.cjs');
      const apiScript = path.join(root, 'consumer.cjs');
      fs.writeFileSync(
        redisScript,
        `
    const fs = require('node:fs');
    fs.writeFileSync(process.argv[2], 'online');
    process.once('SIGTERM', () => { fs.unlinkSync(process.argv[2]); process.exit(0); });
    process.send('ready');
    setInterval(() => {}, 1000);
  `,
      );
      fs.writeFileSync(
        apiScript,
        `
    const fs = require('node:fs');
    process.once('SIGTERM', () => setTimeout(() => {
      if (!fs.existsSync(process.argv[2])) process.exit(1);
      fs.writeFileSync(process.argv[3], 'committed');
      process.exit(0);
    }, 20));
    process.send('ready');
    setInterval(() => {}, 1000);
  `,
      );
      const children = [];
      const spawn = (script, args) => {
        const child = fork(script, args, {
          execArgv: [],
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          env: { HOME: root },
        });
        children.push(child);
        return child;
      };
      try {
        const redis = spawn(redisScript, [online]);
        await once(redis, 'message', { signal: AbortSignal.timeout(3000) });
        const api = spawn(apiScript, [online, committed]);
        await once(api, 'message', { signal: AbortSignal.timeout(3000) });
        if (alreadySignalled) api.kill('SIGTERM');
        const value = manager({ redis, api });
        await value.stopAll();
        if (api.exitCode === null && api.signalCode === null)
          await once(api, 'exit', { signal: AbortSignal.timeout(3000) });
        assert.equal(api.exitCode, 0);
        assert.equal(redis.exitCode, 0);
        assert.equal(fs.readFileSync(committed, 'utf8'), 'committed');
        assert.equal(fs.existsSync(online), false);
      } finally {
        for (const child of children) {
          if (child.exitCode !== null || child.signalCode !== null) continue;
          const exited = once(child, 'exit', { signal: AbortSignal.timeout(3000) });
          child.kill('SIGKILL');
          await exited;
        }
      }
    },
  );
