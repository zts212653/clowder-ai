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

async function buildApp() {
  const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
  const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
  const { TranscriptReader } = await import('../dist/domains/cats/services/session/TranscriptReader.js');
  const { TranscriptWriter } = await import('../dist/domains/cats/services/session/TranscriptWriter.js');
  const { sessionChainRoutes } = await import('../dist/routes/session-chain.js');
  const { sessionTranscriptRoutes } = await import('../dist/routes/session-transcript.js');

  const sessionChainStore = new SessionChainStore();
  const threadStore = new ThreadStore();
  const transcriptDataDir = await mkdtemp(join(tmpdir(), 'external-runtime-anchor-'));
  tempDirs.push(transcriptDataDir);
  const transcriptReader = new TranscriptReader({ dataDir: transcriptDataDir });
  const transcriptWriter = new TranscriptWriter({ dataDir: transcriptDataDir });

  const app = Fastify({ logger: false });
  await app.register(sessionChainRoutes, {
    sessionChainStore,
    threadStore,
    transcriptReader,
  });
  await app.register(sessionTranscriptRoutes, {
    sessionChainStore,
    threadStore,
    transcriptReader,
  });
  await app.ready();

  return { app, sessionChainStore, threadStore, transcriptWriter };
}

async function createSealedTranscript({ sessionChainStore, transcriptWriter, threadId }) {
  const record = sessionChainStore.create({
    cliSessionId: 'cascade-1',
    threadId,
    catId: 'antig-opus',
    userId: 'user-1',
  });

  const session = {
    sessionId: record.id,
    threadId,
    catId: record.catId,
    cliSessionId: record.cliSessionId,
    seq: record.seq,
  };

  transcriptWriter.appendEvent(session, {
    type: 'assistant',
    content: [{ type: 'text', text: 'IDE direct runtime evidence' }],
  });
  sessionChainStore.update(record.id, {
    status: 'sealed',
    sealedAt: 2000,
    updatedAt: 2000,
  });
  await transcriptWriter.flush(session, { createdAt: 1000, sealedAt: 2000 });
  return record;
}

describe('External runtime anchor thread', () => {
  test('creates deterministic hidden anchor threads per runtime and user', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const threadStore = new ThreadStore();

    const first = await threadStore.ensureExternalRuntimeAnchorThread('antigravity-desktop', 'user-1');
    const second = await threadStore.ensureExternalRuntimeAnchorThread('antigravity-desktop', 'user-1');
    const visibleThreads = await threadStore.list('user-1');

    assert.equal(first.id, 'external-runtime:antigravity-desktop:user-1');
    assert.equal(second.id, first.id);
    assert.equal(first.createdBy, 'system');
    assert.deepEqual(first.externalRuntimeAnchorState, {
      v: 1,
      runtime: 'antigravity-desktop',
      userId: 'user-1',
      createdAt: first.createdAt,
    });
    assert.equal(
      visibleThreads.some((thread) => thread.id === first.id),
      false,
      'external runtime anchors must not appear in normal thread list',
    );
  });

  test('session and transcript routes allow only the anchor owner to drill into anchor sessions', async () => {
    const { app, threadStore, sessionChainStore, transcriptWriter } = await buildApp();
    try {
      const anchor = await threadStore.ensureExternalRuntimeAnchorThread('antigravity-desktop', 'user-1');
      const session = await createSealedTranscript({
        sessionChainStore,
        transcriptWriter,
        threadId: anchor.id,
      });

      const sessionRes = await app.inject({
        method: 'GET',
        url: `/api/sessions/${session.id}`,
        headers: { 'x-cat-cafe-user': 'user-1' },
      });
      assert.equal(sessionRes.statusCode, 200);

      const digestRes = await app.inject({
        method: 'GET',
        url: `/api/sessions/${session.id}/digest`,
        headers: { 'x-cat-cafe-user': 'user-1' },
      });
      assert.equal(digestRes.statusCode, 200);

      const foreignRes = await app.inject({
        method: 'GET',
        url: `/api/sessions/${session.id}`,
        headers: { 'x-cat-cafe-user': 'user-2' },
      });
      assert.equal(foreignRes.statusCode, 403);
    } finally {
      await app.close();
    }
  });

  test('session transcript routes allow the session owner to drill into shared default-thread runtime sessions', async () => {
    const { DEFAULT_THREAD_ID } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { app, sessionChainStore, transcriptWriter } = await buildApp();
    try {
      const session = await createSealedTranscript({
        sessionChainStore,
        transcriptWriter,
        threadId: DEFAULT_THREAD_ID,
      });

      const eventsRes = await app.inject({
        method: 'GET',
        url: `/api/sessions/${session.id}/events`,
        headers: { 'x-cat-cafe-user': 'user-1' },
      });
      assert.equal(eventsRes.statusCode, 200);

      const digestRes = await app.inject({
        method: 'GET',
        url: `/api/sessions/${session.id}/digest`,
        headers: { 'x-cat-cafe-user': 'user-1' },
      });
      assert.equal(digestRes.statusCode, 200);

      const foreignRes = await app.inject({
        method: 'GET',
        url: `/api/sessions/${session.id}/events`,
        headers: { 'x-cat-cafe-user': 'user-2' },
      });
      assert.equal(foreignRes.statusCode, 403);
    } finally {
      await app.close();
    }
  });
});
