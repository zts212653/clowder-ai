import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

describe('GET/PUT /api/config/conversation-view (F322)', () => {
  const OWNER_ID = 'conversation-view-owner';
  const ownerHeaders = { 'x-cat-cafe-user': OWNER_ID };
  const browserHeaders = { origin: 'http://localhost:3003', 'x-test-session-user': OWNER_ID };
  let app;
  let projectRoot;

  const threads = new Map([
    [
      'thread-owned',
      {
        id: 'thread-owned',
        createdBy: OWNER_ID,
        participants: ['opus55', 'codex-sol'],
      },
    ],
    [
      'thread-foreign',
      {
        id: 'thread-foreign',
        createdBy: 'another-owner',
        participants: ['opus55'],
      },
    ],
  ]);

  const threadStore = {
    get: async (threadId) => threads.get(threadId) ?? null,
    list: async () => [...threads.values()],
    getThreadMetadata: async () => null,
    atomicMergeThreadMetadata: async () => null,
  };

  async function setup() {
    const { configRoutes } = await import('../../dist/routes/config.js');
    app = Fastify();
    app.addHook('onRequest', (request, _reply, done) => {
      const sessionUserId = request.headers['x-test-session-user'];
      if (typeof sessionUserId === 'string') request.sessionUserId = sessionUserId;
      done();
    });
    await app.register(configRoutes, { projectRoot, threadStore });
    await app.ready();
  }

  beforeEach(async () => {
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    projectRoot = await mkdtemp(join(tmpdir(), 'conversation-view-preference-'));
    await setup();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    delete process.env.DEFAULT_OWNER_USER_ID;
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('persists a confirmed per-thread cat view across API recreation without clobbering sibling preferences', async () => {
    await mkdir(join(projectRoot, '.cat-cafe'), { recursive: true });
    await writeFile(
      join(projectRoot, '.cat-cafe', 'user-preferences.json'),
      `${JSON.stringify(
        {
          catOrder: ['opus55'],
          conversationViews: {
            futureScope: 'preserve-me',
            threads: { 'future-thread': { mode: 'future-mode', detail: 'keep-me' } },
          },
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );

    const initial = await app.inject({
      method: 'GET',
      url: '/api/config/conversation-view?threadId=thread-owned',
      headers: ownerHeaders,
    });
    assert.equal(initial.statusCode, 200, initial.payload);
    assert.deepEqual(initial.json(), {
      stored: null,
      effective: { mode: 'group' },
      source: 'product',
    });

    const save = await app.inject({
      method: 'PUT',
      url: '/api/config/conversation-view',
      headers: browserHeaders,
      payload: { threadId: 'thread-owned', view: { mode: 'cat', catId: 'opus55' } },
    });
    assert.equal(save.statusCode, 200, save.payload);
    assert.deepEqual(save.json(), {
      stored: { mode: 'cat', catId: 'opus55' },
      effective: { mode: 'cat', catId: 'opus55' },
      source: 'thread',
    });

    await app.close();
    app = undefined;
    await setup();
    const restored = await app.inject({
      method: 'GET',
      url: '/api/config/conversation-view?threadId=thread-owned',
      headers: ownerHeaders,
    });
    assert.deepEqual(restored.json(), save.json());

    const persisted = JSON.parse(await readFile(join(projectRoot, '.cat-cafe', 'user-preferences.json'), 'utf-8'));
    assert.deepEqual(persisted.catOrder, ['opus55']);
    assert.equal(persisted.conversationViews.futureScope, 'preserve-me');
    assert.deepEqual(persisted.conversationViews.threads['future-thread'], {
      mode: 'future-mode',
      detail: 'keep-me',
    });
    assert.deepEqual(persisted.conversationViews.threads['thread-owned'], { mode: 'cat', catId: 'opus55' });
  });

  it('stores an explicit group choice and falls back to group without overwriting a missing participant preference', async () => {
    const group = await app.inject({
      method: 'PUT',
      url: '/api/config/conversation-view',
      headers: ownerHeaders,
      payload: { threadId: 'thread-owned', view: { mode: 'group' } },
    });
    assert.equal(group.statusCode, 200, group.payload);
    assert.deepEqual(group.json(), {
      stored: { mode: 'group' },
      effective: { mode: 'group' },
      source: 'thread',
    });

    await writeFile(
      join(projectRoot, '.cat-cafe', 'user-preferences.json'),
      JSON.stringify({ conversationViews: { threads: { 'thread-owned': { mode: 'cat', catId: 'departed-cat' } } } }),
      'utf-8',
    );
    const fallback = await app.inject({
      method: 'GET',
      url: '/api/config/conversation-view?threadId=thread-owned',
      headers: ownerHeaders,
    });
    assert.deepEqual(fallback.json(), {
      stored: { mode: 'cat', catId: 'departed-cat' },
      effective: { mode: 'group' },
      source: 'participant_missing',
    });
    const persisted = JSON.parse(await readFile(join(projectRoot, '.cat-cafe', 'user-preferences.json'), 'utf-8'));
    assert.deepEqual(persisted.conversationViews.threads['thread-owned'], {
      mode: 'cat',
      catId: 'departed-cat',
    });
  });

  it('requires the strict owner session, hides foreign threads, and rejects cats outside the conversation', async () => {
    const browserWithoutSession = await app.inject({
      method: 'PUT',
      url: '/api/config/conversation-view',
      headers: { origin: 'http://localhost:3003' },
      payload: { threadId: 'thread-owned', view: { mode: 'group' } },
    });
    assert.equal(browserWithoutSession.statusCode, 401, browserWithoutSession.payload);

    const guest = await app.inject({
      method: 'PUT',
      url: '/api/config/conversation-view',
      headers: { 'x-cat-cafe-user': 'guest' },
      payload: { threadId: 'thread-owned', view: { mode: 'group' } },
    });
    assert.equal(guest.statusCode, 403, guest.payload);

    const foreign = await app.inject({
      method: 'GET',
      url: '/api/config/conversation-view?threadId=thread-foreign',
      headers: ownerHeaders,
    });
    assert.equal(foreign.statusCode, 404, foreign.payload);

    const nonParticipant = await app.inject({
      method: 'PUT',
      url: '/api/config/conversation-view',
      headers: ownerHeaders,
      payload: { threadId: 'thread-owned', view: { mode: 'cat', catId: 'gemini38' } },
    });
    assert.equal(nonParticipant.statusCode, 400, nonParticipant.payload);
  });
});
