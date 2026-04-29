/**
 * Windows ACP spawn regression test (#401).
 *
 * Covers AcpClient.initialize() default spawn path (no custom spawnFn),
 * ensuring .cmd shim resolution rewrites spawn to: node <script.js> ...
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, it, mock } from 'node:test';

const ACP_CLIENT_MODULE = '../../dist/domains/cats/services/agents/providers/acp/AcpClient.js';
const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const INIT_RESULT = {
  protocolVersion: 1,
  authMethods: [],
  agentInfo: { name: 'test', title: 'Test Agent', version: '1.0.0' },
  agentCapabilities: { loadSession: true },
};

function createMockChild() {
  const clientStdin = new PassThrough();
  const agentStdout = new PassThrough();
  const agentStderr = new PassThrough();
  const ee = new EventEmitter();

  const child = {
    pid: 54321,
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

  return { child, clientStdin, agentStdout };
}

function agentRespond(agentStdout, id, result) {
  setImmediate(() => agentStdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`));
}

describe('AcpClient Windows default spawn path', () => {
  /** @type {import('../../dist/domains/cats/services/agents/providers/acp/AcpClient.js').AcpClient | null} */
  let client = null;
  /** @type {(() => void) | null} */
  let restorePlatform = null;
  /** @type {typeof childProcess.spawn | null} */
  let originalSpawn = null;

  afterEach(async () => {
    if (client) {
      await client.close();
      client = null;
    }
    if (originalSpawn) {
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
      originalSpawn = null;
    }
    if (restorePlatform) {
      restorePlatform();
      restorePlatform = null;
    }
  });

  it('resolves .cmd shim to node + script.js when spawnFn is omitted', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    assert.ok(platformDescriptor, 'expected process.platform descriptor');
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
    restorePlatform = () => Object.defineProperty(process, 'platform', platformDescriptor);

    const tempRoot = mkdtempSync(join(tmpdir(), 'acp-win-shim-'));
    const cmdPath = join(tempRoot, 'gemini.cmd');
    const scriptDir = join(tempRoot, 'node_modules', '@google', 'gemini-cli', 'bin');
    const scriptPath = join(scriptDir, 'gemini.js');
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(scriptPath, 'console.log("fake gemini");\n', 'utf8');
    writeFileSync(
      cmdPath,
      '@ECHO OFF\r\n"%~dp0\\node.exe" "%~dp0\\node_modules\\@google\\gemini-cli\\bin\\gemini.js" %*\r\n',
      'utf8',
    );

    const { child, clientStdin, agentStdout } = createMockChild();
    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          agentRespond(agentStdout, msg.id, INIT_RESULT);
        }
      }
    });

    /** @type {{ command?: string; args?: string[]; options?: import('node:child_process').SpawnOptions }} */
    const captured = {};
    originalSpawn = childProcess.spawn;
    childProcess.spawn = (command, args, options) => {
      captured.command = command;
      captured.args = args;
      captured.options = options;
      return /** @type {any} */ (child);
    };
    syncBuiltinESMExports();

    const { AcpClient } = await import(`${ACP_CLIENT_MODULE}?win-shim-test=${Date.now()}`);
    client = new AcpClient({
      command: cmdPath,
      args: ['--acp', '--approval-mode', 'yolo'],
      cwd: tempRoot,
    });
    const result = await client.initialize();

    assert.equal(result.agentInfo.name, 'test');
    assert.equal(captured.command, process.execPath);
    assert.equal(captured.args?.[0], scriptPath);
    assert.deepEqual(captured.args?.slice(1), ['--acp', '--approval-mode', 'yolo']);
    assert.equal(captured.options?.shell, undefined);
    assert.deepEqual(captured.options?.stdio, ['pipe', 'pipe', 'pipe']);
  });

  it('spawns native .exe commands directly when spawnFn is omitted', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    assert.ok(platformDescriptor, 'expected process.platform descriptor');
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
    restorePlatform = () => Object.defineProperty(process, 'platform', platformDescriptor);

    const tempRoot = mkdtempSync(join(tmpdir(), 'acp-win-native-exe-'));
    const exePath = join(tempRoot, 'gemini.exe');
    writeFileSync(exePath, 'fake exe\n', 'utf8');

    const { child, clientStdin, agentStdout } = createMockChild();
    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          agentRespond(agentStdout, msg.id, INIT_RESULT);
        }
      }
    });

    /** @type {{ command?: string; args?: string[]; options?: import('node:child_process').SpawnOptions }} */
    const captured = {};
    originalSpawn = childProcess.spawn;
    childProcess.spawn = (command, args, options) => {
      captured.command = command;
      captured.args = args;
      captured.options = options;
      return /** @type {any} */ (child);
    };
    syncBuiltinESMExports();

    const { AcpClient } = await import(`${ACP_CLIENT_MODULE}?win-native-exe-test=${Date.now()}`);
    client = new AcpClient({
      command: exePath,
      args: ['--acp', '--approval-mode', 'yolo'],
      cwd: tempRoot,
    });
    const result = await client.initialize();

    assert.equal(result.agentInfo.name, 'test');
    assert.equal(captured.command, exePath);
    assert.deepEqual(captured.args, ['--acp', '--approval-mode', 'yolo']);
    assert.equal(captured.options?.shell, undefined);
    assert.deepEqual(captured.options?.stdio, ['pipe', 'pipe', 'pipe']);
  });
});
