import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCodexSocketDirectory } from '../dist/domains/cats/services/agents/providers/CodexUnixWebSocketSession.js';
import { reapStaleCliProcessOwners } from '../dist/utils/cli-process-owner-reaper.js';
import { isProcessAlive } from './helpers/process-liveness.js';

async function waitUntil(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return Boolean(await predicate());
}

function forceCleanup(pid) {
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

const silentLog = {
  info() {},
  warn() {},
};

test(
  'startup reaper recovers a detached process tree after its supervisor is SIGKILLed',
  { skip: process.platform === 'win32' && 'Unix supervisor is not used on Windows' },
  async () => {
    const dataDir = await mkdtemp(join(realpathSync(tmpdir()), 'cat-cafe-owner-reaper-data-'));
    const socketDirectory = createCodexSocketDirectory();
    const readyPath = join(dataDir, 'ready.json');
    const supervisorPath = fileURLToPath(new URL('../dist/utils/cli-supervisor.js', import.meta.url));
    const descendantScript = 'process.on("SIGTERM",()=>{});setInterval(()=>{},60000)';
    const childScript = [
      'const fs = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      `const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], {`,
      '  detached: true,',
      '  stdio: "ignore",',
      '});',
      'descendant.unref();',
      'process.on("SIGTERM", () => process.exit(0));',
      `fs.writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ leader: process.pid, descendant: descendant.pid }));`,
      'setInterval(() => {}, 60_000);',
    ].join('\n');

    let supervisor;
    let leaderPid;
    let descendantPid;
    try {
      supervisor = spawn(process.execPath, [supervisorPath, '--', process.execPath, '-e', childScript], {
        env: {
          ...process.env,
          CAT_CAFE_DATA_DIR: dataDir,
          CAT_CAFE_SUPERVISOR_PARENT_PID: String(process.pid),
          CAT_CAFE_SUPERVISOR_KILL_GRACE_MS: '100',
          CAT_CAFE_SUPERVISOR_SOCKET_DIR: socketDirectory,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      supervisor.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      assert.equal(await waitUntil(() => existsSync(readyPath)), true, `owned tree not ready: ${stderr}`);
      ({ leader: leaderPid, descendant: descendantPid } = JSON.parse(await readFile(readyPath, 'utf8')));
      const ownerDir = join(dataDir, 'cli-process-owners');
      assert.equal(
        await waitUntil(() => existsSync(ownerDir) && readdir(ownerDir).then((names) => names.length > 0)),
        true,
        `owner manifest not written: ${stderr}`,
      );
      const [manifestName] = await readdir(ownerDir);
      assert.equal((await stat(ownerDir)).mode & 0o777, 0o700);
      assert.equal((await stat(join(ownerDir, manifestName))).mode & 0o777, 0o600);

      supervisor.kill('SIGKILL');
      await new Promise((resolve) => supervisor.once('exit', resolve));
      assert.equal(isProcessAlive(leaderPid), true, 'fixture leader should survive supervisor SIGKILL');
      assert.equal(isProcessAlive(descendantPid), true, 'fixture descendant should survive supervisor SIGKILL');

      const result = await reapStaleCliProcessOwners({ dataDir, killGraceMs: 100, log: silentLog });

      assert.equal(result.reapedOwners, 1);
      assert.equal(result.termSignals, 2);
      assert.equal(result.killSignals, 1, 'only the stubborn matching descendant should escalate to SIGKILL');
      assert.equal(await waitUntil(() => !isProcessAlive(leaderPid) && !isProcessAlive(descendantPid)), true);
      assert.equal(existsSync(socketDirectory), false);
      assert.deepEqual(await readdir(ownerDir), []);

      const repeated = await reapStaleCliProcessOwners({ dataDir, killGraceMs: 100, log: silentLog });
      assert.equal(repeated.reapedOwners, 0);
      assert.equal(repeated.foundOwners, 0);
    } finally {
      supervisor?.kill('SIGKILL');
      forceCleanup(leaderPid);
      forceCleanup(descendantPid);
      await rm(dataDir, { recursive: true, force: true });
      await rm(socketDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'startup reaper preserves an owner whose supervisor identity is still live',
  { skip: process.platform === 'win32' && 'Unix supervisor is not used on Windows' },
  async () => {
    const dataDir = await mkdtemp(join(realpathSync(tmpdir()), 'cat-cafe-owner-active-'));
    const readyPath = join(dataDir, 'active.pid');
    const supervisorPath = fileURLToPath(new URL('../dist/utils/cli-supervisor.js', import.meta.url));
    const childScript = [
      'const fs = require("node:fs");',
      'process.on("SIGTERM", () => process.exit(0));',
      `fs.writeFileSync(${JSON.stringify(readyPath)}, String(process.pid));`,
      'setInterval(() => {}, 60_000);',
    ].join('\n');
    let supervisor;
    let childPid;
    try {
      supervisor = spawn(process.execPath, [supervisorPath, '--', process.execPath, '-e', childScript], {
        env: {
          ...process.env,
          CAT_CAFE_DATA_DIR: dataDir,
          CAT_CAFE_SUPERVISOR_PARENT_PID: String(process.pid),
          CAT_CAFE_SUPERVISOR_KILL_GRACE_MS: '100',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      assert.equal(await waitUntil(() => existsSync(readyPath)), true);
      childPid = Number(await readFile(readyPath, 'utf8'));

      const result = await reapStaleCliProcessOwners({ dataDir, killGraceMs: 100, log: silentLog });

      assert.equal(result.foundOwners, 1);
      assert.equal(result.skippedActiveOwners, 1);
      assert.equal(result.reapedOwners, 0);
      assert.equal(isProcessAlive(childPid), true);
      assert.equal((await readdir(join(dataDir, 'cli-process-owners'))).length, 1);

      supervisor.kill('SIGTERM');
      await new Promise((resolve) => supervisor.once('exit', resolve));
      assert.equal(await waitUntil(() => !isProcessAlive(childPid)), true);
      assert.deepEqual(await readdir(join(dataDir, 'cli-process-owners')), []);
    } finally {
      supervisor?.kill('SIGKILL');
      forceCleanup(childPid);
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

test('startup reaper quarantines malformed manifests without signalling by guess', async () => {
  const dataDir = await mkdtemp(join(realpathSync(tmpdir()), 'cat-cafe-owner-invalid-'));
  const ownerDir = join(dataDir, 'cli-process-owners');
  const invalidPath = join(ownerDir, 'not-an-owner.json');
  try {
    await mkdir(ownerDir, { recursive: true });
    await writeFile(invalidPath, '{"v":1,"ownerId":"../../unsafe"}\n');

    const result = await reapStaleCliProcessOwners({ dataDir, killGraceMs: 1, log: silentLog });

    assert.equal(result.foundOwners, 0);
    assert.equal(result.invalidManifests, 1);
    assert.equal(existsSync(invalidPath), false);
    assert.equal((await readdir(join(dataDir, 'cli-process-owner-quarantine'))).length, 1);
    assert.equal(result.termSignals, 0);
    assert.equal(result.killSignals, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
