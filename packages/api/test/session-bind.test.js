/**
 * Session Manual Bind Tests
 * F24 Phase B / BACKLOG #72: 铲屎官手动绑定 CLI Session ID
 *
 * PATCH /api/threads/:threadId/sessions/:catId/bind
 * Body: { cliSessionId: string }
 *
 * Two modes:
 * - Active session exists → update cliSessionId
 * - No active session → create new session with given cliSessionId
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('Session manual bind (unit)', () => {
  async function loadModules() {
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    return { SessionChainStore };
  }

  const BASE_INPUT = {
    cliSessionId: 'cli-sess-old',
    threadId: 'thread-1',
    catId: 'opus',
    userId: 'user-1',
  };

  describe('update existing active session', () => {
    test('replaces cliSessionId on active session', async () => {
      const { SessionChainStore } = await loadModules();
      const store = new SessionChainStore();

      const s0 = store.create(BASE_INPUT);
      assert.equal(s0.cliSessionId, 'cli-sess-old');

      // Manual bind: update cliSessionId
      const updated = store.update(s0.id, {
        cliSessionId: 'cli-sess-new',
        updatedAt: Date.now(),
      });

      assert.ok(updated);
      assert.equal(updated.cliSessionId, 'cli-sess-new');
      assert.equal(updated.status, 'active');

      // CLI index updated
      assert.equal(store.getByCliSessionId('cli-sess-new')?.id, s0.id);
      assert.equal(store.getByCliSessionId('cli-sess-old'), null);
    });

    test('getActive still works after bind', async () => {
      const { SessionChainStore } = await loadModules();
      const store = new SessionChainStore();

      const s0 = store.create(BASE_INPUT);
      store.update(s0.id, { cliSessionId: 'cli-sess-new', updatedAt: Date.now() });

      const active = store.getActive('opus', 'thread-1');
      assert.ok(active);
      assert.equal(active.cliSessionId, 'cli-sess-new');
    });
  });

  describe('create new session via bind (no active)', () => {
    test('creates session when no active exists', async () => {
      const { SessionChainStore } = await loadModules();
      const store = new SessionChainStore();

      // No sessions exist yet
      assert.equal(store.getActive('opus', 'thread-1'), null);

      // Bind creates a new session
      const created = store.create({
        cliSessionId: 'cli-manual-bind',
        threadId: 'thread-1',
        catId: 'opus',
        userId: 'user-1',
      });

      assert.ok(created);
      assert.equal(created.cliSessionId, 'cli-manual-bind');
      assert.equal(created.status, 'active');
      assert.equal(created.seq, 0);
    });

    test('creates session after previous sealed', async () => {
      const { SessionChainStore } = await loadModules();
      const store = new SessionChainStore();

      // Create + seal session 0
      const s0 = store.create(BASE_INPUT);
      store.update(s0.id, { status: 'sealed', sealedAt: Date.now(), updatedAt: Date.now() });

      assert.equal(store.getActive('opus', 'thread-1'), null);

      // Bind creates session 1
      const s1 = store.create({
        cliSessionId: 'cli-manual-bind',
        threadId: 'thread-1',
        catId: 'opus',
        userId: 'user-1',
      });

      assert.equal(s1.seq, 1);
      assert.equal(s1.cliSessionId, 'cli-manual-bind');
      assert.equal(s1.status, 'active');
    });
  });
});

describe('Session bind API route', () => {
  async function loadModules() {
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    return { SessionChainStore, ThreadStore };
  }

  /**
   * Minimal Fastify mock for testing route handler logic directly.
   * We test the handler function extracted from the route module.
   */
  async function buildApp() {
    const { SessionChainStore, ThreadStore } = await loadModules();
    // Dynamic import Fastify
    const Fastify = (await import('fastify')).default;
    const { sessionChainRoutes } = await import('../dist/routes/session-chain.js');

    const sessionChainStore = new SessionChainStore();
    const threadStore = new ThreadStore();

    const app = Fastify({ logger: false });
    await app.register(sessionChainRoutes, { sessionChainStore, threadStore });
    await app.ready();

    return { app, sessionChainStore, threadStore };
  }

  test('returns 401 without identity for untrusted browser origin', async () => {
    const { app } = await buildApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/threads/thread-1/sessions/opus/bind',
        headers: { origin: 'https://evil.example' },
        payload: { cliSessionId: 'cli-new' },
      });
      assert.equal(res.statusCode, 401);
    } finally {
      await app.close();
    }
  });

  test('returns 404 for nonexistent thread', async () => {
    const { app } = await buildApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/threads/nonexistent/sessions/opus/bind',
        headers: { 'x-cat-cafe-user': 'user-1' },
        payload: { cliSessionId: 'cli-new' },
      });
      assert.equal(res.statusCode, 404);
    } finally {
      await app.close();
    }
  });

  test('returns 400 for invalid catId', async () => {
    const { app, threadStore } = await buildApp();
    try {
      await threadStore.create('user-1', 'Test');
      const threads = await threadStore.list('user-1');
      const threadId = threads[0].id;

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/threads/${threadId}/sessions/invalid-cat/bind`,
        headers: { 'x-cat-cafe-user': 'user-1' },
        payload: { cliSessionId: 'cli-new' },
      });
      assert.equal(res.statusCode, 400);
    } finally {
      await app.close();
    }
  });

  test('returns 400 for missing cliSessionId', async () => {
    const { app, threadStore } = await buildApp();
    try {
      await threadStore.create('user-1', 'Test');
      const threads = await threadStore.list('user-1');
      const threadId = threads[0].id;

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/threads/${threadId}/sessions/opus/bind`,
        headers: { 'x-cat-cafe-user': 'user-1' },
        payload: {},
      });
      assert.equal(res.statusCode, 400);
    } finally {
      await app.close();
    }
  });

  test('updates existing active session cliSessionId', async () => {
    const { app, threadStore, sessionChainStore } = await buildApp();
    try {
      const thread = await threadStore.create('user-1', 'Test');

      // Pre-create active session
      sessionChainStore.create({
        cliSessionId: 'cli-old',
        threadId: thread.id,
        catId: 'opus',
        userId: 'user-1',
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/threads/${thread.id}/sessions/opus/bind`,
        headers: { 'x-cat-cafe-user': 'user-1' },
        payload: { cliSessionId: 'cli-new' },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.session.cliSessionId, 'cli-new');
      assert.equal(body.session.status, 'active');
      assert.equal(body.mode, 'updated');
    } finally {
      await app.close();
    }
  });

  test('creates new session when no active exists', async () => {
    const { app, threadStore } = await buildApp();
    try {
      const thread = await threadStore.create('user-1', 'Test');

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/threads/${thread.id}/sessions/opus/bind`,
        headers: { 'x-cat-cafe-user': 'user-1' },
        payload: { cliSessionId: 'cli-manual' },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.session.cliSessionId, 'cli-manual');
      assert.equal(body.session.status, 'active');
      assert.equal(body.session.catId, 'opus');
      assert.equal(body.mode, 'created');
    } finally {
      await app.close();
    }
  });

  test('returns 403 for non-owner', async () => {
    const { app, threadStore } = await buildApp();
    try {
      const thread = await threadStore.create('user-1', 'Test');

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/threads/${thread.id}/sessions/opus/bind`,
        headers: { 'x-cat-cafe-user': 'hacker' },
        payload: { cliSessionId: 'cli-evil' },
      });

      assert.equal(res.statusCode, 403);
    } finally {
      await app.close();
    }
  });

  test('returns 403 for non-default system-owned thread', async () => {
    const { app, threadStore } = await buildApp();
    try {
      const thread = await threadStore.create('system', 'System Thread');

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/threads/${thread.id}/sessions/opus/bind`,
        headers: { 'x-cat-cafe-user': 'other-user' },
        payload: { cliSessionId: 'cli-system' },
      });

      assert.equal(res.statusCode, 403);
    } finally {
      await app.close();
    }
  });

  test('returns 403 when default-thread active session belongs to another user', async () => {
    const { app, threadStore, sessionChainStore } = await buildApp();
    try {
      const thread = await threadStore.get('default');

      sessionChainStore.create({
        cliSessionId: 'cli-owner',
        threadId: thread.id,
        catId: 'opus',
        userId: 'owner-user',
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/threads/${thread.id}/sessions/opus/bind`,
        headers: { 'x-cat-cafe-user': 'attacker-user' },
        payload: { cliSessionId: 'cli-evil' },
      });

      assert.equal(res.statusCode, 403);
    } finally {
      await app.close();
    }
  });

  test('supports all valid catIds', async () => {
    const { app, threadStore } = await buildApp();
    try {
      const thread = await threadStore.create('user-1', 'Test');

      for (const catId of ['opus', 'codex', 'gemini']) {
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/threads/${thread.id}/sessions/${catId}/bind`,
          headers: { 'x-cat-cafe-user': 'user-1' },
          payload: { cliSessionId: `cli-${catId}` },
        });

        assert.equal(res.statusCode, 200, `Expected 200 for ${catId}`);
        const body = JSON.parse(res.payload);
        assert.equal(body.session.catId, catId);
      }
    } finally {
      await app.close();
    }
  });
});
