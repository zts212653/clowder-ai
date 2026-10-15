import assert from 'node:assert/strict';
import { mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkNativeHash, nativeBinding } from './claude-native-binding.mjs';

test('W5.P native upgrades keep an exact version and reject unknown selectors', () => {
  assert.equal(nativeBinding(undefined).version, '2.1.296');
  assert.equal(nativeBinding('2.1.299').sha256, '295b49ec092f31a7de9c6ff286d9d8f120a4f029b9ad9a5ac0b12c35cbf4df2b');
  for (const input of ['', 'latest', '../2.1.299', '2.1.300'])
    assert.throws(() => nativeBinding(input), /Unsupported pinned native/);
});

test('W5.P a substituted executable is rejected before any model or authentication access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'acp-native-pin-'));
  const path = join(directory, 'claude.exe');
  try {
    await writeFile(path, 'a substituted executable');
    await assert.rejects(checkNativeHash(path, nativeBinding('2.1.296')), /Native binary pin mismatch/);
  } finally {
    await rm(path);
    await rmdir(directory);
  }
});
