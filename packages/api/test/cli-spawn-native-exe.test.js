import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { shouldDirectSpawnNativeExe } = await import('../dist/utils/cli-spawn-win.js');

describe('shouldDirectSpawnNativeExe', () => {
  const trueExists = () => true;
  const falseExists = () => false;

  test('true on Windows for existing .exe path', () => {
    assert.equal(
      shouldDirectSpawnNativeExe('C:\\Users\\me\\.local\\bin\\claude.exe', {
        platform: 'win32',
        exists: trueExists,
      }),
      true,
    );
  });

  test('case-insensitive .exe match', () => {
    assert.equal(shouldDirectSpawnNativeExe('C:\\bin\\Tool.EXE', { platform: 'win32', exists: trueExists }), true);
  });

  test('false when .exe does not exist on disk', () => {
    assert.equal(
      shouldDirectSpawnNativeExe('C:\\does\\not\\exist.exe', {
        platform: 'win32',
        exists: falseExists,
      }),
      false,
    );
  });

  test('false for non-.exe on Windows', () => {
    assert.equal(shouldDirectSpawnNativeExe('C:\\bin\\claude.cmd', { platform: 'win32', exists: trueExists }), false);
    assert.equal(shouldDirectSpawnNativeExe('C:\\bin\\claude.bat', { platform: 'win32', exists: trueExists }), false);
    assert.equal(shouldDirectSpawnNativeExe('claude', { platform: 'win32', exists: trueExists }), false);
  });

  test('false on non-Windows platforms regardless of extension', () => {
    assert.equal(
      shouldDirectSpawnNativeExe('/usr/local/bin/claude.exe', {
        platform: 'linux',
        exists: trueExists,
      }),
      false,
    );
    assert.equal(
      shouldDirectSpawnNativeExe('/usr/local/bin/claude.exe', {
        platform: 'darwin',
        exists: trueExists,
      }),
      false,
    );
  });

  test('defaults platform to process.platform when omitted', () => {
    // Just sanity — should not throw, return depends on host.
    const result = shouldDirectSpawnNativeExe('C:\\nope\\does-not-exist.exe', { exists: falseExists });
    assert.equal(result, false);
  });
});
