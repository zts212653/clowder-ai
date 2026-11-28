import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const { threadsRoutes } = await import('../dist/routes/threads.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
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
  store,
} = {}) {
  const globalMessages = Object.entries(threadMessages)
    .flatMap(([threadId, messages]) =>
      messages.map((message) => ({ userId: 'alice', threadId, mentions: [], ...message })),
    )
    .sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
  const readPage = (eligible, budget) => {
    const raw = eligible.slice(0, budget);
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
  };
  const messageStore = store ?? {
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
      return readPage(eligible, Math.min(limit, scanLimit));
    },
    getByThreadBeforeBounded: async (threadId, timestamp, limit, _beforeId, userId, scanLimit) => {
      messageReadLog.push({ kind: 'thread-bounded', threadId, userId, limit: scanLimit });
      return readPage(
        globalMessages.filter((message) => message.threadId === threadId && message.timestamp < timestamp).reverse(),
        Math.min(limit, scanLimit),
      );
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

  it('filters the project before the recent limit, preserves default and confirms an empty project without scanning', async () => {
    const messageReadLog = [];
    app = await makeApp({
      threads: [
        { ...T1, projectPath: '/target' },
        { ...T2, projectPath: 'default' },
      ],
      threadMessages: {
        T1: [
          imageMessage('a', 1, 'target-a.png'),
          imageMessage('b', 2, 'target-b.png'),
          imageMessage('c', 3, 'target-c.png'),
        ],
        T2: [
          imageMessage('x', 100, 'other-a.png'),
          imageMessage('y', 101, 'other-b.png'),
          imageMessage('z', 102, 'other-c.png'),
        ],
      },
      messageReadLog,
    });
    const read = async (project) =>
      await app.inject({
        method: 'GET',
        url: '/api/artifacts?view=recent-works&limit=3&projectId=' + encodeURIComponent(project),
        headers: AUTH,
      });
    assert.deepEqual(
      (await read('/target')).json().artifacts.map((work) => work.name),
      ['target-c.png', 'target-b.png', 'target-a.png'],
    );
    assert.deepEqual(
      (await read('default')).json().artifacts.map((work) => work.name),
      ['other-c.png', 'other-b.png', 'other-a.png'],
    );
    messageReadLog.length = 0;
    const empty = (await read('/empty')).json();
    assert.deepEqual(empty.artifacts, []);
    assert.equal(empty.complete, true);
    assert.deepEqual(messageReadLog, []);
    assert.equal((await read('')).statusCode, 400);
  });

  it('finds a project image behind 600 newer messages in another project using the in-memory store', async () => {
    const store = new MessageStore({ maxMessages: 1024 });
    const append = (threadId, timestamp, extra) =>
      store.append({
        threadId,
        userId: 'alice',
        from: { kind: 'agent', catId: 'opus' },
        timestamp,
        content: 'fixture',
        mentions: [],
        ...(extra ? { extra } : {}),
      });
    append(T1.id, 1, imageMessage('target', 1, 'target.png').extra);
    nonWorks(600).forEach(({ timestamp }) => append(T2.id, timestamp + 1));
    app = await makeApp({
      threads: [
        { ...T1, projectPath: '/target' },
        { ...T2, projectPath: '/other' },
      ],
      store,
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/artifacts?view=recent-works&projectId=%2Ftarget',
      headers: AUTH,
    });
    const body = response.json();
    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      body.artifacts.map((work) => work.name),
      ['target.png'],
    );
    assert.equal(body.complete, true);
  });

  it('retains a known newer project work and withholds a timestamp group cut by the read budget', async () => {
    const messageReadLog = [];
    app = await makeApp({
      threads: [
        { ...T1, projectPath: '/target' },
        { ...T2, projectPath: '/target' },
      ],
      threadMessages: {
        T1: [
          imageMessage('newer', 101, 'newer.png'),
          imageMessage('tie-work', 100, 'tie-cut.png'),
          ...nonWorks(256).map((message) => ({ ...message, timestamp: 100 })),
        ],
        T2: [imageMessage('other-thread-tie', 100, 'same-time.png')],
      },
      messageReadLog,
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/artifacts?view=recent-works&projectId=%2Ftarget',
      headers: AUTH,
    });
    const body = response.json();
    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      body.artifacts.map((work) => work.name),
      ['newer.png'],
    );
    assert.equal(body.complete, false);
    assert.equal(messageReadLog.length, 2);
    assert.ok(messageReadLog.every((read) => read.kind === 'thread-bounded' && read.userId === 'alice'));
    assert.equal(
      messageReadLog.reduce((sum, read) => sum + read.limit, 0),
      512,
    );
  });

  it('caps project thread reads, keeps a found work, and reports the result as partial', async () => {
    const messageReadLog = [];
    const threads = Array.from({ length: 33 }, (_, index) => ({
      ...T1,
      id: String(index),
      lastActiveAt: index,
      projectPath: '/target',
    }));
    app = await makeApp({
      threads,
      threadMessages: { 32: [imageMessage('active', 100, 'active.png')] },
      messageReadLog,
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/artifacts?view=recent-works&projectId=%2Ftarget',
      headers: AUTH,
    });
    const body = response.json();
    assert.equal(response.statusCode, 200);
    assert.equal(body.artifacts[0]?.name, 'active.png');
    assert.equal(body.complete, false);
    assert.deepEqual(
      messageReadLog.map((read) => read.threadId),
      threads
        .slice(1)
        .reverse()
        .map((thread) => thread.id),
    );
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
