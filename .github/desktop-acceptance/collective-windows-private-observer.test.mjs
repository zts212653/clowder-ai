import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const observerPath = fileURLToPath(new URL('./collective-windows-private-observer.cjs', import.meta.url));
const baselinePath = fileURLToPath(new URL('./collective-windows-private-observer-baseline.cjs', import.meta.url));
const { createObservedExecFile, installObserver, observerSourceSha256 } = require(observerPath);

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const PRIVATE_ROOT = 'D:\\private-canary\\service';
const HASH = 'a'.repeat(64);

function targetOptions() {
  return {
    env: {
      SystemRoot: 'C:\\Windows',
      CLOWDER_COLLECTIVE_PRIVATE_ROOT: PRIVATE_ROOT,
      SECRET_ENV_CANARY: 'never-record-this-environment',
    },
    timeout: 30_000,
    windowsHide: true,
  };
}

function targetArgs() {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', 'ENCODED_COMMAND_CANARY'];
}

test('observer preserves callback arguments, callback receiver and returned child while sampling once', async () => {
  const child = { fixture: 'child' };
  const callbackReceiver = { fixture: 'receiver' };
  const failure = Object.assign(new Error('fixture'), { code: null, killed: true, signal: 'SIGTERM' });
  const calls = [];
  const records = [];
  const baselines = [];
  const clock = [1_000_000n, 31_005_000_000n];
  function original(file, args, options, callback) {
    calls.push({ file, args, options });
    queueMicrotask(() => callback.call(callbackReceiver, failure, 'out', 'err'));
    return child;
  }
  const observed = createObservedExecFile({
    execFile: original,
    appendRecord: (record) => records.push(record),
    scheduleBaseline: (input) => baselines.push(input),
    nowNs: () => clock.shift(),
    observerSha256: HASH,
  });
  let received;
  let receiver;
  const returned = observed(POWERSHELL, targetArgs(), targetOptions(), function (...args) {
    received = args;
    receiver = this;
  });
  assert.equal(returned, child);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [failure, 'out', 'err']);
  assert.equal(receiver, callbackReceiver);
  assert.equal(calls.length, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].elapsedMs, 31_004);
  assert.equal(records[0].killed, true);
  assert.equal(records[0].signal, 'SIGTERM');
  assert.equal(baselines.length, 1);
  assert.equal(baselines[0].privateRoot, PRIVATE_ROOT);

  observed(POWERSHELL, targetArgs(), targetOptions(), () => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(records.length, 1, 'only the first production callback is sampled');
  assert.equal(baselines.length, 1, 'only the first production callback schedules a census');
});

test('observer ignores near misses without inspecting their callback output', async () => {
  const records = [];
  const original = (_file, _args, _options, callback) => {
    queueMicrotask(() => callback(null, 'NEAR_MISS_STDOUT_CANARY', 'NEAR_MISS_STDERR_CANARY'));
    return { fixture: 'child' };
  };
  const observed = createObservedExecFile({
    execFile: original,
    appendRecord: (record) => records.push(record),
    scheduleBaseline: () => assert.fail('near miss scheduled a baseline'),
    observerSha256: HASH,
  });
  observed(process.execPath, targetArgs(), targetOptions(), () => {});
  observed(POWERSHELL, targetArgs(), { env: { SystemRoot: 'C:\\Windows' } }, () => {});
  observed(POWERSHELL, ['-NoProfile'], targetOptions(), () => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(records, []);
});

test('observer diagnostics and synchronous spawn failures cannot change production semantics', async () => {
  const synchronousFailure = new Error('synchronous fixture');
  let attempts = 0;
  const original = (_file, _args, _options, callback) => {
    attempts++;
    if (attempts === 1) throw synchronousFailure;
    queueMicrotask(() => callback(null, 'preserved stdout', 'preserved stderr'));
    return { fixture: 'child' };
  };
  const observed = createObservedExecFile({
    execFile: original,
    appendRecord: () => {
      throw new Error('observer output unavailable');
    },
    scheduleBaseline: () => {
      throw new Error('observer baseline unavailable');
    },
    observerSha256: HASH,
  });
  assert.throws(
    () => observed(POWERSHELL, targetArgs(), targetOptions(), () => {}),
    (error) => error === synchronousFailure,
  );
  const received = await new Promise((resolve) => {
    observed(POWERSHELL, targetArgs(), targetOptions(), (...args) => resolve(args));
  });
  assert.deepEqual(received, [null, 'preserved stdout', 'preserved stderr']);
});

test('promisified observed execFile preserves Node result, rejection and child contracts', async () => {
  for (const shouldFail of [false, true]) {
    const child = { shouldFail };
    const failure = Object.assign(new Error('fixture failure'), { code: 7, killed: false, signal: null });
    const observed = createObservedExecFile({
      execFile: (_file, _args, _options, callback) => {
        queueMicrotask(() => callback(shouldFail ? failure : null, 'stdout', 'stderr'));
        return child;
      },
      appendRecord: () => {},
      scheduleBaseline: () => {},
      observerSha256: HASH,
    });
    const operation = promisify(observed)(POWERSHELL, targetArgs(), targetOptions());
    assert.equal(operation.child, child);
    if (shouldFail) {
      await assert.rejects(operation, (error) => {
        assert.equal(error, failure);
        assert.equal(error.stdout, 'stdout');
        assert.equal(error.stderr, 'stderr');
        return true;
      });
    } else assert.deepEqual(await operation, { stdout: 'stdout', stderr: 'stderr' });
  }
});

test('promisified observed execFile preserves native synchronous validation exceptions', async () => {
  const observed = createObservedExecFile({
    execFile,
    appendRecord: () => {},
    scheduleBaseline: () => {},
    observerSha256: HASH,
  });
  async function capture(call) {
    try {
      const returned = call();
      await returned?.catch(() => {});
      return { threw: false };
    } catch (error) {
      return { threw: true, name: error.name, code: error.code };
    }
  }
  const nativeOutcome = await capture(() => promisify(execFile)(null));
  const observedOutcome = await capture(() => promisify(observed)(null));
  assert.equal(nativeOutcome.threw, true, 'fixture requires native execFile to reject invalid input synchronously');
  assert.deepEqual(observedOutcome, nativeOutcome);
});

test('installer patches only native Windows Node and rolls back a failed builtin synchronization', () => {
  const outputPath = isAbsolute('/tmp/observer.jsonl')
    ? '/tmp/observer.jsonl'
    : `${dirname(observerPath)}/observer.jsonl`;
  const childProcess = { execFile() {} };
  let synchronized = 0;
  assert.deepEqual(
    installObserver({
      platform: 'win32',
      electronVersion: '40.0.0',
      outputPath: 'D:\\evidence\\observer.jsonl',
      childProcess,
      syncBuiltinESMExports: () => synchronized++,
      appendFile: () => {},
    }),
    { installed: false, reason: 'electron' },
  );
  assert.deepEqual(
    installObserver({
      platform: 'darwin',
      outputPath,
      childProcess,
      syncBuiltinESMExports: () => synchronized++,
      appendFile: () => {},
    }),
    { installed: false, reason: 'platform' },
  );
  assert.equal(
    installObserver({
      platform: 'win32',
      outputPath,
      childProcess,
      syncBuiltinESMExports: () => synchronized++,
      appendFile: () => {},
      scheduleBaseline: () => {},
    }).installed,
    true,
  );
  assert.equal(synchronized, 1);

  const rollbackChild = { execFile() {} };
  const original = rollbackChild.execFile;
  assert.deepEqual(
    installObserver({
      platform: 'win32',
      outputPath,
      childProcess: rollbackChild,
      syncBuiltinESMExports: () => {
        throw new Error('fixture sync failure');
      },
      appendFile: () => {},
    }),
    { installed: false, reason: 'installation' },
  );
  assert.equal(rollbackChild.execFile, original);
  assert.equal(
    installObserver({
      platform: 'win32',
      outputPath,
      childProcess: rollbackChild,
      syncBuiltinESMExports: () => {},
      appendFile: () => {},
      scheduleBaseline: () => {},
    }).installed,
    true,
  );
});

test(
  'manual NativeNode installation reaches a later ESM execFile import',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'collective-private-observer-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const executable = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const output = join(root, 'observer.jsonl');
    const probe = join(root, 'probe.cjs');
    await mkdir(dirname(executable), { recursive: true });
    await writeFile(executable, '#!/usr/bin/env node\nprocess.exit(7);\n');
    await chmod(executable, 0o755);
    await writeFile(
      probe,
      `
const { promisify } = require('node:util');
const observer = require(${JSON.stringify(observerPath)});
const installed = observer.installObserver({ platform: 'win32', outputPath: ${JSON.stringify(output)}, scheduleBaseline: () => {} });
if (!installed.installed) process.exit(91);
(async () => {
  const { execFile } = await import('node:child_process');
  try {
    await promisify(execFile)(${JSON.stringify(executable)}, ['-EncodedCommand', 'PRIVATE_ENCODED_CANARY'], {
      env: { ...process.env, CLOWDER_COLLECTIVE_PRIVATE_ROOT: 'D:\\\\PRIVATE_ROOT_CANARY' },
    });
  } catch {}
})().catch(() => process.exit(92));
`,
    );
    execFileSync(process.execPath, [probe], { timeout: 10_000 });
    const records = (await readFile(output, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(records.length, 1);
    assert.equal(records[0].kind, 'collective_windows_private_execfile');
    assert.equal(records[0].code, 7);
    assert.equal(records[0].observerSha256, observerSourceSha256());
    assert.doesNotMatch(JSON.stringify(records), /PRIVATE_(?:ENCODED|ROOT)_CANARY/);
  },
);

test('observer identity binds the exact preload and read-only baseline bytes and the CLI reports it', () => {
  const expected = createHash('sha256')
    .update('cat-cafe-windows-private-observer-v1\0')
    .update(readFileSync(observerPath))
    .update('\0')
    .update(readFileSync(baselinePath))
    .digest('hex');
  assert.equal(observerSourceSha256(), expected);
  assert.equal(execFileSync(process.execPath, [observerPath, '--sha256'], { encoding: 'utf8' }).trim(), expected);
});
