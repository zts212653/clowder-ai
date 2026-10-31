import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TranscriptInvocationReader } from '../dist/domains/cats/services/session/transcript-index/TranscriptInvocationReader.js';

test('real indexed read exposes numeric work without retaining transcript coordinates or body', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'task229-transcript-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const session = {
    id: 'private-session',
    threadId: 'private-thread',
    catId: 'private-cat',
    seq: 1,
    status: 'sealed',
  };
  const event = {
    v: 1,
    t: 100,
    ...session,
    sessionId: session.id,
    invocationId: 'private-invocation',
    eventNo: 0,
    event: { type: 'text', content: 'private-body-canary'.repeat(1000) },
  };
  await writeFile(join(directory, 'events.jsonl'), `${JSON.stringify(event)}\n`);
  const reader = new TranscriptInvocationReader({ getSessionDir: () => directory });
  const reads = [];
  const workers = [];
  const observed = await reader.readInvocation([session], 'private-invocation', {}, undefined, {
    onRead: (metrics) => reads.push(metrics),
    onWorkerTiming: (timing) => workers.push(timing),
  });
  assert.equal(reads.length, 1, 'the actual reader must report its own indexed work');
  assert.equal(reads[0].status, 'success');
  assert.equal(reads[0].sessionCount, 1);
  assert.equal(reads[0].rows, 1);
  assert.ok(Number(reads[0].sourceBytesScanned) > 10_000);
  assert.ok(Number(reads[0].hydratedBytes) > 10_000);
  assert.ok(Number(reads[0].workerAwaitMs) >= 0);
  const baseline = await reader.readInvocation([session], 'private-invocation');
  assert.deepEqual(observed, baseline);
  assert.ok(workers.length >= 1);
  const rendered = JSON.stringify({ reads, workers });
  for (const canary of ['private-session', 'private-thread', 'private-invocation', 'private-body-canary', directory])
    assert.equal(rendered.includes(canary), false);
  const failingHooks = {
    onRead: () => {
      throw new Error('read hook');
    },
    onWorkerTiming: () => {
      throw new Error('worker hook');
    },
  };
  assert.deepEqual(await reader.readInvocation([session], 'private-invocation', {}, undefined, failingHooks), baseline);
});
test('preparation failure and aborted read preserve errors and never invent child work', async () => {
  const session = { id: 's', threadId: 't', catId: 'c', seq: 1, status: 'active' };
  const exact = new Error('buffer failure');
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
  const observer = {
    onRead: (metrics) => reads.push(metrics),
    onWorkerTiming: (metrics) => workers.push(metrics),
  };
  await assert.rejects(reader.readInvocation([session], 'i', {}, undefined, observer), (error) => error === exact);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].status, 'failed');
  assert.equal(reads[0].rows, 0);
  assert.equal(workers.length, 0);
  const controller = new AbortController();
  controller.abort(exact);
  await assert.rejects(
    reader.readInvocation([session], 'i', {}, controller.signal, observer),
    (error) => error === exact,
  );
  assert.equal(reads.at(-1)?.status, 'aborted');
  assert.equal(workers.length, 0);
});
