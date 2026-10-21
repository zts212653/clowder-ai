// P1 (PR #1519, 2026-10-20): ordinary desktop must not substitute an in-memory
// store for a missing/failed Redis. Memory mode is reachable only through an
// explicit one-launch consent (memory-fallback-consent.js).
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const moduleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-memory-fallback-'));
const envKeys = ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'CAT_CAFE_DESKTOP_INSTANCE_ROOT'];
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
for (const key of envKeys.slice(0, 4)) process.env[key] = moduleRoot;
delete process.env.CAT_CAFE_DESKTOP_INSTANCE_ROOT;

class FakeProc extends EventEmitter {
  constructor() {
    super();
    this.killed = false;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }
  kill() {
    this.killed = true;
  }
}

// Capture the env ServiceManager hands to its children instead of spawning them:
// this sandbox cannot create piped stdio, and the contract under test is the env.
const spawned = [];
const childProcess = require('node:child_process');
const realSpawn = childProcess.spawn;
childProcess.spawn = (_cmd, _args, options) => {
  spawned.push({ env: { ...(options?.env || {}) } });
  return new FakeProc();
};
const ServiceManager = require('./service-manager');
const { requestMemoryFallbackOnce, consentPath } = require('./memory-fallback-consent');
childProcess.spawn = realSpawn;

after(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fs.rmSync(moduleRoot, { recursive: true, force: true });
  } catch {}
});

function tempRoot(label) {
  return fs.mkdtempSync(path.join(moduleRoot, `${label}-`));
}

function managerFor(root, options = {}) {
  const userDataDir = path.join(root, 'userdata');
  fs.mkdirSync(userDataDir, { recursive: true });
  const manager = new ServiceManager(root, {
    frontendPort: 3920,
    apiPort: 3921,
    redisPort: 3922,
    ...options,
  });
  manager._getUserDataDir = () => userDataDir;
  manager._ensureUserDataDir = () => {};
  manager._isPortOpen = async () => false;
  manager._commandExists = async () => false;
  return manager;
}

function lastChildEnv(manager, root) {
  manager._startProcess('api', process.execPath, ['-e', ''], { cwd: root });
  return spawned.at(-1).env;
}

test('ordinary install fails closed when the Redis binary is missing', async () => {
  const root = tempRoot('missing');
  const manager = managerFor(root);
  await assert.rejects(
    manager._startRedis(path.join(root, 'userdata')),
    (error) =>
      error.code === 'REDIS_UNAVAILABLE' &&
      error.reason === 'binary_missing' &&
      /不会自动改用内存存储/.test(error.message),
  );
  assert.equal(manager.memoryMode, false);
  const env = lastChildEnv(manager, root);
  assert.equal(env.MEMORY_STORE, undefined);
  assert.equal(env.CAT_CAFE_INVOCATION_REGISTRY, undefined);
  assert.equal(env.REDIS_URL, 'redis://localhost:3922');
});

test('ordinary install fails closed when the port is held by a non-Redis process', async () => {
  const root = tempRoot('occupied');
  const manager = managerFor(root);
  manager._isPortOpen = async () => true;
  manager._verifyRedisPing = async () => false;
  await assert.rejects(
    manager._startRedis(path.join(root, 'userdata')),
    (error) => error.code === 'REDIS_UNAVAILABLE' && error.reason === 'port_in_use_non_redis',
  );
  assert.equal(manager.memoryMode, false);
  assert.equal(lastChildEnv(manager, root).MEMORY_STORE, undefined);
});

test('ordinary install fails closed when Redis does not become ready', async () => {
  const root = tempRoot('failed');
  const segment = process.platform === 'win32' ? 'windows' : `darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
  const redisDir = path.join(root, '.cat-cafe', 'redis', segment);
  fs.mkdirSync(redisDir, { recursive: true });
  fs.writeFileSync(path.join(redisDir, `redis-server${process.platform === 'win32' ? '.exe' : ''}`), 'fixture');
  const manager = managerFor(root);
  manager._testRedisBinary = () => true;
  manager._waitForPortWithFallback = async () => false;
  manager._startProcess = () => new FakeProc();
  await assert.rejects(
    manager._startRedis(path.join(root, 'userdata')),
    (error) => error.code === 'REDIS_UNAVAILABLE' && error.reason === 'start_failed',
  );
  assert.equal(manager.memoryMode, false);
  assert.equal(Object.hasOwn(manager.procs, 'redis'), false, 'the failed Redis child must not stay owned');
});

test('an explicit memory decision enables the degraded env for that launch', async () => {
  const root = tempRoot('consented');
  const manager = managerFor(root, { allowMemoryFallback: true });
  await manager._startRedis(path.join(root, 'userdata'));
  assert.equal(manager.memoryMode, true);
  const env = lastChildEnv(manager, root);
  assert.equal(env.MEMORY_STORE, '1');
  assert.equal(env.CAT_CAFE_INVOCATION_REGISTRY, 'memory');
  assert.equal(Object.hasOwn(env, 'REDIS_URL'), false);
});

test('a one-launch consent file is consumed exactly once', async () => {
  const root = tempRoot('once');
  const userDataDir = path.join(root, 'userdata');
  fs.mkdirSync(userDataDir, { recursive: true });
  requestMemoryFallbackOnce(userDataDir);
  const first = managerFor(root);
  assert.equal(first._consumeMemoryConsent(userDataDir), true);
  assert.equal(first.allowMemoryFallback, true);
  assert.equal(fs.existsSync(consentPath(userDataDir)), false);
  const second = managerFor(root);
  assert.equal(second._consumeMemoryConsent(userDataDir), false, 'the next launch fails closed again');
  assert.equal(second.allowMemoryFallback, false);
});

test('startAll({ allowMemoryFallback }) arms the fallback for that run', async () => {
  const root = tempRoot('startall');
  const manager = managerFor(root);
  let observed;
  manager._startAll = async () => {
    observed = manager.allowMemoryFallback;
  };
  await manager.startAll({ allowMemoryFallback: true });
  assert.equal(observed, true);
});

test('isolated desktop never degrades, even with consent', async () => {
  const root = tempRoot('isolated');
  const isolatedEnv = { FRONTEND_PORT: '3920', API_SERVER_PORT: '3921', REDIS_PORT: '3922' };
  const saved = Object.fromEntries(Object.keys(isolatedEnv).map((key) => [key, process.env[key]]));
  process.env.CAT_CAFE_DESKTOP_INSTANCE_ROOT = root;
  Object.assign(process.env, isolatedEnv);
  try {
    const manager = managerFor(root, { allowMemoryFallback: true });
    await assert.rejects(
      manager._startRedis(path.join(root, 'userdata')),
      (error) =>
        error.code === 'REDIS_UNAVAILABLE' &&
        error.reason === 'binary_missing' &&
        error.recovery.allowMemoryOnce === false,
      'an isolated instance must not advertise the memory option it can never honor',
    );
    assert.equal(manager.memoryMode, false);
  } finally {
    delete process.env.CAT_CAFE_DESKTOP_INSTANCE_ROOT;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('isolated desktop discards a stale consent instead of honoring it', () => {
  const root = tempRoot('isolated-stale');
  const userDataDir = path.join(root, 'userdata');
  fs.mkdirSync(userDataDir, { recursive: true });
  requestMemoryFallbackOnce(userDataDir);
  const isolatedEnv = { FRONTEND_PORT: '3920', API_SERVER_PORT: '3921', REDIS_PORT: '3922' };
  const saved = Object.fromEntries(Object.keys(isolatedEnv).map((key) => [key, process.env[key]]));
  process.env.CAT_CAFE_DESKTOP_INSTANCE_ROOT = root;
  Object.assign(process.env, isolatedEnv);
  try {
    const manager = managerFor(root);
    assert.equal(manager._consumeMemoryConsent(userDataDir), false);
    assert.equal(manager.allowMemoryFallback, false);
    assert.equal(fs.existsSync(consentPath(userDataDir)), false, 'the stale consent must not survive');
  } finally {
    delete process.env.CAT_CAFE_DESKTOP_INSTANCE_ROOT;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('a consent file that cannot be deleted never authorizes a launch', () => {
  const root = tempRoot('undeletable');
  const userDataDir = path.join(root, 'userdata');
  fs.mkdirSync(userDataDir, { recursive: true });
  requestMemoryFallbackOnce(userDataDir);
  const realRmSync = fs.rmSync;
  fs.rmSync = (target, options) => {
    if (String(target).includes('startup-memory-fallback.once')) {
      const error = new Error('EACCES: permission denied, unlink consent');
      error.code = 'EACCES';
      throw error;
    }
    return realRmSync(target, options);
  };
  try {
    for (const attempt of ['first', 'second']) {
      const manager = managerFor(root);
      assert.equal(manager._consumeMemoryConsent(userDataDir), false, `${attempt} launch must stay fail-closed`);
      assert.equal(manager.allowMemoryFallback, false);
    }
  } finally {
    fs.rmSync = realRmSync;
  }
  const later = managerFor(root);
  assert.equal(later._consumeMemoryConsent(userDataDir), false, 'a neutralized leftover is not a consent');
  assert.equal(later.allowMemoryFallback, false);
  assert.equal(fs.existsSync(consentPath(userDataDir)), false);
});

test('API startup failure does not downgrade without consent', async () => {
  const root = tempRoot('api-denied');
  const manager = managerFor(root);
  const controller = new AbortController();
  manager.startupAbort = controller;
  manager._startApi = async () => {
    throw new Error('controlled readiness timeout');
  };
  await assert.rejects(
    manager._startApiWithFallback(process.execPath, root, controller.signal),
    /controlled readiness timeout/,
  );
  assert.equal(manager.memoryMode, false);
});

test('API startup failure retries in memory only after explicit consent', async () => {
  const root = tempRoot('api-consented');
  const manager = managerFor(root, { allowMemoryFallback: true });
  const controller = new AbortController();
  manager.startupAbort = controller;
  let attempts = 0;
  manager._startApi = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('controlled readiness timeout');
  };
  await manager._startApiWithFallback(process.execPath, root, controller.signal);
  assert.equal(attempts, 2);
  assert.equal(manager.memoryMode, true);
});
