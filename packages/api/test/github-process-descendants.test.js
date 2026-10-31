import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { executeGitHubProcess } from '../dist/infrastructure/github/gh-process.js';

const unixOnly = { skip: process.platform === 'win32' ? 'POSIX credential subprocess lifecycle' : false };
async function waitPid(path) {
  for (let i = 0; i < 500; i++) {
    const value = await readFile(path, 'utf8').catch(() => '');
    if (value) return Number(value);
    await delay(10);
  }
  throw new Error('credential helper did not start');
}
function isRunning(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
  // macOS launchd reaps orphaned helpers; do not require its sandbox-restricted
  // ps binary. Linux CI's init may leave a non-running zombie to reap later.
  if (process.platform !== 'linux') return true;
  try {
    return !execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' })
      .trim()
      .startsWith('Z');
  } catch {
    // Failed inspection never proves exit. The next kill(0) detects exit even
    // if ps could not start or lost the race with process termination.
    return true;
  }
}

function killHelper(pid) {
  if (!pid) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

test('a live helper remains live when process inspection is denied', unixOnly, (t) => {
  const denied = t.mock.method(childProcess, 'execFileSync', () => {
    throw Object.assign(new Error('spawnSync ps EPERM'), { code: 'EPERM' });
  });
  syncBuiltinESMExports();
  try {
    assert.equal(isRunning(process.pid), true, 'an unavailable process inspector is not proof of process exit');
  } finally {
    denied.mock.restore();
    syncBuiltinESMExports();
  }
});

for (const mode of ['abort', 'timeout', 'parent-exit', 'inherited-pipes']) {
  test(`gh ${mode} ends its credential helper before returning`, unixOnly, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gh-descendants-'));
    const pidFile = join(dir, 'helper-pid');
    const helper = join(dir, 'helper.cjs');
    const parent = join(dir, 'parent.cjs');
    let helperPid;
    await writeFile(
      helper,
      `const fs = require('node:fs');
process.on('SIGTERM', () => {});
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
    );
    await writeFile(
      parent,
      `const { spawn } = require('node:child_process');
const fs = require('node:fs');
spawn(process.execPath, [${JSON.stringify(helper)}], { stdio: ${mode === 'inherited-pipes' ? "['ignore', 1, 2]" : "'ignore'"} });
setInterval(() => {
  if (fs.existsSync(${JSON.stringify(pidFile)}) && ${JSON.stringify(mode === 'parent-exit' || mode === 'inherited-pipes')}) process.exit(0);
}, 10);
`,
    );
    const controller = new AbortController();
    const pending = executeGitHubProcess(process.execPath, [parent], {
      timeout: mode === 'timeout' ? 500 : 5000,
      maxBuffer: 4096,
      windowsHide: true,
      signal: controller.signal,
    }).then(
      () => undefined,
      (error) => error,
    );
    try {
      helperPid = await waitPid(pidFile);
      if (mode === 'abort') controller.abort();
      const error = await pending;
      if (mode === 'parent-exit' || mode === 'inherited-pipes') assert.equal(error, undefined);
      else assert.ok(error instanceof Error);
      // The request must not release its scheduler lock with a live helper.
      for (let i = 0; i < 50 && isRunning(helperPid); i++) await delay(10);
      assert.equal(isRunning(helperPid), false, 'credential helper survived the completed gh request');
    } finally {
      controller.abort();
      await pending;
      killHelper(helperPid);
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('gh transport retains bounded partial output on failure and can retry', async () => {
  const options = { timeout: 5000, maxBuffer: 128, windowsHide: true };
  await assert.rejects(
    executeGitHubProcess(
      process.execPath,
      ['-e', `process.stdout.write('{"partial":true}'); process.stderr.write('HTTP 403'); process.exitCode=1;`],
      options,
    ),
    (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '{"partial":true}');
      assert.equal(error.stderr, 'HTTP 403');
      return true;
    },
  );
  await assert.rejects(
    executeGitHubProcess(process.execPath, ['-e', `process.stdout.write('x'.repeat(1024));`], options),
    (error) => {
      assert.equal(error.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
      assert.equal(Buffer.byteLength(error.stdout), 128);
      return true;
    },
  );
  assert.deepEqual(await executeGitHubProcess(process.execPath, ['-e', `process.stdout.write('ok');`], options), {
    stdout: 'ok',
  });
});
