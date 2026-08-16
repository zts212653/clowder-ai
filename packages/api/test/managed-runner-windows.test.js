import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const { ManagedRunner } = await import('../dist/infrastructure/managed-runner.js');
const execFileAsync = promisify(execFile);
const windowsOnly = { skip: process.platform !== 'win32', timeout: 30_000 };

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

async function waitFor(getValue, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = getValue();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function forceCleanup(pid) {
  if (!pid || !processExists(pid)) return;
  await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    timeout: 5_000,
    windowsHide: true,
  }).catch(() => undefined);
}

function createProcessTreeFixture() {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'managed-runner-windows-'));
  const pidPath = join(fixtureDir, 'descendant.pid');
  const scriptPath = join(fixtureDir, 'parent.mjs');
  writeFileSync(
    scriptPath,
    [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      'writeFileSync(process.argv[2], String(descendant.pid));',
      'setInterval(() => {}, 1000);',
    ].join('\n'),
  );
  const command = `"${process.execPath}" "${scriptPath}" "${pidPath}"`;
  return { fixtureDir, pidPath, command };
}

async function readDescendantPid(pidPath) {
  return waitFor(() => {
    if (!existsSync(pidPath)) return null;
    const pid = Number.parseInt(readFileSync(pidPath, 'utf8'), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }, 'descendant pid file');
}

async function assertDescendantGone(pid) {
  await waitFor(() => !processExists(pid), `descendant process ${pid} to exit`);
  assert.strictEqual(processExists(pid), false, `descendant process ${pid} should be gone`);
}

test('Windows cancel terminates the real parent and descendant process tree', windowsOnly, async () => {
  const fixture = createProcessTreeFixture();
  const runner = new ManagedRunner();
  let descendantPid = null;

  try {
    const resultPromise = runner.launch(fixture.command, { timeoutMs: 60_000 });
    descendantPid = await readDescendantPid(fixture.pidPath);
    assert.strictEqual(processExists(descendantPid), true);

    runner.cancel();

    const result = await resultPromise;
    assert.strictEqual(result.exitCode, null);
    assert.strictEqual(result.timedOut, false);
    assert.strictEqual(runner.state, 'cancelled');
    await assertDescendantGone(descendantPid);
  } finally {
    runner.cancel();
    await forceCleanup(descendantPid);
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('Windows timeout terminates the real parent and descendant process tree', windowsOnly, async () => {
  const fixture = createProcessTreeFixture();
  const runner = new ManagedRunner();
  let descendantPid = null;

  try {
    const resultPromise = runner.launch(fixture.command, { timeoutMs: 1_000 });
    descendantPid = await readDescendantPid(fixture.pidPath);
    assert.strictEqual(processExists(descendantPid), true);

    const result = await resultPromise;
    assert.strictEqual(result.exitCode, null);
    assert.strictEqual(result.timedOut, true);
    assert.strictEqual(runner.state, 'timed_out');
    await assertDescendantGone(descendantPid);
  } finally {
    runner.cancel();
    await forceCleanup(descendantPid);
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});
