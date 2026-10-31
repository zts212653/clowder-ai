import assert from 'node:assert/strict';
import test from 'node:test';

import { pickGitBashPathFromWhere, resolveBashCommand } from './test-bash-runtime.mjs';

test('resolveBashCommand returns bash on non-Windows platforms', () => {
  assert.equal(resolveBashCommand({ platform: 'darwin' }), 'bash');
});

test('resolveBashCommand returns undefined when Git Bash is unavailable on Windows', () => {
  assert.equal(
    resolveBashCommand({
      platform: 'win32',
      pathExists: () => false,
      execWhere: () => {
        throw new Error('where failed');
      },
    }),
    undefined,
  );
});

test('pickGitBashPathFromWhere prefers Git Bash over the System32 WSL shim', () => {
  const whereOutput = [
    'C:\\Windows\\System32\\bash.exe',
    'C:\\Users\\lang\\scoop\\apps\\git\\current\\bin\\bash.exe',
  ].join('\r\n');

  const resolved = pickGitBashPathFromWhere(
    whereOutput,
    (candidate) =>
      candidate === 'C:\\Windows\\System32\\bash.exe' ||
      candidate === 'C:\\Users\\lang\\scoop\\apps\\git\\current\\bin\\bash.exe',
  );

  assert.equal(resolved, 'C:\\Users\\lang\\scoop\\apps\\git\\current\\bin\\bash.exe');
});
