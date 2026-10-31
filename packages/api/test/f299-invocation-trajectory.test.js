import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';

function event(invocationId, eventNo, event, t = 1_000 + eventNo) {
  return {
    v: 1,
    t,
    threadId: 'thread-f299',
    catId: 'codex-sol',
    sessionId: 'session-f299',
    invocationId,
    eventNo,
    event,
  };
}

describe('F299 invocation trajectory projector', () => {
  it('projects the real 923-event shape without losing terminal or count evidence', async () => {
    const { projectInvocationTrajectories } = await import(
      '../dist/domains/cats/services/session/InvocationTrajectoryProjector.js'
    );
    const events = [];
    let eventNo = 0;
    events.push(event('inv-large', eventNo++, { type: 'session_init', sessionId: 'cli-1' }));
    for (let i = 0; i < 870; i += 1) {
      events.push(event('inv-large', eventNo++, { type: 'status', content: `step ${i}` }));
    }
    for (let i = 0; i < 23; i += 1) {
      events.push(event('inv-large', eventNo++, { type: 'tool_use', toolName: `Tool${i}`, toolUseId: `tool-${i}` }));
      events.push(
        event('inv-large', eventNo++, {
          type: 'tool_result',
          toolName: `Tool${i}`,
          toolUseId: `tool-${i}`,
          toolResultStatus: 'ok',
        }),
      );
    }
    for (let i = 0; i < 5; i += 1) {
      events.push(event('inv-large', eventNo++, { type: 'text', content: `message ${i}` }));
    }
    events.push(
      event('inv-large', eventNo++, {
        type: 'done',
        metadata: { usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 400 } },
      }),
    );

    assert.equal(events.length, 923);
    const [summary] = projectInvocationTrajectories(events, {
      id: 'session-f299',
      threadId: 'thread-f299',
      catId: 'codex-sol',
      seq: 7,
      status: 'sealed',
      sealReason: 'threshold',
    });

    assert.equal(summary.invocationId, 'inv-large');
    assert.equal(summary.status, 'done');
    assert.equal(summary.eventCount, 923);
    assert.equal(summary.statusEventCount, 870);
    assert.equal(summary.toolUseCount, 23);
    assert.equal(summary.toolResultCount, 23);
    assert.equal(summary.messageCount, 5);
    assert.deepEqual(summary.tokens, { input: 1200, output: 300, cacheRead: 400 });
    assert.equal(summary.sessionSeq, 7);
    assert.equal(summary.sealReason, 'threshold');
  });

  it('uses transcript terminal evidence to distinguish error, cancelled, timeout, and running', async () => {
    const { projectInvocationTrajectories } = await import(
      '../dist/domains/cats/services/session/InvocationTrajectoryProjector.js'
    );
    const events = [
      event('inv-running', 0, { type: 'status', content: 'working' }),
      event('inv-error', 1, { type: 'error', error: 'provider failed' }),
      event('inv-error', 2, { type: 'done' }),
      event('inv-cancelled', 3, { type: 'error', errorCode: 'INVOCATION_CANCELLED', error: 'cancelled' }),
      event('inv-cancelled', 4, { type: 'done' }),
      event('inv-timeout', 5, {
        type: 'system_info',
        content: JSON.stringify({ type: 'timeout_diagnostics', silenceDurationMs: 30_000 }),
      }),
      event('inv-timeout', 6, { type: 'error', error: 'CLI timed out' }),
      event('inv-timeout', 7, { type: 'done' }),
    ];
    const summaries = projectInvocationTrajectories(events, {
      id: 'session-f299',
      threadId: 'thread-f299',
      catId: 'codex-sol',
      seq: 0,
      status: 'active',
    });
    assert.equal(summaries.find((item) => item.invocationId === 'inv-running')?.status, 'running');
    assert.equal(summaries.find((item) => item.invocationId === 'inv-error')?.status, 'error');
    assert.equal(summaries.find((item) => item.invocationId === 'inv-cancelled')?.status, 'cancelled');
    assert.equal(summaries.find((item) => item.invocationId === 'inv-timeout')?.status, 'timeout');
  });
});

describe('F299 active and sealed invocation routes', () => {
  let app;
  let dataDir;

  afterEach(async () => {
    if (app) await app.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    app = undefined;
    dataDir = undefined;
  });

  async function setup({ thread = { id: 'thread-f299', createdBy: 'user-f299' }, threads, indexedUsers = [] } = {}) {
    dataDir = await mkdtemp(join(tmpdir(), 'f299-trajectory-'));
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const { TranscriptWriter } = await import('../dist/domains/cats/services/session/TranscriptWriter.js');
    const { TranscriptReader } = await import('../dist/domains/cats/services/session/TranscriptReader.js');
    const { sessionTranscriptRoutes } = await import('../dist/routes/session-transcript.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { InMemoryTurnExecutionStore } = await import(
      '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
    );
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );
    const sessionChainStore = new SessionChainStore();
    const invocationRecordStore = new InvocationRecordStore();
    const transcriptWriter = new TranscriptWriter({ dataDir });
    const transcriptReader = new TranscriptReader({ dataDir });
    const messageStore = new MessageStore();
    const turnExecutionStore = new InMemoryTurnExecutionStore();
    const availableThreads = threads ?? [thread];
    const threadStore = {
      get: async (id) => availableThreads.find((candidate) => candidate.id === id) ?? null,
      list: async (userId) =>
        availableThreads.filter(
          (candidate) => candidate.createdBy === userId || candidate.id === 'default' || indexedUsers.includes(userId),
        ),
      create: async () => {},
      update: async () => null,
      delete: async () => false,
    };
    app = Fastify();
    await app.register(sessionTranscriptRoutes, {
      sessionChainStore,
      threadStore,
      transcriptReader,
      transcriptWriter,
      messageStore,
      turnExecutionStore,
      invocationRecordStore,
    });
    await app.ready();
    return {
      invocationRecordStore,
      messageStore,
      sessionChainStore,
      transcriptReader,
      transcriptWriter,
      turnExecutionStore,
    };
  }

  async function createInvocationRecord(invocationRecordStore, threadId, userId = 'user-f299') {
    const created = await invocationRecordStore.create({
      threadId,
      userId,
      targetCats: ['codex-sol'],
      intent: 'execute',
      idempotencyKey: `f299-resolve-${threadId}-${userId}-${Math.random()}`,
      actionLeaseCarrier: { kind: 'none' },
    });
    return created.invocationId;
  }

  async function createCanonicalExecution(
    { invocationRecordStore, turnExecutionStore },
    threadId,
    userId = 'user-f299',
    catId = 'codex-sol',
  ) {
    const parentInvocationId = await createInvocationRecord(invocationRecordStore, threadId, userId);
    const invocationId = `turn-${Math.random()}`;
    await turnExecutionStore.createRunning({
      invocationId,
      parentInvocationId,
      threadId,
      userId,
      catId,
      executionKind: 'ordinary',
      startedAt: 1_000,
    });
    return { invocationId, parentInvocationId };
  }

  async function writeTranscriptFile(record, filename, envelopes) {
    const dir = join(dataDir, 'threads', record.threadId, record.catId, 'sessions', record.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, filename), `${envelopes.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf-8');
  }

  function envelope(record, invocationId, eventNo, payload, t = 1_000 + eventNo) {
    return {
      v: 1,
      t,
      threadId: record.threadId,
      catId: record.catId,
      sessionId: record.id,
      cliSessionId: record.cliSessionId,
      invocationId,
      eventNo,
      event: payload,
    };
  }

  it('resolves an invocation to its canonical cross-thread session before opening trajectory', async () => {
    const { invocationRecordStore, sessionChainStore, transcriptWriter, turnExecutionStore } = await setup({
      threads: [
        { id: 'thread-current-page', createdBy: 'user-f299' },
        { id: 'thread-canonical', createdBy: 'user-f299' },
      ],
    });
    const { invocationId } = await createCanonicalExecution(
      { invocationRecordStore, turnExecutionStore },
      'thread-canonical',
    );
    const session = await sessionChainStore.create({
      threadId: 'thread-canonical',
      catId: 'codex-sol',
      userId: 'user-f299',
      cliSessionId: 'cli-canonical',
    });
    transcriptWriter.appendEvent(
      {
        sessionId: session.id,
        threadId: session.threadId,
        catId: session.catId,
        cliSessionId: session.cliSessionId,
        seq: session.seq,
      },
      { type: 'done' },
      invocationId,
    );

    const result = await app.inject({
      method: 'GET',
      url: `/api/invocations/${invocationId}/trajectory`,
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json(), {
      invocationId,
      threadId: 'thread-canonical',
      sessionId: session.id,
    });
  });

  it('resolves a real child invocation through its distinct parent dispatch record', async () => {
    const { invocationRecordStore, sessionChainStore, transcriptWriter, turnExecutionStore } = await setup({
      threads: [
        { id: 'thread-current-page', createdBy: 'user-f299' },
        { id: 'thread-canonical', createdBy: 'user-f299' },
      ],
    });
    const parentInvocationId = await createInvocationRecord(invocationRecordStore, 'thread-canonical');
    const childInvocationId = 'turn-child-distinct-from-parent';
    await turnExecutionStore.createRunning({
      invocationId: childInvocationId,
      parentInvocationId,
      threadId: 'thread-canonical',
      userId: 'user-f299',
      catId: 'codex-sol',
      executionKind: 'ordinary',
      startedAt: 1_000,
    });
    const session = await sessionChainStore.create({
      threadId: 'thread-canonical',
      catId: 'codex-sol',
      userId: 'user-f299',
      cliSessionId: 'cli-canonical-child',
    });
    transcriptWriter.appendEvent(
      {
        sessionId: session.id,
        threadId: session.threadId,
        catId: session.catId,
        cliSessionId: session.cliSessionId,
        seq: session.seq,
      },
      { type: 'done' },
      childInvocationId,
    );

    const list = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-canonical/invocations',
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().invocations[0]?.invocationId, childInvocationId);

    const result = await app.inject({
      method: 'GET',
      url: `/api/invocations/${childInvocationId}/trajectory`,
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json(), {
      invocationId: childInvocationId,
      threadId: 'thread-canonical',
      sessionId: session.id,
    });
  });

  it('projects ordered request generations across replacement Sessions through one invocation route', async () => {
    const { invocationRecordStore, messageStore, sessionChainStore, transcriptWriter, turnExecutionStore } =
      await setup();
    const { invocationId } = await createCanonicalExecution(
      { invocationRecordStore, turnExecutionStore },
      'thread-f299',
    );
    const first = await sessionChainStore.create({
      threadId: 'thread-f299',
      catId: 'codex-sol',
      userId: 'user-f299',
      cliSessionId: 'cli-generation-1',
    });
    const second = await sessionChainStore.create({
      threadId: 'thread-f299',
      catId: 'codex-sol',
      userId: 'user-f299',
      cliSessionId: 'cli-generation-2',
    });
    const availableSource = await messageStore.append(
      canonicalTestMessageInput({
        threadId: 'thread-f299',
        userId: 'user-f299',
        catId: null,
        content: 'available source',
        timestamp: 900,
      }),
    );
    const hardDeletedSource = await messageStore.append(
      canonicalTestMessageInput({
        threadId: 'thread-f299',
        userId: 'user-f299',
        catId: null,
        content: 'hard-deleted source',
        timestamp: 901,
      }),
    );
    await messageStore.hardDelete(hardDeletedSource.id, 'user-f299');
    const sourceIds = [availableSource.id, hardDeletedSource.id];
    const digest = `hmac-sha256:${'a'.repeat(64)}`;
    for (const [index, session] of [first, second].entries()) {
      const ordinal = index + 1;
      const requestGenerationId = `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
      await transcriptWriter.appendDurableEvent(
        {
          sessionId: session.id,
          threadId: session.threadId,
          catId: session.catId,
          cliSessionId: session.cliSessionId,
          seq: session.seq,
        },
        {
          type: 'request_generation_assembled',
          envelope: {
            v: 1,
            invocationId,
            sessionId: session.id,
            generationOrdinal: ordinal,
            requestGenerationId,
            promptGenerationId: digest,
            assembledAt: 1_000 + ordinal,
            continuity: { capability: 'unknown', compactionRefs: [] },
            channels: [
              {
                channel: 'message',
                accuracy: 'exact',
                keyedContentDigest: digest,
                byteLength: 6,
                body: `turn-${ordinal}`,
                sourceRefs: [{ owner: 'message', ref: `thread-f299:${sourceIds[index]}` }],
              },
            ],
            presentations: [],
            runtime: {
              requested: { provider: 'openai', carrier: 'app_server' },
              providerNativeVisibility: 'unknown',
            },
            tools: { finalSurface: 'unknown' },
            retryBoundary:
              ordinal === 1 ? { attempt: 1 } : { attempt: 2, previousGenerationOrdinal: 1, reason: 'missing_session' },
          },
        },
        invocationId,
      );
    }

    const result = await app.inject({
      method: 'GET',
      url: `/api/invocations/${invocationId}/request-generations`,
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });

    assert.equal(result.statusCode, 200);
    assert.deepEqual(
      result.json().generations.map((generation) => ({
        ordinal: generation.envelope.generationOrdinal,
        sessionId: generation.envelope.sessionId,
        state: generation.envelope.channels[0].state,
        ...(generation.envelope.channels[0].body === undefined ? {} : { body: generation.envelope.channels[0].body }),
      })),
      [
        { ordinal: 1, sessionId: first.id, state: 'redacted' },
        { ordinal: 2, sessionId: second.id, state: 'redacted' },
      ],
    );

    const revealed = await app.inject({
      method: 'GET',
      url: `/api/invocations/${invocationId}/request-generations?reveal=exact`,
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });
    assert.equal(revealed.statusCode, 200);
    assert.deepEqual(
      revealed.json().generations.map((generation) => ({
        state: generation.envelope.channels[0].state,
        ...(generation.envelope.channels[0].body === undefined ? {} : { body: generation.envelope.channels[0].body }),
      })),
      [{ state: 'available', body: 'turn-1' }, { state: 'deleted' }],
    );
  });

  it('returns intact later generations with a typed ordinal gap instead of failing the whole route', async () => {
    const { invocationRecordStore, sessionChainStore, transcriptWriter, turnExecutionStore } = await setup();
    const { invocationId } = await createCanonicalExecution(
      { invocationRecordStore, turnExecutionStore },
      'thread-f299',
    );
    const session = await sessionChainStore.create({
      threadId: 'thread-f299',
      catId: 'codex-sol',
      userId: 'user-f299',
      cliSessionId: 'cli-generation-gap',
    });
    const digest = `hmac-sha256:${'a'.repeat(64)}`;
    await transcriptWriter.appendDurableEvent(
      {
        sessionId: session.id,
        threadId: session.threadId,
        catId: session.catId,
        cliSessionId: session.cliSessionId,
        seq: session.seq,
      },
      {
        type: 'request_generation_assembled',
        envelope: {
          v: 1,
          invocationId,
          sessionId: session.id,
          generationOrdinal: 2,
          requestGenerationId: '00000000-0000-4000-8000-000000000002',
          promptGenerationId: digest,
          assembledAt: 1_002,
          continuity: { capability: 'unknown', compactionRefs: [] },
          channels: [
            {
              channel: 'message',
              accuracy: 'exact',
              keyedContentDigest: digest,
              byteLength: 6,
              body: 'turn-2',
              sourceRefs: [],
            },
          ],
          presentations: [],
          runtime: {
            requested: { provider: 'openai', carrier: 'app_server' },
            providerNativeVisibility: 'unknown',
          },
          tools: { finalSurface: 'unknown' },
          retryBoundary: { attempt: 2, previousGenerationOrdinal: 1, reason: 'missing_session' },
        },
      },
      invocationId,
    );

    const result = await app.inject({
      method: 'GET',
      url: `/api/invocations/${invocationId}/request-generations`,
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });

    assert.equal(result.statusCode, 200);
    assert.deepEqual(
      result.json().generations.map((generation) => generation.envelope.generationOrdinal),
      [2],
    );
    assert.deepEqual(result.json().gaps, [
      { kind: 'evidence_gap', fromOrdinal: 1, toOrdinal: 1, state: 'unknown', reason: 'ordinal_gap' },
    ]);
  });

  it('treats evidence thread and session coordinates as fail-closed hints', async () => {
    const { invocationRecordStore, sessionChainStore, transcriptWriter, turnExecutionStore } = await setup();
    const { invocationId } = await createCanonicalExecution(
      { invocationRecordStore, turnExecutionStore },
      'thread-f299',
    );
    const session = await sessionChainStore.create({
      threadId: 'thread-f299',
      catId: 'codex-sol',
      userId: 'user-f299',
      cliSessionId: 'cli-hint',
    });
    transcriptWriter.appendEvent(
      {
        sessionId: session.id,
        threadId: session.threadId,
        catId: session.catId,
        cliSessionId: session.cliSessionId,
        seq: session.seq,
      },
      { type: 'done' },
      invocationId,
    );

    const threadMismatch = await app.inject({
      method: 'GET',
      url: `/api/invocations/${invocationId}/trajectory?threadId=thread-stale`,
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });
    assert.equal(threadMismatch.statusCode, 409);
    assert.equal(threadMismatch.json().code, 'INVOCATION_THREAD_HINT_MISMATCH');

    const sessionMismatch = await app.inject({
      method: 'GET',
      url: `/api/invocations/${invocationId}/trajectory?threadId=thread-f299&sessionId=session-stale`,
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });
    assert.equal(sessionMismatch.statusCode, 409);
    assert.equal(sessionMismatch.json().code, 'INVOCATION_SESSION_HINT_MISMATCH');
  });

  it('returns typed unavailable results for missing canonical records and sessions', async () => {
    const { invocationRecordStore, turnExecutionStore } = await setup();
    const missingRecord = await app.inject({
      method: 'GET',
      url: '/api/invocations/inv-missing/trajectory',
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });
    assert.equal(missingRecord.statusCode, 404);
    assert.equal(missingRecord.json().code, 'INVOCATION_RECORD_NOT_FOUND');

    const { invocationId } = await createCanonicalExecution(
      { invocationRecordStore, turnExecutionStore },
      'thread-f299',
    );
    const missingSession = await app.inject({
      method: 'GET',
      url: `/api/invocations/${invocationId}/trajectory`,
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });
    assert.equal(missingSession.statusCode, 404);
    assert.equal(missingSession.json().code, 'INVOCATION_SESSION_NOT_FOUND');

    await turnExecutionStore.createRunning({
      invocationId: 'turn-parent-missing',
      parentInvocationId: 'parent-missing',
      threadId: 'thread-f299',
      userId: 'user-f299',
      catId: 'codex-sol',
      executionKind: 'ordinary',
      startedAt: 1_001,
    });
    const missingParent = await app.inject({
      method: 'GET',
      url: '/api/invocations/turn-parent-missing/trajectory',
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });
    assert.equal(missingParent.statusCode, 404);
    assert.equal(missingParent.json().code, 'INVOCATION_PARENT_RECORD_NOT_FOUND');
  });

  it('fails closed when the exact child and parent dispatch identity disagree', async () => {
    const { invocationRecordStore, turnExecutionStore } = await setup({
      threads: [
        { id: 'thread-f299', createdBy: 'user-f299' },
        { id: 'thread-other', createdBy: 'user-f299' },
      ],
    });
    const parentInvocationId = await createInvocationRecord(invocationRecordStore, 'thread-other');
    await turnExecutionStore.createRunning({
      invocationId: 'turn-parent-mismatch',
      parentInvocationId,
      threadId: 'thread-f299',
      userId: 'user-f299',
      catId: 'codex-sol',
      executionKind: 'ordinary',
      startedAt: 1_002,
    });

    const result = await app.inject({
      method: 'GET',
      url: '/api/invocations/turn-parent-mismatch/trajectory',
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });

    assert.equal(result.statusCode, 409);
    assert.equal(result.json().code, 'INVOCATION_RECORD_INTEGRITY_MISMATCH');
  });

  it('rejects foreign records and filters user-indexed system-thread sessions by current user', async () => {
    const { invocationRecordStore, sessionChainStore, transcriptWriter, turnExecutionStore } = await setup({
      thread: { id: 'thread-f299', createdBy: 'system' },
      indexedUsers: ['user-f299', 'other-user'],
    });
    const { invocationId: ownerInvocationId } = await createCanonicalExecution(
      { invocationRecordStore, turnExecutionStore },
      'thread-f299',
    );
    const { invocationId: foreignInvocationId } = await createCanonicalExecution(
      { invocationRecordStore, turnExecutionStore },
      'thread-f299',
      'other-user',
      'opus',
    );
    const ownerSession = await sessionChainStore.create({
      threadId: 'thread-f299',
      catId: 'codex-sol',
      userId: 'user-f299',
      cliSessionId: 'cli-system-owner',
    });
    const foreignSession = await sessionChainStore.create({
      threadId: 'thread-f299',
      catId: 'opus',
      userId: 'other-user',
      cliSessionId: 'cli-system-foreign',
    });
    for (const [session, invocationId] of [
      [ownerSession, ownerInvocationId],
      [foreignSession, foreignInvocationId],
    ]) {
      transcriptWriter.appendEvent(
        {
          sessionId: session.id,
          threadId: session.threadId,
          catId: session.catId,
          cliSessionId: session.cliSessionId,
          seq: session.seq,
        },
        { type: 'done' },
        invocationId,
      );
    }

    const owner = await app.inject({
      method: 'GET',
      url: `/api/invocations/${ownerInvocationId}/trajectory`,
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });
    assert.equal(owner.statusCode, 200);
    assert.equal(owner.json().sessionId, ownerSession.id);

    const foreign = await app.inject({
      method: 'GET',
      url: `/api/invocations/${foreignInvocationId}/trajectory`,
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });
    assert.equal(foreign.statusCode, 403);
    assert.equal(foreign.json().code, 'INVOCATION_RECORD_ACCESS_DENIED');
    assert.equal(JSON.stringify(foreign.json()).includes(foreignSession.id), false);
  });

  it('keeps an owned invocation inaccessible when its system thread is not user-indexed', async () => {
    const { invocationRecordStore, turnExecutionStore } = await setup({
      thread: { id: 'thread-f299', createdBy: 'system' },
      indexedUsers: [],
    });
    const { invocationId } = await createCanonicalExecution(
      { invocationRecordStore, turnExecutionStore },
      'thread-f299',
    );

    const result = await app.inject({
      method: 'GET',
      url: `/api/invocations/${invocationId}/trajectory`,
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });

    assert.equal(result.statusCode, 403);
    assert.equal(result.json().code, 'THREAD_ACCESS_DENIED');
    assert.equal(result.json().reason, 'not_visible_to_user');
  });

  it('reads only the current user subset from a user-indexed system thread', async () => {
    const { sessionChainStore, transcriptWriter } = await setup({
      thread: { id: 'thread-f299', createdBy: 'system' },
      indexedUsers: ['user-f299'],
    });
    const ownerSession = await sessionChainStore.create({
      threadId: 'thread-f299',
      catId: 'codex-sol',
      userId: 'user-f299',
      cliSessionId: 'cli-indexed-owner',
    });
    const otherSession = await sessionChainStore.create({
      threadId: 'thread-f299',
      catId: 'opus',
      userId: 'other-user',
      cliSessionId: 'cli-indexed-other',
    });
    const ownerInfo = {
      sessionId: ownerSession.id,
      threadId: ownerSession.threadId,
      catId: ownerSession.catId,
      cliSessionId: ownerSession.cliSessionId,
      seq: ownerSession.seq,
    };
    const otherInfo = {
      sessionId: otherSession.id,
      threadId: otherSession.threadId,
      catId: otherSession.catId,
      cliSessionId: otherSession.cliSessionId,
      seq: otherSession.seq,
    };
    transcriptWriter.appendEvent(ownerInfo, { type: 'text', content: 'shared needle owner' }, 'inv-indexed-owner');
    transcriptWriter.appendEvent(otherInfo, { type: 'text', content: 'shared needle other' }, 'inv-indexed-other');

    const list = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-f299/invocations',
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(
      list.json().invocations.map((item) => item.invocationId),
      ['inv-indexed-owner'],
    );

    const ownEvents = await app.inject({
      method: 'GET',
      url: `/api/sessions/${ownerSession.id}/events`,
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });
    assert.equal(ownEvents.statusCode, 200);

    const foreignDetail = await app.inject({
      method: 'GET',
      url: `/api/sessions/${otherSession.id}/invocations/inv-indexed-other`,
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });
    assert.equal(foreignDetail.statusCode, 403);
    assert.equal(foreignDetail.json().code, 'THREAD_RECORD_ACCESS_DENIED');

    await transcriptWriter.flush(ownerInfo);
    await transcriptWriter.flush(otherInfo);
    const search = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-f299/sessions/search?q=needle',
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });
    assert.equal(search.statusCode, 200);
    assert.deepEqual([...new Set(search.json().hits.map((hit) => hit.sessionId))], [ownerSession.id]);
  });

  it('lists and drills an active invocation from the existing writer buffer', async () => {
    const { sessionChainStore, transcriptWriter } = await setup();
    const record = await sessionChainStore.create({
      threadId: 'thread-f299',
      catId: 'codex-sol',
      userId: 'user-f299',
      cliSessionId: 'cli-active',
    });
    const info = {
      sessionId: record.id,
      threadId: record.threadId,
      catId: record.catId,
      cliSessionId: record.cliSessionId,
      seq: record.seq,
    };
    transcriptWriter.appendEvent(info, { type: 'status', content: 'running tests' }, 'inv-active');
    transcriptWriter.appendEvent(info, { type: 'tool_use', toolName: 'Bash', toolUseId: 'tool-1' }, 'inv-active');

    const list = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-f299/invocations',
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });
    assert.equal(list.statusCode, 200);
    const listBody = list.json();
    assert.equal(listBody.invocations.length, 1);
    assert.equal(listBody.invocations[0].invocationId, 'inv-active');
    assert.equal(listBody.invocations[0].status, 'running');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/invocations/inv-active`,
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().events.length, 2);
    assert.equal(detail.json().summary.invocationId, 'inv-active');
  });

  it('hydrates only the covered canonical trigger with typed available, deleted, invisible, and missing states', async () => {
    const { messageStore, sessionChainStore, transcriptWriter, turnExecutionStore } = await setup();
    const record = await sessionChainStore.create({
      threadId: 'thread-f299',
      catId: 'codex-sol',
      userId: 'user-f299',
      cliSessionId: 'cli-prompt-input',
    });
    const info = {
      sessionId: record.id,
      threadId: record.threadId,
      catId: record.catId,
      cliSessionId: record.cliSessionId,
      seq: record.seq,
    };
    const available = await messageStore.append(
      canonicalTestMessageInput({
        threadId: 'thread-f299',
        userId: 'user-f299',
        catId: null,
        content: 'canonical user request',
        timestamp: 900,
      }),
    );
    const deleted = await messageStore.append(
      canonicalTestMessageInput({
        threadId: 'thread-f299',
        userId: 'user-f299',
        catId: null,
        content: 'must not survive deletion',
        timestamp: 901,
      }),
    );
    await messageStore.softDelete(deleted.id, 'user-f299');
    const invisible = await messageStore.append(
      canonicalTestMessageInput({
        threadId: 'thread-f299',
        userId: 'other-user',
        catId: null,
        content: 'foreign body must not leak',
        timestamp: 902,
      }),
    );
    const context = await messageStore.append(
      canonicalTestMessageInput({
        threadId: 'thread-f299',
        userId: 'user-f299',
        catId: 'opus',
        content: 'covered prompt context must not be presented as the trigger',
        timestamp: 903,
      }),
    );
    const cases = [
      {
        invocationId: 'inv-prompt-available',
        triggerMessageId: available.id,
        expected: {
          messageId: available.id,
          status: 'available',
          author: 'user',
          excerpt: 'canonical user request',
        },
      },
      {
        invocationId: 'inv-prompt-deleted',
        triggerMessageId: deleted.id,
        expected: { messageId: deleted.id, status: 'deleted' },
      },
      {
        invocationId: 'inv-prompt-invisible',
        triggerMessageId: invisible.id,
        expected: { messageId: invisible.id, status: 'invisible' },
      },
      {
        invocationId: 'inv-prompt-missing',
        triggerMessageId: 'message-missing',
        expected: { messageId: 'message-missing', status: 'missing' },
      },
    ];
    for (const [index, fixture] of cases.entries()) {
      await turnExecutionStore.createRunning({
        invocationId: fixture.invocationId,
        parentInvocationId: 'parent-prompt-input',
        threadId: 'thread-f299',
        userId: 'user-f299',
        catId: 'codex-sol',
        executionKind: 'ordinary',
        startedAt: 1_000 + index,
        causal: {
          triggerMessageId: fixture.triggerMessageId,
          coveredMessageIds: [fixture.triggerMessageId, context.id],
        },
      });
      transcriptWriter.appendEvent(info, { type: 'text', content: 'answer' }, fixture.invocationId);
      const detail = await app.inject({
        method: 'GET',
        url: `/api/sessions/${record.id}/invocations/${fixture.invocationId}`,
        headers: { 'x-cat-cafe-user': 'user-f299' },
      });
      assert.equal(detail.statusCode, 200);
      assert.deepEqual(detail.json().promptInput, { status: 'available', messages: [fixture.expected] });
      assert.equal(
        JSON.stringify(detail.json().promptInput).includes(
          'covered prompt context must not be presented as the trigger',
        ),
        false,
      );
    }
    const serialized = JSON.stringify(
      (
        await app.inject({
          method: 'GET',
          url: `/api/sessions/${record.id}/invocations/inv-prompt-invisible`,
          headers: { 'x-cat-cafe-user': 'user-f299' },
        })
      ).json().promptInput,
    );
    assert.equal(serialized.includes('foreign body must not leak'), false);
    assert.equal(serialized.includes('must not survive deletion'), false);
  });

  it('fails closed when the trigger was not covered or execution scope does not match the session', async () => {
    const { messageStore, sessionChainStore, transcriptWriter, turnExecutionStore } = await setup();
    const record = await sessionChainStore.create({
      threadId: 'thread-f299',
      catId: 'codex-sol',
      userId: 'user-f299',
      cliSessionId: 'cli-prompt-scope',
    });
    const trigger = await messageStore.append(
      canonicalTestMessageInput({
        threadId: 'thread-f299',
        userId: 'user-f299',
        catId: null,
        content: 'canonical trigger',
        timestamp: 910,
      }),
    );
    const context = await messageStore.append(
      canonicalTestMessageInput({
        threadId: 'thread-f299',
        userId: 'user-f299',
        catId: 'opus',
        content: 'context only',
        timestamp: 911,
      }),
    );
    const info = {
      sessionId: record.id,
      threadId: record.threadId,
      catId: record.catId,
      cliSessionId: record.cliSessionId,
      seq: record.seq,
    };
    await turnExecutionStore.createRunning({
      invocationId: 'inv-trigger-not-covered',
      parentInvocationId: 'parent-prompt-input',
      threadId: 'thread-f299',
      userId: 'user-f299',
      catId: 'codex-sol',
      executionKind: 'ordinary',
      startedAt: 1_100,
      causal: { triggerMessageId: trigger.id, coveredMessageIds: [context.id] },
    });
    await turnExecutionStore.createRunning({
      invocationId: 'inv-scope-mismatch',
      parentInvocationId: 'parent-prompt-input',
      threadId: 'thread-foreign',
      userId: 'user-f299',
      catId: 'codex-sol',
      executionKind: 'ordinary',
      startedAt: 1_101,
      causal: { triggerMessageId: trigger.id, coveredMessageIds: [trigger.id] },
    });
    transcriptWriter.appendEvent(info, { type: 'text', content: 'answer' }, 'inv-trigger-not-covered');
    transcriptWriter.appendEvent(info, { type: 'text', content: 'answer' }, 'inv-scope-mismatch');

    const notCovered = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/invocations/inv-trigger-not-covered`,
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });
    assert.deepEqual(notCovered.json().promptInput, {
      status: 'unavailable',
      reason: 'trigger_message_not_covered',
      messages: [],
    });
    const mismatch = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/invocations/inv-scope-mismatch`,
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });
    assert.deepEqual(mismatch.json().promptInput, {
      status: 'unavailable',
      reason: 'execution_scope_mismatch',
      messages: [],
    });
  });

  it('lists and drills a sealed invocation from the canonical transcript', async () => {
    const { sessionChainStore, transcriptWriter } = await setup();
    const record = await sessionChainStore.create({
      threadId: 'thread-f299',
      catId: 'codex-sol',
      userId: 'user-f299',
      cliSessionId: 'cli-sealed',
    });
    const info = {
      sessionId: record.id,
      threadId: record.threadId,
      catId: record.catId,
      cliSessionId: record.cliSessionId,
      seq: record.seq,
    };
    transcriptWriter.appendEvent(info, { type: 'text', content: 'sealed answer' }, 'inv-sealed');
    transcriptWriter.appendEvent(info, { type: 'done' }, 'inv-sealed');
    const sealedAt = Date.now();
    await transcriptWriter.flush(info, {
      createdAt: record.createdAt,
      sealedAt,
      sealReason: 'threshold',
    });
    await sessionChainStore.update(record.id, {
      status: 'sealed',
      sealedAt,
      sealReason: 'threshold',
    });

    const list = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-f299/invocations',
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().invocations[0].status, 'done');
    assert.equal(list.json().invocations[0].sessionStatus, 'sealed');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/invocations/inv-sealed`,
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().events.length, 2);
    assert.equal(detail.json().summary.sealReason, 'threshold');
  });

  it('uses durable restart terminal truth in both history and detail without manufacturing transcript events', async () => {
    const stores = await setup();
    const { invocationId } = await createCanonicalExecution(stores, 'thread-f299');
    const record = await stores.sessionChainStore.create({
      threadId: 'thread-f299',
      catId: 'codex-sol',
      userId: 'user-f299',
      cliSessionId: 'cli-restart',
    });
    await writeTranscriptFile(record, 'events.live.jsonl', [
      envelope(record, invocationId, 0, { type: 'session_init' }, 1_100),
    ]);
    await stores.turnExecutionStore.interruptRunningBefore(1_500, {
      endedAt: 2_000,
      terminalReason: 'process_restart',
    });
    const list = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-f299/invocations',
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });
    const detail = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/invocations/${invocationId}`,
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });
    assert.equal(list.statusCode, 200);
    assert.equal(detail.statusCode, 200);
    for (const summary of [list.json().invocations[0], detail.json().summary]) {
      assert.equal(summary.status, 'error');
      assert.equal(summary.terminalReason, 'process_restart');
      assert.equal(summary.startedAt, 1_000);
      assert.equal(summary.endedAt, 2_000);
      assert.equal(summary.durationMs, 1_000);
      assert.equal(summary.eventCount, 1);
      assert.equal(summary.errorCount, 0);
    }
    assert.deepEqual(
      detail.json().events.map((item) => item.event.type),
      ['session_init'],
    );
  });

  for (const [terminalStatus, reason, expectedStatus] of [
    ['failed', 'provider_error', 'error'],
    ['failed', 'cli_timeout', 'timeout'],
    ['canceled', 'operator_cancelled', 'cancelled'],
    ['succeeded', undefined, 'done'],
  ]) {
    it(`keeps list and detail consistent with durable ${terminalStatus}/${reason} despite conflicting transcript terminal`, async () => {
      const stores = await setup();
      const { invocationId } = await createCanonicalExecution(stores, 'thread-f299');
      const record = await stores.sessionChainStore.create({
        threadId: 'thread-f299',
        catId: 'codex-sol',
        userId: 'user-f299',
        cliSessionId: 'cli-terminal',
      });
      await writeTranscriptFile(record, 'events.live.jsonl', [
        envelope(
          record,
          invocationId,
          0,
          terminalStatus === 'succeeded' ? { type: 'error', error: 'earlier failure' } : { type: 'done' },
          1_100,
        ),
      ]);
      await stores.turnExecutionStore.transitionTerminal(invocationId, {
        status: terminalStatus,
        endedAt: 2_000,
        ...(reason ? { terminalReason: reason } : {}),
      });
      const headers = { 'x-cat-cafe-user': 'user-f299' };
      const list = await app.inject({ method: 'GET', url: '/api/threads/thread-f299/invocations', headers });
      const detail = await app.inject({
        method: 'GET',
        url: `/api/sessions/${record.id}/invocations/${invocationId}`,
        headers,
      });
      assert.equal(list.statusCode, 200);
      assert.equal(detail.statusCode, 200);
      for (const summary of [list.json().invocations[0], detail.json().summary]) {
        assert.equal(summary.status, expectedStatus);
        assert.equal(summary.terminalReason, reason);
        assert.equal(summary.endedAt, 2_000);
      }
    });
  }

  for (const [sealReason, eventCount, endedOffset] of [
    ['threshold', 132, 595_619],
    ['threshold', 390, 2_671_300],
    ['budget_exhausted', 51, 356_973],
  ]) {
    it(`reconciles the #1580 sealed ${sealReason}/${eventCount} shape without changing its archive or usage`, async () => {
      const stores = await setup();
      const { invocationId } = await createCanonicalExecution(stores, 'thread-f299');
      const record = await stores.sessionChainStore.create({
        threadId: 'thread-f299',
        catId: 'codex-sol',
        userId: 'user-f299',
        cliSessionId: 'sealed-fixture',
      });
      const events = Array.from({ length: eventCount - 2 }, (_, index) =>
        envelope(record, invocationId, index, {
          type: 'status',
          content: 'working',
          ...(index === 0 ? { metadata: { usage: { inputTokens: 30, outputTokens: 7 } } } : {}),
        }),
      );
      events.push(
        envelope(
          record,
          invocationId,
          eventCount - 2,
          {
            type: 'request_generation_terminal',
            requestGenerationId: '00000000-0000-4000-8000-000000000001',
            generationOrdinal: 1,
            terminalAt: endedOffset,
            outcome: 'accepted',
          },
          endedOffset,
        ),
        envelope(
          record,
          invocationId,
          eventCount - 1,
          {
            type: 'system_info',
            content: JSON.stringify({ type: 'session_seal_requested', reason: sealReason }),
          },
          endedOffset + 1,
        ),
      );
      await writeTranscriptFile(record, 'events.jsonl', events);
      await stores.sessionChainStore.update(record.id, { status: 'sealed', sealedAt: endedOffset + 2, sealReason });
      const archive = join(dataDir, 'threads', record.threadId, record.catId, 'sessions', record.id, 'events.jsonl');
      const original = await readFile(archive, 'utf8');
      const headers = { 'x-cat-cafe-user': 'user-f299' };
      // Populate the transcript index before the durable terminal arrives.
      const before = await app.inject({ method: 'GET', url: '/api/threads/thread-f299/invocations', headers });
      assert.equal(before.json().invocations[0].status, 'running');
      await stores.turnExecutionStore.transitionTerminal(invocationId, {
        status: 'succeeded',
        endedAt: 1_000 + endedOffset,
      });
      const list = await app.inject({ method: 'GET', url: '/api/threads/thread-f299/invocations', headers });
      const detail = await app.inject({
        method: 'GET',
        url: `/api/sessions/${record.id}/invocations/${invocationId}`,
        headers,
      });
      for (const summary of [list.json().invocations[0], detail.json().summary]) {
        assert.equal(summary.status, 'done');
        assert.equal(summary.eventCount, eventCount);
        assert.equal(summary.endedAt, 1_000 + endedOffset);
        assert.equal(summary.sealReason, sealReason);
        assert.deepEqual(summary.tokens, { input: 30, output: 7 });
      }
      assert.deepEqual(detail.json().events, events);
      assert.equal(await readFile(archive, 'utf8'), original);
    });
  }

  function crossSessionEvents(record, invocationId, index) {
    const terminal = {
      type: 'request_generation_terminal',
      requestGenerationId: `00000000-0000-4000-8000-00000000000${index + 1}`,
      generationOrdinal: index + 1,
      terminalAt: 2_000 + index,
      outcome: index === 0 ? 'replaced' : 'error',
      ...(index === 1 ? { reason: 'provider_error' } : {}),
    };
    const payloads =
      index === 0
        ? [{ type: 'status', content: 'old segment' }, terminal]
        : [terminal, { type: 'error', errorCode: 'model_not_found' }, { type: 'done' }];
    return payloads.map((payload, eventNo) => envelope(record, invocationId, eventNo, payload));
  }

  for (const [ledger, terminal, statuses] of [
    ['failed', { status: 'failed', terminalReason: 'model_not_found' }, ['error', 'error']],
    ['succeeded', { status: 'succeeded' }, ['done', 'done']],
    ['missing', undefined, ['running', 'error']],
    ['running', undefined, ['running', 'error']],
    ['foreign', undefined, ['running', 'error']],
  ]) {
    it(`preserves both #1580 cross-session audit segments with a ${ledger} child`, async () => {
      const stores = await setup();
      const { invocationId, parentInvocationId } = await createCanonicalExecution(stores, 'thread-f299');
      const records = [];
      const segments = [];
      for (const index of [0, 1]) {
        const record = await stores.sessionChainStore.create({
          threadId: 'thread-f299',
          catId: 'codex-sol',
          userId: 'user-f299',
          cliSessionId: `cross-session-${index}`,
        });
        records.push(record);
        const events = crossSessionEvents(record, invocationId, index);
        segments.push(events);
        await writeTranscriptFile(record, 'events.jsonl', events);
        await stores.sessionChainStore.update(record.id, {
          status: 'sealed',
          sealedAt: 3_000,
          sealReason: ['cli_session_replaced', 'threshold'][index],
        });
      }
      // The report does not supply D's child terminal. These are conditional
      // fixtures; neither the parent nor the sealed sessions establish it.
      await stores.invocationRecordStore.update(parentInvocationId, { status: 'running' });
      await stores.invocationRecordStore.update(parentInvocationId, { status: 'succeeded' });
      const own = await stores.turnExecutionStore.get(invocationId);
      if (terminal) {
        await stores.turnExecutionStore.transitionTerminal(invocationId, { ...terminal, endedAt: 4_000 });
      } else if (ledger !== 'running') {
        stores.turnExecutionStore.get = async () =>
          ledger === 'missing'
            ? null
            : {
                ...own,
                userId: 'foreign-user',
                status: 'succeeded',
                endedAt: 4_000,
                terminalReason: 'private_reason',
              };
      }
      const headers = { 'x-cat-cafe-user': 'user-f299' };
      const list = await app.inject({ method: 'GET', url: '/api/threads/thread-f299/invocations', headers });
      assert.equal(list.statusCode, 200);
      assert.equal(list.json().invocations.length, 2);
      for (const [index, record] of records.entries()) {
        const row = list.json().invocations.find((summary) => summary.sessionId === record.id);
        const detail = await app.inject({
          method: 'GET',
          url: `/api/sessions/${record.id}/invocations/${invocationId}`,
          headers,
        });
        assert.equal(detail.statusCode, 200);
        assert.equal(row.status, statuses[index]);
        assert.deepEqual(detail.json().summary, row);
        assert.deepEqual(detail.json().events, segments[index]);
        assert.equal(row.eventCount, segments[index].length);
        assert.notEqual(row.terminalReason, 'private_reason');
      }
    });
  }

  it('keeps scoped lifecycle semantics on the real list/detail consumers', async () => {
    const stores = await setup();
    const { invocationId } = await createCanonicalExecution(stores, 'thread-f299');
    const record = await stores.sessionChainStore.create({
      threadId: 'thread-f299',
      catId: 'codex-sol',
      userId: 'user-f299',
      scopedInvocation: { executionScope: 'collective-participation', invocationId, originMessageId: 'fixture-origin' },
    });
    await writeTranscriptFile(record, 'events.live.jsonl', [envelope(record, invocationId, 0, { type: 'done' })]);
    const headers = { 'x-cat-cafe-user': 'user-f299' };
    const read = async () => {
      const list = await app.inject({ method: 'GET', url: '/api/threads/thread-f299/invocations', headers });
      const detail = await app.inject({
        method: 'GET',
        url: `/api/sessions/${record.id}/invocations/${invocationId}`,
        headers,
      });
      assert.equal(list.statusCode, 200);
      assert.equal(detail.statusCode, 200);
      const { durationMs: _listDuration, ...listed } = list.json().invocations[0];
      const { durationMs: _detailDuration, ...drilled } = detail.json().summary;
      assert.deepEqual(listed, drilled);
      return detail.json().summary;
    };
    assert.equal((await read()).status, 'running');
    await stores.turnExecutionStore.transitionTerminal(invocationId, {
      status: 'interrupted',
      endedAt: 2_000,
      terminalReason: 'process_restart',
    });
    // Scoped interrupted remains cancelled; ordinary restart uses error.
    assert.equal((await read()).status, 'cancelled');
    const real = await stores.turnExecutionStore.get(invocationId);
    stores.turnExecutionStore.get = async () => ({ ...real, userId: 'foreign-user' });
    assert.equal((await read()).terminalReason, 'collective_execution_identity_unproved');
  });

  it('does not expose mismatched durable identity or replace transcript evidence for legacy/running rows', async () => {
    const stores = await setup();
    const { invocationId } = await createCanonicalExecution(stores, 'thread-f299');
    const record = await stores.sessionChainStore.create({
      threadId: 'thread-f299',
      catId: 'codex-sol',
      userId: 'user-f299',
      cliSessionId: 'cli-scoped-terminal',
    });
    await writeTranscriptFile(record, 'events.live.jsonl', [
      envelope(record, invocationId, 0, { type: 'session_init' }, 1_100),
    ]);
    const own = await stores.turnExecutionStore.get(invocationId);
    for (const changes of [
      { userId: 'other-user' },
      { threadId: 'other-thread' },
      { catId: 'other-cat' },
      { invocationId: 'other-execution' },
    ]) {
      stores.turnExecutionStore.get = async () => ({
        ...own,
        status: 'interrupted',
        endedAt: 2_000,
        terminalReason: 'private_reason',
        ...changes,
      });
      const list = await app.inject({
        method: 'GET',
        url: '/api/threads/thread-f299/invocations',
        headers: { 'x-cat-cafe-user': 'user-f299' },
      });
      assert.equal(list.json().invocations[0].status, 'running');
      assert.equal(list.json().invocations[0].terminalReason, undefined);
      const detail = await app.inject({
        method: 'GET',
        url: `/api/sessions/${record.id}/invocations/${invocationId}`,
        headers: { 'x-cat-cafe-user': 'user-f299' },
      });
      assert.equal(detail.json().summary.status, 'running');
      assert.equal(detail.json().summary.terminalReason, undefined);
    }
    for (const execution of [null, own]) {
      stores.turnExecutionStore.get = async () => execution;
      const list = await app.inject({
        method: 'GET',
        url: '/api/threads/thread-f299/invocations',
        headers: { 'x-cat-cafe-user': 'user-f299' },
      });
      assert.equal(list.json().invocations[0].status, 'running');
    }
    await writeTranscriptFile(record, 'events.live.jsonl', [
      envelope(record, invocationId, 0, { type: 'done' }, 1_200),
    ]);
    for (const execution of [null, own]) {
      stores.turnExecutionStore.get = async () => execution;
      const headers = { 'x-cat-cafe-user': 'user-f299' };
      const list = await app.inject({ method: 'GET', url: '/api/threads/thread-f299/invocations', headers });
      const detail = await app.inject({
        method: 'GET',
        url: `/api/sessions/${record.id}/invocations/${invocationId}`,
        headers,
      });
      assert.equal(list.json().invocations[0].status, 'done');
      assert.equal(detail.json().summary.status, 'done');
    }
  });

  it('bounds durable reads to returned history rows and preserves caller cat filtering', async () => {
    const stores = await setup();
    const record = await stores.sessionChainStore.create({
      threadId: 'thread-f299',
      catId: 'codex-sol',
      userId: 'user-f299',
      cliSessionId: 'cli-paged-terminal',
    });
    await writeTranscriptFile(record, 'events.live.jsonl', [
      envelope(record, 'legacy-old', 0, { type: 'session_init' }, 1_100),
      envelope(record, 'legacy-new', 1, { type: 'session_init' }, 2_100),
    ]);
    const lookedUp = [];
    stores.turnExecutionStore.get = async (id) => {
      lookedUp.push(id);
      return null;
    };
    const list = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-f299/invocations?limit=1',
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().total, 2);
    assert.deepEqual(lookedUp, ['legacy-new']);
    lookedUp.length = 0;
    const filtered = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-f299/invocations',
      headers: { 'x-cat-cafe-user': 'user-f299', 'x-cat-id': 'other-cat' },
    });
    assert.deepEqual(filtered.json().invocations, []);
    assert.deepEqual(lookedUp, []);
  });

  it('skips a syntactically valid active envelope whose event payload is invalid', async () => {
    const { sessionChainStore } = await setup();
    const record = await sessionChainStore.create({
      threadId: 'thread-f299',
      catId: 'codex-sol',
      userId: 'user-f299',
      cliSessionId: 'cli-active-invalid',
    });
    await writeTranscriptFile(record, 'events.live.jsonl', [
      envelope(record, 'inv-invalid-live', 0, null),
      envelope(record, 'inv-valid-live', 1, { type: 'done' }),
    ]);

    const list = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-f299/invocations',
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });

    assert.equal(list.statusCode, 200);
    assert.deepEqual(
      list.json().invocations.map((item) => item.invocationId),
      ['inv-valid-live'],
    );
  });

  it('skips a syntactically valid sealed envelope whose event payload is invalid', async () => {
    const { sessionChainStore } = await setup();
    const record = await sessionChainStore.create({
      threadId: 'thread-f299',
      catId: 'codex-sol',
      userId: 'user-f299',
      cliSessionId: 'cli-sealed-invalid',
    });
    await writeTranscriptFile(record, 'events.jsonl', [
      envelope(record, 'inv-invalid-sealed', 0, null),
      envelope(record, 'inv-valid-sealed', 1, { type: 'done' }),
    ]);
    await sessionChainStore.update(record.id, { status: 'sealed', sealedAt: Date.now(), sealReason: 'threshold' });

    const list = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-f299/invocations',
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });

    assert.equal(list.statusCode, 200);
    assert.deepEqual(
      list.json().invocations.map((item) => item.invocationId),
      ['inv-valid-sealed'],
    );
  });

  it('keeps active and sealed identity identical when timestamp and payload collide across invocations', async () => {
    const { sessionChainStore, transcriptReader, transcriptWriter: beforeRestart } = await setup();
    const { TranscriptWriter } = await import('../dist/domains/cats/services/session/TranscriptWriter.js');
    const record = await sessionChainStore.create({
      threadId: 'thread-f299',
      catId: 'codex-sol',
      userId: 'user-f299',
      cliSessionId: 'cli-identity-collision',
    });
    const info = {
      sessionId: record.id,
      threadId: record.threadId,
      catId: record.catId,
      cliSessionId: record.cliSessionId,
      seq: record.seq,
    };
    const originalNow = Date.now;
    Date.now = () => 42_000;
    try {
      beforeRestart.appendEvent(info, { type: 'done' }, 'inv-before');
      await beforeRestart.drainPendingWrites(record.id);
      const afterRestart = new TranscriptWriter({ dataDir });
      afterRestart.appendEvent(info, { type: 'done' }, 'inv-after');

      const active = await afterRestart.readActiveEvents(info);
      assert.deepEqual(
        active.map((item) => item.invocationId),
        ['inv-before', 'inv-after'],
      );

      await afterRestart.flush(info);
      const sealed = await transcriptReader.readAllEvents(record.id, record.threadId, record.catId);
      assert.deepEqual(
        sealed.map((item) => item.invocationId),
        active.map((item) => item.invocationId),
      );
    } finally {
      Date.now = originalNow;
    }
  });

  it('does not double-count persisted and active copies while a session is sealing', async () => {
    const { sessionChainStore } = await setup();
    const record = await sessionChainStore.create({
      threadId: 'thread-f299',
      catId: 'codex-sol',
      userId: 'user-f299',
      cliSessionId: 'cli-sealing-overlap',
    });
    const events = [
      envelope(record, 'inv-sealing', 0, { type: 'status', content: 'finishing' }),
      envelope(record, 'inv-sealing', 1, { type: 'done' }),
    ];
    await writeTranscriptFile(record, 'events.jsonl', events);
    await writeTranscriptFile(record, 'events.live.jsonl', events);
    await sessionChainStore.update(record.id, { status: 'sealing', sealReason: 'threshold' });

    const list = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-f299/invocations',
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });

    assert.equal(list.statusCode, 200);
    assert.equal(list.json().invocations[0].eventCount, 2);
    assert.equal(list.json().invocations[0].statusEventCount, 1);
  });

  it('keeps a persisted invocation prefix when the active source only has its suffix', async () => {
    const { sessionChainStore } = await setup();
    const record = await sessionChainStore.create({
      threadId: 'thread-f299',
      catId: 'codex-sol',
      userId: 'user-f299',
      cliSessionId: 'cli-restored-same-invocation',
    });
    await writeTranscriptFile(record, 'events.jsonl', [
      envelope(record, 'inv-restored', 0, { type: 'text', content: 'before restart' }),
    ]);
    await writeTranscriptFile(record, 'events.live.jsonl', [envelope(record, 'inv-restored', 1, { type: 'done' })]);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/invocations/inv-restored`,
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });

    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().events.length, 2);
    assert.deepEqual(
      detail.json().events.map((item) => item.event.type),
      ['text', 'done'],
    );
  });

  it('keeps sealed history visible when a restored session gains new active events', async () => {
    const { sessionChainStore, transcriptWriter } = await setup();
    const record = await sessionChainStore.create({
      threadId: 'thread-f299',
      catId: 'codex-sol',
      userId: 'user-f299',
      cliSessionId: 'cli-restored',
    });
    const info = {
      sessionId: record.id,
      threadId: record.threadId,
      catId: record.catId,
      cliSessionId: record.cliSessionId,
      seq: record.seq,
    };
    transcriptWriter.appendEvent(info, { type: 'done' }, 'inv-before-restore');
    await transcriptWriter.flush(info);
    await sessionChainStore.update(record.id, { status: 'active', sealReason: null, sealedAt: null });
    transcriptWriter.appendEvent(info, { type: 'status', content: 'working again' }, 'inv-after-restore');

    const list = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-f299/invocations',
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(
      new Set(list.json().invocations.map((item) => item.invocationId)),
      new Set(['inv-before-restore', 'inv-after-restore']),
    );
  });

  it('preserves the existing thread ownership guard on invocation listing', async () => {
    await setup();
    const result = await app.inject({
      method: 'GET',
      url: '/api/threads/thread-f299/invocations',
      headers: { 'x-cat-cafe-user': 'other-user' },
    });
    assert.equal(result.statusCode, 403);
  });

  it('F322 typed first output reaches the authorized list and exact drill without changing Raw or access', async () => {
    const { sessionChainStore, transcriptWriter } = await setup();
    const record = await sessionChainStore.create({
      threadId: 'thread-f299',
      catId: 'codex-sol',
      userId: 'user-f299',
      cliSessionId: 'cli-evidence',
    });
    const info = {
      sessionId: record.id,
      threadId: record.threadId,
      catId: record.catId,
      cliSessionId: record.cliSessionId,
      seq: record.seq,
    };
    const native = {
      provider: 'codex',
      runtimeSessionId: 'native',
      turnId: 'turn',
      nativeId: 'first',
      channel: 'commentary',
      complete: true,
      textMode: 'replace',
    };
    const { mapCodexAppServerNotification } = await import(
      '../dist/domains/cats/services/agents/providers/CodexAppServerEventMapper.js'
    );
    const { transformCodexEvent } = await import(
      '../dist/domains/cats/services/agents/providers/codex-event-transform.js'
    );
    const first = transformCodexEvent(
      mapCodexAppServerNotification({
        method: 'item/completed',
        params: {
          threadId: 'native',
          turnId: 'turn',
          item: { type: 'agentMessage', id: 'first', phase: 'commentary', text: 'You，' },
        },
      }),
      'codex-sol',
    );
    transcriptWriter.appendEvent(info, first, 'inv-evidence');
    transcriptWriter.appendEvent(
      info,
      { type: 'text', content: 'later final', outputMessage: { ...native, nativeId: 'second', channel: 'final' } },
      'inv-evidence',
    );
    transcriptWriter.appendEvent(info, { type: 'done' }, 'inv-evidence');
    const read = (url, user = 'user-f299') => app.inject({ method: 'GET', url, headers: { 'x-cat-cafe-user': user } });
    const url = '/api/threads/thread-f299/invocations';
    const list = await read(url);
    assert.equal(list.statusCode, 200);
    const evidence = list.json().invocations[0].firstAssistantOutputEvidence;
    assert.equal(evidence.status, 'available');
    assert.equal(evidence.content, 'You，');
    assert.equal(evidence.identity.nativeId, 'first');
    const detailUrl = `/api/sessions/${evidence.source.sessionId}/invocations/${evidence.source.invocationId}`;
    const detail = await read(`${detailUrl}?cursor=${evidence.source.firstEventNo}&limit=1`);
    assert.equal(detail.statusCode, 200);
    assert.deepEqual(detail.json().events[0].event, first);
    assert.ok(detail.json().nextCursor);
    for (const deniedUrl of [url, detailUrl, `/api/sessions/${record.id}/events?view=raw&cursor=0&limit=1`]) {
      const denied = await read(deniedUrl, 'other-user');
      assert.equal(denied.statusCode, 403);
      assert.equal(JSON.stringify(denied.json()).includes('You'), false);
    }
    await transcriptWriter.flush(info);
    await sessionChainStore.update(record.id, { status: 'sealed', sealedAt: Date.now(), sealReason: 'threshold' });
    assert.deepEqual((await read(url)).json().invocations[0].firstAssistantOutputEvidence, evidence);
  });

  it('F322 oversized first output stays unavailable and its exact original payload is reachable in bounded Raw slices', async () => {
    const { sessionChainStore, transcriptWriter } = await setup();
    const record = await sessionChainStore.create({
      threadId: 'thread-f299',
      catId: 'codex-sol',
      userId: 'user-f299',
      cliSessionId: 'cli-oversized-evidence',
    });
    const info = {
      sessionId: record.id,
      threadId: record.threadId,
      catId: record.catId,
      cliSessionId: record.cliSessionId,
      seq: record.seq,
    };
    const payload = {
      type: 'text',
      content: '猫🙂'.repeat(10000),
      outputMessage: {
        provider: 'codex',
        runtimeSessionId: 'native',
        turnId: 'turn',
        nativeId: 'first',
        channel: 'commentary',
        complete: true,
        textMode: 'replace',
      },
    };
    transcriptWriter.appendEvent(info, payload, 'inv-big-evidence');
    const read = (url) => app.inject({ method: 'GET', url, headers: { 'x-cat-cafe-user': 'user-f299' } });
    const list = await read('/api/threads/thread-f299/invocations');
    const evidence = list.json().invocations[0].firstAssistantOutputEvidence;
    assert.equal(evidence.status, 'oversized');
    assert.equal(evidence.complete, true);
    assert.equal(evidence.content, undefined);
    assert.equal(evidence.byteLength, Buffer.byteLength(payload.content));
    // The existing session Raw reader reads the published transcript, while the
    // invocation reader can also observe the live writer buffer. Keep that boundary.
    await transcriptWriter.flush(info);
    await sessionChainStore.update(record.id, { status: 'sealed', sealedAt: Date.now(), sealReason: 'threshold' });
    const cursor = evidence.source.firstEventNo;
    const rawUrl = `/api/sessions/${record.id}/events?view=raw&cursor=${cursor}&limit=1`;
    const page = await read(rawUrl);
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.length <= 24000);
    assert.equal(page.json().events[0].oversized, true);
    assert.equal(page.json().events[0].drillDown.args.cursor, cursor);
    let offset = 0;
    let serialized = '';
    do {
      const slice = await read(`${rawUrl}&charOffset=${offset}`);
      assert.equal(slice.statusCode, 200);
      const body = slice.json();
      assert.equal(body.eventNo, cursor);
      assert.ok(body.eventSlice.length <= 8000);
      serialized += body.eventSlice;
      offset = body.nextCharOffset;
    } while (offset !== undefined);
    assert.deepEqual(JSON.parse(serialized), payload);
  });

  it('F322 undefined modes have identical evidence in live buffer, published JSONL and a restarted reader', async () => {
    const { sessionChainStore, transcriptWriter } = await setup();
    const { projectInvocationTrajectories } = await import(
      '../dist/domains/cats/services/session/InvocationTrajectoryProjector.js'
    );
    const { TranscriptInvocationReader } = await import(
      '../dist/domains/cats/services/session/transcript-index/TranscriptInvocationReader.js'
    );
    const { TranscriptReader } = await import('../dist/domains/cats/services/session/TranscriptReader.js');
    const record = await sessionChainStore.create({
      threadId: 'thread-f299',
      catId: 'codex-sol',
      userId: 'user-f299',
      cliSessionId: 'cli-undefined-mode',
    });
    const info = {
      sessionId: record.id,
      threadId: record.threadId,
      catId: record.catId,
      cliSessionId: record.cliSessionId,
      seq: record.seq,
    };
    const native = {
      provider: 'codex',
      runtimeSessionId: 'native',
      turnId: 'turn',
      nativeId: 'first',
      channel: 'commentary',
      textMode: 'append',
      complete: false,
    };
    const cases = [
      { mode: undefined, outer: 'replace', expected: 'full snapshot' },
      { mode: undefined, outer: undefined, expected: 'prefixfull snapshot' },
      { mode: 'append', outer: undefined, expected: 'prefixfull snapshot' },
      { mode: 'replace', outer: undefined, expected: 'full snapshot' },
      { mode: undefined, outer: null, expected: undefined },
    ];
    const before = new Map();
    for (const [index, value] of cases.entries()) {
      const id = `inv-undefined-${index}`;
      const events = [
        { type: 'text', content: 'prefix', outputMessage: native },
        {
          type: 'text',
          content: 'full snapshot',
          textMode: value.outer,
          outputMessage: { ...native, textMode: value.mode, complete: true },
        },
      ];
      const direct = projectInvocationTrajectories(
        events.map((payload, eventNo) => envelope(record, id, eventNo, payload)),
        record,
      )[0].firstAssistantOutputEvidence;
      assert.equal(direct.content, value.expected);
      assert.equal(direct.status, value.expected === undefined ? 'conflict' : 'available');
      for (const payload of events) transcriptWriter.appendEvent(info, payload, id);
    }
    const read = () =>
      app.inject({
        method: 'GET',
        url: '/api/threads/thread-f299/invocations',
        headers: { 'x-cat-cafe-user': 'user-f299' },
      });
    const active = await read();
    assert.equal(active.statusCode, 200);
    for (const item of active.json().invocations) before.set(item.invocationId, item.firstAssistantOutputEvidence);
    for (const [index, value] of cases.entries())
      assert.equal(before.get(`inv-undefined-${index}`).content, value.expected);
    await transcriptWriter.flush(info);
    await sessionChainStore.update(record.id, { status: 'sealed', sealedAt: Date.now(), sealReason: 'threshold' });
    for (const item of (await read()).json().invocations)
      assert.deepEqual(item.firstAssistantOutputEvidence, before.get(item.invocationId));
    const restarted = new TranscriptInvocationReader(new TranscriptReader({ dataDir }));
    const summaries = await restarted.list([{ ...record, status: 'sealed' }], 200);
    for (const item of summaries.invocations)
      assert.deepEqual(item.firstAssistantOutputEvidence, before.get(item.invocationId));
  });
});
