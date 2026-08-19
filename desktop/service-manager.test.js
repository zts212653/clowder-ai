const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const { existsSync, mkdirSync, rmSync, writeFileSync } = fs;
const { mkdtemp } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const moduleHome = path.join(tmpdir(), `service-manager-module-${process.pid}`);
mkdirSync(moduleHome, { recursive: true });
process.env.HOME = moduleHome;
process.env.LOCALAPPDATA = moduleHome;
process.env.USERPROFILE = moduleHome;

const ServiceManager = require('./service-manager');

after(() => {
  rmSync(moduleHome, { recursive: true, force: true });
});

function seedMirrorSource(root, name, probeFile = '.keep') {
  const dir = path.join(root, name);
  mkdirSync(path.dirname(path.join(dir, probeFile)), { recursive: true });
  writeFileSync(path.join(dir, probeFile), `${name}\n`, 'utf-8');
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('declares the packaged Web frontend ready only after an HTTP response', async () => {
  const installRoot = await mkdtemp(path.join(tmpdir(), 'service-manager-http-ready-'));
  const manager = new ServiceManager(installRoot, { frontendPort: 3003, apiPort: 3004 });
  const tcpOnly = net.createServer((socket) => socket.destroy());
  const web = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>Clowder AI</title>');
  });

  try {
    const tcpPort = await listen(tcpOnly);
    assert.equal(await manager._isHttpReady(tcpPort), false, 'a bare TCP accept is not a rendered Web document');
    await close(tcpOnly);

    const webPort = await listen(web);
    assert.equal(await manager._isHttpReady(webPort), true);

    const source = fs.readFileSync(path.join(__dirname, 'service-manager.js'), 'utf8');
    assert.match(source, /await this\._waitForHttpReady\(this\.frontendPort, 'Web'\)/);
  } finally {
    if (tcpOnly.listening) await close(tcpOnly);
    if (web.listening) await close(web);
    rmSync(installRoot, { recursive: true, force: true });
  }
});

test('settles the packaged Web readiness probe when the HTTP response stalls', async () => {
  const installRoot = await mkdtemp(path.join(tmpdir(), 'service-manager-http-stall-'));
  const manager = new ServiceManager(installRoot, { frontendPort: 3003, apiPort: 3004 });
  const originalGet = http.get;
  const stalledRequest = new EventEmitter();
  stalledRequest.setTimeout = (_timeout, onTimeout) => {
    setImmediate(onTimeout);
    return stalledRequest;
  };
  stalledRequest.destroy = () => setImmediate(() => stalledRequest.emit('close'));
  http.get = () => stalledRequest;

  try {
    const result = await Promise.race([
      manager._isHttpReady(3003),
      new Promise((resolve) => setTimeout(() => resolve('still-pending'), 100)),
    ]);

    assert.equal(result, false, 'a timeout followed only by close must release the outer startup deadline');
  } finally {
    http.get = originalGet;
    rmSync(installRoot, { recursive: true, force: true });
  }
});

test('mirrors bundled plugins into the writable API project root', async () => {
  const installRoot = await mkdtemp(path.join(tmpdir(), 'service-manager-install-'));
  const userDataRoot = await mkdtemp(path.join(tmpdir(), 'service-manager-user-'));
  try {
    for (const name of ['.claude', 'assets', 'docs', 'guides', 'packages', 'scripts']) {
      seedMirrorSource(installRoot, name);
    }
    seedMirrorSource(installRoot, 'cat-cafe-skills', path.join('refs', 'shared-rules.md'));
    seedMirrorSource(installRoot, 'plugins', path.join('github', 'plugin.yaml'));

    const manager = new ServiceManager(installRoot, { frontendPort: 3003, apiPort: 3004 });

    manager._ensureUserDataDir(userDataRoot);

    assert.equal(existsSync(path.join(userDataRoot, 'project', 'plugins', 'github', 'plugin.yaml')), true);
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
    rmSync(userDataRoot, { recursive: true, force: true });
  }
});

test('probes bundled plugin mirror and rebuilds it when the first read fails', async () => {
  const installRoot = await mkdtemp(path.join(tmpdir(), 'service-manager-install-'));
  const userDataRoot = await mkdtemp(path.join(tmpdir(), 'service-manager-user-'));
  try {
    for (const name of ['.claude', 'assets', 'docs', 'guides', 'packages', 'scripts']) {
      seedMirrorSource(installRoot, name);
    }
    seedMirrorSource(installRoot, 'cat-cafe-skills', path.join('refs', 'shared-rules.md'));
    seedMirrorSource(installRoot, 'plugins', path.join('github', 'plugin.yaml'));

    const pluginProbePath = path.join(userDataRoot, 'project', 'plugins', 'github', 'plugin.yaml');
    const pluginMirrorPath = path.join(userDataRoot, 'project', 'plugins');
    const originalReadFileSync = fs.readFileSync;
    const originalSymlinkSync = fs.symlinkSync;
    let pluginProbeReads = 0;
    let pluginMirrorLinks = 0;
    fs.symlinkSync = function symlinkSyncWithProbeCount(src, dst, type) {
      if (dst === pluginMirrorPath) pluginMirrorLinks += 1;
      return originalSymlinkSync.call(this, src, dst, type);
    };
    fs.readFileSync = function readFileSyncWithOnePluginProbeFailure(filePath, ...args) {
      if (filePath === pluginProbePath) {
        pluginProbeReads += 1;
        if (pluginMirrorLinks < 2) {
          throw new Error('simulated unreadable plugin junction');
        }
      }
      return originalReadFileSync.call(this, filePath, ...args);
    };

    try {
      const manager = new ServiceManager(installRoot, { frontendPort: 3003, apiPort: 3004 });

      manager._ensureUserDataDir(userDataRoot);
    } finally {
      fs.readFileSync = originalReadFileSync;
      fs.symlinkSync = originalSymlinkSync;
    }

    assert.equal(pluginProbeReads, 2, 'plugin mirror should be probed, rebuilt, and verified');
    assert.equal(pluginMirrorLinks, 2, 'plugin mirror should be recreated after the failed probe');
    assert.equal(existsSync(pluginProbePath), true);
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
    rmSync(userDataRoot, { recursive: true, force: true });
  }
});
