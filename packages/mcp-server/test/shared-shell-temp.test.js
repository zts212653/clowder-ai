import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

test('shared shell preserves native temporary variables without inheriting other authority', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shared-shell-temp-'));
  const originalExec = childProcess.exec;
  const previous = {
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    UNRELATED_SHELL_SECRET: process.env.UNRELATED_SHELL_SECRET,
  };
  process.env.TEMP = join(root, 'temp');
  process.env.TMP = join(root, 'tmp');
  process.env.UNRELATED_SHELL_SECRET = 'fixture-only';
  t.after(() => {
    childProcess.exec = originalExec;
    syncBuiltinESMExports();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const calls = [];
  const fakeExec = Object.assign(() => {}, {
    [promisify.custom]: async (command, options) => {
      calls.push({ command, options });
      return { stdout: '', stderr: '' };
    },
  });
  childProcess.exec = fakeExec;
  syncBuiltinESMExports();
  const { withInvocationCredentials } = await import('../dist/tools/invocation-auth.js');
  const { handleShellExec } = await import('../dist/tools/shell-tools.js');
  const result = await withInvocationCredentials(
    {
      invocationId: 'fixture-temp',
      callbackToken: 'fixture-only',
      sharedContext: {
        v: 1,
        deploymentId: 'fixture',
        workspaceRoot: root,
        dataDir: root,
        capabilityRoot: root,
        allowedWorkspaceDirs: [root],
        families: ['memory'],
      },
    },
    () => handleShellExec({ commandLine: 'pwd', cwd: root }),
  );
  assert.notEqual(result.isError, true, result.content[0]?.text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.env.TEMP, process.env.TEMP);
  assert.equal(calls[0].options.env.TMP, process.env.TMP);
  assert.equal(calls[0].options.env.UNRELATED_SHELL_SECRET, undefined);
});
