import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const { threadsRoutes } = await import('../dist/routes/threads.js');
const AUTH = { 'x-cat-cafe-user': 'alice' };
const T1 = { id: 'T1', title: 'Recent works', createdBy: 'alice' };
const T2 = { id: 'T2', title: 'More works', createdBy: 'alice' };

function fileMessage(id, timestamp, fileName, catId = 'codex') {
  return {
    id,
    catId,
    timestamp,
    contentBlocks: [{ type: 'file', url: `/uploads/${fileName}`, fileName, mimeType: 'application/pdf' }],
  };
}

function imageMessage(id, timestamp, fileName, catId = 'opus') {
  return {
    id,
    catId,
    timestamp,
    extra: {
      rich: {
        blocks: [
          {
            kind: 'media_gallery',
            v: 1,
            id: `gallery-${id}`,
            items: [{ url: `/uploads/${fileName}`, alt: fileName }],
          },
        ],
      },
    },
  };
}

function nonWorks(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `text-${String(index).padStart(4, '0')}`,
    catId: 'opus',
    timestamp: index + 1,
    extra: {
      rich: { blocks: [{ kind: 'diff', v: 1, id: `diff-${index}`, filePath: `src/${index}.ts`, hunks: [] }] },
    },
  }));
}

async function makeApp({
  threads = [],
  threadMessages = {},
  messageReadLog = [],
  artifactWorkLineage,
  withMessageStore = true,
} = {}) {
  const globalMessages = Object.entries(threadMessages)
    .flatMap(([threadId, messages]) =>
      messages.map((message) => ({ userId: 'alice', threadId, mentions: [], ...message })),
    )
    .sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
  const messageStore = {
    getByThread: async (threadId) => {
      messageReadLog.push({ kind: 'thread', threadId });
      return threadMessages[threadId] ?? [];
    },
    getByThreadBefore: async () => {
      messageReadLog.push({ kind: 'thread-before' });
      return [];
    },
    getOwnerBeforeBounded: async (userId, timestamp, limit, beforeId, scanLimit) => {
      messageReadLog.push({ kind: 'global-before', timestamp, limit, userId, beforeId, scanLimit });
      const eligible = globalMessages
        .filter(
          (message) =>
            message.timestamp < timestamp ||
            (message.timestamp === timestamp && beforeId !== undefined && message.id < beforeId),
        )
        .sort((left, right) => right.timestamp - left.timestamp || right.id.localeCompare(left.id));
      const raw = eligible.slice(0, Math.min(limit, scanLimit));
      const lookahead = eligible[raw.length];
      const oldest = raw.at(-1);
      return {
        messages: [...raw].reverse(),
        scannedCount: raw.length,
        storageRoundTrips: 0,
        exhausted: lookahead === undefined,
        oldestTimelineGroupComplete: !oldest || !lookahead || lookahead.timestamp !== oldest.timestamp,
        ...(oldest ? { nextCursor: { timestamp: oldest.timestamp, id: oldest.id } } : {}),
      };
    },
  };
  const app = Fastify();
  await app.register(threadsRoutes, {
    threadStore: {
      get: async (id) => threads.find((thread) => thread.id === id) ?? null,
      list: async () => threads,
      getThreadMemory: async () => null,
    },
    ...(withMessageStore ? { messageStore } : {}),
    taskStore: { listByThread: async () => [] },
    artifactWorkLineage: {
      current: artifactWorkLineage ?? { resolve: async ({ artifacts }) => artifacts.map(() => undefined) },
      independent: {
        readRecent: async () => ({ artifacts: [], complete: true }),
        readThread: async () => ({ artifacts: [], snapshot: 'empty' }),
      },
    },
  });
  return app;
}

describe('GET /api/artifacts bounded recent works view (F232 KD-9)', () => {
  let app;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('reads the owner-global timeline instead of every thread history and applies the server limit', async () => {
    const messageReadLog = [];
    app = await makeApp({
      threads: [T1, T2],
      threadMessages: {
        T1: [imageMessage('newest', 300, 'screenshot.png')],
        T2: [fileMessage('second', 250, 'report.pdf'), imageMessage('oldest', 200, 'old.png')],
      },
      messageReadLog,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/artifacts?view=recent-works&limit=2',
      headers: AUTH,
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body);
    assert.deepEqual(
      body.artifacts.map((candidate) => candidate.name),
      ['screenshot.png', 'report.pdf'],
    );
    assert.equal(body.complete, true);
    assert.ok(messageReadLog.some((read) => read.kind === 'global-before'));
    assert.ok(messageReadLog.every((read) => !read.kind.startsWith('thread')));
  });

  it('caps an artifact-free history and reports unknown rather than verified empty', async () => {
    const messageReadLog = [];
    app = await makeApp({ threads: [T1], threadMessages: { T1: nonWorks(700) }, messageReadLog });

    const res = await app.inject({
      method: 'GET',
      url: '/api/artifacts?view=recent-works&limit=3',
      headers: AUTH,
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.artifacts, []);
    assert.equal(body.complete, false);
    assert.ok(messageReadLog.length > 1);
    assert.ok(messageReadLog.reduce((sum, read) => sum + (read.kind === 'global-before' ? read.limit : 0), 0) < 700);
    assert.ok(messageReadLog.every((read) => !read.kind.startsWith('thread')));
  });

  it('returns found works with complete=false and resolves lineage once for the bounded batch', async () => {
    let lineageCalls = 0;
    app = await makeApp({
      threads: [T1],
      threadMessages: {
        T1: [...nonWorks(700), fileMessage('second', 1_001, 'second.pdf'), imageMessage('newest', 1_002, 'newest.png')],
      },
      artifactWorkLineage: {
        resolve: async ({ artifacts }) => {
          lineageCalls += 1;
          return artifacts.map(() => undefined);
        },
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/artifacts?view=recent-works&limit=3',
      headers: AUTH,
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body);
    assert.deepEqual(
      body.artifacts.map((candidate) => candidate.name),
      ['newest.png', 'second.pdf'],
    );
    assert.equal(body.complete, false);
    assert.equal(lineageCalls, 1);
  });

  it('distinguishes verified empty history and rejects invalid limits', async () => {
    app = await makeApp({ threads: [T1], threadMessages: { T1: nonWorks(1) } });
    const empty = await app.inject({
      method: 'GET',
      url: '/api/artifacts?view=recent-works&limit=3',
      headers: AUTH,
    });
    assert.equal(empty.statusCode, 200, empty.body);
    assert.equal(JSON.parse(empty.body).complete, true);
    assert.deepEqual(JSON.parse(empty.body).artifacts, []);

    for (const limit of ['0', '13', 'oops']) {
      const invalid = await app.inject({
        method: 'GET',
        url: `/api/artifacts?view=recent-works&limit=${limit}`,
        headers: AUTH,
      });
      assert.equal(invalid.statusCode, 400, `${limit}: ${invalid.body}`);
    }
  });

  it('defaults to three works and rejects unsupported bounded-view query shapes', async () => {
    app = await makeApp({
      threads: [T1],
      threadMessages: {
        T1: Array.from({ length: 5 }, (_, index) => fileMessage(`work-${index}`, index + 1, `work-${index}.pdf`)),
      },
    });
    const defaulted = await app.inject({
      method: 'GET',
      url: '/api/artifacts?view=recent-works',
      headers: AUTH,
    });
    assert.equal(defaulted.statusCode, 200, defaulted.body);
    assert.equal(JSON.parse(defaulted.body).artifacts.length, 3);

    for (const query of ['view=unknown', 'view=recent-works&type=file']) {
      const invalid = await app.inject({ method: 'GET', url: `/api/artifacts?${query}`, headers: AUTH });
      assert.equal(invalid.statusCode, 400, `${query}: ${invalid.body}`);
    }
  });

  it('reports an unavailable message source as incomplete instead of a genuine empty café', async () => {
    app = await makeApp({ threads: [T1], withMessageStore: false });
    const res = await app.inject({
      method: 'GET',
      url: '/api/artifacts?view=recent-works&limit=3',
      headers: AUTH,
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(JSON.parse(res.body).artifacts, []);
    assert.equal(JSON.parse(res.body).complete, false);
  });
});
