/**
 * #1203 P1: Actual AcpHttpStreamClient + AcpProcessPool integration.
 *
 * Proves that an HTTP-stream carrier, which also spawns a local child with a
 * local cwd, participates in the same cwd-loss retirement contract as stdio.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, it, mock } from 'node:test';

const { AcpHttpStreamClient } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/AcpHttpStreamClient.js'
);
const { AcpProcessPool } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js');

const INIT_RESULT = {
  protocolVersion: 1,
  authMethods: [],
  agentInfo: { name: 'http-acp', title: 'HTTP ACP Test Agent', version: '1.0.0' },
  agentCapabilities: { loadSession: true },
};

function createMockChild() {
  const agentStdout = new PassThrough();
  const agentStderr = new PassThrough();
  const clientStdin = new PassThrough();
  const ee = new EventEmitter();
  const child = {
    pid: 12345,
    stdin: clientStdin,
    stdout: agentStdout,
    stderr: agentStderr,
    killed: false,
    kill: mock.fn(() => {
      child.killed = true;
      agentStdout.end();
      agentStderr.end();
      ee.emit('exit', 0, null);
      return true;
    }),
    on: ee.on.bind(ee),
    once: ee.once.bind(ee),
    removeListener: ee.removeListener.bind(ee),
  };
  return { child, agentStdout };
}

function startJsonRpcServer(handler) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const response = await handler(message, res);
    if (response === undefined) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(`${JSON.stringify(response)}\n`);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function serverPort(server) {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

const httpstreamVariantConfig = {
  command: 'fake-http-acp',
  startupArgs: ['--acp'],
  supportsMultiplexing: false,
  transport: 'httpstream',
};

const poolKey = { projectPath: '/tmp/httpstream-pool-test', providerProfile: 'httpstream-default' };

describe('AcpHttpStreamClient pool retirement (#1203)', () => {
  let pool = null;
  let cwd = null;
  const servers = [];

  afterEach(async () => {
    if (pool) {
      await pool.closeAll();
      pool = null;
    }
    for (const server of servers.splice(0)) {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
    if (cwd) {
      rmSync(cwd, { recursive: true, force: true });
      cwd = null;
    }
  });

  it('retires an actual HTTP-stream carrier after cwd deletion and cold-starts a replacement', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'acp-http-pool-cwd-'));

    // Pre-start a server for each cold start the pool may need. The pool's
    // clientFactory is synchronous, so the server must already be listening.
    const serverHandler = (message) => {
      if (message.method === 'initialize') {
        return { jsonrpc: '2.0', id: message.id, result: INIT_RESULT };
      }
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not found' } };
    };
    const server1 = await startJsonRpcServer(serverHandler);
    const server2 = await startJsonRpcServer(serverHandler);
    const server3 = await startJsonRpcServer(serverHandler);
    servers.push(server1, server2, server3);

    let serverIndex = 0;
    const createClient = () => {
      const server = servers[serverIndex++];
      const { child, agentStdout } = createMockChild();
      const port = serverPort(server);
      return new AcpHttpStreamClient({
        command: 'fake-http-acp',
        args: [],
        cwd,
        spawnFn: () => {
          setImmediate(() => agentStdout.write(`Listening on port ${port}\n`));
          return child;
        },
        portDiscoveryTimeoutMs: 500,
      });
    };

    pool = new AcpProcessPool(
      { maxLiveProcesses: 2, idleTtlMs: 999_999, healthCheckIntervalMs: 999_999 },
      httpstreamVariantConfig,
      createClient,
    );

    const lease1 = await pool.acquire(poolKey);
    const staleClient = lease1.client;
    assert.equal(staleClient.isCwdIntact, true, 'fresh HTTP carrier must report cwd intact');
    lease1.release();

    // External cleaner deletes the shared bootstrap root.
    rmSync(cwd, { recursive: true, force: true });
    assert.equal(staleClient.isCwdIntact, false, 'cwd-less HTTP carrier must report not intact');

    // A real cold start would re-create the cwd before spawn. In tests spawnFn
    // skips mkdir, so recreate it here to give the replacement a live inode.
    mkdirSync(cwd);

    const lease2 = await pool.acquire(poolKey);
    assert.notStrictEqual(
      lease2.client,
      staleClient,
      'pool must cold-start a fresh HTTP carrier instead of reusing cwd-less one',
    );
    assert.equal(staleClient.isAlive, false, 'retired HTTP carrier child must be closed');
    assert.equal(lease2.client.isCwdIntact, true, 'replacement carrier must capture the new inode');

    // Now the replacement child holds the live inode. Recreate the path again
    // and confirm the carrier detects the inode change.
    rmSync(cwd, { recursive: true, force: true });
    mkdirSync(cwd);
    assert.equal(
      lease2.client.isCwdIntact,
      false,
      'recreated cwd at same path is a different inode — replacement carrier must also report lost',
    );

    const lease3 = await pool.acquire(poolKey);
    assert.notStrictEqual(lease3.client, lease2.client, 'pool must cold-start again after recreate');
    assert.equal(lease2.client.isAlive, false, 'second retired HTTP carrier child must be closed');
    lease3.release();
  });
});
