import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  devEnvironment,
  nodeOptionsWithSigusr1Guard,
  resolveTsxCli,
  runDevSupervisor,
  shouldStopDev,
} from '../scripts/dev-supervisor.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

test('dev supervisor stops only on 0, 130, or SIGINT', () => {
  assert.equal(shouldStopDev(0, null), true);
  assert.equal(shouldStopDev(130, null), true);
  assert.equal(shouldStopDev(null, 'SIGINT'), true);
  assert.equal(shouldStopDev(1, null), false);
  assert.equal(shouldStopDev(130, 'SIGTERM'), true);
  assert.equal(shouldStopDev(2, null), false);
  assert.equal(shouldStopDev(null, 'SIGTERM'), false);
});

test('dev supervisor prepends the guard and preserves inherited NODE_OPTIONS', () => {
  const guard = pathToFileURL('/tmp/a folder/sigusr1-guard.mjs').href;
  const options = nodeOptionsWithSigusr1Guard('/tmp/a folder/sigusr1-guard.mjs', '--max-old-space-size=4096');
  assert.equal(options, `--import ${guard} --max-old-space-size=4096`);
  assert.equal(options.split('--import ').length - 1, 1);
});

test('dev supervisor does not add an empty NODE_OPTIONS suffix', () => {
  const guard = pathToFileURL('/tmp/sigusr1-guard.mjs').href;
  const options = nodeOptionsWithSigusr1Guard('/tmp/sigusr1-guard.mjs', '');
  assert.equal(options, `--import ${guard}`);
});

test('dev supervisor resolves the local tsx CLI and guard', () => {
  assert.equal(existsSync(resolveTsxCli(packageRoot)), true);
  const env = devEnvironment({ root: packageRoot, inherited: undefined });
  assert.match(env.NODE_OPTIONS, /sigusr1-guard\.mjs/);
  assert.equal(env.PATH ?? env.Path, process.env.PATH ?? process.env.Path);
  assert.equal(env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT, process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT);
});

test('dev supervisor restarts a failed child and stops on clean exit', async () => {
  const children = [1, 0].map((code) => {
    const child = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => child.emit('exit', code, null));
    return child;
  });
  const exits = [];
  const messages = [];
  const launches = [];
  await runDevSupervisor({
    root: packageRoot,
    tsxCli: join(packageRoot, 'fake-tsx.mjs'),
    spawnChild: (_command, _args, options) => {
      launches.push(options);
      return children.shift();
    },
    exit: (code) => exits.push(code),
    sleepFn: async () => {},
    log: { error: (message) => messages.push(message), warn: () => {} },
  });

  assert.deepEqual(exits, [0]);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /\[api\] dev exited \(1\)/);
  assert.match(messages[0], /auto-restarting in 1s/);
  assert.equal(launches.length, 2);
  for (const options of launches) {
    assert.equal(options.windowsHide, true);
    assert.equal(options.stdio, 'inherit');
  }
});

for (const [signal, expectedCode] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  test(`dev supervisor stops with ${expectedCode} when ${signal} arrives during restart backoff`, async () => {
    const child = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => child.emit('exit', 1, null));
    const signals = new EventEmitter();
    let spawnCount = 0;
    const exits = [];
    await runDevSupervisor({
      root: packageRoot,
      tsxCli: join(packageRoot, 'fake-tsx.mjs'),
      spawnChild: () => {
        spawnCount += 1;
        return child;
      },
      signalSource: signals,
      exit: (code) => exits.push(code),
      sleepFn: async () => signals.emit(signal),
      log: { error: () => {} },
    });

    assert.deepEqual(exits, [expectedCode]);
    assert.equal(spawnCount, 1);
  });
}

test('dev supervisor direct execution follows a directory alias', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cat-cafe-dev-supervisor-alias-'));
  try {
    const alias = join(directory, 'alias with spaces');
    symlinkSync(join(packageRoot, 'scripts'), alias, process.platform === 'win32' ? 'junction' : 'dir');
    const fakeCli = join(directory, 'fake-tsx.mjs');
    writeFileSync(fakeCli, "console.log('FAKE_TSX_STARTED');\n", 'utf8');
    const result = spawnSync(process.execPath, [join(alias, 'dev-supervisor.mjs')], {
      cwd: packageRoot,
      encoding: 'utf8',
      env: { ...process.env, CAT_CAFE_DEV_TSX_CLI: fakeCli },
      windowsHide: true,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /FAKE_TSX_STARTED/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('dev supervisor package entry points at the Node supervisor', async () => {
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.match(
    packageJson.scripts.dev,
    /^(?:node --import tsx \.\/scripts\/copy-bundled-plugin-packages\.mjs --source && )?node scripts\/dev-supervisor\.mjs$/,
  );
});
