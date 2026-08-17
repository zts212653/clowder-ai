import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createCodexSocketDirectory,
  removeCodexSocketDirectory,
} from '../dist/domains/cats/services/agents/providers/CodexUnixWebSocketSession.js';
import {
  buildUnixProcessSnapshotArgs,
  decodeLinuxProcEnvironment,
  findOwnedUnixProcesses,
  isValidatedCodexSocketDirectory,
  parseCliProcessOwnerManifest,
  sameUnixProcess,
  signalOwnedUnixProcesses,
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
