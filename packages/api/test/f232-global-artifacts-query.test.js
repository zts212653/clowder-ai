/**
 * F232 Phase B: Server-side query params for GET /api/artifacts.
 * Tests ?type=X&cat=X&q=keyword filtering at the API level.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const { threadsRoutes } = await import('../dist/routes/threads.js');

describe('GET /api/artifacts — server-side query params (F232 Phase B)', () => {
  let app;
  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  const AUTH = { 'x-cat-cafe-user': 'alice' };

  /**
   * Builds a Fastify app with threadStore.list() returning multiple threads,
   * each containing messages with rich blocks to produce varied artifacts.
   */
  async function makeApp({ threads = [], threadMessages = {}, threadTasks = {}, threadMemory = {} } = {}) {
    const threadStore = {
      get: async (id) => threads.find((t) => t.id === id) ?? null,
      list: async () => threads,
      getThreadMemory: async (id) => threadMemory[id] ?? null,
    };
    const a = Fastify();
    await a.register(threadsRoutes, {
      threadStore,
      messageStore: {
        getByThread: async (threadId) => threadMessages[threadId] ?? [],
        getByThreadBefore: async () => [],
      },
      taskStore: {
        listByThread: async (threadId) => threadTasks[threadId] ?? [],
      },
    });
    return a;
  }

  // --- Test fixtures ---
  const T1 = { id: 'T1', title: 'F232 产物', createdBy: 'alice' };
  const T2 = { id: 'T2', title: 'F229 审计', createdBy: 'alice' };

  // Messages with rich blocks: image by opus, file by codex, code-diff by opus
  const messagesT1 = [
    {
      id: 'm1',
      catId: 'opus',
      timestamp: 300,
      extra: {
        rich: {
          blocks: [
            {
              kind: 'media_gallery',
              v: 1,
              id: 'b1',
              items: [{ url: '/uploads/screenshot.png', alt: 'screenshot.png' }],
            },
          ],
        },
      },
    },
    {
      id: 'm2',
      catId: 'opus',
      timestamp: 200,
      extra: {
        rich: {
          blocks: [{ kind: 'diff', v: 1, id: 'b2', fileName: 'index.ts', language: 'typescript', hunks: [] }],
        },
      },
    },
  ];
  const messagesT2 = [
    {
      id: 'm3',
      catId: 'codex',
      timestamp: 250,
      extra: {
        rich: {
          blocks: [{ kind: 'file', v: 1, id: 'b3', url: '/uploads/report.pdf', fileName: 'report.pdf' }],
        },
      },
    },
    {
      id: 'm4',
      catId: 'sonnet',
      timestamp: 150,
      extra: {
        rich: {
          blocks: [{ kind: 'audio', v: 1, id: 'b4', url: '/uploads/voice.mp3', duration: 10 }],
        },
      },
    },
  ];

  // Message with null catId (system/unknown origin)
  const T3 = { id: 'T3', title: 'System Thread', createdBy: 'alice' };
  const messagesT3 = [
    {
      id: 'm5',
      catId: null,
      timestamp: 100,
      extra: {
        rich: {
          blocks: [{ kind: 'file', v: 1, id: 'b5', url: '/uploads/syslog.txt', fileName: 'syslog.txt' }],
        },
      },
    },
  ];

  function seedApp() {
    return makeApp({
      threads: [T1, T2],
      threadMessages: { T1: messagesT1, T2: messagesT2 },
    });
  }

  // --- Baseline: no params returns all ---
  it('returns all artifacts without query params', async () => {
    app = await seedApp();
    const res = await app.inject({ method: 'GET', url: '/api/artifacts', headers: AUTH });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.artifacts.length, 4);
    assert.equal(body.total, 4);
  });

  // --- ?cat= filter ---
  it('?cat=opus returns only opus artifacts', async () => {
    app = await seedApp();
    const res = await app.inject({ method: 'GET', url: '/api/artifacts?cat=opus', headers: AUTH });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.artifacts.length > 0, 'should have opus artifacts');
    assert.ok(
      body.artifacts.every((a) => a.catId === 'opus'),
      'all artifacts should be by opus',
    );
    assert.equal(body.total, body.artifacts.length);
  });

  it('?cat=codex returns only codex artifacts', async () => {
    app = await seedApp();
    const res = await app.inject({ method: 'GET', url: '/api/artifacts?cat=codex', headers: AUTH });
    const body = JSON.parse(res.body);
    assert.ok(body.artifacts.every((a) => a.catId === 'codex'));
  });

  it('?cat=nonexistent returns empty', async () => {
    app = await seedApp();
    const res = await app.inject({ method: 'GET', url: '/api/artifacts?cat=nonexistent', headers: AUTH });
    const body = JSON.parse(res.body);
    assert.equal(body.artifacts.length, 0);
    assert.equal(body.total, 0);
  });

  // --- ?type= filter ---
  it('?type=image returns only image artifacts', async () => {
    app = await seedApp();
    const res = await app.inject({ method: 'GET', url: '/api/artifacts?type=image', headers: AUTH });
    const body = JSON.parse(res.body);
    assert.ok(body.artifacts.length > 0);
    assert.ok(body.artifacts.every((a) => a.type === 'image'));
  });

  it('?type=audio returns only audio artifacts', async () => {
    app = await seedApp();
    const res = await app.inject({ method: 'GET', url: '/api/artifacts?type=audio', headers: AUTH });
    const body = JSON.parse(res.body);
    assert.ok(body.artifacts.every((a) => a.type === 'audio'));
  });

  // --- ?q= search ---
  it('?q=report matches artifact names (case-insensitive substring)', async () => {
    app = await seedApp();
    const res = await app.inject({ method: 'GET', url: '/api/artifacts?q=report', headers: AUTH });
    const body = JSON.parse(res.body);
    assert.ok(body.artifacts.length > 0);
    assert.ok(body.artifacts.every((a) => a.name.toLowerCase().includes('report')));
  });

  it('?q=SCREENSHOT matches case-insensitively', async () => {
    app = await seedApp();
    const res = await app.inject({ method: 'GET', url: '/api/artifacts?q=SCREENSHOT', headers: AUTH });
    const body = JSON.parse(res.body);
    assert.ok(body.artifacts.length > 0);
    assert.ok(body.artifacts.some((a) => a.name.toLowerCase().includes('screenshot')));
  });

  it('?q=zzzzz returns empty', async () => {
    app = await seedApp();
    const res = await app.inject({ method: 'GET', url: '/api/artifacts?q=zzzzz', headers: AUTH });
    const body = JSON.parse(res.body);
    assert.equal(body.artifacts.length, 0);
  });

  // --- Combined filters ---
  it('?type=file&cat=codex narrows to codex files only', async () => {
    app = await seedApp();
    const res = await app.inject({ method: 'GET', url: '/api/artifacts?type=file&cat=codex', headers: AUTH });
    const body = JSON.parse(res.body);
    assert.ok(body.artifacts.length > 0);
    assert.ok(body.artifacts.every((a) => a.type === 'file' && a.catId === 'codex'));
  });

  it('?cat=opus&q=index narrows to opus artifacts matching "index"', async () => {
    app = await seedApp();
    const res = await app.inject({ method: 'GET', url: '/api/artifacts?cat=opus&q=index', headers: AUTH });
    const body = JSON.parse(res.body);
    assert.ok(body.artifacts.every((a) => a.catId === 'opus' && a.name.toLowerCase().includes('index')));
  });

  // --- Duplicate query param robustness (cloud P2: array q → 500) ---
  it('?q=report&q=log does not crash (duplicate param)', async () => {
    app = await seedApp();
    const res = await app.inject({ method: 'GET', url: '/api/artifacts?q=report&q=log', headers: AUTH });
    assert.equal(res.statusCode, 200, 'should not 500 on duplicate q param');
  });

  // --- ?cat=— filters null-catId artifacts (P1 fix: sentinel normalization) ---
  it('?cat=— returns artifacts with null catId', async () => {
    app = await makeApp({
      threads: [T1, T2, T3],
      threadMessages: { T1: messagesT1, T2: messagesT2, T3: messagesT3 },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/artifacts?cat=${encodeURIComponent('—')}`,
      headers: AUTH,
    });
    const body = JSON.parse(res.body);
    assert.equal(body.artifacts.length, 1, 'should find the null-catId artifact');
    assert.equal(body.artifacts[0].catId, null);
  });
});
