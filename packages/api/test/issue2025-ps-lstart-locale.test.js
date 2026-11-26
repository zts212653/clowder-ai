import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  rawDurableGateRecord,
  recordDurableManagedGateProcess,
  recordManagedJobAttempt,
} from '../dist/domains/managed-job/durable-managed-gate-job-store.js';
import { ManagedJobService } from '../dist/domains/managed-job/ManagedJobService.js';
import { reconcileManagedJobDescriptor } from '../dist/domains/managed-job/managed-job-reconcile-descriptor.js';
import { retainLiveManagedAttemptMembers } from '../dist/infrastructure/managed-runner/attempt-members.js';
import {
  readUnixProcessSnapshot,
  readUnixProcessSnapshotSync,
  sameUnixProcess,
} from '../dist/utils/cli-process-ownership.js';
import { streamMacProcessEnvironments } from '../runtime/process-observation/ps-environment-worker.mjs';

// Issue #2025: `ps -o lstart` follows the caller's locale. Under zh_CN it prints
// `二 11月/17 17:50:43 2026` (4 fields) instead of `Tue Nov 17 17:50:43 2026` (5),
// so start-time identity could never be proven and cleanup stayed unproven.
const NON_C_LOCALE = { LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8', LC_TIME: 'zh_CN.UTF-8' };
const C_LSTART = /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/u;
const ATTEMPT_TOKEN_ENV = 'CAT_CAFE_MANAGED_GATE_ATTEMPT_TOKEN';

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

/** The identity a pre-fix build recorded: the caller-locale line, split exactly as its snapshot parser did. */
function preFixIdentity(pid) {
  const line = cp.spawnSync('/bin/ps', ['-p', String(pid), '-o', 'pid=,ppid=,pgid=,lstart=,command='], {
    encoding: 'utf8',
    env: process.env,
  }).stdout;
  const parts = line.trim().split(/\s+/);
  return { pid, ppid: Number(parts[1]), pgid: Number(parts[2]), startedAt: parts.slice(3, 8).join(' ') };
}

async function startChild(t, env = process.env) {
  const child = cp.spawn(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'], {
    env,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  await once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) });
  return child;
}

async function stopChild(child) {
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

test('every ps lstart identity read runs its child in the C locale under a non-C parent environment', async (t) => {
  withNonCParentLocale(t);
  const originals = { spawnSync: cp.spawnSync, execFile: cp.execFile };
  const seen = [];
  const reader = (args, fallback) => {
    if (args.includes('pid=,lstart=,stat=')) return 'attempt liveness';
    return args[0] === '-ww' ? `${fallback} pre-fix compatibility read` : fallback;
  };
  cp.spawnSync = (file, args, options) => {
    seen.push({ reader: reader(args, 'sync snapshot'), options });
    return originals.spawnSync(file, args, options);
  };
  cp.execFile = (file, args, options, callback) => {
    seen.push({ reader: reader(args, 'async snapshot'), options });
    return originals.execFile(file, args, options, callback);
  };
  syncBuiltinESMExports();
  t.after(() => {
    Object.assign(cp, originals);
    syncBuiltinESMExports();
  });

  readUnixProcessSnapshotSync({ pids: [process.pid] });
  await readUnixProcessSnapshot({ pids: [process.pid] });
  const current = { pid: process.pid, ppid: 0, pgid: 0, startedAt: 'Thu Nov 26 18:10:51 2026' };
  await retainLiveManagedAttemptMembers(new Map([[process.pid, current]]), []);

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
    'async snapshot pre-fix compatibility read',
    'attempt liveness',
    'macOS environment worker',
    'sync snapshot',
    'sync snapshot pre-fix compatibility read',
  ]);
  for (const { reader: name, options } of seen) {
    const expected = name.endsWith('pre-fix compatibility read') ? NON_C_LOCALE.LC_ALL : 'C';
    assert.equal(options?.env?.LC_ALL, expected, `${name} uses LC_ALL=${expected}`);
    assert.equal(options.env.LANG, NON_C_LOCALE.LANG, `${name} keeps the rest of the parent environment`);
  }
});

test('cleanup completes under a non-C parent locale while PID/start-time identity stays enforced', async (t) => {
  if (process.platform === 'win32') return t.skip('Unix process table only');
  withNonCParentLocale(t);
  const child = await startChild(t);

  const identity = readUnixProcessSnapshotSync({ pids: [child.pid] }).get(child.pid);
  assert.match(identity.startedAt, C_LSTART, 'startedAt is the C-locale lstart, not absorbing the command');
  assert.equal((await readUnixProcessSnapshot({ pids: [child.pid] })).get(child.pid).startedAt, identity.startedAt);

  const known = new Map();
  assert.deepEqual(await retainLiveManagedAttemptMembers(known, [identity]), [identity], 'live member is provable');
  const impostor = new Map([[child.pid, { ...identity, startedAt: 'Mon Jan 1 00:00:00 2001' }]]);
  assert.deepEqual(await retainLiveManagedAttemptMembers(impostor, []), [], 'a reused PID never matches');

  await stopChild(child);
  assert.deepEqual(await retainLiveManagedAttemptMembers(known, []), [], 'cleanup is proven once the member is gone');
});

test('a pre-fix identity keeps its exact pre-fix meaning: live stays live, reused or absent stays not-same', async (t) => {
  if (process.platform === 'win32') return t.skip('Unix process table only');
  withNonCParentLocale(t);
  const child = await startChild(t);
  const legacy = preFixIdentity(child.pid);
  if (C_LSTART.test(legacy.startedAt)) return t.skip('zh_CN locale is not installed on this host');

  const sync = readUnixProcessSnapshotSync({ pids: [child.pid] });
  const async = await readUnixProcessSnapshot({ pids: [child.pid] });
  assert.match(sync.get(child.pid).startedAt, C_LSTART);
  assert.equal(sameUnixProcess(legacy, sync.get(child.pid)), true, 'sync reader: live pre-fix owner still matches');
  assert.equal(sameUnixProcess(legacy, async.get(child.pid)), true, 'async reader: live pre-fix owner still matches');
  assert.equal(JSON.stringify(sync.get(child.pid)).includes(legacy.startedAt), false, 'nothing new is serialized');
  const reused = { ...legacy, startedAt: legacy.startedAt.replace(/\d{2}:\d{2}:\d{2}/u, '00:00:00') };
  assert.equal(sameUnixProcess(reused, sync.get(child.pid)), false, 'a reused PID still does not match');
  const liveMembers = await retainLiveManagedAttemptMembers(new Map([[child.pid, legacy]]), []);
  assert.ok(liveMembers === null || liveMembers.length === 1, 'a live pre-fix member is never reported gone');

  await stopChild(child);
  const gone = readUnixProcessSnapshotSync({ pids: [child.pid] });
  assert.equal(sameUnixProcess(legacy, gone.get(child.pid)), false, 'an absent PID is not-same, exactly as before');
  assert.deepEqual(
    await retainLiveManagedAttemptMembers(new Map([[child.pid, legacy]]), []),
    [],
    'an absent pre-fix member reads as gone, exactly as the pre-fix liveness read did',
  );
});

test('reconcile neither signals nor reports gone a live worker whose owner identity predates the fix', async (t) => {
  if (process.platform === 'win32') return t.skip('Unix process table only');
  withNonCParentLocale(t);
  const root = mkdtempSync(join(tmpdir(), 'issue2025-legacy-owner-'));
  const priorDataRoot = process.env.CAT_CAFE_DATA_DIR;
  process.env.CAT_CAFE_DATA_DIR = root;
  t.after(() => {
    if (priorDataRoot === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = priorDataRoot;
    rmSync(root, { recursive: true, force: true });
  });
  const attemptToken = 'issue2025-legacy-attempt';
  const worker = await startChild(t, { ...process.env, [ATTEMPT_TOKEN_ENV]: attemptToken });
  const legacy = preFixIdentity(worker.pid);
  if (C_LSTART.test(legacy.startedAt)) return t.skip('zh_CN locale is not installed on this host');

  const service = new ManagedJobService(root);
  const principal = { userId: 'fixture-user', threadId: 'fixture-thread', catId: 'codex-astra' };
  const job = await service.submit(principal, {
    command: 'true',
    cwd: root,
    originTaskId: 'fixture-task',
    originInvocationId: 'fixture-invocation',
    idempotencyKey: 'issue2025-legacy-owner',
    executionSlaMs: 60000,
    wakeTarget: principal,
  });
  service.admit(principal, job.jobId, 'fixture-visible-admission');
  recordManagedJobAttempt(job, attemptToken);
  assert.equal(recordDurableManagedGateProcess(job, legacy), true);
  assert.equal(rawDurableGateRecord(job).attemptToken, attemptToken);

  await reconcileManagedJobDescriptor(job, Date.now(), job.supervisorEpoch);
  await delay(300);
  assert.equal(worker.exitCode, null, 'the live worker was not terminated');
  assert.equal(worker.signalCode, null, 'the live worker was not signalled');
  assert.equal(rawDurableGateRecord(job).cleanupProven, false, 'cleanup is not marked proven');
  assert.notEqual(rawDurableGateRecord(job).state, 'terminal');
  assert.deepEqual(rawDurableGateRecord(job).ownerIdentity, legacy, 'ownership evidence is preserved as recorded');
});
