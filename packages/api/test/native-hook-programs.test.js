import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gateHookProgram, nativeHookPrograms, nativeHookTestEnv } from './helpers/native-hook-programs.js';

test('public exports exercise shipped CLIs while missing home wrappers still fail', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'native-hook-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(nativeHookPrograms(root), [
    [process.execPath, join(root, 'scripts/native-effect-target-guard.mjs'), 'exec_command'],
  ]);
  assert.deepEqual(gateHookProgram(root), [process.execPath, join(root, 'scripts/gate-background-decision.mjs')]);

  writeFileSync(join(root, 'sync-manifest.yaml'), 'managed_files: []\n');
  const entries = nativeHookPrograms(root);
  assert.equal(entries.length, 2);
  assert.equal(entries[1][2], 'Bash');
  const missingNativeWrapper = spawnSync(entries[1][0], [entries[1][1]], {
    encoding: 'utf8',
    env: nativeHookTestEnv(),
  });
  assert.equal(missingNativeWrapper.status, 127);
  const gate = gateHookProgram(root);
  assert.equal(gate[0], '/bin/bash');
  assert.equal(spawnSync(gate[0], [gate[1]], { encoding: 'utf8', env: nativeHookTestEnv() }).status, 127);
});
