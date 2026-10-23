const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { readProjectMirrorsInConsumer } = require('./project-mirror-consumer');

function preload(t, code) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-observability-preload-'));
  const file = path.join(root, 'preload.cjs');
  fs.writeFileSync(file, code);
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--require=${JSON.stringify(file)}`;
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
}

test('each real consumer reports its start and complete settled filesystem result', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-observability-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entries = ['source', 'mirror'].map((kind) => ({ kind, path: path.join(root, kind, 'missing.yaml') }));
  const diagnostics = [];
  const failures = await readProjectMirrorsInConsumer({
    nodeExe: process.execPath,
    entries,
    timeoutMs: 5000,
    attempt: 3,
    onDiagnostic: (event) => diagnostics.push(event),
  });
  assert.equal(failures.length, 2);
  assert.equal(diagnostics.length, 2, 'spawn-only logging must be paired with the completed read result');
  const [started, settled] = diagnostics;
  assert.equal(started.phase, 'started');
  assert.equal(settled.phase, 'settled');
  assert.equal(settled.status, 'read_failed');
  assert.equal(started.attempt, 3);
  assert.equal(settled.attempt, 3);
  assert.equal(settled.pid, started.pid);
  assert.ok(Number.isInteger(settled.pid));
  assert.equal(settled.exitCode, 0);
  assert.equal(settled.signal, null);
  assert.equal(settled.budgetMs, 5000);
  assert.ok(settled.elapsedMs >= started.elapsedMs);
  for (const [index, failure] of settled.failures.entries()) {
    assert.equal(failure.kind, entries[index].kind);
    assert.equal(failure.path, entries[index].path);
    assert.equal(failure.code, 'ENOENT');
    assert.equal(typeof failure.errno, 'number');
    assert.equal(failure.syscall, 'open');
    assert.equal('message' in failure, false);
  }
});

test('ready diagnostics do not expose the readable file contents', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-observability-ready-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'readable.yaml');
  fs.writeFileSync(file, 'DO_NOT_LOG_FILE_BODY');
  const diagnostics = [];
  assert.deepEqual(
    await readProjectMirrorsInConsumer({
      nodeExe: process.execPath,
      entries: [{ kind: 'source', path: file }],
      timeoutMs: 5000,
      onDiagnostic: (event) => diagnostics.push(event),
    }),
    [],
  );
  assert.equal(diagnostics[1].status, 'ready');
  assert.equal(diagnostics[1].entryCount, 1);
  assert.equal(JSON.stringify(diagnostics).includes('DO_NOT_LOG_FILE_BODY'), false);
});

test('spawn failure has paired safe diagnostics without claiming a PID', async () => {
  const diagnostics = [];
  await assert.rejects(
    readProjectMirrorsInConsumer({
      nodeExe: path.join(os.tmpdir(), 'missing-observability-node.exe'),
      entries: [],
      onDiagnostic: (event) => diagnostics.push(event),
    }),
    { code: 'ENOENT' },
  );
  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics[0].status, 'spawn_pending');
  assert.equal(diagnostics[1].status, 'spawn_failed');
  assert.equal(diagnostics[1].pid, null);
  assert.equal(diagnostics[1].error.code, 'ENOENT');
});

for (const [status, code] of [
  ['exited', 'process.stdout.write("DO_NOT_LOG_STDOUT"); process.stderr.write("DO_NOT_LOG_STDERR"); process.exit(23);'],
  ['invalid_output', 'process.stdout.write("DO_NOT_LOG_MALFORMED_OUTPUT"); process.exit(0);'],
]) {
  test(`${status} records safe completion without stdout or arbitrary stderr`, async (t) => {
    preload(t, code);
    const diagnostics = [];
    await assert.rejects(
      readProjectMirrorsInConsumer({
        nodeExe: process.execPath,
        entries: [],
        timeoutMs: 5000,
        onDiagnostic: (event) => diagnostics.push(event),
      }),
      (error) => {
        assert.equal(error.projectMirrorConsumer.status, status);
        assert.equal(error.message.includes('DO_NOT_LOG'), false);
        return true;
      },
    );
    assert.equal(diagnostics.length, 2);
    assert.equal(diagnostics[1].status, status);
    assert.ok(diagnostics[1].stdoutBytes > 0);
    assert.equal(JSON.stringify(diagnostics).includes('DO_NOT_LOG'), false);
  });
}

test('worker-reported paths cannot inject arbitrary diagnostic data', async (t) => {
  const foreign = 'DO_NOT_LOG_FOREIGN_PATH';
  preload(
    t,
    `process.stdout.write(${JSON.stringify(JSON.stringify({ version: 1, failures: [{ kind: 'source', path: foreign, code: 'ENOENT', message: 'DO_NOT_LOG_MESSAGE' }] }))}); process.exit(0);`,
  );
  const diagnostics = [];
  await assert.rejects(
    readProjectMirrorsInConsumer({
      nodeExe: process.execPath,
      entries: [{ kind: 'source', path: path.join(os.tmpdir(), 'known-probe') }],
      timeoutMs: 5000,
      onDiagnostic: (event) => diagnostics.push(event),
    }),
    /Invalid consumer diagnostics/,
  );
  assert.equal(diagnostics[1].status, 'invalid_output');
  assert.equal(JSON.stringify(diagnostics).includes('DO_NOT_LOG'), false);
});
