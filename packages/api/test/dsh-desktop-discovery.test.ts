import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { discoverDshRuntimes } from '../src/routes/native-dsh-discovery.js';
import { discoverNativeRuntimes } from '../src/routes/native-runtimes.js';
import { resolveDshDesktopHome } from '../src/utils/dsh-desktop-launch.js';

function useWin32Platform(t: test.TestContext) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  t.after(() => {
    if (descriptor) Object.defineProperty(process, 'platform', descriptor);
  });
}

test('automatic DSH onboarding uses Desktop alone and ignores the old native ACP patch', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-desktop-only-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'native-home');
  const cached = join(root, 'cache/_npx/cached/node_modules/@deepseek-ai/dsh');
  mkdirSync(join(cached, 'lib'), { recursive: true });
  writeFileSync(join(cached, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', bin: 'lib/bin.js' }));
  writeFileSync(join(cached, 'lib/bin.js'), '');
  const wrapper = join(root, 'dsh.cmd');
  writeFileSync(wrapper, '@echo off\nnode old-source-wrapper.mjs %*\n');
  const options = { dshHome: home, npmCaches: [join(root, 'cache')], resolveCommand: () => wrapper };
  await t.test('a PATH wrapper or npm cache is not a Desktop installation', async () => {
    assert.equal((await discoverDshRuntimes({ ...options, desktopRoots: [] }))[0]!.installed, false);
  });

  const desktop = join(root, 'Desktop');
  const bin = join(desktop, 'resources/runtime/cli/bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(desktop, 'resources/runtime/primary-runtime'), { recursive: true });
  writeFileSync(join(desktop, 'DeepSeek Harness.exe'), '');
  writeFileSync(join(desktop, 'resources/app.asar'), '');
  writeFileSync(
    join(desktop, 'resources/runtime/primary-runtime/runtime.json'),
    JSON.stringify({ desktopVersion: '0.2.2-rc.1' }),
  );
  const command = join(bin, 'dsh.cmd');
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
  const profile = join(home, 'profiles/acp');
  mkdirSync(profile, { recursive: true });
  const patch = join(profile, 'cordis.patch.yml');
  writeFileSync(patch, '# old native ACP is broken\n');
  await t.test('registry discovery uses asynchronous process I/O', async (t) => {
    useWin32Platform(t);
    t.mock.method(childProcess, 'execFileSync', () => {
      throw Error('discovery must not block the API event loop');
    });
    t.mock.method(childProcess, 'execFile', (_file, _args, _options, callback) => {
      setImmediate(() => callback(null, JSON.stringify([desktop]), ''));
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    assert.equal((await discoverDshRuntimes())[0]?.command, command);
  });
  await t.test('the official Desktop remains a candidate despite PATH and a broken native ACP patch', async () => {
    const runtime = (await discoverDshRuntimes({ ...options, desktopRoots: [desktop] }))[0]!;
    assert.equal(runtime.installed, true);
    assert.equal(runtime.command, command);
    assert.deepEqual(runtime.acp, { command, startupArgs: ['--profile', 'acp'], transport: 'stdio' });
    assert.equal(readFileSync(patch, 'utf8'), '# old native ACP is broken\n');
  });
  await t.test('HOME binds the running official Host profile, otherwise the user native HOME candidate', async (t) => {
    const activeHome = join(root, 'active-home');
    const nativeCwd = join(activeHome, 'profiles/desktop');
    mkdirSync(nativeCwd, { recursive: true });
    mkdirSync(join(home, 'profiles/desktop'), { recursive: true });
    let running = true;
    t.mock.method(childProcess, 'execFile', (_file, _args, _options, callback) => {
      callback(
        null,
        JSON.stringify({
          userHome: home,
          machineHome: null,
          processes: running
            ? [
                {
                  ExecutablePath: join(desktop, 'DeepSeek Harness.exe'),
                  CommandLine: `"${join(desktop, 'DeepSeek Harness.exe')}" --expose-internals "${join(desktop, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js')}" "${join(desktop, 'resources/runtime')}" "${nativeCwd}"`,
                },
              ]
            : [],
        }),
        '',
      );
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    assert.deepEqual(await resolveDshDesktopHome(command), { nativeHome: activeHome, nativeCwd });
    running = false;
    assert.deepEqual(await resolveDshDesktopHome(command), {
      nativeHome: home,
      nativeCwd: join(home, 'profiles/desktop'),
    });
  });
  const other = join(root, 'Desktop-two');
  cpSync(desktop, other, { recursive: true });
  await t.test('multiple installations match the running official Host or offer explicit locations', async (t) => {
    useWin32Platform(t);
    let running = true;
    t.mock.method(childProcess, 'execFile', (_file, args, _options, callback) => {
      const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      if (script.includes('Get-ItemProperty')) return callback(null, JSON.stringify([desktop, other]), '');
      callback(
        null,
        JSON.stringify({
          userHome: home,
          machineHome: null,
          processes: running
            ? [
                {
                  ExecutablePath: join(other, 'DeepSeek Harness.exe'),
                  CommandLine: `"${join(other, 'DeepSeek Harness.exe')}" "${join(other, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js')}" runtime "${join(home, 'profiles/desktop')}"`,
                },
              ]
            : [],
        }),
        '',
      );
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const active = await discoverDshRuntimes();
    assert.equal(active.length, 1);
    assert.equal(active[0]?.command, join(other, 'resources/runtime/cli/bin/dsh.cmd'));
    running = false;
    const choices = await discoverDshRuntimes();
    assert.equal(choices.length, 2);
    assert.notEqual(choices[0]?.id, choices[1]?.id);
    assert.ok(choices.every((choice) => choice.label.includes(root)));
  });
  for (const failure of [new Error('Desktop process query timed out'), 'not JSON', '{"processes":[]}']) {
    await t.test(`optional Desktop disambiguation failure preserves discovery: ${String(failure)}`, async (t) => {
      useWin32Platform(t);
      t.mock.method(childProcess, 'execFile', (_file, args, _options, callback) => {
        const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
        if (script.includes('Get-ItemProperty')) return callback(null, JSON.stringify([desktop, other]), '');
        if (failure instanceof Error) return callback(failure, '', '');
        callback(null, failure, '');
      });
      syncBuiltinESMExports();
      t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      });
      const { runtimes } = await discoverNativeRuntimes(root, () => null);
      assert.deepEqual(
        runtimes.filter((runtime) => runtime.id === 'codex' || runtime.id === 'claude').map((runtime) => runtime.id),
        ['codex', 'claude'],
      );
      assert.deepEqual(
        runtimes.filter((runtime) => 'dshDesktop' in runtime).map((runtime) => runtime.command),
        [command, join(other, 'resources/runtime/cli/bin/dsh.cmd')],
      );
      await assert.rejects(resolveDshDesktopHome(command), 'required HOME binding must still reject the query failure');
    });
  }
});
