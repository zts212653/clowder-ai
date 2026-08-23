import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';

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
    const { invocationRecordStore, sessionChainStore, transcriptWriter } = await setup({
      threads: [
        { id: 'thread-current-page', createdBy: 'user-f299' },
        { id: 'thread-canonical', createdBy: 'user-f299' },
      ],
    });
    const invocationId = await createInvocationRecord(invocationRecordStore, 'thread-canonical');
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

  it('treats evidence thread and session coordinates as fail-closed hints', async () => {
    const { invocationRecordStore, sessionChainStore, transcriptWriter } = await setup();
    const invocationId = await createInvocationRecord(invocationRecordStore, 'thread-f299');
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
    const { invocationRecordStore } = await setup();
    const missingRecord = await app.inject({
      method: 'GET',
      url: '/api/invocations/inv-missing/trajectory',
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });
    assert.equal(missingRecord.statusCode, 404);
    assert.equal(missingRecord.json().code, 'INVOCATION_RECORD_NOT_FOUND');

    const invocationId = await createInvocationRecord(invocationRecordStore, 'thread-f299');
    const missingSession = await app.inject({
      method: 'GET',
      url: `/api/invocations/${invocationId}/trajectory`,
      headers: { 'x-cat-cafe-user': 'user-f299' },
    });
    assert.equal(missingSession.statusCode, 404);
    assert.equal(missingSession.json().code, 'INVOCATION_SESSION_NOT_FOUND');
  });

  it('rejects foreign records and filters user-indexed system-thread sessions by current user', async () => {
    const { invocationRecordStore, sessionChainStore, transcriptWriter } = await setup({
      thread: { id: 'thread-f299', createdBy: 'system' },
      indexedUsers: ['user-f299', 'other-user'],
    });
    const ownerInvocationId = await createInvocationRecord(invocationRecordStore, 'thread-f299');
    const foreignInvocationId = await createInvocationRecord(invocationRecordStore, 'thread-f299', 'other-user');
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
    const { invocationRecordStore } = await setup({
      thread: { id: 'thread-f299', createdBy: 'system' },
      indexedUsers: [],
    });
    const invocationId = await createInvocationRecord(invocationRecordStore, 'thread-f299');

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
    const available = await messageStore.append({
      threadId: 'thread-f299',
      userId: 'user-f299',
      catId: null,
      content: 'canonical user request',
      timestamp: 900,
    });
    const deleted = await messageStore.append({
      threadId: 'thread-f299',
      userId: 'user-f299',
      catId: null,
      content: 'must not survive deletion',
      timestamp: 901,
    });
    await messageStore.softDelete(deleted.id, 'user-f299');
    const invisible = await messageStore.append({
      threadId: 'thread-f299',
      userId: 'other-user',
      catId: null,
      content: 'foreign body must not leak',
      timestamp: 902,
    });
    const context = await messageStore.append({
      threadId: 'thread-f299',
      userId: 'user-f299',
      catId: 'opus',
      content: 'covered prompt context must not be presented as the trigger',
      timestamp: 903,
    });
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
    const trigger = await messageStore.append({
      threadId: 'thread-f299',
      userId: 'user-f299',
      catId: null,
      content: 'canonical trigger',
      timestamp: 910,
    });
    const context = await messageStore.append({
      threadId: 'thread-f299',
      userId: 'user-f299',
      catId: 'opus',
      content: 'context only',
      timestamp: 911,
    });
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
});
