const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');
const { readProjectMirrorsInConsumer } = require('./project-mirror-consumer');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-consumer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const receipt = path.join(root, 'child.pid');
  const preload = path.join(root, 'hang.cjs');
  fs.writeFileSync(
    preload,
    `require('node:fs').writeFileSync(${JSON.stringify(receipt)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`,
  );
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--require=${JSON.stringify(preload)}`;
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  });
  return receipt;
}

function readOwnedPid(receipt, ownedPid) {
  if (!Number.isSafeInteger(ownedPid) || ownedPid <= 0) return null;
  let text;
  try {
    text = fs.readFileSync(receipt, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return text === String(ownedPid) ? ownedPid : null;
}

function assertExited(receipt, ownedPid) {
  const pid = readOwnedPid(receipt, ownedPid);
  assert.notEqual(pid, null, 'the receipt must identify the actual owned child');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the child must be gone before rejection');
}

test('consumer deadline waits for its owned Node to close before rejecting', async (t) => {
  const receipt = fixture(t);
  const diagnostics = [];
  await assert.rejects(
    readProjectMirrorsInConsumer({
      nodeExe: process.execPath,
      entries: [],
      timeoutMs: 1000,
      onDiagnostic: (event) => diagnostics.push(event),
    }),
    /timed out/,
  );
  assertExited(receipt, diagnostics[0]?.pid);
  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics[1].status, 'timed_out');
  assert.equal(diagnostics[1].signal, 'SIGKILL');
  assert.equal(diagnostics[1].pid, diagnostics[0].pid);
});

test('consumer cancellation waits for a complete owned PID receipt and child close', async (t) => {
  const receipt = fixture(t);
  // A receipt can exist before the writer has emitted its PID bytes.
  fs.writeFileSync(receipt, '');
  const controller = new AbortController();
  const diagnostics = [];
  let ownedPid;
  const reading = readProjectMirrorsInConsumer({
    nodeExe: process.execPath,
    entries: [],
    signal: controller.signal,
    timeoutMs: 3000,
    onSpawn: (pid) => {
      ownedPid = pid;
    },
    onDiagnostic: (event) => diagnostics.push(event),
  });
  const rejected = assert.rejects(reading, /controlled consumer cancellation/);
  try {
    for (let i = 0; i < 200 && readOwnedPid(receipt, ownedPid) === null; i += 1) await delay(10);
    assert.notEqual(readOwnedPid(receipt, ownedPid), null, 'the owned real child must finish its receipt');
  } finally {
    controller.abort(new Error('controlled consumer cancellation'));
    await rejected;
  }
  assertExited(receipt, ownedPid);
  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics[1].status, 'aborted');
  assert.equal(diagnostics[1].pid, diagnostics[0].pid);
});

test('invalid or unrelated PID receipts never reach the liveness probe', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-consumer-receipt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const receipt = path.join(root, 'child.pid');
  const kill = t.mock.method(process, 'kill', () => assert.fail('must not probe an unowned PID'));
  for (const text of ['', '0', '-1', '12junk', String(process.pid + 1)]) {
    fs.writeFileSync(receipt, text);
    assert.throws(() => assertExited(receipt, process.pid), /receipt must identify the actual owned child/);
  }
  fs.writeFileSync(receipt, '0');
  assert.throws(() => assertExited(receipt, 0), /receipt must identify the actual owned child/);
  assert.equal(kill.mock.callCount(), 0);
});

test('a missing consumer executable returns its spawn error without hanging', async () => {
  await assert.rejects(
    readProjectMirrorsInConsumer({
      nodeExe: path.join(os.tmpdir(), 'project-mirror-node-does-not-exist.exe'),
      entries: [],
      timeoutMs: 1000,
    }),
    { code: 'ENOENT' },
  );
});

test('the real consumer returns structured missing-file errors for source and mirror', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-consumer-missing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entries = ['source', 'mirror'].map((kind) => ({
    kind,
    path: path.join(root, kind, 'missing.yaml'),
  }));
  const failures = await readProjectMirrorsInConsumer({ nodeExe: process.execPath, entries, timeoutMs: 5000 });
  assert.equal(failures.length, entries.length);
  for (const [index, failure] of failures.entries()) {
    assert.equal(failure.kind, entries[index].kind);
    assert.equal(failure.path, entries[index].path);
    assert.equal(failure.code, 'ENOENT');
    assert.equal(typeof failure.errno, 'number');
    assert.equal(failure.syscall, 'open');
  }
});
