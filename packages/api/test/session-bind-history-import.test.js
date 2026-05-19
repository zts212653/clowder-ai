import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import Fastify from 'fastify';

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Session bind history import', () => {
  async function buildApp() {
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { TranscriptReader } = await import('../dist/domains/cats/services/session/TranscriptReader.js');
    const { TranscriptWriter } = await import('../dist/domains/cats/services/session/TranscriptWriter.js');
    const { sessionChainRoutes } = await import('../dist/routes/session-chain.js');
    const { messagesRoutes } = await import('../dist/routes/messages.js');

    const sessionChainStore = new SessionChainStore();
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const transcriptDataDir = await mkdtemp(join(tmpdir(), 'session-bind-history-'));
    tempDirs.push(transcriptDataDir);
    const transcriptReader = new TranscriptReader({ dataDir: transcriptDataDir });
    const transcriptWriter = new TranscriptWriter({ dataDir: transcriptDataDir });

    const app = Fastify({ logger: false });
    await app.register(sessionChainRoutes, {
      sessionChainStore,
      threadStore,
      messageStore,
      transcriptReader,
    });
    await app.register(messagesRoutes, {
      registry: new InvocationRegistry(),
      messageStore,
      socketManager: { broadcastAgentMessage: () => {} },
    });
    await app.ready();

    return {
      app,
      sessionChainStore,
      threadStore,
      messageStore,
      transcriptWriter,
    };
  }

  async function createSealedTranscript({
    sessionChainStore,
    transcriptWriter,
    threadId,
    userId,
    catId,
    cliSessionId,
    events,
  }) {
    const record = sessionChainStore.create({
      cliSessionId,
      threadId,
      catId,
      userId,
    });

    const session = {
      sessionId: record.id,
      threadId,
      catId,
      cliSessionId,
      seq: record.seq,
    };

    for (const { event, invocationId } of events) {
      transcriptWriter.appendEvent(session, event, invocationId);
    }

    sessionChainStore.update(record.id, {
      status: 'sealed',
      sealedAt: Date.now(),
      updatedAt: Date.now(),
    });

    await transcriptWriter.flush(session, { createdAt: 1000, sealedAt: 2000 });
    return record;
  }

  test('bind-time backfill imports transcript history into message timeline', async () => {
    const { app, threadStore, sessionChainStore, transcriptWriter, messageStore } = await buildApp();
    try {
      const thread = await threadStore.create('user-1', 'Test');

      await createSealedTranscript({
        sessionChainStore,
        transcriptWriter,
        threadId: thread.id,
        userId: 'user-1',
        catId: 'opus',
        cliSessionId: 'cli-old',
        events: [
          {
            invocationId: 'inv-1',
            event: {
              type: 'assistant',
              content: [{ type: 'text', text: '历史里的布偶猫回答' }],
            },
          },
        ],
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/threads/${thread.id}/sessions/opus/bind`,
        headers: { 'x-cat-cafe-user': 'user-1' },
        payload: { cliSessionId: 'cli-rebound' },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.deepEqual(body.historyImport, {
        status: 'ok',
        importedCount: 1,
      });

      const stored = await messageStore.getByThread(thread.id, 20, 'user-1');
      assert.equal(stored.length, 1);
      assert.equal(stored[0]?.catId, 'opus');
      assert.equal(stored[0]?.content, '历史里的布偶猫回答');
      // F194 Phase Z9 AC-Z25 (KD-28): history import now stamps turnInvocationId
      // explicitly (= invocationId for history records — they have only one identity).
      assert.deepEqual(stored[0]?.extra?.stream, { invocationId: 'inv-1', turnInvocationId: 'inv-1' });

      const historyRes = await app.inject({
        method: 'GET',
        url: `/api/messages?threadId=${thread.id}`,
        headers: { 'x-cat-cafe-user': 'user-1' },
      });
      assert.equal(historyRes.statusCode, 200);
      const historyBody = JSON.parse(historyRes.body);
      assert.equal(historyBody.messages.length, 1);
      assert.equal(historyBody.messages[0].content, '历史里的布偶猫回答');
    } finally {
      await app.close();
    }
  });

  test('bind reports no_transcript_found when there is nothing importable yet', async () => {
    const { app, threadStore } = await buildApp();
    try {
      const thread = await threadStore.create('user-1', 'Test');

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/threads/${thread.id}/sessions/opus/bind`,
        headers: { 'x-cat-cafe-user': 'user-1' },
        payload: { cliSessionId: 'cli-no-history' },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.deepEqual(body.historyImport, {
        status: 'skipped',
        importedCount: 0,
        reason: 'no_transcript_found',
      });
    } finally {
      await app.close();
    }
  });

  test('repeated bind does not duplicate imported history', async () => {
    const { app, threadStore, sessionChainStore, transcriptWriter, messageStore } = await buildApp();
    try {
      const thread = await threadStore.create('user-1', 'Test');

      await createSealedTranscript({
        sessionChainStore,
        transcriptWriter,
        threadId: thread.id,
        userId: 'user-1',
        catId: 'opus',
        cliSessionId: 'cli-old',
        events: [
          {
            invocationId: 'inv-2',
            event: {
              type: 'assistant',
              content: [{ type: 'text', text: '同一条历史不该长双胞胎' }],
            },
          },
        ],
      });

      for (const cliSessionId of ['cli-rebound-a', 'cli-rebound-b']) {
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/threads/${thread.id}/sessions/opus/bind`,
          headers: { 'x-cat-cafe-user': 'user-1' },
          payload: { cliSessionId },
        });
        assert.equal(res.statusCode, 200);
      }

      const stored = await messageStore.getByThread(thread.id, 20, 'user-1');
      assert.equal(stored.length, 1);
      assert.equal(stored[0]?.content, '同一条历史不该长双胞胎');
    } finally {
      await app.close();
    }
  });
});
