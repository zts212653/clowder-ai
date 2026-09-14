/**
 * Integration tests for port resolution and routes-manifest retargeting.
 *
 * port-pair.test.js and routes-manifest.test.js cover the pure rules. This file
 * drives the real ServiceManager wiring against a temp install root, so the
 * pieces that decide which ports the app uses and whether the built rewrites
 * follow them are exercised rather than just their inputs.
 *
 * The end-to-end behaviour (a retargeted manifest actually moving the API behind
 * `next start`) is proven separately against a real built Next.js app; see the
 * PR description.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { after, describe, it } = require('node:test');

// Keep the module-level log directory out of the real install.
const moduleHome = path.join(tmpdir(), `service-manager-ports-${process.pid}`);
fs.mkdirSync(moduleHome, { recursive: true });
process.env.HOME = moduleHome;
process.env.LOCALAPPDATA = moduleHome;
process.env.USERPROFILE = moduleHome;

const ServiceManager = require('./service-manager');
const { instanceFilePath } = require('./desktop-instance');

const tmpDirs = [];
after(async () => {
  while (tmpDirs.length > 0) await rm(tmpDirs.pop(), { recursive: true, force: true });
  await rm(moduleHome, { recursive: true, force: true });
});

/** Install root containing a built routes-manifest.json. */
async function makeRoot(manifest = null) {
  const root = await mkdtemp(path.join(tmpdir(), 'cc-ports-root-'));
  tmpDirs.push(root);
  if (manifest) {
    const dir = path.join(root, 'packages', 'web', '.next');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'routes-manifest.json'), JSON.stringify(manifest), 'utf8');
  }
  return root;
}

/** Install root that also passes startAll()'s pre-flight checks. */
async function makeInstallRoot() {
  const root = await makeRoot();
  const apiDir = path.join(root, 'packages', 'api');
  fs.mkdirSync(path.join(apiDir, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(apiDir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(apiDir, 'dist', 'index.js'), '// entry\n', 'utf8');
  return root;
}

function readManifest(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'packages', 'web', '.next', 'routes-manifest.json'), 'utf8'));
}

const arrayManifest = (apiPort) => ({
  version: 3,
  rewrites: [
    { source: '/api/:path*', destination: `http://127.0.0.1:${apiPort}/api/:path*` },
    { source: '/socket.io/:path*', destination: `http://127.0.0.1:${apiPort}/socket.io/:path*` },
    { source: '/uploads/:path*', destination: `http://127.0.0.1:${apiPort}/uploads/:path*` },
  ],
});

describe('ServiceManager: port resolution', () => {
  it('uses the default pair when nothing is listening', async () => {
    const root = await makeRoot();
    const sm = new ServiceManager(root, {});
    sm._isPortOpen = async () => false;

    await sm._resolvePorts(instanceFilePath(root));

    assert.deepEqual({ frontend: sm.frontendPort, api: sm.apiPort }, { frontend: 3003, api: 3004 });
  });

  it('moves to the next pair when the first is occupied', async () => {
    const root = await makeRoot();
    const sm = new ServiceManager(root, {});
    sm._isPortOpen = async (port) => port === 3003 || port === 3004;

    await sm._resolvePorts(instanceFilePath(root));

    // The pair must stay adjacent, or the renderer's frontend+1 rule breaks.
    assert.equal(sm.apiPort, sm.frontendPort + 1);
    assert.notEqual(sm.frontendPort, 3003);
  });

  it('keeps a remembered pair when it is still free', async () => {
    const root = await makeRoot();
    const sm = new ServiceManager(root, {});
    sm.instance = { instanceId: 'x', frontendPort: 4104, apiPort: 4105 };
    sm._isPortOpen = async () => false;

    await sm._resolvePorts(instanceFilePath(root));

    assert.deepEqual({ frontend: sm.frontendPort, api: sm.apiPort }, { frontend: 4104, api: 4105 });
  });

  it('ignores a remembered pair that drifted apart', async () => {
    const root = await makeRoot();
    const sm = new ServiceManager(root, {});
    sm.instance = { instanceId: 'x', frontendPort: 4104, apiPort: 4199 };
    sm._isPortOpen = async () => false;

    await sm._resolvePorts(instanceFilePath(root));

    assert.deepEqual({ frontend: sm.frontendPort, api: sm.apiPort }, { frontend: 3003, api: 3004 });
  });

  it('fails with an actionable message when no pair is free', async () => {
    const root = await makeRoot();
    const sm = new ServiceManager(root, {});
    sm._isPortOpen = async () => true;

    await assert.rejects(
      () => sm._resolvePorts(instanceFilePath(root)),
      /No free Web\/API port pair found[\s\S]*fix: stop whatever holds ports/,
    );
  });

  it('defers a port failure to startAll so the shell keeps one error path', async () => {
    const root = await makeInstallRoot();
    const sm = new ServiceManager(root, {});
    sm._isPortOpen = async () => true;

    // The shell calls prepareRuntime() before it can report a startup failure,
    // so this must not throw; startAll() re-throws inside the shell's try/catch.
    await assert.doesNotReject(() => sm.prepareRuntime());
    assert.ok(sm.prepareError, 'the port failure is recorded');
    await assert.rejects(() => sm.startAll(), /No free Web\/API port pair found/);
  });
});

describe('ServiceManager: routes-manifest retargeting', () => {
  it('points the built rewrites at the port this run uses', async () => {
    const root = await makeRoot(arrayManifest(3004));
    const sm = new ServiceManager(root, {});
    sm.apiPort = 4105;
    sm.frontendPort = 4104;

    sm._retargetRoutesManifest();

    assert.deepEqual(
      readManifest(root).rewrites.map((rewrite) => rewrite.destination),
      [
        'http://127.0.0.1:4105/api/:path*',
        'http://127.0.0.1:4105/socket.io/:path*',
        'http://127.0.0.1:4105/uploads/:path*',
      ],
    );
  });

  it('leaves the manifest untouched when it already matches', async () => {
    const root = await makeRoot(arrayManifest(3004));
    const before = fs.statSync(path.join(root, 'packages', 'web', '.next', 'routes-manifest.json')).mtimeMs;
    const sm = new ServiceManager(root, {});
    sm.apiPort = 3004;

    sm._retargetRoutesManifest();

    assert.equal(readManifest(root).rewrites[0].destination, 'http://127.0.0.1:3004/api/:path*');
    assert.equal(
      fs.statSync(path.join(root, 'packages', 'web', '.next', 'routes-manifest.json')).mtimeMs,
      before,
      'no rewrite means no write',
    );
  });

  it('tolerates a missing manifest without crashing', async () => {
    const root = await makeRoot();
    const sm = new ServiceManager(root, {});
    sm.apiPort = 4105;

    assert.doesNotThrow(() => sm._retargetRoutesManifest());
  });

  it('fails loudly on an unparseable manifest', async () => {
    const root = await makeRoot(arrayManifest(3004));
    const dir = path.join(root, 'packages', 'web', '.next');
    fs.writeFileSync(path.join(dir, 'routes-manifest.json'), '{ not json', 'utf8');
    const sm = new ServiceManager(root, {});
    sm.apiPort = 4105;

    assert.throws(() => sm._retargetRoutesManifest(), /Could not parse[\s\S]*fix: reinstall/);
  });
});

describe('ServiceManager: runtime status carries the ports', () => {
  it('exposes the resolved pair to the shell', async () => {
    const root = await makeRoot();
    const sm = new ServiceManager(root, {});
    sm._isPortOpen = async () => false;

    await sm.prepareRuntime();

    const status = sm.getRuntimeStatus();
    assert.equal(status.frontendPort, 3003);
    assert.equal(status.apiPort, 3004);
  });

  it('persists the chosen pair so the next run reuses it', async () => {
    const root = await makeRoot();
    // The instance record lives in the USER data directory, not the install root.
    const recordPath = instanceFilePath(ServiceManager.USER_DATA_DIR);
    fs.rmSync(recordPath, { force: true });

    const sm = new ServiceManager(root, {});
    sm._isPortOpen = async (port) => port === 3003 || port === 3004;

    await sm.prepareRuntime();
    const chosen = { frontend: sm.frontendPort, api: sm.apiPort };
    assert.notEqual(chosen.frontend, 3003, 'the first pair was busy, so it must have moved');

    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    assert.deepEqual({ frontend: record.frontendPort, api: record.apiPort }, chosen);

    // A second manager reads it back instead of re-deriving.
    const second = new ServiceManager(root, {});
    second._isPortOpen = async () => false;
    await second.prepareRuntime();
    assert.deepEqual({ frontend: second.frontendPort, api: second.apiPort }, chosen);
  });
});

describe('ServiceManager: the port constraints are documented', () => {
  it('keeps the read-only install limitation in the desktop README', () => {
    const readme = fs.readFileSync(path.resolve(__dirname, 'README.md'), 'utf8');

    // This constraint is easy to lose and expensive to rediscover: a per-machine
    // install cannot rewrite the built routes-manifest, so a moved API port has
    // to fail loudly rather than serve a UI whose /api points elsewhere.
    assert.match(readme, /安装目录只读时端口无法迁移/, 'README must state the read-only limitation');
    assert.match(readme, /routes-manifest\.json/, 'README must name the file that pins the API origin');
    assert.match(readme, /api = web \+ 1/, 'README must state the adjacent-port rule');
    assert.match(readme, /clowder:desktop:instance/, 'README must explain Redis ownership');
  });
});
