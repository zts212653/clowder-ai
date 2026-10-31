const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const consumer = require('./project-mirror-consumer');
const { PROJECT_MIRROR_PROBES } = require('./project-mirrors');
const { createConsumerDiagnosticEmitter, safeProbeFailure } = require('./project-mirror-diagnostics');

test('optional metadata preserves immutable and primitive cancellation reasons exactly', async () => {
  for (const reason of [Object.freeze(new Error('immutable cancellation')), 'primitive cancellation']) {
    const controller = new AbortController();
    controller.abort(reason);
    await assert.rejects(
      require('./project-mirror-readiness').waitForProjectMirrors({
        signal: controller.signal,
        installRoot: 'unused',
        projectDir: 'unused',
      }),
      (error) => {
        assert.equal(error, reason, 'best-effort diagnostics cannot replace the original cancellation');
        return true;
      },
    );
  }
});

function fixture(t, readConsumer) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-diagnostic-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = {
    installRoot: path.join(root, 'installed'),
    projectDir: path.join(root, 'project'),
    nodeExe: process.execPath,
  };
  for (const base of [options.installRoot, options.projectDir]) {
    for (const { mirror, relativePath } of PROJECT_MIRROR_PROBES) {
      const file = path.join(base, mirror, relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'fixture contents must not be logged');
    }
  }
  const missing = PROJECT_MIRROR_PROBES[0];
  fs.unlinkSync(path.join(options.projectDir, missing.mirror, missing.relativePath));
  t.mock.method(consumer, 'readProjectMirrorsInConsumer', readConsumer);
  const readiness = require.resolve('./project-mirror-readiness');
  delete require.cache[readiness];
  t.after(() => {
    delete require.cache[readiness];
  });
  return { options, wait: require(readiness).waitForProjectMirrors };
}

function reporter(options) {
  return createConsumerDiagnosticEmitter({
    nodeExe: options.nodeExe,
    attempt: options.attempt,
    budgetMs: options.timeoutMs,
    entryCount: options.entries.length,
    onDiagnostic: options.onDiagnostic,
  });
}

test('each completed consumer stays in desktop diagnostics even when the last attempt times out', async (t) => {
  let clock = 1_000_000;
  t.mock.method(Date, 'now', () => clock);
  const { options, wait } = fixture(t, async (request) => {
    const emit = reporter(request);
    emit('started', 'spawned', { pid: 10000 + request.attempt }); // Unit seam; no process is started by this mock.
    if (request.attempt === 1) {
      const entry = request.entries.find((item) => item.kind === 'mirror' && item.mirror === 'docs');
      const failures = [safeProbeFailure(entry, { code: 'ENOENT', errno: -4058, syscall: 'open' })];
      emit('settled', 'read_failed', { pid: 10001, exitCode: 0, failures });
      clock += 1000;
      return failures;
    }
    const error = Object.assign(new Error('arbitrary implementation detail'), { code: 'ETIMEDOUT', syscall: 'read' });
    emit('settled', 'timed_out', { pid: 10002, signal: 'SIGKILL', error });
    clock = 1_005_000; // End the real total-budget loop without a CI scheduling assumption.
    throw error;
  });
  const logs = [];
  await assert.rejects(wait({ ...options, log: (line) => logs.push(line) }), (error) => {
    const metadata = error.projectMirrorDiagnostics;
    assert.equal(metadata.schemaVersion, 1);
    assert.equal(metadata.sourceFailures.length, 0);
    assert.equal(metadata.mirrorFailures.length, 1);
    assert.deepEqual(
      metadata.consumerAttempts.map((event) => event.status),
      ['read_failed', 'timed_out'],
    );
    assert.equal(metadata.consumerAttempts[0].failures[0].code, 'ENOENT');
    assert.equal(metadata.consumerAttempts[0].failures[0].kind, 'mirror');
    assert.match(error.message, /consumer .*code=ETIMEDOUT/);
    return true;
  });
  const prefix = 'Project mirror consumer diagnostic ';
  const events = logs.filter((line) => line.startsWith(prefix)).map((line) => JSON.parse(line.slice(prefix.length)));
  assert.deepEqual(
    events.map((event) => [event.attempt, event.phase]),
    [
      [1, 'started'],
      [1, 'settled'],
      [2, 'started'],
      [2, 'settled'],
    ],
  );
  assert.equal(events[1].failures[0].errno, -4058);
  assert.equal(events[1].failures[0].syscall, 'open');
  assert.equal(logs.join('\n').includes('fixture contents'), false);
  assert.equal(logs.join('\n').includes('arbitrary implementation detail'), false);
});

test('cancellation retains the original reason and completed consumer diagnostics', async (t) => {
  const controller = new AbortController();
  const reason = new Error('controlled history cancellation');
  const { options, wait } = fixture(t, async (request) => {
    const emit = reporter(request);
    emit('started', 'spawned', { pid: 10001 });
    controller.abort(reason);
    emit('settled', 'aborted', { pid: 10001, signal: 'SIGKILL', error: reason });
    throw reason;
  });
  const logs = [];
  await assert.rejects(wait({ ...options, signal: controller.signal, log: (line) => logs.push(line) }), (error) => {
    assert.equal(error, reason);
    assert.equal(error.projectMirrorDiagnostics.consumerAttempts[0].status, 'aborted');
    return true;
  });
  assert.ok(logs.some((line) => line.includes('"phase":"settled"') && line.includes('"status":"aborted"')));
});

test('real consumer results remain complete when a final recovery round has no remaining spawn budget', async (t) => {
  let clock = 2_000_000;
  t.mock.method(Date, 'now', () => clock);
  const { options, wait } = fixture(t, consumer.readProjectMirrorsInConsumer);
  const events = [];
  const logs = [];
  const prefix = 'Project mirror consumer diagnostic ';
  const log = (line) => {
    logs.push(line);
    if (line.startsWith(prefix)) {
      const event = JSON.parse(line.slice(prefix.length));
      events.push(event);
      if (event.phase === 'settled') clock += 1000;
    }
    if (line.startsWith('Project mirror recovery attempt 3:')) clock = 2_005_000;
  };
  await assert.rejects(wait({ ...options, log }), (error) => {
    const settled = events.filter((event) => event.phase === 'settled');
    assert.equal(settled.length, 2, 'two real owned Node processes must settle before the final recovery round');
    assert.deepEqual(error.projectMirrorDiagnostics.consumerAttempts, settled);
    for (const event of settled) {
      assert.ok(
        ['read_failed', 'timed_out'].includes(event.status),
        'persistent failures must never authorize readiness',
      );
      assert.ok(event.pid > 0);
      assert.throws(() => process.kill(event.pid, 0), { code: 'ESRCH' });
      assert.equal(
        events.find((started) => started.phase === 'started' && started.attempt === event.attempt).pid,
        event.pid,
      );
    }
    return true;
  });
  assert.ok(logs.some((line) => line.startsWith('Project mirror recovery attempt 3:')));
  assert.equal(
    events.some((event) => event.attempt === 3),
    false,
  );
});
