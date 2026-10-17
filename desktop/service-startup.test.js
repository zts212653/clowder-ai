const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const moduleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-order-'));
const envKeys = ['CAT_CAFE_DESKTOP_INSTANCE_ROOT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];
const prior = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
delete process.env.CAT_CAFE_DESKTOP_INSTANCE_ROOT;
for (const key of envKeys.slice(1)) process.env[key] = moduleRoot;
const ServiceManager = require('./service-manager');
for (const [key, value] of Object.entries(prior)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
after(() => fs.rmSync(moduleRoot, { recursive: true, force: true }));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function manager() {
  const root = fs.mkdtempSync(path.join(moduleRoot, 'instance-'));
  for (const entry of ['packages/api/dist', 'packages/api/node_modules', 'node'])
    fs.mkdirSync(path.join(root, entry), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages/api/dist/index.js'), '');
  fs.writeFileSync(path.join(root, 'node/node.exe'), '');
  const value = new ServiceManager(root, { frontendPort: 5200, apiPort: 3200, redisPort: 6300 });
  value._getUserDataDir = () => root;
  value._ensureUserDataDir = () => {};
  value._startRedis = async () => {};
  value._isPortOpen = async () => false;
  return value;
}

for (const first of ['api', 'web'])
  test(`prepares API and Web together, waiting for both (${first} first)`, async () => {
    const value = manager(),
      api = deferred(),
      web = deferred();
    const starts = [];
    value._startApi = async () => {
      starts.push('api');
      await api.promise;
    };
    value._startNextJs = () => starts.push('web');
    value._waitForHttpReady = async () => web.promise;
    let settled = false;
    const startup = value.startAll().then(() => {
      settled = true;
    });
    try {
      await new Promise(setImmediate);
      assert.deepEqual([...starts].sort(), ['api', 'web'], 'Web preparation must not wait for API readiness');
      (first === 'api' ? api : web).resolve();
      await new Promise(setImmediate);
      assert.equal(settled, false, 'Neither phase alone makes the desktop ready');
    } finally {
      api.resolve();
      web.resolve();
      await startup;
    }
  });

test('a failed phase cancels and settles the other waiter before rejecting', async () => {
  const value = manager(),
    started = deferred();
  let peerSettled = false;
  value._startApi = async (_node, _root, signal) => {
    started.resolve();
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    peerSettled = true;
    signal.throwIfAborted();
  };
  value._startNextJs = () => {};
  value._waitForHttpReady = async () => {
    await started.promise;
    throw new Error('controlled Web failure');
  };
  value.memoryMode = true;
  await assert.rejects(value.startAll(), /controlled Web failure/);
  assert.equal(peerSettled, true);
});

test('stops the first owned API before fallback replaces its handle', async () => {
  const value = manager(),
    children = [];
  const controller = new AbortController();
  value.startupAbort = controller;
  value._startApi = async () => {
    if (children.length) {
      assert.notEqual(
        children[0].exitCode ?? children[0].signalCode,
        null,
        'first API must exit before its handle is replaced',
      );
    }
    value._startProcess('api', process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    children.push(value.procs.api);
    if (children.length === 1) throw new Error('controlled readiness timeout');
  };
  try {
    await value._startApiWithFallback(process.execPath, value.root, controller.signal);
    assert.equal(children.length, 2);
  } finally {
    const { stopOwnedStartupProcess } = require('./startup-services');
    await Promise.all(
      children.map((child) => stopOwnedStartupProcess(child, () => value._killProcessTree('fixture-api', child, 5000))),
    );
  }
});

test('a quit during preparation cancels late spawning and never reports ready', async () => {
  const value = manager(),
    entered = deferred(),
    release = deferred(),
    statuses = [];
  value.onStatus = (message) => statuses.push(message);
  value._startApi = async () => {
    entered.resolve();
    await release.promise;
    value._startProcess('api', process.execPath, []);
  };
  value._startNextJs = () => {};
  value._waitForHttpReady = async (_port, _label, signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  const startup = value.startAll();
  await entered.promise;
  const rejected = assert.rejects(startup, /Desktop startup cancelled/);
  await value.stopAll();
  release.resolve();
  await rejected;
  assert.deepEqual(value.procs, {});
  assert.equal(statuses.includes('Ready!'), false);
});
