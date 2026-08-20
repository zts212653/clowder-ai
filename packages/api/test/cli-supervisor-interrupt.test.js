/** Real-process guard: Clowder AI supervisor must not translate SIGINT into SIGTERM. */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { waitForSupervisorExit } from './helpers/cli-supervisor-exit.js';
import { isProcessAlive } from './helpers/process-liveness.js';

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

test(
  'cli supervisor persists the opt-in execution join key without callback secrets',
  { skip: process.platform === 'win32' && 'Unix supervisor is not used on Windows' },
  async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'cat-cafe-supervisor-execution-owner-'));
    const readyPath = join(tempDir, 'ready');
    const ownerDir = join(tempDir, 'cli-process-owners');
    const supervisorPath = fileURLToPath(new URL('../dist/utils/cli-supervisor.js', import.meta.url));
    const childScript = [
      'const fs = require("node:fs");',
      'process.on("SIGTERM", () => process.exit(0));',
      `fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");`,
      'setInterval(() => {}, 60_000);',
    ].join('\n');
    let supervisor;
    try {
      supervisor = spawn(process.execPath, [supervisorPath, '--', process.execPath, '-e', childScript], {
        env: {
          ...process.env,
          CAT_CAFE_DATA_DIR: tempDir,
          CAT_CAFE_SUPERVISOR_PARENT_PID: String(process.pid),
          CAT_CAFE_SUPERVISOR_KILL_GRACE_MS: '100',
          CAT_CAFE_PROCESS_EXECUTION_OWNER: '1',
          CAT_CAFE_EXECUTION_ID: 'parent-execution-1',
          CAT_CAFE_INVOCATION_ID: 'turn-invocation-1',
          CAT_CAFE_THREAD_ID: 'thread-1',
          CAT_CAFE_CAT_ID: 'codex-sol',
          CAT_CAFE_USER_ID: 'scheduler',
          CAT_CAFE_CALLBACK_TOKEN: 'must-not-enter-manifest',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      supervisor.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      assert.equal(await waitUntil(() => existsSync(readyPath) && existsSync(ownerDir)), true, stderr);
      const [manifestName] = await readdir(ownerDir);
      const manifest = JSON.parse(await readFile(join(ownerDir, manifestName), 'utf8'));
      assert.deepEqual(manifest.execution, {
        executionId: 'parent-execution-1',
        invocationId: 'turn-invocation-1',
        threadId: 'thread-1',
        catId: 'codex-sol',
        userId: 'scheduler',
      });
      assert.equal(JSON.stringify(manifest).includes('must-not-enter-manifest'), false);

      supervisor.kill('SIGTERM');
      const exit = await waitForSupervisorExit(supervisor);
      assert.notEqual(exit.timedOut, true, `supervisor did not exit: ${stderr}`);
    } finally {
      supervisor?.kill('SIGKILL');
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  'cli supervisor forwards SIGINT unchanged to the supervised process group',
  { skip: process.platform === 'win32' && 'Unix supervisor is not used on Windows' },
  async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'cat-cafe-supervisor-interrupt-'));
    const readyPath = join(tempDir, 'ready');
    const signalPath = join(tempDir, 'signal');
    const supervisorPath = fileURLToPath(new URL('../dist/utils/cli-supervisor.js', import.meta.url));
    const childScript = [
      'const fs = require("node:fs");',
      `const readyPath = ${JSON.stringify(readyPath)};`,
      `const signalPath = ${JSON.stringify(signalPath)};`,
      'process.on("SIGINT", () => { fs.writeFileSync(signalPath, "SIGINT"); process.exit(0); });',
      'process.on("SIGTERM", () => { fs.writeFileSync(signalPath, "SIGTERM"); process.exit(0); });',
      'fs.writeFileSync(readyPath, "ready");',
      'setInterval(() => {}, 60_000);',
    ].join('\n');

    let supervisor;
    try {
      supervisor = spawn(process.execPath, [supervisorPath, '--', process.execPath, '-e', childScript], {
        env: {
          ...process.env,
          CAT_CAFE_DATA_DIR: tempDir,
          CAT_CAFE_SUPERVISOR_PARENT_PID: String(process.pid),
          CAT_CAFE_SUPERVISOR_KILL_GRACE_MS: '100',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      supervisor.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      assert.equal(await waitUntil(() => existsSync(readyPath)), true, `child not ready: ${stderr}`);

      supervisor.kill('SIGINT');
      const exit = await waitForSupervisorExit(supervisor);

      assert.notEqual(exit.timedOut, true, `supervisor did not exit: ${stderr}`);
      assert.equal(await readFile(signalPath, 'utf8'), 'SIGINT');
    } finally {
      supervisor?.kill('SIGKILL');
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  'cli supervisor can escalate SIGINT to SIGTERM when the supervised process stays alive',
  { skip: process.platform === 'win32' && 'Unix supervisor is not used on Windows' },
  async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'cat-cafe-supervisor-escalation-'));
    const readyPath = join(tempDir, 'ready');
    const signalPath = join(tempDir, 'signals');
    const supervisorPath = fileURLToPath(new URL('../dist/utils/cli-supervisor.js', import.meta.url));
    const childScript = [
      'const fs = require("node:fs");',
      `const readyPath = ${JSON.stringify(readyPath)};`,
      `const signalPath = ${JSON.stringify(signalPath)};`,
      'process.on("SIGINT", () => fs.appendFileSync(signalPath, "SIGINT\\n"));',
      'process.on("SIGTERM", () => { fs.appendFileSync(signalPath, "SIGTERM\\n"); process.exit(0); });',
      'fs.writeFileSync(readyPath, "ready");',
      'setInterval(() => {}, 60_000);',
    ].join('\n');

    let supervisor;
    try {
      supervisor = spawn(process.execPath, [supervisorPath, '--', process.execPath, '-e', childScript], {
        env: {
          ...process.env,
          CAT_CAFE_DATA_DIR: tempDir,
          CAT_CAFE_SUPERVISOR_PARENT_PID: String(process.pid),
          CAT_CAFE_SUPERVISOR_KILL_GRACE_MS: '100',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      supervisor.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      assert.equal(await waitUntil(() => existsSync(readyPath)), true, `child not ready: ${stderr}`);

      supervisor.kill('SIGINT');
      assert.equal(await waitUntil(() => existsSync(signalPath)), true, `child did not receive interrupt: ${stderr}`);
      supervisor.kill('SIGTERM');
      const exit = await waitForSupervisorExit(supervisor);

      assert.notEqual(exit.timedOut, true, `supervisor did not exit: ${stderr}`);
      assert.deepEqual((await readFile(signalPath, 'utf8')).trim().split('\n'), ['SIGINT', 'SIGTERM']);
    } finally {
      supervisor?.kill('SIGKILL');
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  'cli supervisor terminates descendants that create an independent process group',
  { skip: process.platform === 'win32' && 'Unix supervisor is not used on Windows' },
  async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'cat-cafe-supervisor-descendant-'));
    const readyPath = join(tempDir, 'ready');
    const supervisorPath = fileURLToPath(new URL('../dist/utils/cli-supervisor.js', import.meta.url));
    const descendantScript = ['process.on("SIGTERM", () => {});', 'setInterval(() => {}, 60_000);'].join('\n');
    const childScript = [
      'const fs = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      `const readyPath = ${JSON.stringify(readyPath)};`,
      `const descendantScript = ${JSON.stringify(descendantScript)};`,
      'const descendant = spawn(process.execPath, ["-e", descendantScript], {',
      '  detached: true,',
      '  stdio: "ignore",',
      '});',
      'descendant.unref();',
      'process.on("SIGTERM", () => process.exit(0));',
      'fs.writeFileSync(readyPath, String(descendant.pid));',
      'setInterval(() => {}, 60_000);',
    ].join('\n');

    let supervisor;
    let descendantPid;
    try {
      supervisor = spawn(process.execPath, [supervisorPath, '--', process.execPath, '-e', childScript], {
        env: {
          ...process.env,
          CAT_CAFE_DATA_DIR: tempDir,
          CAT_CAFE_SUPERVISOR_PARENT_PID: String(process.pid),
          CAT_CAFE_SUPERVISOR_KILL_GRACE_MS: '100',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      supervisor.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      assert.equal(await waitUntil(() => existsSync(readyPath)), true, `child not ready: ${stderr}`);
      descendantPid = Number(await readFile(readyPath, 'utf8'));
      assert.equal(isProcessAlive(descendantPid), true, 'detached descendant should start alive');

      supervisor.kill('SIGTERM');
      const exit = await waitForSupervisorExit(supervisor);

      assert.notEqual(exit.timedOut, true, `supervisor did not exit: ${stderr}`);
      assert.equal(
        await waitUntil(() => !isProcessAlive(descendantPid), 2_000),
        true,
        'detached descendant survived supervisor shutdown',
      );
    } finally {
      supervisor?.kill('SIGKILL');
      if (descendantPid && isProcessAlive(descendantPid)) {
        try {
          process.kill(descendantPid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  'cli supervisor owns a late detached descendant when the leader exits before the default poll',
  { skip: process.platform === 'win32' && 'Unix supervisor is not used on Windows' },
  async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'cat-cafe-supervisor-leader-exit-'));
    const readyPath = join(tempDir, 'ready');
    const supervisorPath = fileURLToPath(new URL('../dist/utils/cli-supervisor.js', import.meta.url));
    const descendantScript = ['process.on("SIGTERM", () => {});', 'setInterval(() => {}, 60_000);'].join('\n');
    const childScript = [
      'const fs = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      `const readyPath = ${JSON.stringify(readyPath)};`,
      `const descendantScript = ${JSON.stringify(descendantScript)};`,
      'setTimeout(() => {',
      '  const descendant = spawn(process.execPath, ["-e", descendantScript], {',
      '    detached: true,',
      '    stdio: "ignore",',
      '  });',
      '  descendant.unref();',
      '  fs.writeFileSync(readyPath, String(descendant.pid));',
      '  setTimeout(() => process.exit(0), 50);',
      '}, 100);',
    ].join('\n');

    let supervisor;
    let descendantPid;
    try {
      supervisor = spawn(process.execPath, [supervisorPath, '--', process.execPath, '-e', childScript], {
        env: {
          ...process.env,
          CAT_CAFE_DATA_DIR: tempDir,
          CAT_CAFE_SUPERVISOR_PARENT_PID: String(process.pid),
          CAT_CAFE_SUPERVISOR_KILL_GRACE_MS: '100',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      supervisor.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      assert.equal(await waitUntil(() => existsSync(readyPath)), true, `child not ready: ${stderr}`);
      descendantPid = Number(await readFile(readyPath, 'utf8'));
      assert.equal(isProcessAlive(descendantPid), true, 'detached descendant should start alive');

      const exit = await waitForSupervisorExit(supervisor);

      assert.notEqual(exit.timedOut, true, `supervisor did not exit after its leader: ${stderr}`);
      assert.equal(
        await waitUntil(() => !isProcessAlive(descendantPid), 2_000),
        true,
        'detached descendant survived after the supervised leader exited',
      );
    } finally {
      supervisor?.kill('SIGKILL');
      if (descendantPid && isProcessAlive(descendantPid)) {
        try {
          process.kill(descendantPid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  'cli supervisor performs no ownership process-table scan during steady state',
  { skip: process.platform === 'win32' && 'Unix supervisor is not used on Windows' },
  async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'cat-cafe-supervisor-scan-cost-'));
    const readyPath = join(tempDir, 'ready');
    const supervisorPath = fileURLToPath(new URL('../dist/utils/cli-supervisor.js', import.meta.url));
    const childScript = [
      'const fs = require("node:fs");',
      'process.on("SIGTERM", () => process.exit(0));',
      `fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");`,
      'setInterval(() => {}, 60_000);',
    ].join('\n');
    let supervisor;
    try {
      supervisor = spawn(process.execPath, [supervisorPath, '--', process.execPath, '-e', childScript], {
        env: {
          ...process.env,
          CAT_CAFE_DATA_DIR: tempDir,
          CAT_CAFE_SUPERVISOR_PARENT_PID: String(process.pid),
          CAT_CAFE_SUPERVISOR_KILL_GRACE_MS: '100',
          NODE_DEBUG: [process.env.NODE_DEBUG, 'cat-cafe-cli-supervisor'].filter(Boolean).join(','),
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      supervisor.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      assert.equal(await waitUntil(() => existsSync(readyPath)), true, `child not ready: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      assert.doesNotMatch(stderr, /ownership-process-table-scan/);

      supervisor.kill('SIGTERM');
      const exit = await waitForSupervisorExit(supervisor);
      assert.notEqual(exit.timedOut, true, `supervisor did not exit: ${stderr}`);
      assert.match(stderr, /ownership-process-table-scan/);
    } finally {
      supervisor?.kill('SIGKILL');
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);
