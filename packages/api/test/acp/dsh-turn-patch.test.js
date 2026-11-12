import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import {
  prepareDshTurnPatch,
  verifyDshTurnPatch,
} from '../../dist/domains/cats/services/agents/providers/acp/dsh/dsh-turn-patch.js';

test('an existing Desktop member gets a turn overlay after its own and secret patches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'issue1947-turn-patch-'));
  const command = join(root, 'resources/runtime/cli/bin/dsh.cmd');
  const manifest = join(root, 'resources/runtime/primary-runtime/runtime.json');
  mkdirSync(dirname(command), { recursive: true });
  mkdirSync(dirname(manifest), { recursive: true });
  writeFileSync(
    command,
    [
      '@echo off',
      'setlocal DisableDelayedExpansion',
      'set "ELECTRON_RUN_AS_NODE=1"',
      '"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" --expose-internals "%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*',
      'exit /b %errorlevel%',
    ].join('\n'),
  );
  writeFileSync(join(root, 'DeepSeek Harness.exe'), '');
  writeFileSync(join(root, 'resources/app.asar'), '');
  writeFileSync(manifest, JSON.stringify({ desktopVersion: '0.2.2-rc.1' }));
  const args = ['--profile', 'acp', '--patch', 'member.patch.yml', '--patch', 'secret.patch.yml'];
  const selection = JSON.stringify(['deepseek-official', 'deepseek-flash']);
  const prepared = await prepareDshTurnPatch(command, args, root, selection);
  assert.deepEqual(prepared.slice(0, -2), args);
  assert.equal(prepared.at(-2), '--patch');
  const patch = prepared.at(-1);
  assert.ok(patch);
  assert.equal(verifyDshTurnPatch(patch, command, args), true);
  const rows = parse(readFileSync(patch, 'utf8'));
  assert.deepEqual(rows[0], { id: 'acp', disabled: true });
  const bridge = rows[1].insert[0];
  assert.match(bridge.name, /dsh-turn-bridge\.mjs$/);
  assert.deepEqual(bridge.inject, ['acpAppStartup', 'catCafeSecretContent', 'credentials']);
  assert.equal(bridge.config.provider, 'deepseek-official');
  assert.equal(bridge.config.model, 'deepseek-flash');
  assert.ok(bridge.config.nativeScope.includes('app.asar'));
  assert.deepEqual(await prepareDshTurnPatch(command, args, root, selection), prepared);
  writeFileSync(patch, readFileSync(patch, 'utf8').replace('deepseek-flash', 'other-model'));
  assert.equal(verifyDshTurnPatch(patch, command, args), false, 'a modified managed overlay cannot launch');
  assert.equal(await prepareDshTurnPatch(command, args, root, 'unknown'), args);
  for (const desktopVersion of ['0.2.1-rc.2', 'unreviewed']) {
    writeFileSync(manifest, JSON.stringify({ desktopVersion }));
    assert.equal(await prepareDshTurnPatch(command, args, root, selection), args);
  }
  // Keep isolated state as evidence; no user profile or installed package was changed.
});

test('ordinary ACP, npm DSH, old Desktop and unknown model routes keep their original arguments', async () => {
  const root = mkdtempSync(join(tmpdir(), 'issue1947-unsupported-'));
  const args = ['--profile', 'acp'];
  for (const command of ['gemini', 'dsh']) {
    assert.equal(await prepareDshTurnPatch(command, args, root, '["p","m"]'), args);
  }
  assert.equal(await prepareDshTurnPatch('dsh', args, root, 'unknown'), args);
});
