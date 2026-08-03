/** Real-process guard: Clowder AI supervisor must not translate SIGINT into SIGTERM. */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

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
      const exit = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ timedOut: true }), 2_000);
        supervisor.once('exit', (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      });

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
      const exit = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ timedOut: true }), 2_000);
        supervisor.once('exit', (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      });

      assert.notEqual(exit.timedOut, true, `supervisor did not exit: ${stderr}`);
      assert.deepEqual((await readFile(signalPath, 'utf8')).trim().split('\n'), ['SIGINT', 'SIGTERM']);
    } finally {
      supervisor?.kill('SIGKILL');
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);
