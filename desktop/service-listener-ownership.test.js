const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-listener-ownership-')));
process.env.LOCALAPPDATA = root;
process.env.HOME = root;
process.env.USERPROFILE = root;
const ServiceManager = require('./service-manager');
const revision = 'same-build-fixture';
const fixture = `
  const port = Number(process.env.FIXTURE_PORT);
  const payload = JSON.stringify({ revision: '${revision}', dataRoot: process.cwd() });
  const server = require('node:http').createServer((request, response) => {
    if (request.headers['x-clowder-desktop-probe'] === '1' && process.env.CAT_CAFE_DESKTOP_STARTUP_ID)
      response.setHeader('x-clowder-desktop-startup-id', process.env.CAT_CAFE_DESKTOP_STARTUP_ID);
    response.end(payload);
  });
  server.listen(port, '127.0.0.1', () => console.log(server.address().port));
`;
const install = path.join(root, 'program');
fs.mkdirSync(path.join(install, 'packages/api/dist'), { recursive: true });
fs.mkdirSync(path.join(install, 'packages/api/node_modules'), { recursive: true });
fs.writeFileSync(path.join(install, 'packages/api/dist/index.js'), '');

async function listener(t, cwd) {
  const proc = spawn(process.execPath, ['-e', fixture], {
    cwd,
    env: { ...process.env, FIXTURE_PORT: '0', CAT_CAFE_DESKTOP_STARTUP_ID: 'foreign-launch' },
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  });
  t.after(async () => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = once(proc, 'exit');
    proc.kill();
    await exited;
  });
  const [chunk] = await once(proc.stdout, 'data');
  return { port: Number(chunk.toString().trim()), pid: proc.pid };
}

async function assertForeignHealthy({ port }, directory) {
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { revision, dataRoot: directory });
}

async function freePort() {
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function managerFor(apiPort, frontendPort, onStatus) {
  const manager = new ServiceManager(install, { apiPort, frontendPort, onStatus });
  manager._waitForProjectMirrors = async () => {};
  manager._ensureUserDataDir = () => {};
  manager._startRedis = async () => {};
  return manager;
}

after(() => fs.rmSync(root, { recursive: true, force: true }));

for (const services of [['API'], ['Web'], ['API', 'Web']]) {
  test(`rejects occupied ${services.join(' and ')} ports before starting children`, async (t) => {
    const foreign = await listener(t, root);
    const another = await listener(t, root);
    const status = [];
    const manager = managerFor(
      services.includes('API') ? foreign.port : 0,
      services.includes('Web') ? another.port : 0,
      (value) => status.push(value),
    );
    manager._startApi = async () => {};
    manager._startNextJs = () => {};
    if (!services.includes('Web')) manager._waitForHttpReady = async () => {};
    await assert.rejects(manager.startAll(), (error) => {
      for (const service of services)
        assert.match(error.message, new RegExp(`${service} ${service === 'API' ? foreign.port : another.port}`));
      return true;
    });
    assert.deepEqual(status, []);
    assert.deepEqual(manager.procs, {});
    await assertForeignHealthy(foreign, root);
    await assertForeignHealthy(another, root);
  });
}

for (const apiExits of [false, true]) {
  test(`requires both owned children at startup handoff (API exits: ${apiExits})`, async (t) => {
    const [apiPort, webPort] = await Promise.all([freePort(), freePort()]);
    const statuses = [];
    let apiExit;
    const manager = managerFor(apiPort, webPort, (status) => {
      statuses.push(status);
      if (apiExits && status.startsWith('API ready')) manager.procs.api.kill();
    });
    t.after(() => manager.stopAll());
    const start = (name, port) => {
      manager._startProcess(name, process.execPath, ['-e', fixture], {
        cwd: install,
        envOverrides: { FIXTURE_PORT: String(port) },
      });
    };
    const wait = manager._waitForHttpReady.bind(manager);
    manager._startApi = async (_node, _dataRoot, signal) => {
      start('api', apiPort);
      apiExit = once(manager.procs.api, 'exit');
      await wait(apiPort, 'API', signal);
    };
    manager._startNextJs = () => start('web', webPort);
    manager._waitForHttpReady = async (port, label, signal) => {
      if (apiExits) await apiExit;
      await wait(port, label, signal);
    };
    if (apiExits) await assert.rejects(manager.startAll(), /API 进程已退出/);
    else await manager.startAll();
    assert.equal(statuses.includes(`API ready on port ${apiPort}`), true);
    assert.equal(statuses.includes(`Web ready on port ${webPort}`), true);
    assert.equal(statuses.includes('Ready!'), !apiExits);
  });
}

for (const label of ['API', 'Web']) {
  for (const exitedFirst of [false, true]) {
    test(`rejects same-build foreign ${label} (${exitedFirst ? 'child already exited' : 'child still starting'})`, async (t) => {
      const foreign = await listener(t, root);
      const manager = new ServiceManager(install, { apiPort: foreign.port, frontendPort: foreign.port });
      const script = exitedFirst ? fixture : `setTimeout(() => { ${fixture} }, 1000)`;
      manager._startProcess(label.toLowerCase(), process.execPath, ['-e', script], {
        cwd: install,
        envOverrides: { FIXTURE_PORT: String(foreign.port) },
      });
      const child = manager.procs[label.toLowerCase()];
      const exited = once(child, 'exit');
      t.after(() => exited);
      if (exitedFirst) assert.equal((await exited)[0], 1);

      const result = await manager._waitForHttpReady(foreign.port, label).then(
        () => 'accepted',
        (error) => error.message,
      );
      assert.equal((await exited)[0], 1, 'owned child could not bind the port');
      await assertForeignHealthy(foreign, root);
      assert.match(result, exitedFirst ? /进程.*退出/ : /本次启动/, `unexpected readiness: ${result}`);
    });
  }
}
