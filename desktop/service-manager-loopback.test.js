/**
 * Tests that the packaged Web UI is bound to loopback.
 *
 * `next start` listens on 0.0.0.0 unless --hostname says otherwise. That would
 * publish the desktop UI — and, through its same-origin /api, /socket.io and
 * /uploads rewrites, the API — to the local network, while the API process
 * itself defaults to 127.0.0.1 (packages/api/src/index.ts).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { after, describe, it } = require('node:test');

// Keep the module-level log directory out of the real install.
const moduleHome = path.join(tmpdir(), `service-manager-loopback-${process.pid}`);
fs.mkdirSync(moduleHome, { recursive: true });
process.env.HOME = moduleHome;
process.env.LOCALAPPDATA = moduleHome;
process.env.USERPROFILE = moduleHome;

const ServiceManager = require('./service-manager');

const tmpDirs = [];
after(async () => {
  while (tmpDirs.length > 0) await rm(tmpDirs.pop(), { recursive: true, force: true });
  await rm(moduleHome, { recursive: true, force: true });
});

/** Build an install root whose deployed Next.js entry exists. */
async function makeRootWithDeployedNext() {
  const root = await mkdtemp(path.join(tmpdir(), 'cc-loopback-root-'));
  tmpDirs.push(root);
  const nextEntry = path.join(root, 'packages', 'web', 'node_modules', 'next', 'dist', 'bin', 'next');
  fs.mkdirSync(path.dirname(nextEntry), { recursive: true });
  fs.writeFileSync(nextEntry, '');
  return { root, nextEntry };
}

describe('ServiceManager: Web UI is bound to loopback', () => {
  it('passes --hostname 127.0.0.1 to next start', async () => {
    const { root, nextEntry } = await makeRootWithDeployedNext();
    const sm = new ServiceManager(root, { frontendPort: 3003, apiPort: 3004 });

    let captured = null;
    sm._startProcess = (name, cmd, args, opts) => {
      captured = { name, cmd, args, opts };
    };

    sm._startNextJs();

    assert.ok(captured, '_startNextJs should spawn the web process');
    assert.equal(captured.name, 'web');
    assert.equal(captured.args[0], nextEntry);
    assert.deepEqual(captured.args.slice(1), ['start', '--port', '3003', '--hostname', '127.0.0.1']);
    assert.equal(captured.opts.cwd, path.join(root, 'packages', 'web'));
  });

  it('never asks Next.js to listen on all interfaces', async () => {
    const { root } = await makeRootWithDeployedNext();
    const sm = new ServiceManager(root, { frontendPort: 4104, apiPort: 4105 });

    let captured = null;
    sm._startProcess = (name, cmd, args) => {
      captured = { name, cmd, args };
    };

    sm._startNextJs();

    assert.ok(!captured.args.includes('0.0.0.0'), '0.0.0.0 must never be passed');
    assert.equal(captured.args[captured.args.indexOf('--port') + 1], '4104');
    assert.equal(captured.args[captured.args.indexOf('--hostname') + 1], '127.0.0.1');
  });
});
