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

const LOCALES = {
  zh_CN: 'zh_CN.UTF-8',
  en_GB: 'en_GB.UTF-8',
  de_DE: 'de_DE.UTF-8',
  en_US: 'en_US.UTF-8',
};

function withLocale(t, locale) {
  const keys = ['LANG', 'LC_ALL', 'LC_TIME'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) process.env[key] = locale;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/** The identity a pre-fix build recorded while running under `locale`. */
function preFixIdentityUnder(pid, locale) {
  const line = cp.spawnSync('/bin/ps', ['-p', String(pid), '-o', 'pid=,ppid=,pgid=,lstart=,command='], {
    encoding: 'utf8',
    env: { ...process.env, LANG: locale, LC_ALL: locale, LC_TIME: locale },
  }).stdout;
  const parts = line.trim().split(/\s+/);
  return { pid, ppid: Number(parts[1]), pgid: Number(parts[2]), startedAt: parts.slice(3, 8).join(' ') };
}

const MANAGED_JOB_ID_ENV = 'CAT_CAFE_MANAGED_JOB_ID';
const CARRIER = 'console.log(process.pid); setInterval(() => {}, 1000)';

/**
 * A faithful two-process scene of the real topology: the recorded owner is the durable worker, started with
 * this job's id in its environment, and the attempt token is only on the command it spawns. `shape` is the
 * command: a direct `node` child, a compound shell command (worker → sh → node, so the token carrier is a
 * grandchild), or a system binary whose environment `ps eww` may not show. `none` is an unrelated process
 * standing in for a reused PID: no job id and no command.
 */
async function startOwner(t, { jobId, attemptToken, shape }) {
  const commands = {
    node: [process.execPath, ['-e', CARRIER]],
    compound: ['/bin/sh', ['-c', `"${process.execPath}" -e '${CARRIER}'; echo done`]],
    system: ['/bin/sleep', ['600']],
  };
  const script =
    shape === 'none'
      ? 'setInterval(() => {}, 1000); console.log(process.pid)'
      : `const [cmd, args] = ${JSON.stringify(commands[shape])};
         const child = require('node:child_process').spawn(cmd, args, {
           env: { ...process.env, ${ATTEMPT_TOKEN_ENV}: ${JSON.stringify(attemptToken)} },
           stdio: ['ignore', 'inherit', 'ignore'],
         });
         delete process.env.${ATTEMPT_TOKEN_ENV};
         console.log(child.pid);
         setInterval(() => {}, 1000);`;
  const env = { ...process.env };
  delete env[ATTEMPT_TOKEN_ENV];
  if (shape !== 'none') env[MANAGED_JOB_ID_ENV] = jobId;
  else delete env[MANAGED_JOB_ID_ENV];
  const owner = cp.spawn(process.execPath, ['-e', script], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  const pids = new Set();
  owner.stdout.on('data', (chunk) => {
    for (const n of String(chunk).match(/\d+/g) ?? []) pids.add(Number(n));
  });
  await once(owner.stdout, 'data', { signal: AbortSignal.timeout(5000) });
  await delay(shape === 'compound' ? 600 : 150);
  pids.delete(owner.pid);
  t.after(() => {
    for (const pid of [owner.pid, ...pids]) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  });
  return { owner, commandPids: [...pids] };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function reconcileScene(t, { written, apiNow, shape, ownerDies = false }) {
  if (process.platform === 'win32') return t.skip('Unix process table only');
  const root = mkdtempSync(join(tmpdir(), 'issue2025-legacy-owner-'));
  const priorDataRoot = process.env.CAT_CAFE_DATA_DIR;
  process.env.CAT_CAFE_DATA_DIR = root;
  t.after(() => {
    if (priorDataRoot === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = priorDataRoot;
    rmSync(root, { recursive: true, force: true });
  });
  const attemptToken = `issue2025-${written}-${apiNow}-${shape}-${ownerDies ? 'dead' : 'live'}`;
  const service = new ManagedJobService(root);
  const principal = { userId: 'fixture-user', threadId: 'fixture-thread', catId: 'codex-astra' };
  const job = await service.submit(principal, {
    command: 'true',
    cwd: root,
    originTaskId: 'fixture-task',
    originInvocationId: 'fixture-invocation',
    idempotencyKey: attemptToken,
    executionSlaMs: 60000,
    wakeTarget: principal,
  });
  service.admit(principal, job.jobId, 'fixture-visible-admission');

  const { owner, commandPids } = await startOwner(t, { jobId: job.jobId, attemptToken, shape });
  const legacy = preFixIdentityUnder(owner.pid, LOCALES[written]);
  const reference = preFixIdentityUnder(owner.pid, LOCALES[apiNow]);
  if (written !== 'en_US' && C_LSTART.test(legacy.startedAt)) return t.skip(`${written} locale is not installed`);
  if (written !== apiNow && legacy.startedAt === reference.startedAt)
    return t.skip(`${apiNow} formats like ${written}`);
  withLocale(t, LOCALES[apiNow]);

  recordManagedJobAttempt(job, attemptToken);
  assert.equal(recordDurableManagedGateProcess(job, legacy), true);
  if (ownerDies) {
    for (const pid of [owner.pid, ...commandPids]) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    await delay(150);
  }

  await reconcileManagedJobDescriptor(job, Date.now(), job.supervisorEpoch);
  await delay(300);
  return { job, owner, commandPids, legacy };
}

for (const [written, apiNow] of [
  ['zh_CN', 'zh_CN'],
  ['en_GB', 'en_GB'],
  ['en_GB', 'zh_CN'],
  ['zh_CN', 'en_GB'],
  ['zh_CN', 'de_DE'],
  ['zh_CN', 'en_US'],
]) {
  for (const shape of ['node', 'compound', 'system']) {
    test(`reconcile leaves a live job alone: written under ${written}, API now ${apiNow}, ${shape} command`, async (t) => {
      const scene = await reconcileScene(t, { written, apiNow, shape });
      if (!scene) return;
      const { job, owner, commandPids, legacy } = scene;
      assert.ok(commandPids.length > 0, 'the scene started a command');
      assert.equal(isAlive(owner.pid), true, 'the live worker was not signalled');
      for (const pid of commandPids) assert.equal(isAlive(pid), true, `command process ${pid} was not signalled`);
      const record = rawDurableGateRecord(job);
      assert.equal(record.cleanupProven, false, 'cleanup is not marked proven');
      assert.notEqual(record.state, 'terminal', 'the job is not settled');
      assert.deepEqual(record.ownerIdentity, legacy, 'ownership evidence is preserved as recorded');
    });
  }
}

test('reconcile still proves cleanup once a pre-fix owner and its command are really gone', async (t) => {
  const scene = await reconcileScene(t, { written: 'zh_CN', apiNow: 'en_GB', shape: 'node', ownerDies: true });
  if (!scene) return;
  const { job, legacy } = scene;
  assert.equal(rawDurableGateRecord(job).cleanupProven, true, 'an absent owner with no attempt members is proven');
  assert.deepEqual(rawDurableGateRecord(job).ownerIdentity, legacy, 'ownership evidence is preserved as recorded');
});

test('a reused owner PID without this job id is still treated as gone, and is never signalled', async (t) => {
  const scene = await reconcileScene(t, { written: 'zh_CN', apiNow: 'en_GB', shape: 'none' });
  if (!scene) return;
  const { job, owner } = scene;
  assert.equal(rawDurableGateRecord(job).cleanupProven, true, 'no live owner runs this job, so cleanup is proven');
  assert.equal(isAlive(owner.pid), true, 'the unrelated process carries no attempt token and is not signalled');
});
