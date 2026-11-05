import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { TranscriptInvocationReader } from '../dist/domains/cats/services/session/transcript-index/TranscriptInvocationReader.js';
import { createTranscriptReadDiagnostics } from '../dist/infrastructure/transcript-read-diagnostics.js';
import { runModuleWorker } from '../dist/utils/run-module-worker.js';

const session = { id: 'private-session', threadId: 'private-thread', catId: 'private-cat', seq: 1, status: 'active' };
const moduleUrl = new URL('./helpers/transcript-pool-blocker.mjs', import.meta.url);

test('file projection observes preparation, the actual shared pool and exit release without copying file data', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'task229-files-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, 'events.live.jsonl'),
    `${JSON.stringify({
      v: 1,
      t: 100,
      sessionId: session.id,
      threadId: session.threadId,
      catId: session.catId,
      eventNo: 0,
      event: { type: 'tool_use', toolName: 'Edit', toolInput: { file_path: 'src/private-file-canary.ts' } },
    })}\n`,
  );
  let preparationFinished = false;
  const reader = new TranscriptInvocationReader(
    { getSessionDir: () => directory },
    {
      readBufferedSnapshot: async () => {
        preparationFinished = true;
        return { events: [], compact: [] };
      },
    },
  );
  const flags = [new SharedArrayBuffer(8), new SharedArrayBuffer(8)];
  const blockers = flags.map((flag) => runModuleWorker({ moduleUrl, exportName: 'held', input: { flag } }));
  const release = () => {
    for (const flag of flags) {
      Atomics.store(new Int32Array(flag), 1, 1);
      Atomics.notify(new Int32Array(flag), 1);
    }
  };
  const reads = [];
  const timings = [];
  let pending;
  try {
    for (let i = 0; i < 2000 && flags.some((flag) => !Atomics.load(new Int32Array(flag), 0)); ++i) await delay(5);
    assert.ok(
      flags.every((flag) => Atomics.load(new Int32Array(flag), 0)),
      'both real shared-pool slots are occupied',
    );
    pending = reader.readFiles({ ...session, status: 'active' }, undefined, {
      onRead: (value) => reads.push(value),
      onWorkerTiming: (value) => timings.push(value),
    });
    await delay(150);
    assert.equal(preparationFinished, true);
    assert.equal(reads.length, 0);
    assert.equal(timings.length, 0, 'file projection remains queued behind these exact occupants');
    release();
    const files = await pending;
    assert.deepEqual(files, [{ path: 'src/private-file-canary.ts', ops: ['edit'] }]);
    assert.equal(reads.length, 1);
    assert.equal(reads[0].status, 'success');
    assert.equal(reads[0].rows, 1);
    assert.ok(reads[0].workerAwaitMs >= 150);
    for (let i = 0; i < 2000 && timings.length < 2; ++i) await delay(5);
    assert.deepEqual(
      timings.map((row) => row.phase),
      ['settled', 'released'],
    );
    assert.equal(timings[0].activeAtAdmission, 2);
    assert.equal(timings[0].started, true);
    assert.ok(timings[0].queueMs >= 100);
    assert.ok(timings[0].processMetrics.moduleLoadWallMs >= 0);
    assert.ok(timings[1].releaseLagMs >= 0);
    const rendered = JSON.stringify({ reads, timings });
    for (const canary of [session.id, session.threadId, directory, 'private-file-canary'])
      assert.equal(rendered.includes(canary), false);
    assert.deepEqual(
      await reader.readFiles(session, undefined, {
        onRead: () => {
          throw new Error('read logging');
        },
        onWorkerTiming: () => {
          throw new Error('worker logging');
        },
      }),
      files,
    );
  } finally {
    release();
    await Promise.allSettled([...blockers, ...(pending ? [pending] : [])]);
  }
});

test('file preparation failure and pre-abort preserve exact errors without inventing child execution', async () => {
  const exact = new Error('buffer drain failed');
  const reader = new TranscriptInvocationReader(
    { getSessionDir: () => '/unused' },
    {
      readBufferedSnapshot: async () => {
        throw exact;
      },
    },
  );
  const reads = [];
  const workers = [];
  const observer = { onRead: (row) => reads.push(row), onWorkerTiming: (row) => workers.push(row) };
  await assert.rejects(
    reader.readFiles({ ...session, status: 'active' }, undefined, observer),
    (error) => error === exact,
  );
  assert.equal(reads.length, 1);
  assert.equal(reads[0].status, 'failed');
  assert.equal(reads[0].workerAwaitMs, 0);
  assert.equal(workers.length, 0);
  const controller = new AbortController();
  controller.abort(exact);
  await assert.rejects(reader.readFiles(session, controller.signal, observer), (error) => error === exact);
  assert.equal(reads.at(-1).status, 'aborted');
  assert.equal(workers.length, 0);
});

test('file diagnostics keep their actual operation and retain the existing bounded report window', () => {
  const events = [];
  const diagnostics = createTranscriptReadDiagnostics({
    operation: 'TranscriptWriter.getFilesTouched',
    onEvent: (event) => events.push(event),
    slowMs: 0,
    maxReports: 1,
  });
  for (let i = 0; i < 2; ++i)
    diagnostics.beginRead('owned-session', 'files').onRead({
      status: 'success',
      sessionCount: 1,
      rows: 0,
      prepareMs: 0,
      workerAwaitMs: 1,
      materializeMs: 0,
      elapsedMs: 1,
      sourceBytesScanned: 0,
      hydratedBytes: 0,
      summaryCacheHits: 0,
    });
  diagnostics.stop();
  assert.ok(events.every((row) => row.operation === 'TranscriptWriter.getFilesTouched'));
  assert.equal(events[0].stage, 'files');
  assert.equal(events.at(-1).observedReads, 2);
  assert.equal(events.at(-1).reportedReads, 1);
  assert.equal(events.at(-1).droppedReads, 1);
});
