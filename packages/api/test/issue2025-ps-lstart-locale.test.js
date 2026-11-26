import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { retainLiveManagedAttemptMembers } from '../dist/infrastructure/managed-runner/attempt-members.js';
import { readUnixProcessSnapshot, readUnixProcessSnapshotSync } from '../dist/utils/cli-process-ownership.js';
import { streamMacProcessEnvironments } from '../runtime/process-observation/ps-environment-worker.mjs';

// Issue #2025: `ps -o lstart` follows the caller's locale. Under zh_CN it prints
// `二 11月/17 17:50:43 2026` (4 fields) instead of `Tue Nov 17 17:50:43 2026` (5),
// so start-time identity could never be proven and cleanup stayed unproven.
const NON_C_LOCALE = { LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8', LC_TIME: 'zh_CN.UTF-8' };
const C_LSTART = /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/u;

function withNonCParentLocale(t) {
  const saved = Object.fromEntries(Object.keys(NON_C_LOCALE).map((key) => [key, process.env[key]]));
  Object.assign(process.env, NON_C_LOCALE);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('every ps lstart read runs its child in the C locale under a non-C parent environment', async (t) => {
  withNonCParentLocale(t);
  const originals = { spawnSync: cp.spawnSync, execFile: cp.execFile };
  const seen = [];
  cp.spawnSync = (file, args, options) => {
    seen.push({ reader: 'sync snapshot', options });
    return originals.spawnSync(file, args, options);
  };
  cp.execFile = (file, args, options, callback) => {
    seen.push({ reader: args.includes('pid=,lstart=,stat=') ? 'attempt liveness' : 'async snapshot', options });
    return originals.execFile(file, args, options, callback);
  };
  syncBuiltinESMExports();
  t.after(() => {
    Object.assign(cp, originals);
    syncBuiltinESMExports();
  });

  readUnixProcessSnapshotSync({ pids: [process.pid] });
  await readUnixProcessSnapshot({ pids: [process.pid] });
  await retainLiveManagedAttemptMembers(new Map([[process.pid, { pid: process.pid, startedAt: 'x' }]]), []);

  let workerOptions;
  await streamMacProcessEnvironments(
    { pids: [process.pid], markers: ['CAT_CAFE_ISSUE_2025=1'] },
    {
      spawnImpl: (_file, _args, options) => {
        workerOptions = options;
        throw new Error('captured');
      },
      output: { write() {} },
    },
  ).catch(() => {});
  seen.push({ reader: 'macOS environment worker', options: workerOptions });

  assert.deepEqual(seen.map((call) => call.reader).sort(), [
    'async snapshot',
    'attempt liveness',
    'macOS environment worker',
    'sync snapshot',
  ]);
  for (const { reader, options } of seen) {
    assert.equal(options?.env?.LC_ALL, 'C', `${reader} must pin LC_ALL=C`);
    assert.equal(options.env.LANG, NON_C_LOCALE.LANG, `${reader} keeps the rest of the parent environment`);
  }
});

test('cleanup completes under a non-C parent locale while PID/start-time identity stays enforced', async (t) => {
  if (process.platform === 'win32') return t.skip('Unix process table only');
  withNonCParentLocale(t);
  const child = cp.spawn(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  await once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) });

  const identity = readUnixProcessSnapshotSync({ pids: [child.pid] }).get(child.pid);
  assert.match(identity.startedAt, C_LSTART, 'startedAt is the C-locale lstart, not absorbing the command');
  assert.equal((await readUnixProcessSnapshot({ pids: [child.pid] })).get(child.pid).startedAt, identity.startedAt);

  const known = new Map();
  assert.deepEqual(await retainLiveManagedAttemptMembers(known, [identity]), [identity], 'live member is provable');
  const impostor = new Map([[child.pid, { ...identity, startedAt: 'Mon Jan 1 00:00:00 2001' }]]);
  assert.deepEqual(await retainLiveManagedAttemptMembers(impostor, []), [], 'a reused PID never matches');

  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  assert.deepEqual(await retainLiveManagedAttemptMembers(known, []), [], 'cleanup is proven once the member is gone');
});
