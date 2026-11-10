import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveDshSetupLaunch } from '../src/routes/dsh-setup-launch.js';
import { discoverDshRuntime } from '../src/routes/native-dsh-discovery.js';
import { invalidateCliCommand } from '../src/utils/cli-resolve.js';
import { resolveWindowsSpawnPlan } from '../src/utils/cli-spawn-win.js';

test('the installed Desktop launcher preserves its Electron CLI and environment through setup and spawning', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-launch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const resources = join(root, 'resources');
  const bin = join(resources, 'runtime/cli/bin');
  const manifest = join(resources, 'runtime/primary-runtime/runtime.json');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(resources, 'runtime/primary-runtime'), { recursive: true });
  const command = join(bin, 'dsh.cmd');
  const script = [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    'set "ELECTRON_RUN_AS_NODE=1"',
    '"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" --expose-internals "%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*',
    'exit /b %errorlevel%',
    '',
  ].join('\r\n');
  writeFileSync(command, script);
  writeFileSync(join(root, 'DeepSeek Harness.exe'), '');
  writeFileSync(join(resources, 'app.asar'), '');
  writeFileSync(manifest, JSON.stringify({ desktopVersion: '0.2.2-rc.1' }));
  const profile = join(root, 'profiles/acp');
  mkdirSync(profile, { recursive: true });
  writeFileSync(
    join(profile, 'package.json'),
    JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-acp-app'] } } }),
  );
  const discovered = discoverDshRuntime({
    dshHome: root,
    resolveCommand: () => null,
    npmCaches: [],
    desktopRoots: [root],
  });
  assert.equal(discovered.installed, true, 'Desktop needs neither a PATH entry nor an npm installation');
  assert.equal(discovered.label, 'DSH Desktop');
  assert.deepEqual(discovered.acp, { command, startupArgs: ['--profile', 'acp'], transport: 'stdio' });
  const args = ['--profile', 'acp', '--patch', join(root, 'member.yml')];
  assert.deepEqual(resolveWindowsSpawnPlan(command, args), {
    command: join(root, 'DeepSeek Harness.exe'),
    args: [
      '--expose-internals',
      join(resources, 'app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'),
      ...args,
    ],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    mode: 'shim',
  });
  if (process.platform === 'win32') {
    const previous = process.env.DSH_HOME;
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin};${previousPath}`;
    invalidateCliCommand('dsh');
    process.env.DSH_HOME = root;
    t.after(() => {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      invalidateCliCommand('dsh');
    });
    assert.deepEqual(resolveDshSetupLaunch(command, args, root), { command, args, cwd: root, profileIndex: 1 });
    assert.equal(resolveWindowsSpawnPlan('dsh', args).command, join(root, 'DeepSeek Harness.exe'));
    assert.deepEqual(resolveDshSetupLaunch('dsh', args, root), { command: 'dsh', args, cwd: root, profileIndex: 1 });
  }
  writeFileSync(command, script.replace('setlocal DisableDelayedExpansion', 'set DSH_HOME=C:\\other-home'));
  assert.equal(resolveWindowsSpawnPlan(command, args, { refresh: true }).env, undefined);
  writeFileSync(command, script);
  writeFileSync(manifest, JSON.stringify({ desktopVersion: 'unreviewed' }));
  assert.equal(resolveWindowsSpawnPlan(command, args, { refresh: true }).env, undefined);
});
