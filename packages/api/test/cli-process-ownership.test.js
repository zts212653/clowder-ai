import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createCodexSocketDirectory,
  removeCodexSocketDirectory,
} from '../dist/domains/cats/services/agents/providers/CodexUnixWebSocketSession.js';
import {
  buildUnixProcessSnapshotArgs,
  cliExecutionOwnerRefFromEnvironment,
  createCliExecutionOwnerService,
  decodeLinuxProcEnvironment,
  findOwnedUnixProcesses,
  isValidatedCodexSocketDirectory,
  listLiveCliExecutionOwners,
  parseCliProcessOwnerManifest,
  readUnixProcessSnapshot,
  readUnixProcessSnapshotSync,
  sameUnixProcess,
  signalOwnedUnixProcesses,
  terminateCliExecutionOwner,
} from '../dist/utils/cli-process-ownership.js';

const OWNER_ID = '12345678-1234-4234-8234-123456789abc';
const START = 'Wed Aug 13 01:00:00 2026';

function identity(pid, ppid, pgid, startedAt = START, commandAndEnvironment) {
  return { pid, ppid, pgid, startedAt, ...(commandAndEnvironment ? { commandAndEnvironment } : {}) };
}

test('Linux ownership snapshots leave environment discovery to procfs', () => {
  assert.deepEqual(buildUnixProcessSnapshotArgs(true, undefined, 'linux'), [
    '-ww',
    '-ax',
    '-o',
    'pid=,ppid=,pgid=,lstart=',
  ]);
  assert.deepEqual(buildUnixProcessSnapshotArgs(true, [41, 42], 'linux'), [
    '-ww',
    '-p',
    '41,42',
    '-o',
    'pid=,ppid=,pgid=,lstart=',
  ]);
  assert.deepEqual(buildUnixProcessSnapshotArgs(true, undefined, 'darwin'), [
    'eww',
    '-ax',
    '-o',
    'pid=,ppid=,pgid=,lstart=,command=',
  ]);
});

test('production process snapshots distinguish an empty exact PID set from a reader failure', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Unix process snapshots are unavailable on Windows');
    return;
  }
  const definitelyDeadPid = spawnSync('/usr/bin/true').pid;
  assert.ok(Number.isSafeInteger(definitelyDeadPid));

  assert.deepEqual(readUnixProcessSnapshotSync({ pids: [definitelyDeadPid] }), new Map());
  assert.deepEqual(await readUnixProcessSnapshot({ pids: [definitelyDeadPid] }), new Map());
});

test('Linux procfs environment decoding preserves exact token boundaries', () => {
  assert.equal(
    decodeLinuxProcEnvironment(Buffer.from(`HOME=/tmp\0CAT_CAFE_PROCESS_OWNER_ID=${OWNER_ID}\0TERM=xterm\0`, 'utf8')),
    `HOME=/tmp CAT_CAFE_PROCESS_OWNER_ID=${OWNER_ID} TERM=xterm `,
  );
});

test('production Codex socket directories pass the ownership path validator', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Codex Unix socket ownership is unavailable on Windows');
    return;
  }
  const socketDirectory = createCodexSocketDirectory();
  try {
    assert.equal(isValidatedCodexSocketDirectory(socketDirectory), true);
  } finally {
    await removeCodexSocketDirectory(socketDirectory);
  }
});

test('owner-token projection requires an exact inherited environment token', () => {
  const snapshot = new Map([
    [10, identity(10, 1, 10, START, `node app ${'CAT_CAFE_PROCESS_OWNER_ID'}=${OWNER_ID}`)],
    [11, identity(11, 10, 11, START, `node child ${'CAT_CAFE_PROCESS_OWNER_ID'}=${OWNER_ID}x`)],
    [12, identity(12, 10, 12, START, `node child X${'CAT_CAFE_PROCESS_OWNER_ID'}=${OWNER_ID}`)],
    [13, identity(13, 10, 13, START, `node child ${'CAT_CAFE_PROCESS_OWNER_ID'}=${OWNER_ID} OTHER=1`)],
  ]);

  assert.deepEqual(
    findOwnedUnixProcesses(snapshot, OWNER_ID).map((entry) => entry.pid),
    [10, 13],
  );
});

test('PID reuse fence rejects the same PID with a different start identity', () => {
  const captured = identity(42, 1, 42);
  assert.equal(sameUnixProcess(captured, identity(42, 1, 42)), true);
  assert.equal(sameUnixProcess(captured, identity(42, 1, 42, 'Wed Aug 13 01:00:01 2026')), false);
});

test('group signalling is used only when every live PGID member is owned', () => {
  const owned = [identity(100, 1, 100), identity(101, 100, 100)];
  const safeSnapshot = new Map(owned.map((entry) => [entry.pid, entry]));
  const safeCalls = [];
  assert.equal(
    signalOwnedUnixProcesses(owned, safeSnapshot, 'SIGTERM', (pid) => safeCalls.push(pid)),
    2,
  );
  assert.deepEqual(safeCalls, [-100]);

  const mixedSnapshot = new Map([...safeSnapshot, [102, identity(102, 1, 100)]]);
  const mixedCalls = [];
  assert.equal(
    signalOwnedUnixProcesses(owned, mixedSnapshot, 'SIGTERM', (pid) => mixedCalls.push(pid)),
    2,
  );
  assert.deepEqual(mixedCalls, [100, 101]);
});

test('manifest parsing and socket cleanup paths fail closed', async () => {
  const socketDirectory = createCodexSocketDirectory();
  try {
    const valid = parseCliProcessOwnerManifest({
      v: 1,
      ownerId: OWNER_ID,
      createdAt: Date.now(),
      supervisor: identity(10, 1, 10),
      socketDirectory,
    });
    assert.equal(valid?.socketDirectory, socketDirectory);
    assert.equal(isValidatedCodexSocketDirectory(join(socketDirectory, 'nested')), false);
    assert.equal(
      parseCliProcessOwnerManifest({ ...valid, socketDirectory: join(socketDirectory, '..', 'unrelated') }),
      null,
    );
    assert.equal(parseCliProcessOwnerManifest({ ...valid, ownerId: '../escape' }), null);
  } finally {
    await removeCodexSocketDirectory(socketDirectory);
  }
});

test('owner manifest carries the non-secret parent execution coordinates used after tracker loss', () => {
  const execution = {
    executionId: 'parent-execution-1',
    invocationId: 'turn-invocation-1',
    threadId: 'thread-1',
    catId: 'codex-sol',
    userId: 'scheduler',
  };
  const parsed = parseCliProcessOwnerManifest({
    v: 1,
    ownerId: OWNER_ID,
    createdAt: 1_000,
    supervisor: identity(10, 1, 10),
    execution,
  });

  assert.deepEqual(parsed?.execution, execution);
  assert.equal(parseCliProcessOwnerManifest({ ...parsed, execution: { ...execution, threadId: '' } }), null);
  assert.equal(parseCliProcessOwnerManifest({ ...parsed, execution: { ...execution, callbackToken: 'secret' } }), null);
  assert.deepEqual(
    cliExecutionOwnerRefFromEnvironment({
      CAT_CAFE_EXECUTION_ID: execution.executionId,
      CAT_CAFE_PROCESS_EXECUTION_OWNER: '1',
      CAT_CAFE_INVOCATION_ID: execution.invocationId,
      CAT_CAFE_THREAD_ID: execution.threadId,
      CAT_CAFE_CAT_ID: execution.catId,
      CAT_CAFE_USER_ID: execution.userId,
      CAT_CAFE_CALLBACK_TOKEN: 'must-not-enter-manifest',
    }),
    execution,
  );
  assert.equal(
    cliExecutionOwnerRefFromEnvironment({
      CAT_CAFE_EXECUTION_ID: execution.executionId,
      CAT_CAFE_INVOCATION_ID: execution.invocationId,
      CAT_CAFE_THREAD_ID: execution.threadId,
      CAT_CAFE_CAT_ID: execution.catId,
      CAT_CAFE_USER_ID: execution.userId,
    }),
    undefined,
    'persistent carrier hosts must not be bound to their first invocation',
  );
});

test('tracker-less owner projection and cancellation bind exact execution and process start identity', () => {
  const execution = {
    executionId: 'parent-execution-1',
    invocationId: 'turn-invocation-1',
    threadId: 'thread-1',
    catId: 'codex-sol',
    userId: 'scheduler',
  };
  const liveRecord = {
    path: '/tmp/live-owner.json',
    manifest: {
      v: 1,
      ownerId: OWNER_ID,
      createdAt: 1_000,
      supervisor: identity(10, 1, 10),
      execution,
    },
  };
  const reusedRecord = {
    path: '/tmp/reused-owner.json',
    manifest: {
      ...liveRecord.manifest,
      ownerId: '22345678-1234-4234-8234-123456789abc',
      supervisor: identity(20, 1, 20),
    },
  };
  const siblingRecord = {
    path: '/tmp/sibling-owner.json',
    manifest: {
      ...liveRecord.manifest,
      ownerId: '32345678-1234-4234-8234-123456789abc',
      supervisor: identity(30, 1, 30),
      execution: { ...execution, invocationId: 'turn-invocation-2' },
    },
  };
  const snapshot = new Map([
    [10, identity(10, 1, 10)],
    [20, identity(20, 1, 20, 'Wed Aug 13 01:00:01 2026')],
    [30, identity(30, 1, 30)],
  ]);

  assert.deepEqual(listLiveCliExecutionOwners([liveRecord, reusedRecord, siblingRecord], snapshot), [
    { ...execution, startedAt: 1_000 },
    { ...siblingRecord.manifest.execution, startedAt: 1_000 },
  ]);

  const signals = [];
  assert.deepEqual(
    terminateCliExecutionOwner(execution, [liveRecord, reusedRecord, siblingRecord], snapshot, (pid, signal) =>
      signals.push({ pid, signal }),
    ),
    { matched: 2, signaled: 2, missing: 0, failed: 0 },
  );
  assert.deepEqual(signals, [
    { pid: 10, signal: 'SIGTERM' },
    { pid: 30, signal: 'SIGTERM' },
  ]);

  signals.length = 0;
  assert.deepEqual(
    terminateCliExecutionOwner({ ...execution, catId: 'other-cat' }, [liveRecord], snapshot, (pid, signal) =>
      signals.push({ pid, signal }),
    ),
    { matched: 0, signaled: 0, missing: 0, failed: 0 },
  );
  assert.deepEqual(signals, []);

  assert.deepEqual(
    terminateCliExecutionOwner(execution, [liveRecord], snapshot, () => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    }),
    { matched: 1, signaled: 0, missing: 1, failed: 0 },
  );
  assert.deepEqual(
    terminateCliExecutionOwner(execution, [liveRecord], snapshot, () => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    }),
    { matched: 1, signaled: 0, missing: 0, failed: 1 },
  );
});

test('execution owner service preserves process-table degradation for projection and exact cancel', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cat-cafe-execution-owner-degraded-'));
  const ownerDirectory = join(dataDir, 'cli-process-owners');
  const execution = {
    executionId: 'parent-execution-degraded',
    invocationId: 'turn-invocation-degraded',
    threadId: 'thread-degraded',
    catId: 'codex-sol',
    userId: 'scheduler',
  };
  try {
    await mkdir(ownerDirectory, { recursive: true });
    await writeFile(
      join(ownerDirectory, `${OWNER_ID}.json`),
      JSON.stringify({
        v: 1,
        ownerId: OWNER_ID,
        createdAt: 1_000,
        supervisor: identity(10, 1, 10),
        execution,
      }),
    );
    const service = createCliExecutionOwnerService({
      dataDir,
      readProcessSnapshot: async () => null,
    });

    assert.deepEqual(await service.listLive(), { owners: [], complete: false });
    assert.deepEqual(await service.terminateExact(execution), {
      matched: 0,
      signaled: 0,
      complete: false,
    });

    await writeFile(join(ownerDirectory, 'invalid.json'), '{not-json');
    const signals = [];
    const warnings = [];
    const recoveredService = createCliExecutionOwnerService({
      dataDir,
      readProcessSnapshot: async () => new Map([[10, identity(10, 1, 10)]]),
      kill: (pid, signal) => signals.push({ pid, signal }),
      log: { warn: (bindings, message) => warnings.push({ bindings, message }) },
    });
    assert.deepEqual(await recoveredService.listLive(), {
      owners: [{ ...execution, startedAt: 1_000 }],
      complete: true,
    });
    assert.deepEqual(await recoveredService.terminateExact(execution), {
      matched: 1,
      signaled: 1,
      complete: true,
    });
    assert.deepEqual(signals, [{ pid: 10, signal: 'SIGTERM' }]);
    assert.deepEqual(await readdir(ownerDirectory), [`${OWNER_ID}.json`]);
    assert.equal((await readdir(join(dataDir, 'cli-process-owner-quarantine'))).length, 1);
    assert.equal(warnings.length, 1, 'quarantining malformed control truth must emit an operator-visible warning');

    const deniedService = createCliExecutionOwnerService({
      dataDir,
      readProcessSnapshot: async () => new Map([[10, identity(10, 1, 10)]]),
      kill: () => {
        throw Object.assign(new Error('denied'), { code: 'EPERM' });
      },
    });
    assert.deepEqual(await deniedService.terminateExact(execution), {
      matched: 1,
      signaled: 0,
      complete: false,
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('owner service keeps valid rows non-destructive when malformed manifest quarantine is unavailable', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cat-cafe-execution-owner-quarantine-failure-'));
  const ownerDirectory = join(dataDir, 'cli-process-owners');
  const execution = {
    executionId: 'parent-execution-quarantine-failure',
    invocationId: 'turn-invocation-quarantine-failure',
    threadId: 'thread-quarantine-failure',
    catId: 'codex-sol',
    userId: 'scheduler',
  };
  try {
    await mkdir(ownerDirectory, { recursive: true });
    await writeFile(
      join(ownerDirectory, `${OWNER_ID}.json`),
      JSON.stringify({
        v: 1,
        ownerId: OWNER_ID,
        createdAt: 1_000,
        supervisor: identity(10, 1, 10),
        execution,
      }),
    );
    await writeFile(join(ownerDirectory, 'invalid.json'), '{not-json');
    await writeFile(join(dataDir, 'cli-process-owner-quarantine'), 'not-a-directory');
    const signals = [];
    const service = createCliExecutionOwnerService({
      dataDir,
      readProcessSnapshot: async () => new Map([[10, identity(10, 1, 10)]]),
      kill: (pid, signal) => signals.push({ pid, signal }),
    });

    assert.deepEqual(await service.listLive(), {
      owners: [{ ...execution, startedAt: 1_000 }],
      complete: false,
    });
    assert.deepEqual(await service.terminateExact(execution), { matched: 0, signaled: 0, complete: false });
    assert.deepEqual(signals, []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('owner service converts non-ENOENT manifest directory failures into control-plane degradation', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cat-cafe-execution-owner-read-failure-'));
  try {
    await writeFile(join(dataDir, 'cli-process-owners'), 'not-a-directory');
    const warnings = [];
    const service = createCliExecutionOwnerService({
      dataDir,
      log: { warn: (bindings, message) => warnings.push({ bindings, message }) },
    });

    assert.deepEqual(await service.listLive(), { owners: [], complete: false });
    assert.deepEqual(
      await service.terminateExact({
        executionId: 'unavailable',
        invocationId: 'unavailable',
        threadId: 'thread-unavailable',
        catId: 'codex-sol',
        userId: 'scheduler',
      }),
      { matched: 0, signaled: 0, complete: false },
    );
    assert.equal(warnings.length, 2);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
