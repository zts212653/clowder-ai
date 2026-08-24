import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

let resolveCanonicalInvocationTrajectory;
const DIGEST = `hmac-sha256:${'a'.repeat(64)}`;

before(async () => {
  ({ resolveCanonicalInvocationTrajectory } = await import(
    '../dist/domains/cats/services/session/CanonicalInvocationTrajectoryResolver.js'
  ));
});

function generationEnvelope(sessionId, ordinal, generationId) {
  return {
    v: 1,
    invocationId: 'inv-cross-session',
    sessionId,
    generationOrdinal: ordinal,
    requestGenerationId: generationId,
    promptGenerationId: DIGEST,
    assembledAt: 100 + ordinal,
    continuity: { capability: 'unknown', compactionRefs: [] },
    channels: [
      {
        channel: 'message',
        accuracy: 'exact',
        keyedContentDigest: DIGEST,
        byteLength: 1,
        body: String(ordinal),
        sourceRefs: [{ owner: 'message', ref: `thread-1:message-${ordinal}` }],
      },
    ],
    presentations: [],
    runtime: {
      requested: { provider: 'openai', carrier: 'app_server' },
      providerNativeVisibility: 'unknown',
    },
    tools: { finalSurface: 'unknown' },
    retryBoundary:
      ordinal === 1
        ? { attempt: 1 }
        : { attempt: 2, previousGenerationOrdinal: ordinal - 1, reason: 'missing_session' },
  };
}

function transcriptEvent(sessionId, ordinal, generationId) {
  return {
    v: 1,
    t: 100 + ordinal,
    threadId: 'thread-1',
    catId: 'codex-sol',
    sessionId,
    invocationId: 'inv-cross-session',
    eventNo: 0,
    event: {
      type: 'request_generation_assembled',
      envelope: generationEnvelope(sessionId, ordinal, generationId),
    },
  };
}

function dependencies(eventsBySession) {
  return {
    invocationRecordStore: {
      get: async () => ({ id: 'parent-1', userId: 'user-1', threadId: 'thread-1' }),
    },
    turnExecutionStore: {
      get: async () => ({
        invocationId: 'inv-cross-session',
        parentInvocationId: 'parent-1',
        userId: 'user-1',
        threadId: 'thread-1',
        catId: 'codex-sol',
      }),
    },
    sessionChainStore: {
      getChainByThread: async () => [
        {
          id: 'session-1',
          threadId: 'thread-1',
          catId: 'codex-sol',
          userId: 'user-1',
          seq: 0,
          status: 'sealed',
        },
        {
          id: 'session-2',
          threadId: 'thread-1',
          catId: 'codex-sol',
          userId: 'user-1',
          seq: 1,
          status: 'active',
        },
      ],
    },
    threadStore: {
      get: async () => ({ id: 'thread-1', createdBy: 'user-1' }),
      list: async () => [{ id: 'thread-1', createdBy: 'user-1' }],
    },
    readInvocationEvents: async (session) => eventsBySession[session.id] ?? [],
  };
}

describe('F299 canonical request-generation resolver', () => {
  it('resolves one child to an ordered generation-to-Session map instead of returning ambiguity', async () => {
    const result = await resolveCanonicalInvocationTrajectory(
      { invocationId: 'inv-cross-session', userId: 'user-1' },
      dependencies({
        'session-1': [transcriptEvent('session-1', 1, '00000000-0000-4000-8000-000000000001')],
        'session-2': [transcriptEvent('session-2', 2, '00000000-0000-4000-8000-000000000002')],
      }),
    );

    assert.deepEqual(result, {
      status: 200,
      body: {
        invocationId: 'inv-cross-session',
        threadId: 'thread-1',
        sessionId: 'session-1',
        sessionIds: ['session-1', 'session-2'],
        generationSessions: [
          { generationOrdinal: 1, sessionId: 'session-1' },
          { generationOrdinal: 2, sessionId: 'session-2' },
        ],
      },
    });
  });

  it('accepts a hint for any Session in the canonical child chain', async () => {
    const result = await resolveCanonicalInvocationTrajectory(
      { invocationId: 'inv-cross-session', userId: 'user-1', sessionIdHint: 'session-2' },
      dependencies({
        'session-1': [transcriptEvent('session-1', 1, '00000000-0000-4000-8000-000000000001')],
        'session-2': [transcriptEvent('session-2', 2, '00000000-0000-4000-8000-000000000002')],
      }),
    );
    assert.equal(result.status, 200);
  });

  it('keeps legacy multi-Session matches ambiguous when no generation evidence can prove the chain', async () => {
    const legacy = (sessionId) => ({
      v: 1,
      t: 100,
      threadId: 'thread-1',
      catId: 'codex-sol',
      sessionId,
      invocationId: 'inv-cross-session',
      eventNo: 0,
      event: { type: 'done' },
    });
    const result = await resolveCanonicalInvocationTrajectory(
      { invocationId: 'inv-cross-session', userId: 'user-1' },
      dependencies({ 'session-1': [legacy('session-1')], 'session-2': [legacy('session-2')] }),
    );
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'INVOCATION_SESSION_AMBIGUOUS');
  });
});
