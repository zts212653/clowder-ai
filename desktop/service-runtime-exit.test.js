const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue1881-service-exit-'));
process.env.CAT_CAFE_DESKTOP_INSTANCE_ROOT = root;
process.env.FRONTEND_PORT = '5102';
process.env.API_SERVER_PORT = '3102';
process.env.REDIS_PORT = '6398';
const ServiceManager = require('./service-manager');
after(() => fs.rmSync(root, { recursive: true, force: true }));

async function start(t, names, onUnexpectedExit) {
  const manager = new ServiceManager(root, { frontendPort: 5102, apiPort: 3102, redisPort: 6398, onUnexpectedExit });
  manager._startAll = async () => {
    await Promise.all(
      names.map(async (name) => {
        manager._startProcess(name, process.execPath, [
          '-e',
          'process.stdin.once("data", () => process.exit(0)); console.log("ready"); setInterval(() => {}, 1000)',
        ]);
        await once(manager.procs[name].stdout, 'data');
      }),
    );
  };
  manager._killProcessTree = async (_name, proc) => {
    const exited = once(proc, 'exit');
    proc.kill();
    await exited;
  };
  t.after(() => manager.stopAll());
  await manager.startAll();
  return manager;
}

['api', 'web', 'redis'].map((name) =>
  test(`notifies the owner when its running ${name} child is killed`, async (t) => {
    const notices = [];
    const manager = await start(t, [name], (event) => notices.push(event));
    const child = manager.procs[name];
    const exited = once(child, 'exit');
    child.kill();
    await exited;
    assert.equal(notices.length, 1);
    assert.equal(notices[0].name, name);
  }),
);

test('three child exits report one incident rather than three native dialogs', async (t) => {
  const notices = [];
  const manager = await start(t, ['api', 'web', 'redis'], (event) => notices.push(event));
  await Promise.all(
    Object.values(manager.procs).map(async (child) => {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }),
  );
  assert.equal(notices.length, 1);
});

test('a child exiting with code zero is still unexpected while the desktop is running', async (t) => {
  const notices = [];
  const manager = await start(t, ['api'], (event) => notices.push(event));
  const exited = once(manager.procs.api, 'exit');
  manager.procs.api.stdin.write('exit');
  await exited;
  assert.deepEqual(notices, [{ name: 'api', code: 0, signal: null }]);
});

test('controlled stop for quit or upgrade does not report an unexpected exit', async (t) => {
  const notices = [];
  const manager = await start(t, ['api', 'web', 'redis'], (event) => notices.push(event));
  await manager.stopAll();
  assert.deepEqual(notices, []);
});

test('an exit before startup settles remains a startup failure', async (t) => {
  const notices = [];
  const manager = await start(t, [], (event) => notices.push(event));
  manager._startAll = async () => {
    manager._startProcess('web', process.execPath, ['-e', 'process.exit(1)']);
    await once(manager.procs.web, 'exit');
    throw new Error('startup failed');
  };
  await assert.rejects(manager.startAll(), /startup failed/);
  assert.deepEqual(notices, []);
});
