import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createTranscriptReadDiagnostics } from '../dist/infrastructure/transcript-read-diagnostics.js';
import { registerInvocationTrajectoryRoutes } from '../dist/routes/invocation-trajectory-routes.js';

test('request-generations attributes one canonical read per authorized request without changing the response', async (t) => {
  const session = {
    id: 'private-session',
    threadId: 'private-thread',
    catId: 'codex61-sol',
    userId: 'owner',
    seq: 1,
    status: 'active',
  };
  const events = [
    { v: 1, t: 100, ...session, sessionId: session.id, invocationId: 'inv', eventNo: 0, event: { type: 'done' } },
  ];
  const logs = [];
  const diagnostic = createTranscriptReadDiagnostics({ onEvent: (event) => logs.push(event), slowMs: 0 });
  t.after(() => diagnostic.stop());
  const admissions = [];
  let physicalReads = 0;
  const app = Fastify();
  t.after(() => app.close());
  registerInvocationTrajectoryRoutes(app, {
    stores: {
      invocationRecordStore: { get: async () => ({ id: 'parent', userId: 'owner', threadId: session.threadId }) },
      turnExecutionStore: {
        get: async () => ({
          invocationId: 'inv',
          parentInvocationId: 'parent',
          userId: 'owner',
          threadId: session.threadId,
          catId: session.catId,
        }),
      },
      sessionChainStore: { get: async () => session, getChainByThread: async () => [session] },
      threadStore: {
        get: async () => ({ id: session.threadId, createdBy: 'owner' }),
        list: async () => [{ id: session.threadId, createdBy: 'owner' }],
      },
    },
    listInvocationSummaries: async () => ({ invocations: [], total: 0 }),
    createReadObserver: (requestId, stage) => {
      admissions.push(stage);
      return diagnostic.beginRead(requestId, stage);
    },
    readInvocationEvents: async (sessions, _id, signal, observer) => {
      physicalReads += 1;
      signal?.throwIfAborted();
      observer?.onRead({
        status: 'success',
        sessionCount: sessions.length,
        rows: 1,
        prepareMs: 1,
        workerAwaitMs: 1,
        materializeMs: 1,
        elapsedMs: 3,
        sourceBytesScanned: 10,
        hydratedBytes: 10,
        summaryCacheHits: 0,
      });
      return new Map([[session.id, events]]);
    },
  });
  const denied = await app.inject({
    method: 'GET',
    url: '/api/invocations/inv/request-generations',
    headers: { 'x-cat-cafe-user': 'other' },
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(admissions.length, 0);
  assert.equal(physicalReads, 0);
  const staleHint = await app.inject({
    method: 'GET',
    url: '/api/invocations/inv/request-generations?threadId=foreign',
    headers: { 'x-cat-cafe-user': 'owner' },
  });
  assert.equal(staleHint.statusCode, 409);
  assert.equal(admissions.length, 0);
  assert.equal(physicalReads, 0);
  const ok = await app.inject({
    method: 'GET',
    url: '/api/invocations/inv/request-generations?sessionId=private-session',
    headers: { 'x-cat-cafe-user': 'owner', 'request-id': 'duplicate-client-id' },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(physicalReads, 1);
  assert.deepEqual(admissions, ['canonical']);
  assert.deepEqual(ok.json(), { invocationId: 'inv', threadId: session.threadId, generations: [], gaps: [] });
  assert.deepEqual(
    logs.map((event) => event.stage),
    ['canonical'],
  );
  const next = await app.inject({
    method: 'GET',
    url: '/api/invocations/inv/request-generations?sessionId=private-session',
    headers: { 'x-cat-cafe-user': 'owner', 'request-id': 'duplicate-client-id' },
  });
  assert.equal(next.statusCode, 200);
  assert.deepEqual(next.json(), ok.json());
  assert.equal(physicalReads, 2);
  assert.deepEqual(admissions, ['canonical', 'canonical']);
  assert.deepEqual(
    logs.map((event) => event.stage),
    ['canonical', 'canonical'],
  );
  assert.ok(logs.every((event) => event.requestId === 'duplicate-client-id'));
  assert.notEqual(logs[0].readSequence, logs[1].readSequence);
  assert.equal(JSON.stringify(logs).includes(session.id), false);
  assert.equal(JSON.stringify(logs).includes(session.threadId), false);
});
