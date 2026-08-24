import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AcpClient } from '../dist/domains/cats/services/agents/providers/acp/AcpClient.js';
import { AcpHttpStreamClient } from '../dist/domains/cats/services/agents/providers/acp/AcpHttpStreamClient.js';
import { CodexAppServerHostPool } from '../dist/domains/cats/services/agents/providers/CodexAppServerHostPool.js';
import {
  createCodexSocketDirectory,
  removeCodexSocketDirectory,
  spawnCodexAppServerHost,
} from '../dist/domains/cats/services/agents/providers/CodexUnixWebSocketSession.js';
import { createDirectAgentCarrierSession } from '../dist/domains/cats/services/agents/providers/DirectAgentCarrierSession.js';
import { isProcessAlive } from './helpers/process-liveness.js';

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  return predicate();
}

async function readReadyPid(path) {
  assert.equal(await waitUntil(() => existsSync(path)), true, 'detached descendant did not become ready');
  return Number(await readFile(path, 'utf8'));
}

function forceCleanup(pid) {
  if (!pid || !isProcessAlive(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

const DESCENDANT_SCRIPT = 'process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},60000)';

test(
  'direct Codex carrier owns detached descendants through terminate',
  { skip: process.platform === 'win32' && 'Unix supervisor is not used on Windows' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cat-cafe-direct-tree-'));
    const pidPath = join(directory, 'descendant.pid');
    const ownershipPath = join(directory, 'ownership.json');
    const script = [
      'const fs=require("node:fs");',
      'const {spawn}=require("node:child_process");',
      `const child=spawn(process.execPath,["-e",${JSON.stringify(DESCENDANT_SCRIPT)}],{detached:true,stdio:"ignore"});`,
      'child.unref();',
      `fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));`,
      `fs.writeFileSync(${JSON.stringify(ownershipPath)},JSON.stringify({binding:process.env.CAT_CAFE_PROCESS_EXECUTION_OWNER??null,executionId:process.env.CAT_CAFE_EXECUTION_ID??null}));`,
      'setInterval(()=>{},60000);',
    ].join('');

    let descendantPid;
    const session = await createDirectAgentCarrierSession({
      command: process.execPath,
      args: ['-e', script],
      cwd: directory,
      env: {
        CAT_CAFE_DATA_DIR: directory,
        CAT_CAFE_PROCESS_EXECUTION_OWNER: '1',
        CAT_CAFE_EXECUTION_ID: 'outer-execution-direct',
      },
      invocationId: 'direct-process-tree-test',
    });
    try {
      descendantPid = await readReadyPid(pidPath);
      assert.equal(await waitUntil(() => existsSync(ownershipPath)), true);
      assert.deepEqual(JSON.parse(await readFile(ownershipPath, 'utf8')), { binding: null, executionId: null });
      await session.terminate();
      assert.equal(await waitUntil(() => !isProcessAlive(descendantPid)), true);
    } finally {
      await session.terminate().catch(() => {});
      forceCleanup(descendantPid);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'pooled Codex unix host owns detached descendants through close',
  { skip: process.platform === 'win32' && 'Unix socket pooling is unavailable on Windows' },
  async () => {
    const directory = createCodexSocketDirectory();
    const dataDir = await mkdtemp(join(tmpdir(), 'cat-cafe-codex-owner-data-'));
    const socketPath = join(directory, 'app.sock');
    const pidPath = join(directory, 'descendant.pid');
    const ownershipPath = join(directory, 'ownership.json');
    const script = [
      'const fs=require("node:fs");',
      'const net=require("node:net");',
      'const {spawn}=require("node:child_process");',
      'const socketPath=process.argv[1];',
      'const pidPath=process.argv[2];',
      'const ownershipPath=process.argv[3];',
      `const child=spawn(process.execPath,["-e",${JSON.stringify(DESCENDANT_SCRIPT)}],{detached:true,stdio:"ignore"});`,
      'child.unref();',
      'const server=net.createServer(()=>{});',
      'server.listen(socketPath,()=>{fs.writeFileSync(pidPath,String(child.pid));fs.writeFileSync(ownershipPath,JSON.stringify({binding:process.env.CAT_CAFE_PROCESS_EXECUTION_OWNER??null,executionId:process.env.CAT_CAFE_EXECUTION_ID??null}));});',
      'process.on("SIGTERM",()=>server.close(()=>process.exit(0)));',
      'setInterval(()=>{},60000);',
    ].join('');

    let descendantPid;
    let host;
    try {
      host = await spawnCodexAppServerHost({
        command: process.execPath,
        args: ['-e', script, socketPath, pidPath, ownershipPath],
        cwd: directory,
        env: {
          CAT_CAFE_DATA_DIR: dataDir,
          CAT_CAFE_PROCESS_EXECUTION_OWNER: '1',
          CAT_CAFE_EXECUTION_ID: 'outer-execution-pooled',
        },
        socketDirectory: directory,
        socketPath,
      });
      descendantPid = await readReadyPid(pidPath);
      assert.equal(await waitUntil(() => existsSync(ownershipPath)), true);
      assert.deepEqual(JSON.parse(await readFile(ownershipPath, 'utf8')), { binding: null, executionId: null });
      await host.close();
      assert.equal(await waitUntil(() => !isProcessAlive(descendantPid)), true);
    } finally {
      await host?.close().catch(() => {});
      forceCleanup(descendantPid);
      await rm(directory, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

test(
  'aborting one pooled invocation kills its foreground tree without touching another live host',
  { skip: process.platform === 'win32' && 'Unix socket pooling is unavailable on Windows' },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cat-cafe-codex-abort-owner-data-'));
    const spawned = [];
    const fixture = [
      'const fs=require("node:fs");',
      'const net=require("node:net");',
      'const {spawn}=require("node:child_process");',
      'const socketPath=process.argv[1];',
      'const pidPath=process.argv[2];',
      `const child=spawn(process.execPath,["-e",${JSON.stringify(DESCENDANT_SCRIPT)}],{detached:true,stdio:"ignore"});`,
      'child.unref();',
      'const server=net.createServer(()=>{});',
      'server.listen(socketPath,()=>fs.writeFileSync(pidPath,String(child.pid)));',
      'process.on("SIGTERM",()=>server.close(()=>process.exit(0)));',
      'setInterval(()=>{},60000);',
    ].join('');
    const pool = new CodexAppServerHostPool(
      { idleTtlMs: 60_000, maxWarmHosts: 4, abortGraceMs: 60_000 },
      {
        createSocketDirectory: () => createCodexSocketDirectory(),
        removeSocketDirectory: (path) => removeCodexSocketDirectory(path),
        spawnHost: async (launch) => {
          const pidPath = join(launch.socketDirectory, 'foreground-child.pid');
          const host = await spawnCodexAppServerHost({
            command: process.execPath,
            args: ['-e', fixture, launch.socketPath, pidPath],
            cwd: launch.socketDirectory,
            env: { CAT_CAFE_DATA_DIR: dataDir },
            socketDirectory: launch.socketDirectory,
            socketPath: launch.socketPath,
          });
          spawned.push({ host, pidPath });
          return host;
        },
        connectHost: async () => ({
          async *read() {},
          async write() {},
          async close() {},
          async terminate() {},
        }),
      },
    );
    const cancelledController = new AbortController();
    let cancelledPid;
    let unrelatedPid;
    let cancelled;
    let unrelated;
    try {
      cancelled = await pool.createSession({
        command: 'codex',
        args: ['app-server', '--stdio'],
        invocationId: 'invocation-cancelled-tree',
        signal: cancelledController.signal,
      });
      unrelated = await pool.createSession({
        command: 'codex',
        args: ['app-server', '--stdio'],
        invocationId: 'invocation-unrelated-tree',
      });
      cancelledPid = await readReadyPid(spawned[0].pidPath);
      unrelatedPid = await readReadyPid(spawned[1].pidPath);

      cancelledController.abort('user_cancel');
      await cancelled.close();

      assert.equal(
        await waitUntil(() => !isProcessAlive(cancelledPid)),
        true,
        'cooperative close after abort must terminate the exact host-owned foreground tree',
      );
      assert.equal(isProcessAlive(unrelatedPid), true, 'exact lease eviction must not kill another live invocation');
      assert.equal(spawned[1].host.isAlive, true, 'the unrelated host start identity must remain live');
      await unrelated.close();
    } finally {
      await Promise.allSettled([cancelled?.terminate(), unrelated?.terminate(), pool.closeAll()]);
      forceCleanup(cancelledPid);
      forceCleanup(unrelatedPid);
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

test(
  'ACP stdio carrier owns detached descendants through close',
  { skip: process.platform === 'win32' && 'Unix supervisor is not used on Windows' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cat-cafe-acp-tree-'));
    const pidPath = join(directory, 'descendant.pid');
    const script = [
      'const fs=require("node:fs");',
      'const readline=require("node:readline");',
      'const {spawn}=require("node:child_process");',
      `const child=spawn(process.execPath,["-e",${JSON.stringify(DESCENDANT_SCRIPT)}],{detached:true,stdio:"ignore"});`,
      'child.unref();',
      `fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));`,
      'readline.createInterface({input:process.stdin}).on("line",line=>{',
      'const message=JSON.parse(line);',
      'if(message.method==="initialize")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:message.id,result:{protocolVersion:1,authMethods:[],agentInfo:{name:"fixture",title:"Fixture",version:"1"},agentCapabilities:{loadSession:true}}})+"\\n");',
      '});',
      'setInterval(()=>{},60000);',
    ].join('');

    let descendantPid;
    const client = new AcpClient({
      command: process.execPath,
      args: ['-e', script],
      cwd: directory,
      env: { CAT_CAFE_DATA_DIR: directory },
    });
    try {
      await client.initialize();
      descendantPid = await readReadyPid(pidPath);
      await client.close();
      assert.equal(await waitUntil(() => !isProcessAlive(descendantPid)), true);
    } finally {
      await client.close().catch(() => {});
      forceCleanup(descendantPid);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'ACP HTTP carrier owns detached descendants through close',
  { skip: process.platform === 'win32' && 'Unix supervisor is not used on Windows' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cat-cafe-acp-http-tree-'));
    const pidPath = join(directory, 'descendant.pid');
    const script = [
      'const fs=require("node:fs");',
      'const http=require("node:http");',
      'const {spawn}=require("node:child_process");',
      `const child=spawn(process.execPath,["-e",${JSON.stringify(DESCENDANT_SCRIPT)}],{detached:true,stdio:"ignore"});`,
      'child.unref();',
      `fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));`,
      'const server=http.createServer((request,response)=>{',
      'let body="";',
      'request.on("data",chunk=>{body+=chunk});',
      'request.on("end",()=>{',
      'const message=JSON.parse(body);',
      'response.setHeader("content-type","application/json");',
      'response.end(JSON.stringify({jsonrpc:"2.0",id:message.id,result:{protocolVersion:1,authMethods:[],agentInfo:{name:"fixture-http",title:"Fixture HTTP",version:"1"},agentCapabilities:{loadSession:true}}}));',
      '});',
      '});',
      'server.listen(0,"127.0.0.1",()=>process.stdout.write("Listening on port "+server.address().port+"\\n"));',
      'setInterval(()=>{},60000);',
    ].join('');

    let descendantPid;
    const client = new AcpHttpStreamClient({
      command: process.execPath,
      args: ['-e', script],
      cwd: directory,
      env: { CAT_CAFE_DATA_DIR: directory },
      portDiscoveryTimeoutMs: 2_000,
    });
    try {
      await client.initialize();
      descendantPid = await readReadyPid(pidPath);
      await client.close();
      assert.equal(await waitUntil(() => !isProcessAlive(descendantPid)), true);
    } finally {
      await client.close().catch(() => {});
      forceCleanup(descendantPid);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
