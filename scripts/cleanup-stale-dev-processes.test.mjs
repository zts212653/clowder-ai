import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  findStaleDevProcesses,
  killWindowsProcess,
  parseWindowsProcessList,
  readWindowsCreationMs,
  terminateFindings,
} from './cleanup-stale-dev-processes.mjs';
import { isCatCafeCommand, isOrphaned } from './lib/stale-dev-process-rules.mjs';

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'cleanup-stale-dev-processes.mjs');

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 30_000 });
}

function aliasFixture() {
  const root = mkdtempSync(join(tmpdir(), 'stale-process-alias-'));
  const alias = join(root, 'alias with spaces');
  symlinkSync(dirname(script), alias, process.platform === 'win32' ? 'junction' : 'dir');
  return { root, aliasScript: join(alias, 'cleanup-stale-dev-processes.mjs') };
}

test('importing the process doctor stays inert', () => {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `await import(${JSON.stringify(pathToFileURL(script).href)});`],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('a missing entry path stays inert', () => {
  const missing = pathToFileURL(join(tmpdir(), 'definitely-missing-stale-process-entry.mjs')).href;
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `process.argv[1] = ${JSON.stringify(new URL(missing).pathname)}; await import(${JSON.stringify(pathToFileURL(script).href)});`,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('Windows alias/junction path reaches native enumeration', { skip: process.platform !== 'win32' }, () => {
  const fixture = aliasFixture();
  try {
    const result = spawnSync(process.execPath, [fixture.aliasScript], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[stale-dev-processes\]/);
    assert.doesNotMatch(result.stderr, /not supported yet/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('POSIX alias path enters the real entrypoint', { skip: process.platform === 'win32' }, () => {
  const fixture = aliasFixture();
  const bin = join(fixture.root, 'bin');
  try {
    mkdirSync(bin);
    writeFileSync(join(bin, 'ps'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const result = spawnSync(process.execPath, [fixture.aliasScript], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no cleanup-safe stale/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test(
  'Windows direct execution enumerates instead of silently succeeding',
  { skip: process.platform !== 'win32' },
  () => {
    const result = run([]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[stale-dev-processes\]/);
    assert.doesNotMatch(result.stderr, /not supported yet/);
  },
);

test('Windows process snapshots normalize paths and detect dead parents', () => {
  const now = Date.parse('2026-11-02T10:00:00.000Z');
  const rows = parseWindowsProcessList(
    JSON.stringify([
      {
        ProcessId: 4100,
        ParentProcessId: 1,
        CreationDate: '2026-11-02T09:00:00.000Z',
        WorkingSetSize: 2 * 1024 * 1024,
        CommandLine: 'C:\\Program Files\\nodejs\\node.exe C:\\src\\cat-cafe\\scripts\\x.mjs',
      },
      {
        ProcessId: 4101,
        ParentProcessId: 4100,
        CreationDate: '2026-11-02T09:59:00.000Z',
        WorkingSetSize: 1024,
        CommandLine: '"C:\\Program Files\\nodejs\\node.exe" --test',
      },
    ]),
    { nowMs: now },
  );

  assert.equal(rows.length, 2);
  assert.equal(rows[0].elapsedSeconds, 3600);
  assert.equal(rows[0].createdAt, Date.parse('2026-11-02T09:00:00.000Z'));
  assert.equal(rows[0].elapsed, '01:00:00');
  assert.equal(rows[0].rssKb, 2048);
  assert.equal(rows[0].command, 'C:/Program Files/nodejs/node.exe C:/src/cat-cafe/scripts/x.mjs');
  assert.equal(rows[0].orphaned, true);
  assert.equal(rows[1].orphaned, false);
});

test('Windows orphan detection rejects a reused parent PID', () => {
  const now = Date.parse('2026-11-02T10:00:00.000Z');
  const child = {
    ProcessId: 770001,
    ParentProcessId: 770099,
    CreationDate: '2026-11-02T08:00:00.000Z',
    WorkingSetSize: 1024,
    CommandLine: String.raw`"C:\Program Files\nodejs\node.exe" --test C:\work\cat-cafe\packages\api\test\cli-spawn.test.js`,
  };
  const reusedParent = {
    ProcessId: 770099,
    ParentProcessId: 1,
    CreationDate: '2026-11-02T09:59:59.000Z',
    WorkingSetSize: 1024,
    CommandLine: 'C:\\Windows\\System32\\cmd.exe',
  };
  const rows = parseWindowsProcessList(JSON.stringify([child, reusedParent]), { nowMs: now });
  assert.equal(rows.find((row) => row.pid === child.ProcessId).orphaned, true);
  assert.equal(findStaleDevProcesses(rows, { ownPid: 1, nowMs: now }).length, 1);

  const oldParent = { ...reusedParent, CreationDate: '2026-11-02T07:00:00.000Z' };
  const withOldParent = parseWindowsProcessList(JSON.stringify([child, oldParent]), { nowMs: now });
  assert.equal(withOldParent.find((row) => row.pid === child.ProcessId).orphaned, false);
  assert.equal(findStaleDevProcesses(withOldParent, { ownPid: 1, nowMs: now }).length, 0);

  const withoutParent = parseWindowsProcessList(JSON.stringify([child]), { nowMs: now });
  assert.equal(withoutParent[0].orphaned, true);

  const parentWithoutCreation = { ...reusedParent, CreationDate: null };
  const unknownParent = parseWindowsProcessList(JSON.stringify([child, parentWithoutCreation]), { nowMs: now });
  assert.equal(unknownParent.find((row) => row.pid === child.ProcessId).orphaned, false);
});

test('Windows worktree matching is case-insensitive without weakening POSIX', () => {
  assert.equal(isCatCafeCommand('C:/src/cat-cafe/scripts/a.mjs'), true);
  assert.equal(isCatCafeCommand('C:/src/Cat-Cafe/scripts/a.mjs', { caseInsensitive: true }), true);
  assert.equal(isCatCafeCommand('C:/src/Cat-Cafe/scripts/a.mjs', { caseInsensitive: false }), false);
});

test('Windows kill revalidation rejects a missing or recycled PID', () => {
  assert.doesNotThrow(() => killWindowsProcess(123, { createdAt: 1000 }, { execFileImpl: () => {} }));
  assert.throws(() => killWindowsProcess(123, {}, { execFileImpl: () => {} }), /no snapshot creation time/);
});

test('orphan fallback keeps POSIX PID 1 semantics', () => {
  assert.equal(isOrphaned({ ppid: 1 }), true);
  assert.equal(isOrphaned({ ppid: 42 }), false);
  assert.equal(isOrphaned({ ppid: 42, orphaned: true }), true);
});

test('Windows quoted node commands still match orphan rules', () => {
  const now = Date.parse('2026-11-02T10:00:00.000Z');
  const command = String.raw`"C:\Program Files\nodejs\node.exe" --test C:\work\cat-cafe\packages\api\test\cli-spawn.test.js`;
  const rows = parseWindowsProcessList(
    JSON.stringify([
      {
        ProcessId: 500,
        ParentProcessId: 999,
        CreationDate: '2026-11-02T08:00:00.000Z',
        WorkingSetSize: 1024,
        CommandLine: command,
      },
    ]),
    { nowMs: now },
  );
  const findings = findStaleDevProcesses(rows, { ownPid: 1, nowMs: now });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleId, 'orphan-cat-cafe-node-test');
});

test('Windows quoted gate-permit script paths still match the orphan rule', () => {
  const now = Date.parse('2026-11-02T10:00:00.000Z');
  const command = String.raw`"C:\Program Files\nodejs\node.exe" "D:\work\Cat-Cafe\scripts\run-with-gate-resource-permit.mjs"`;
  const rows = parseWindowsProcessList(
    JSON.stringify([
      {
        ProcessId: 700,
        ParentProcessId: 999,
        CreationDate: '2026-11-02T08:00:00.000Z',
        WorkingSetSize: 1024,
        CommandLine: command,
      },
    ]),
    { nowMs: now },
  );
  const findings = findStaleDevProcesses(rows, { ownPid: 1, nowMs: now });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleId, 'orphan-cat-cafe-gate-permit');
});

test('Windows stale rules match a Cat-Cafe worktree casing', { skip: process.platform !== 'win32' }, () => {
  const now = Date.parse('2026-11-02T10:00:00.000Z');
  const command = String.raw`"C:\Program Files\nodejs\node.exe" --test C:\work\Cat-Cafe\packages\api\test\cli-spawn.test.js`;
  const rows = parseWindowsProcessList(
    JSON.stringify([
      {
        ProcessId: 600,
        ParentProcessId: 999,
        CreationDate: '2026-11-02T08:00:00.000Z',
        WorkingSetSize: 1024,
        CommandLine: command,
      },
    ]),
    { nowMs: now },
  );
  const findings = findStaleDevProcesses(rows, { ownPid: 1, nowMs: now });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleId, 'orphan-cat-cafe-node-test');
});

test('Windows cleanup --run is explicit even when nothing is stale', { skip: process.platform !== 'win32' }, () => {
  const result = run(['--run', '--pencil-only']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /sigterm=0 sigkill=0 gone=0/);
  assert.match(result.stdout, /skippedProtected=0/);
});

test('termination refuses to kill the doctor or its parent', async () => {
  const findings = [
    { pid: process.pid, ruleId: 'fixture' },
    { pid: process.ppid, ruleId: 'fixture' },
  ];
  const result = await terminateFindings(findings, {
    killFn: () => {
      throw new Error('must not be called');
    },
    sleepFn: async () => {},
  });
  assert.equal(result.skippedProtected, 2);
  assert.equal(result.sigtermSent, 0);
  assert.equal(result.failed.length, 0);
});

test('termination sends a signal and records a process that exits during grace', async () => {
  const signals = [];
  const result = await terminateFindings([{ pid: 987654, ruleId: 'fixture' }], {
    killFn: (pid, signal) => signals.push([pid, signal]),
    existsFn: () => false,
    sleepFn: async () => {},
  });
  assert.deepEqual(signals, [[987654, 'SIGTERM']]);
  assert.equal(result.sigtermSent, 1);
  assert.equal(result.alreadyGone, 1);
  assert.equal(result.failed.length, 0);
});

test('termination passes the snapshot identity to the platform kill path', async () => {
  const seen = [];
  const result = await terminateFindings([{ pid: 4242, ruleId: 'fixture', createdAt: 111 }], {
    killFn: (pid, signal, item) => {
      seen.push([pid, signal, item.createdAt]);
    },
    existsFn: () => false,
    sleepFn: async () => {},
  });
  assert.deepEqual(seen, [[4242, 'SIGTERM', 111]]);
  assert.equal(result.sigtermSent, 1);
  assert.equal(result.alreadyGone, 1);
});

test('Windows cleanup never expands a finding into an implicit process tree', async () => {
  const calls = [];
  await terminateFindings([{ pid: 5151, ruleId: 'fixture', createdAt: 222 }], {
    killFn: (pid, signal) => calls.push([pid, signal]),
    existsFn: () => false,
    sleepFn: async () => {},
  });
  assert.deepEqual(calls, [[5151, 'SIGTERM']]);
  assert.doesNotMatch(readFileSync(script, 'utf8'), /taskkill|\/T\b/i);
});

test(
  'Windows termination opens and terminates the same verified process handle',
  { skip: process.platform !== 'win32' },
  async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      await once(child, 'spawn');
      const createdAt = readWindowsCreationMs(child.pid);
      assert.equal(typeof createdAt, 'number', 'test child must expose a snapshot creation time');
      killWindowsProcess(child.pid, { createdAt });
      const [code, signal] = await once(child, 'exit');
      assert.ok(code !== null || signal !== null, 'child must actually exit after TerminateProcess');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  },
);
