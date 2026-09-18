/**
 * Integration tests for Redis ownership enforcement in ServiceManager.
 *
 * redis-ownership.test.js covers the pure decision logic. This file exercises
 * the real `_startRedis()` wiring against a fake RESP server, which covers the
 * socket + RESP encode/parse + decision path end to end.
 *
 * The fake server records every command it receives, which lets us assert the
 * strongest property of this change: the app must never WRITE to a Redis it
 * does not own.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { after, describe, it } = require('node:test');

// Point the user data directory at a temp dir BEFORE service-manager is
// required, so the module-level LOG_FILE does not touch the real install.
const moduleHome = path.join(tmpdir(), `service-manager-redis-owner-${process.pid}`);
fs.mkdirSync(moduleHome, { recursive: true });
process.env.HOME = moduleHome;
process.env.LOCALAPPDATA = moduleHome;
process.env.USERPROFILE = moduleHome;

const ServiceManager = require('./service-manager');
const { INSTANCE_MARKER_KEY } = require('./redis-ownership');

const OUR_ID = 'instance-under-test';
const tmpDirs = [];

after(async () => {
  while (tmpDirs.length > 0) await rm(tmpDirs.pop(), { recursive: true, force: true });
  await rm(moduleHome, { recursive: true, force: true });
});

/** Parse one RESP array command out of a partial buffer. */
function readCommand(buffer) {
  if (!buffer.startsWith('*')) return null;
  let end = buffer.indexOf('\r\n');
  if (end === -1) return null;

  const count = Number(buffer.slice(1, end));
  let idx = end + 2;
  const args = [];

  for (let i = 0; i < count; i += 1) {
    end = buffer.indexOf('\r\n', idx);
    if (end === -1) return null;
    const length = Number(buffer.slice(idx + 1, end));
    const start = end + 2;
    if (buffer.length < start + length + 2) return null;
    args.push(buffer.slice(start, start + length));
    idx = start + length + 2;
  }

  return { args, rest: buffer.slice(idx) };
}

function bulkReply(value) {
  if (value === null || value === undefined) return '$-1\r\n';
  return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
}

/**
 * Run `fn` against a listener on 127.0.0.1.
 * `plain: true` gives a dumb TCP listener that never speaks RESP.
 */
async function withListener({ markerValue = null, plain = false }, fn) {
  const received = [];
  const stats = { connections: 0 };
  const server = net.createServer((socket) => {
    stats.connections += 1;
    socket.on('error', () => {});
    if (plain) {
      socket.destroy();
      return;
    }
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let command = readCommand(buffer);
      while (command !== null) {
        buffer = command.rest;
        received.push(command.args);
        const verb = command.args[0];
        if (verb === 'GET') socket.write(bulkReply(markerValue));
        else if (verb === 'SET') socket.write('+OK\r\n');
        else socket.write('-ERR unknown command\r\n');
        command = readCommand(buffer);
      }
    });
  });

  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

  try {
    return await fn({ port, received, stats });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function makeServiceManager(listeningPort) {
  const root = await mkdtemp(path.join(tmpdir(), 'cc-redis-owner-install-'));
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'cc-redis-owner-user-'));
  tmpDirs.push(root, userDataDir);

  const sm = new ServiceManager(root, { frontendPort: 0, apiPort: 0 });
  sm.instance = { instanceId: OUR_ID, redisPort: listeningPort };
  // Hermetic: pretend no redis-server exists, so every path that would start a
  // real Redis ends in memory mode with a clear log instead of spawning one.
  sm._commandExists = async () => false;
  return { sm, userDataDir };
}

describe('ServiceManager: Redis ownership enforcement', () => {
  it('REFUSES a Redis owned by a different instance and never writes to it', async () => {
    await withListener({ markerValue: 'some-other-instance' }, async ({ port, received }) => {
      const { sm, userDataDir } = await makeServiceManager(port);

      await sm._startRedis(userDataDir);

      assert.equal(sm.redisRefusal?.verdict, 'foreign');
      assert.notEqual(sm.redisPort, port, 'must not keep using the foreign port');
      assert.equal(sm.memoryMode, true);

      // The critical assertion: only the read probe may reach a foreign Redis.
      const writes = received.filter((args) => args[0] !== 'GET');
      assert.deepEqual(writes, [], 'the app must never write to a Redis it does not own');
      assert.deepEqual(received[0], ['GET', INSTANCE_MARKER_KEY]);
    });
  });

  it('REFUSES an unmarked Redis (a Clowder server or system Redis)', async () => {
    await withListener({ markerValue: null }, async ({ port, received }) => {
      const { sm, userDataDir } = await makeServiceManager(port);

      await sm._startRedis(userDataDir);

      assert.equal(sm.redisRefusal?.verdict, 'unmarked');
      assert.notEqual(sm.redisPort, port);
      assert.deepEqual(
        received.filter((args) => args[0] !== 'GET'),
        [],
      );
    });
  });

  it('ADOPTS a Redis that carries this instance marker', async () => {
    await withListener({ markerValue: OUR_ID }, async ({ port, received }) => {
      const { sm, userDataDir } = await makeServiceManager(port);

      await sm._startRedis(userDataDir);

      assert.equal(sm.redisRefusal, null);
      assert.equal(sm.memoryMode, false, 'an owned Redis must not fall back to memory mode');
      assert.equal(sm.redisPort, port);
      // Adoption is read-only: no marker rewrite, no SET.
      assert.deepEqual(received, [['GET', INSTANCE_MARKER_KEY]]);
    });
  });

  it('treats a non-Redis listener as unreachable without claiming it', async () => {
    await withListener({ plain: true }, async ({ port, stats }) => {
      const { sm, userDataDir } = await makeServiceManager(port);

      await sm._startRedis(userDataDir);

      assert.equal(sm.redisRefusal, null, 'a non-Redis listener is not an ownership conflict');
      assert.equal(sm.memoryMode, true);
      // Probed (reachability + one RESP command), then walked away. A memory-mode
      // instance has no Redis port of its own, so redisPort is not asserted.
      assert.ok(stats.connections >= 1, 'the listener should have been probed');
    });
  });
});

describe('ServiceManager: Redis launch resolution', () => {
  async function makeManager() {
    const root = await mkdtemp(path.join(tmpdir(), 'cc-redis-launch-'));
    tmpDirs.push(root);
    const sm = new ServiceManager(root, { frontendPort: 0, apiPort: 0 });
    sm.redisPort = 53111;
    sm._commandExists = async () => false;
    return { sm, root };
  }

  it('prefers the packaged portable binary when its smoke test passes', async () => {
    const { sm, root } = await makeManager();
    const redisDir = path.join(root, '.cat-cafe', 'redis', 'windows');
    const portable = path.join(redisDir, 'redis-server.exe');
    fs.mkdirSync(redisDir, { recursive: true });
    fs.writeFileSync(portable, '');
    sm._testRedisBinary = () => true;

    assert.deepEqual(await sm._resolveRedisCommand(portable, redisDir), { cmd: portable, cwd: redisDir });
  });

  it('falls back to a system redis-server when no portable build is present', async () => {
    const { sm, root } = await makeManager();
    sm._commandExists = async (name) => name === 'redis-server';

    assert.deepEqual(await sm._resolveRedisCommand(path.join(root, 'missing'), root), {
      cmd: 'redis-server',
      cwd: root,
    });
  });

  it('refuses a portable binary that fails its smoke test', async () => {
    const { sm, root } = await makeManager();
    const redisDir = path.join(root, '.cat-cafe', 'redis', 'windows');
    const portable = path.join(redisDir, 'redis-server.exe');
    fs.mkdirSync(redisDir, { recursive: true });
    fs.writeFileSync(portable, '');
    sm._testRedisBinary = () => false;
    sm._commandExists = async () => true;

    assert.equal(await sm._resolveRedisCommand(portable, redisDir), null);
  });

  it('returns null when neither a portable nor a system Redis exists', async () => {
    const { sm, root } = await makeManager();

    assert.equal(await sm._resolveRedisCommand(path.join(root, 'missing'), root), null);
  });

  it('builds launch args from the port this instance actually owns', async () => {
    const { sm } = await makeManager();
    const userDataDir = await mkdtemp(path.join(tmpdir(), 'cc-redis-args-'));
    tmpDirs.push(userDataDir);

    assert.deepEqual(sm._redisArgs(userDataDir), [
      '--port',
      '53111',
      '--dir',
      path.join(userDataDir, 'data', 'redis'),
      '--save',
      '60 1',
      '--appendonly',
      'yes',
      '--maxclients',
      '512',
    ]);
  });
});

describe('ServiceManager: runtime status for the shell', () => {
  it('exposes memory mode and the refused port', async () => {
    await withListener({ markerValue: 'some-other-instance' }, async ({ port }) => {
      const { sm, userDataDir } = await makeServiceManager(port);

      await sm._startRedis(userDataDir);

      const status = sm.getRuntimeStatus();
      assert.equal(status.memoryMode, true);
      assert.equal(status.redisRefusal.port, port);
      assert.equal(status.redisRefusal.verdict, 'foreign');
    });
  });

  it('returns a copy so a caller cannot mutate internal state', async () => {
    await withListener({ markerValue: OUR_ID }, async ({ port }) => {
      const { sm, userDataDir } = await makeServiceManager(port);

      await sm._startRedis(userDataDir);

      const status = sm.getRuntimeStatus();
      status.memoryMode = 'tampered';
      status.redisRefusal = { port: 1 };

      assert.equal(sm.memoryMode, false);
      assert.equal(sm.redisRefusal, null);
      assert.equal(sm.getRuntimeStatus().redisPort, port);
    });
  });
});
