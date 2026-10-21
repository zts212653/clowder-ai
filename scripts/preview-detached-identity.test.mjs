import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const { launchDetached, ownsProcess } = await import(
  process.env.PREVIEW_LAUNCHER_TEST_MODULE
    ? pathToFileURL(process.env.PREVIEW_LAUNCHER_TEST_MODULE)
    : new URL('./preview-process-launchers.mjs', import.meta.url)
);
test('detached startup records the actual child identity on Windows and Unix', async () => {
  const root = mkdtempSync(join(tmpdir(), 'preview-detached-identity-'));
  const pidPath = join(root, 'owned.pid'),
    program = join(root, 'owned.cjs');
  writeFileSync(
    program,
    // Identity capture can spend 20 * 5s in Windows CIM queries before ownsProcess
    // performs one more query. Keep the fixture alive throughout that budget;
    // the finally block owns cleanup, with a separate safety cap for test crashes.
    `require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setTimeout(()=>{},150000);`,
  );
  let record;
  try {
    record = await launchDetached({
      command: [process.execPath, program],
      cwd: root,
      logPath: join(root, 'owned.log'),
    });
    assert.equal(ownsProcess(record), true);
    assert.ok(record.processCommand.includes(program));
    assert.ok(record.processStartedAt);
  } finally {
    for (let i = 0; i < 30 && !existsSync(pidPath); i++) await new Promise((resolve) => setTimeout(resolve, 25));
    const pid = record?.pid ?? (existsSync(pidPath) ? Number(readFileSync(pidPath, 'utf8')) : undefined);
    if (pid) {
      if (process.platform === 'win32')
        spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});
