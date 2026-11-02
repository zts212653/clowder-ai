import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { withInvocationCredentials } from '../src/tools/invocation-auth.js';
import { handleShellExec } from '../src/tools/shell-tools.js';

test('relative shell cwd uses each admitted workspace while stdio keeps its process root', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'shared-shell-cwd-')));
  const previousCwd = process.cwd();
  const previousAllowedDirs = process.env.ALLOWED_WORKSPACE_DIRS;
  mkdirSync(join(root, 'nested'));
  process.chdir(root);
  process.env.ALLOWED_WORKSPACE_DIRS = root;
  const assertDirectory = async (cwd: string | undefined, expected: string) => {
    const result = await handleShellExec({ commandLine: 'pwd', cwd });
    assert.notEqual(result.isError, true, result.content[0]?.text);
    assert.ok(
      result.content[0]?.text.includes(`--- stdout ---\n${expected}\n`),
      `cwd ${cwd} must execute in ${expected}: ${result.content[0]?.text}`,
    );
  };
  try {
    await Promise.all(
      ['A', 'B'].map(async (owner) => {
        const workspaceRoot = join(root, `workspace-${owner}`);
        mkdirSync(join(workspaceRoot, 'nested'), { recursive: true });
        await withInvocationCredentials(
          {
            invocationId: `fixture-cwd-${owner}`,
            callbackToken: `fixture-cwd-secret-${owner}`,
            sharedContext: {
              v: 1,
              deploymentId: 'fixture',
              workspaceRoot,
              dataDir: root,
              capabilityRoot: workspaceRoot,
              allowedWorkspaceDirs: [root],
              families: ['memory'],
            },
          },
          async () => {
            // The ambient API root is allowed too: a wrong answer would look successful.
            await assertDirectory(undefined, workspaceRoot);
            await assertDirectory('.', workspaceRoot);
            await assertDirectory('nested', join(workspaceRoot, 'nested'));
            await assertDirectory(workspaceRoot, workspaceRoot);
            const denied = await handleShellExec({ commandLine: 'pwd', cwd: '../..' });
            assert.equal(denied.isError, true, 'workspace resolution must retain the root boundary');
          },
        );
      }),
    );
    await assertDirectory('.', root);
    await assertDirectory('nested', join(root, 'nested'));
  } finally {
    process.chdir(previousCwd);
    if (previousAllowedDirs === undefined) delete process.env.ALLOWED_WORKSPACE_DIRS;
    else process.env.ALLOWED_WORKSPACE_DIRS = previousAllowedDirs;
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'shared shell cancellation ends the owned command and preserves another caller',
  { skip: process.platform === 'win32' },
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'shared-shell-cancel-')));
    const pidFile = join(root, 'owned.pid');
    const fifo = join(root, 'input.fifo');
    execFileSync('mkfifo', [fifo]);
    // The allowed command records its own pid, then becomes the actual blocked reader.
    writeFileSync(join(root, 'cat'), `#!/bin/sh\necho $$ > '${pidFile}'\nexec /bin/cat "$@"\n`, { mode: 0o700 });
    const oldPath = process.env.PATH;
    process.env.PATH = `${root}:${oldPath ?? ''}`;
    const controller = new AbortController();
    const scope = {
      invocationId: 'fixture-shell-A',
      callbackToken: 'fixture-shell-secret-A',
      requestSignal: controller.signal,
      sharedContext: {
        v: 1 as const,
        deploymentId: 'fixture',
        workspaceRoot: root,
        dataDir: root,
        capabilityRoot: root,
        allowedWorkspaceDirs: [root],
        families: ['memory' as const],
      },
    };
    let pid: number | undefined;
    const pending = withInvocationCredentials(scope, () => handleShellExec({ commandLine: `cat ${fifo}` }));
    try {
      for (let i = 0; i < 200 && !existsSync(pidFile); i++) await pause(5);
      assert.ok(existsSync(pidFile), 'the owned reader must actually start before cancellation');
      pid = Number(readFileSync(pidFile, 'utf8').trim());
      controller.abort();
      const cancelled = await Promise.race([pending, pause(1500).then(() => undefined)]);
      assert.equal(cancelled?.isError, true, 'cancelled shell must settle within two seconds');
      for (let i = 0; i < 100; i++) {
        try {
          process.kill(pid, 0);
        } catch {
          pid = undefined;
          break;
        }
        await pause(5);
      }
      assert.equal(pid, undefined, 'cancellation must stop the command, not just stop awaiting it');
      const other = await withInvocationCredentials({ ...scope, requestSignal: undefined }, () =>
        handleShellExec({ commandLine: 'pwd' }),
      );
      assert.notEqual(other.isError, true);
    } finally {
      controller.abort();
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
      await pending;
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      rmSync(root, { recursive: true, force: true });
    }
  },
);
