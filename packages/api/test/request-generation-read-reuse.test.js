import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerInvocationTrajectoryRoutes } from '../dist/routes/invocation-trajectory-routes.js';

const invocationId = 'private-invocation';
const threadId = 'private-thread';
const userId = 'owner';
const catId = 'codex61-sol';
const digest = `hmac-sha256:${'a'.repeat(64)}`;

function generation(sessionId, ordinal) {
  return {
    v: 1,
    t: ordinal,
    threadId,
    catId,
    sessionId,
    invocationId,
    eventNo: ordinal,
    event: {
      type: 'request_generation_assembled',
      envelope: {
        v: 1,
        invocationId,
        sessionId,
        generationOrdinal: ordinal,
        requestGenerationId: `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`,
        promptGenerationId: digest,
        assembledAt: ordinal,
        continuity: { capability: 'unknown', compactionRefs: [] },
        channels: [
          {
            channel: 'message',
            accuracy: 'exact',
            keyedContentDigest: digest,
            byteLength: Buffer.byteLength('secret-canary'),
            body: 'secret-canary',
            sourceRefs: [],
          },
        ],
        presentations: [],
        runtime: { requested: { provider: 'openai', carrier: 'app_server' }, providerNativeVisibility: 'unknown' },
        tools: { finalSurface: 'unknown' },
        retryBoundary:
          ordinal === 1
            ? { attempt: 1 }
            : {
                attempt: ordinal,
                previousGenerationOrdinal: ordinal - 1,
                reason: 'missing_session',
              },
      },
    },
  };
}

async function setup(t) {
  const app = Fastify();
  t.after(() => app.close());
  const sessions = ['first', 'second', 'empty'].map((id, seq) => ({
    id,
    threadId,
    catId,
    userId,
    seq,
    status: 'active',
  }));
  const state = { reads: 0, extraGeneration: false, missing: false, scopes: [] };
  const events = () =>
    new Map([
      ['first', [generation('first', 1)]],
      ['second', [generation('second', 2), ...(state.extraGeneration ? [generation('second', 3)] : [])]],
      ['empty', []],
    ]);
  registerInvocationTrajectoryRoutes(app, {
    stores: {
      invocationRecordStore: { get: async () => ({ userId, threadId }) },
      turnExecutionStore: { get: async () => ({ userId, threadId, catId, parentInvocationId: 'parent' }) },
      sessionChainStore: {
        getChainByThread: async () => sessions,
        get: async (id) => (state.missing ? null : sessions.find((session) => session.id === id)),
      },
      threadStore: {
        get: async () => ({ id: threadId, createdBy: userId }),
        list: async () => [{ id: threadId, createdBy: userId }],
      },
    },
    listInvocationSummaries: async () => ({ invocations: [], total: 0 }),
    readInvocationEvents: async (scopedSessions) => {
      state.reads += 1;
      state.scopes.push(scopedSessions.map((session) => session.id));
      return events();
    },
  });
  const read = () =>
    app.inject({
      method: 'GET',
      url: `/api/invocations/${invocationId}/request-generations`,
      headers: { 'x-cat-cafe-user': userId },
    });
  return { state, read };
}

function assertGenerations(response, ordinals) {
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.invocationId, invocationId);
  assert.equal(body.threadId, threadId);
  assert.deepEqual(
    body.generations.map(({ envelope }) => envelope.generationOrdinal),
    ordinals,
  );
  assert.deepEqual(
    body.generations.map(({ envelope }) => envelope.sessionId),
    ordinals.map((ordinal) => (ordinal === 1 ? 'first' : 'second')),
  );
  assert.deepEqual(body.gaps, []);
  assert.ok(body.generations.every(({ envelope }) => envelope.channels[0].state === 'redacted'));
  assert.equal(response.body.includes('secret-canary'), false);
}

test('request generations reuse the authorized canonical read across matched sessions', async (t) => {
  const { state, read } = await setup(t);
  assertGenerations(await read(), [1, 2]);
  assert.deepEqual(state.scopes[0], ['first', 'second', 'empty']);
  assert.equal(state.reads, 1, 'one request must not hydrate the same invocation twice');
});

test('a later HTTP request reads fresh events instead of reusing a previous request snapshot', async (t) => {
  const { state, read } = await setup(t);
  assertGenerations(await read(), [1, 2]);
  state.extraGeneration = true;
  assertGenerations(await read(), [1, 2, 3]);
  assert.equal(state.reads, 2, 'each request owns exactly one fresh canonical read');
});

test('a disappeared matched session still fails closed before projecting generations', async (t) => {
  const { state, read } = await setup(t);
  state.missing = true;
  const response = await read();
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, 'INVOCATION_SESSION_CHAIN_CHANGED');
  assert.equal(response.body.includes('secret-canary'), false);
  assert.equal(state.reads, 1);
});
