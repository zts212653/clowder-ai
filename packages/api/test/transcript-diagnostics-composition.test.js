import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import { TranscriptReader } from '../dist/domains/cats/services/session/TranscriptReader.js';
import { TranscriptWriter } from '../dist/domains/cats/services/session/TranscriptWriter.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { InvocationRecordStore } from '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { SessionChainStore } from '../dist/domains/cats/services/stores/ports/SessionChainStore.js';
import { sessionTranscriptRoutes } from '../dist/routes/session-transcript.js';

test('compiled API composition logs one reused process read without transcript bodies or source IDs', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'task229-composition-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const sessionChainStore = new SessionChainStore();
  const invocationRecordStore = new InvocationRecordStore();
  const turnExecutionStore = new InMemoryTurnExecutionStore();
  const writer = new TranscriptWriter({ dataDir });
  const realSnapshot = writer.readBufferedSnapshot.bind(writer);
  writer.readBufferedSnapshot = async (...args) => {
    await delay(120); // Force the actual read report above the finite reporter's threshold.
    return realSnapshot(...args);
  };
  const threadId = 'private-thread-canary';
  const userId = 'owner';
  const catId = 'codex61-sol';
  const parent = await invocationRecordStore.create({
    threadId,
    userId,
    targetCats: [catId],
    intent: 'execute',
    idempotencyKey: 'private-key',
    actionLeaseCarrier: { kind: 'none' },
  });
  const invocationId = 'private-invocation-canary';
  await turnExecutionStore.createRunning({
    invocationId,
    parentInvocationId: parent.invocationId,
    threadId,
    userId,
    catId,
    executionKind: 'ordinary',
    startedAt: 100,
  });
  const session = await sessionChainStore.create({ threadId, catId, userId, cliSessionId: 'private-cli-canary' });
  writer.appendEvent(
    { sessionId: session.id, threadId, catId, seq: session.seq, cliSessionId: session.cliSessionId },
    { type: 'text', content: 'private-body-canary'.repeat(1000) },
    invocationId,
  );
  writer.appendEvent(
    { sessionId: session.id, threadId, catId, seq: session.seq, cliSessionId: session.cliSessionId },
    { type: 'done' },
    invocationId,
  );
  const records = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of String(chunk).trim().split('\n')) {
        const record = JSON.parse(line);
        if (record.msg === '[Task229] transcript read diagnostic') records.push(record);
      }
      callback();
    },
  });
  const app = Fastify({ logger: { stream } });
  t.after(() => app.close());
  await app.register(sessionTranscriptRoutes, {
    sessionChainStore,
    invocationRecordStore,
    turnExecutionStore,
    transcriptReader: new TranscriptReader({ dataDir }),
    transcriptWriter: writer,
    threadStore: {
      get: async () => ({ id: threadId, createdBy: userId }),
      list: async () => [{ id: threadId, createdBy: userId }],
    },
  });
  const response = await app.inject({
    method: 'GET',
    url: `/api/invocations/${invocationId}/request-generations`,
    headers: { 'x-cat-cafe-user': userId, 'request-id': 'request-canary' },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { invocationId, threadId, generations: [], gaps: [] });
  await app.close();
  const reads = records.filter((record) => record.type === 'transcript_read');
  assert.deepEqual(
    reads.map((record) => record.stage),
    ['canonical'],
  );
  assert.ok(
    reads.every((record) => record.rows === 2 && record.sessionCount === 1 && record.requestId === 'request-canary'),
  );
  const settled = records.filter((record) => record.type === 'transcript_worker' && record.phase === 'settled');
  // Fast workers need not be reported individually; coverage still counts the read.
  assert.ok(settled.every((record) => record.started && record.outcome === 'success'));
  const coverage = records.find((record) => record.type === 'transcript_read_coverage_end');
  assert.equal(coverage.observedReads, 1);
  assert.equal(coverage.completedReads, 1);
  assert.equal(coverage.rows, 2);
  assert.equal(coverage.settledWorkers, 1);
  assert.equal(coverage.settledStartedWorkers, 1);
  assert.equal(coverage.processMeasuredWorkers, 1);
  assert.equal(coverage.processMeasurementMissingWorkers, 0);
  assert.ok(coverage.moduleLoadWallMs > 0);
  assert.ok(coverage.operationWallMs > 0);
  assert.ok(coverage.moduleLoadProcessCpuMs >= 0);
  assert.ok(coverage.operationProcessCpuMs >= 0);
  const rendered = JSON.stringify(records);
  for (const canary of [threadId, invocationId, session.id, 'private-cli-canary', 'private-body-canary', dataDir])
    assert.equal(rendered.includes(canary), false);
});
