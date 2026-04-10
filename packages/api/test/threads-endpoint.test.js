/**
 * Thread API endpoint tests
 * POST /api/threads, GET /api/threads, GET /api/threads/:id,
 * PATCH /api/threads/:id, DELETE /api/threads/:id
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

describe('Thread API', () => {
  let app;
  let threadStore;

  beforeEach(async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { threadsRoutes } = await import('../dist/routes/threads.js');

    threadStore = new ThreadStore();
    app = Fastify();
    await app.register(threadsRoutes, { threadStore });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('POST /api/threads creates a thread', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads',
      payload: { userId: 'alice', title: 'My Chat' },
    });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.ok(body.id);
    assert.equal(body.title, 'My Chat');
    assert.equal(body.createdBy, 'alice');
    assert.deepEqual(body.participants, []);
  });

  it('POST /api/threads keeps omitted projectPath as default', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads',
      payload: { userId: 'alice', title: 'Lobby Chat' },
    });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.projectPath, 'default');
  });

  it('POST /api/threads with pinned=true creates a pinned thread', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads',
      payload: { userId: 'alice', title: 'Pinned Chat', pinned: true },
    });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.pinned, true);
    assert.ok(body.pinnedAt);
  });

  it('POST /api/threads with backlogItemId links the thread when item exists', async () => {
    // Pre-create the backlog item so validation passes
    const { BacklogStore } = await import('../dist/domains/cats/services/stores/ports/BacklogStore.js');
    const { threadsRoutes } = await import('../dist/routes/threads.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const backlogStore = new BacklogStore();
    const item = backlogStore.create({
      userId: 'alice',
      title: 'F095 Sidebar',
      summary: 'sidebar nav',
      priority: 'medium',
      tags: [],
      createdBy: 'user',
    });

    const localThreadStore = new ThreadStore();
    const localApp = Fastify();
    await localApp.register(threadsRoutes, { threadStore: localThreadStore, backlogStore });
    await localApp.ready();

    const res = await localApp.inject({
      method: 'POST',
      url: '/api/threads',
      payload: { userId: 'alice', title: 'Feat Thread', backlogItemId: item.id },
    });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.backlogItemId, item.id);

    await localApp.close();
  });

  it('POST /api/threads rejects non-existent backlogItemId with 400', async () => {
    const { BacklogStore } = await import('../dist/domains/cats/services/stores/ports/BacklogStore.js');
    const { threadsRoutes } = await import('../dist/routes/threads.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const backlogStore = new BacklogStore();
    // No items created — 'ghost-feat' does not exist

    const localThreadStore = new ThreadStore();
    const localApp = Fastify();
    await localApp.register(threadsRoutes, { threadStore: localThreadStore, backlogStore });
    await localApp.ready();

    const res = await localApp.inject({
      method: 'POST',
      url: '/api/threads',
      payload: { userId: 'alice', title: 'Ghost Thread', backlogItemId: 'ghost-feat' },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error?.includes('backlog'));

    await localApp.close();
  });

  it('POST /api/threads rejects cross-user backlogItemId with 400', async () => {
    const { BacklogStore } = await import('../dist/domains/cats/services/stores/ports/BacklogStore.js');
    const { threadsRoutes } = await import('../dist/routes/threads.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const backlogStore = new BacklogStore();
    // Create item owned by bob
    const bobItem = backlogStore.create({
      userId: 'bob',
      title: 'Bob Feature',
      summary: 'bob only',
      priority: 'medium',
      tags: [],
      createdBy: 'user',
    });

    const localThreadStore = new ThreadStore();
    const localApp = Fastify();
    await localApp.register(threadsRoutes, { threadStore: localThreadStore, backlogStore });
    await localApp.ready();

    // Alice tries to link bob's item
    const res = await localApp.inject({
      method: 'POST',
      url: '/api/threads',
      payload: { userId: 'alice', title: 'Cross User', backlogItemId: bobItem.id },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error?.includes('backlog'));

    await localApp.close();
  });

  it('POST /api/threads returns 401 for missing identity', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads',
      payload: { title: 'No User' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('GET /api/threads lists user threads', async () => {
    threadStore.create('alice', 'Thread A');
    threadStore.create('alice', 'Thread B');
    threadStore.create('bob', 'Thread C');

    const res = await app.inject({
      method: 'GET',
      url: '/api/threads?userId=alice',
    });
    const body = JSON.parse(res.body);
    // alice has 2 custom + default thread
    const titles = body.threads.map((t) => t.title);
    assert.ok(titles.includes('Thread A'));
    assert.ok(titles.includes('Thread B'));
    assert.ok(!titles.includes('Thread C'));
  });

  it('GET /api/threads supports case-insensitive title search via q', async () => {
    threadStore.create('alice', 'Frontend polish');
    threadStore.create('alice', 'Backend Thread Search');
    threadStore.create('alice', 'Random chat');

    const res = await app.inject({
      method: 'GET',
      url: '/api/threads?userId=alice&q=thread',
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const titles = body.threads.map((t) => t.title);
    assert.deepEqual(titles, ['Backend Thread Search']);
  });

  it('GET /api/threads matches exact threadId via q', async () => {
    const t = threadStore.create('alice', 'Some thread');
    threadStore.create('alice', 'Another thread');

    const res = await app.inject({
      method: 'GET',
      url: `/api/threads?userId=alice&q=${t.id}`,
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.threads.length, 1);
    assert.equal(body.threads[0].id, t.id);
  });

  it('GET /api/threads filters by backlogItemIds without leaking other user threads', async () => {
    const aliceThread = threadStore.create('alice', 'Alice Linked');
    const bobThread = threadStore.create('bob', 'Bob Linked');
    const aliceOther = threadStore.create('alice', 'Alice Unlinked');

    threadStore.linkBacklogItem(aliceThread.id, 'b-alice-1');
    threadStore.linkBacklogItem(bobThread.id, 'b-bob-1');
    threadStore.linkBacklogItem(aliceOther.id, 'b-alice-2');

    const res = await app.inject({
      method: 'GET',
      url: '/api/threads?userId=alice&backlogItemIds=b-alice-1,b-bob-1',
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const threadIds = body.threads.map((thread) => thread.id);
    const titles = body.threads.map((thread) => thread.title);

    assert.ok(threadIds.includes(aliceThread.id));
    assert.ok(!threadIds.includes(bobThread.id));
    assert.ok(!threadIds.includes(aliceOther.id));
    assert.ok(!titles.includes('Bob Linked'));
  });

  it('GET /api/threads rejects backlogItemIds with more than 50 IDs', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `id-${i}`).join(',');
    const res = await app.inject({
      method: 'GET',
      url: `/api/threads?userId=alice&backlogItemIds=${encodeURIComponent(ids)}`,
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error?.includes('50'));
  });

  it('GET /api/threads accepts backlogItemIds with exactly 50 IDs', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `id-${i}`).join(',');
    const res = await app.inject({
      method: 'GET',
      url: `/api/threads?userId=alice&backlogItemIds=${encodeURIComponent(ids)}`,
    });
    assert.equal(res.statusCode, 200);
  });

  it('GET /api/threads supports hasBacklogItemId=true without leaking other user threads', async () => {
    const aliceLinked = threadStore.create('alice', 'Alice Linked');
    const aliceUnlinked = threadStore.create('alice', 'Alice Unlinked');
    const bobLinked = threadStore.create('bob', 'Bob Linked');

    threadStore.linkBacklogItem(aliceLinked.id, 'b-alice-linked');
    threadStore.linkBacklogItem(bobLinked.id, 'b-bob-linked');

    const res = await app.inject({
      method: 'GET',
      url: '/api/threads?userId=alice&hasBacklogItemId=true',
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const threadIds = body.threads.map((thread) => thread.id);
    const titles = body.threads.map((thread) => thread.title);

    assert.ok(threadIds.includes(aliceLinked.id));
    assert.ok(!threadIds.includes(aliceUnlinked.id));
    assert.ok(!threadIds.includes(bobLinked.id));
    assert.ok(!titles.includes('Bob Linked'));
  });

  it('GET /api/threads treats hasBacklogItemId=false as no filter', async () => {
    const aliceLinked = threadStore.create('alice', 'Alice Linked');
    const aliceUnlinked = threadStore.create('alice', 'Alice Unlinked');
    const bobLinked = threadStore.create('bob', 'Bob Linked');

    threadStore.linkBacklogItem(aliceLinked.id, 'b-alice-linked');
    threadStore.linkBacklogItem(bobLinked.id, 'b-bob-linked');

    const res = await app.inject({
      method: 'GET',
      url: '/api/threads?userId=alice&hasBacklogItemId=false',
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const threadIds = body.threads.map((thread) => thread.id);
    const titles = body.threads.map((thread) => thread.title);

    assert.ok(threadIds.includes(aliceLinked.id));
    assert.ok(threadIds.includes(aliceUnlinked.id));
    assert.ok(!threadIds.includes(bobLinked.id));
    assert.ok(!titles.includes('Bob Linked'));
  });

  it('GET /api/threads with featureIds returns threadsByFeature grouped by title match', async () => {
    threadStore.create('alice', 'f058 phase A 实现');
    threadStore.create('alice', 'f058 phase B review');
    threadStore.create('alice', 'f042 prompt audit');
    threadStore.create('alice', 'unrelated thread');

    const res = await app.inject({
      method: 'GET',
      url: '/api/threads?userId=alice&featureIds=f058,f042',
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.threadsByFeature);
    assert.equal(body.threadsByFeature.F058?.length, 2);
    assert.equal(body.threadsByFeature.F042?.length, 1);
    assert.equal(body.threadsByFeature.F042[0].title, 'f042 prompt audit');
  });

  it('GET /api/threads with featureIds matches titles without leading zeros (f063 → f63)', async () => {
    threadStore.create('alice', 'f63 文件概览的冷启动守护');
    threadStore.create('alice', 'f63 文件预览');
    threadStore.create('alice', 'f063 padded title');

    const res = await app.inject({
      method: 'GET',
      url: '/api/threads?userId=alice&featureIds=F063',
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.threadsByFeature);
    // Should match both "f63" (no leading zero) and "f063" (padded) variants
    assert.equal(body.threadsByFeature.F063?.length, 3);
  });

  it('GET /api/threads with featureIds rejects more than 50 IDs', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `f${String(i).padStart(3, '0')}`).join(',');
    const res = await app.inject({
      method: 'GET',
      url: `/api/threads?userId=alice&featureIds=${encodeURIComponent(ids)}`,
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error?.includes('50'));
  });

  it('GET /api/threads/:id returns thread details', async () => {
    const thread = threadStore.create('alice', 'Details Test');

    const res = await app.inject({
      method: 'GET',
      url: `/api/threads/${thread.id}`,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.id, thread.id);
    assert.equal(body.title, 'Details Test');
  });

  it('GET /api/threads/:id returns 404 for nonexistent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/nonexistent-id',
    });
    assert.equal(res.statusCode, 404);
  });

  it('PATCH /api/threads/:id updates title', async () => {
    const thread = threadStore.create('alice', 'Old Title');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}`,
      payload: { title: 'New Title' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.title, 'New Title');
  });

  it('PATCH /api/threads/:id persists via threadStore.updateTitle (regression: Redis)', async () => {
    const persisted = {
      id: 'thread-1',
      projectPath: 'default',
      title: 'Original Title',
      createdBy: 'alice',
      participants: [],
      lastActiveAt: Date.now(),
      createdAt: Date.now(),
    };

    const fakeStore = {
      create: () => persisted,
      get: (threadId) => {
        if (threadId !== persisted.id) return null;
        // Simulate Redis hydration: return a fresh object on every read
        return {
          ...persisted,
          participants: [...persisted.participants],
        };
      },
      list: () => [persisted],
      listByProject: () => [persisted],
      addParticipants: () => {},
      getParticipants: () => [],
      updateTitle: (threadId, title) => {
        if (threadId === persisted.id) persisted.title = title;
      },
      updateLastActive: () => {},
      delete: () => true,
    };

    const { threadsRoutes } = await import('../dist/routes/threads.js');
    const isolated = Fastify();
    await isolated.register(threadsRoutes, { threadStore: fakeStore });
    await isolated.ready();

    const res = await isolated.inject({
      method: 'PATCH',
      url: `/api/threads/${persisted.id}`,
      payload: { title: 'Renamed Title' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.title, 'Renamed Title');
    assert.equal(persisted.title, 'Renamed Title');

    await isolated.close();
  });

  it('PATCH /api/threads/:id returns 404 for nonexistent', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/threads/nonexistent-id',
      payload: { title: 'New Title' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('PATCH /api/threads/:id returns 400 for blank title', async () => {
    const thread = threadStore.create('alice', 'Title Before');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}`,
      payload: { title: '   ' },
    });

    assert.equal(res.statusCode, 400);
  });

  it('PATCH /api/threads/:id sets pinned=true', async () => {
    const thread = threadStore.create('alice', 'Pin Test');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}`,
      payload: { pinned: true },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.pinned, true);
    assert.ok(body.pinnedAt > 0);
  });

  it('PATCH /api/threads/:id sets pinned=false', async () => {
    const thread = threadStore.create('alice', 'Unpin Test');
    threadStore.updatePin(thread.id, true);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}`,
      payload: { pinned: false },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.pinned, false);
    assert.equal(body.pinnedAt, null);
  });

  it('PATCH /api/threads/:id sets favorited=true', async () => {
    const thread = threadStore.create('alice', 'Fav Test');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}`,
      payload: { favorited: true },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.favorited, true);
    assert.ok(body.favoritedAt > 0);
  });

  it('PATCH /api/threads/:id sets favorited=false', async () => {
    const thread = threadStore.create('alice', 'Unfav Test');
    threadStore.updateFavorite(thread.id, true);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}`,
      payload: { favorited: false },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.favorited, false);
    assert.equal(body.favoritedAt, null);
  });

  it('PATCH /api/threads/:id can update pin and title together', async () => {
    const thread = threadStore.create('alice', 'Multi Update');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}`,
      payload: { title: 'New Title', pinned: true },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.title, 'New Title');
    assert.equal(body.pinned, true);
  });

  it('PATCH /api/threads/:id rejects mentionActionabilityMode-only payload (field removed)', async () => {
    const thread = threadStore.create('alice', 'Mention Mode Removed');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}`,
      payload: { mentionActionabilityMode: 'relaxed' },
    });
    assert.equal(res.statusCode, 400, 'mentionActionabilityMode is no longer a valid field');
  });

  it('PATCH /api/threads/:id returns 400 for empty body', async () => {
    const thread = threadStore.create('alice', 'Empty Body');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}`,
      payload: {},
    });
    assert.equal(res.statusCode, 400);
  });

  it('PATCH /api/threads/:id rejects multiline routingPolicy reason', async () => {
    const thread = threadStore.create('alice', 'Routing Policy Validation');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}`,
      payload: {
        routingPolicy: {
          v: 1,
          scopes: {
            review: {
              avoidCats: ['opus'],
              reason: 'budget\ninject',
            },
          },
        },
      },
    });

    assert.equal(res.statusCode, 400);
  });

  it('DELETE /api/threads/:id soft-deletes thread (Phase D)', async () => {
    const thread = threadStore.create('alice', 'To Delete');

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/threads/${thread.id}`,
    });
    assert.equal(res.statusCode, 204);

    // Thread still exists but has deletedAt set (soft delete)
    const check = threadStore.get(thread.id);
    assert.ok(check, 'thread should still exist after soft delete');
    assert.ok(check.deletedAt, 'deletedAt should be set');
  });

  it('DELETE /api/threads/:id cannot delete default thread', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/threads/default',
    });
    assert.equal(res.statusCode, 400);
  });
});

describe('Thread soft-delete preserves data (Phase D)', () => {
  let app;
  let threadStore;
  let messageStore;
  let taskStore;
  let memoryStore;

  beforeEach(async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const { MemoryStore } = await import('../dist/domains/cats/services/stores/ports/MemoryStore.js');
    const { threadsRoutes } = await import('../dist/routes/threads.js');

    threadStore = new ThreadStore();
    messageStore = new MessageStore();
    taskStore = new TaskStore();
    memoryStore = new MemoryStore();

    app = Fastify();
    await app.register(threadsRoutes, {
      threadStore,
      messageStore,
      taskStore,
      memoryStore,
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('DELETE /api/threads/:id soft-deletes but preserves messages, tasks, and memory', async () => {
    const thread = threadStore.create('alice', 'Cascade Test');
    const threadId = thread.id;

    // Add some messages
    messageStore.append({
      userId: 'alice',
      catId: null,
      content: 'test message 1',
      mentions: [],
      timestamp: Date.now(),
      threadId,
    });
    messageStore.append({
      userId: 'alice',
      catId: null,
      content: 'test message 2',
      mentions: [],
      timestamp: Date.now() + 1,
      threadId,
    });

    // Add a task
    taskStore.create({
      threadId,
      title: 'Test task',
      why: 'testing',
      createdBy: 'user',
    });

    // Add memory
    memoryStore.set({
      threadId,
      key: 'test-key',
      value: 'test-value',
      updatedBy: 'user',
    });

    // Verify data exists
    assert.equal(messageStore.getByThread(threadId).length, 2);
    assert.equal(taskStore.listByThread(threadId).length, 1);
    assert.equal(memoryStore.list(threadId).length, 1);

    // Soft-delete thread
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/threads/${threadId}`,
    });
    assert.equal(res.statusCode, 204);

    // Thread still exists with deletedAt (soft delete)
    const after = threadStore.get(threadId);
    assert.ok(after, 'thread should still exist');
    assert.ok(after.deletedAt, 'deletedAt should be set');

    // Data preserved for potential restore
    assert.equal(messageStore.getByThread(threadId).length, 2);
    assert.equal(taskStore.listByThread(threadId).length, 1);
    assert.equal(memoryStore.list(threadId).length, 1);
  });
});

describe('Thread delete invocation protection (#35)', () => {
  it('DELETE returns 409 when thread has active invocation', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { threadsRoutes } = await import('../dist/routes/threads.js');

    const threadStore = new ThreadStore();
    const thread = threadStore.create('alice', 'Active Thread');

    // guardDelete returns acquired:false when thread has active invocation
    const mockTracker = {
      guardDelete: (id) =>
        id === thread.id ? { acquired: false, release: () => {} } : { acquired: true, release: () => {} },
    };

    const app = Fastify();
    await app.register(threadsRoutes, { threadStore, invocationTracker: mockTracker });
    await app.ready();

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/threads/${thread.id}`,
    });
    assert.equal(res.statusCode, 409);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'ACTIVE_INVOCATION');

    // Thread should still exist
    assert.ok(threadStore.get(thread.id));

    await app.close();
  });

  it('DELETE succeeds when no active invocation', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { threadsRoutes } = await import('../dist/routes/threads.js');

    const threadStore = new ThreadStore();
    const thread = threadStore.create('alice', 'Idle Thread');

    let released = false;
    const mockTracker = {
      guardDelete: () => ({
        acquired: true,
        release: () => {
          released = true;
        },
      }),
    };

    const app = Fastify();
    await app.register(threadsRoutes, { threadStore, invocationTracker: mockTracker });
    await app.ready();

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/threads/${thread.id}`,
    });
    assert.equal(res.statusCode, 204);
    // Guard must be released after delete
    assert.ok(released, 'delete guard should be released');

    await app.close();
  });

  it('guardDelete blocks start() during async delete window', async () => {
    const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');

    const tracker = new InvocationTracker();
    const threadId = 'race-test-thread';

    // 1. No active invocation — guard should succeed
    const guard = tracker.guardDelete(threadId);
    assert.ok(guard.acquired, 'guard should be acquired when no active invocation');

    // 2. While guard is held, start() should return pre-aborted controller
    const controller = tracker.start(threadId, 'user1');
    assert.ok(controller.signal.aborted, 'controller should be pre-aborted during delete guard');

    // 3. has() should return false (start didn't register the invocation)
    assert.ok(!tracker.has(threadId), 'thread should not have active invocation during delete guard');

    // 4. Release guard
    guard.release();

    // 5. After release, start() should work normally
    const controller2 = tracker.start(threadId, 'user2');
    assert.ok(!controller2.signal.aborted, 'controller should not be aborted after guard released');
    assert.ok(tracker.has(threadId), 'thread should have active invocation after normal start');

    // Cleanup
    tracker.complete(threadId);
  });
});

describe('Thread delete audit failure resilience (P1 fix)', () => {
  it('DELETE succeeds even when audit log append rejects', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { threadsRoutes } = await import('../dist/routes/threads.js');
    const { getEventAuditLog } = await import('../dist/domains/cats/services/orchestration/EventAuditLog.js');

    const threadStore = new ThreadStore();
    const thread = threadStore.create('alice', 'Audit Fail Thread');

    const app = Fastify();
    await app.register(threadsRoutes, { threadStore });
    await app.ready();

    // Mock append to reject (simulates unwritable audit dir)
    const auditLog = getEventAuditLog();
    const originalAppend = auditLog.append.bind(auditLog);
    auditLog.append = () => Promise.reject(new Error('ENOTDIR: simulated audit failure'));

    // Track unhandled rejections
    let unhandled = false;
    const handler = () => {
      unhandled = true;
    };
    process.on('unhandledRejection', handler);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/threads/${thread.id}`,
    });
    assert.equal(res.statusCode, 204);

    // Give event loop a tick for any unhandled rejection to fire
    await new Promise((r) => setTimeout(r, 50));
    process.removeListener('unhandledRejection', handler);

    assert.equal(unhandled, false, 'audit failure must not cause unhandled rejection');
    // Phase D: soft delete — thread exists but has deletedAt
    const after = threadStore.get(thread.id);
    assert.ok(after, 'thread should still exist (soft delete)');
    assert.ok(after.deletedAt, 'deletedAt should be set');

    // Restore
    auditLog.append = originalAppend;
    await app.close();
  });
});

describe('F095 Phase D: Soft delete + trash bin', () => {
  let app;
  let threadStore;

  beforeEach(async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { threadsRoutes } = await import('../dist/routes/threads.js');

    threadStore = new ThreadStore();
    app = Fastify();
    await app.register(threadsRoutes, { threadStore });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('DELETE /api/threads/:id soft-deletes instead of hard-deleting', async () => {
    const thread = threadStore.create('alice', 'Soft Delete Me');

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/threads/${thread.id}`,
    });
    assert.equal(res.statusCode, 204);

    // Thread still exists but has deletedAt set
    const after = threadStore.get(thread.id);
    assert.ok(after, 'thread should still exist after soft delete');
    assert.ok(after.deletedAt, 'deletedAt should be set');
  });

  it('soft-deleted threads are excluded from GET /api/threads list', async () => {
    const t1 = threadStore.create('alice', 'Active Thread');
    const t2 = threadStore.create('alice', 'Deleted Thread');
    threadStore.softDelete(t2.id);

    const res = await app.inject({
      method: 'GET',
      url: '/api/threads?userId=alice',
    });
    const body = JSON.parse(res.body);
    const ids = body.threads.map((t) => t.id);
    assert.ok(ids.includes(t1.id), 'active thread should be listed');
    assert.ok(!ids.includes(t2.id), 'soft-deleted thread should not be listed');
  });

  it('POST /api/threads/:id/restore restores a soft-deleted thread', async () => {
    const thread = threadStore.create('alice', 'Restore Me');
    threadStore.softDelete(thread.id);
    assert.ok(threadStore.get(thread.id).deletedAt, 'precondition: should be soft-deleted');

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/restore`,
    });
    assert.equal(res.statusCode, 200);

    const restored = threadStore.get(thread.id);
    assert.ok(!restored.deletedAt, 'deletedAt should be cleared after restore');
  });

  it('POST /api/threads/:id/restore returns 400 for non-deleted thread', async () => {
    const thread = threadStore.create('alice', 'Not Deleted');

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/restore`,
    });
    assert.equal(res.statusCode, 400);
  });

  it('POST /api/threads/:id/restore returns 404 for nonexistent thread', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/nonexistent-id/restore',
    });
    assert.equal(res.statusCode, 404);
  });

  it('GET /api/threads?deleted=true lists only soft-deleted threads', async () => {
    threadStore.create('alice', 'Active');
    const t2 = threadStore.create('alice', 'Trashed 1');
    const t3 = threadStore.create('alice', 'Trashed 2');
    threadStore.softDelete(t2.id);
    threadStore.softDelete(t3.id);

    const res = await app.inject({
      method: 'GET',
      url: '/api/threads?userId=alice&deleted=true',
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.threads.length, 2);
    const titles = body.threads.map((t) => t.title);
    assert.ok(titles.includes('Trashed 1'));
    assert.ok(titles.includes('Trashed 2'));
  });

  it('PATCH /api/threads/:id returns 404 for soft-deleted thread (P1 fix)', async () => {
    const thread = threadStore.create('alice', 'Deleted Thread');
    threadStore.softDelete(thread.id);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}`,
      payload: { title: 'Should Not Work' },
    });
    assert.equal(res.statusCode, 404, 'PATCH on soft-deleted thread should return 404');
    // Title should NOT have changed
    const after = threadStore.get(thread.id);
    assert.equal(after.title, 'Deleted Thread', 'title should not be modified');
  });

  it('soft-deleted thread cannot be double-deleted', async () => {
    const thread = threadStore.create('alice', 'Already Deleted');
    threadStore.softDelete(thread.id);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/threads/${thread.id}`,
    });
    assert.equal(res.statusCode, 400, 'double soft-delete should fail');
  });

  it('DELETE /api/threads/default still rejects', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/threads/default',
    });
    assert.equal(res.statusCode, 400);
  });
});

describe('GET /api/messages with threadId', () => {
  let app;
  let messageStore;

  beforeEach(async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { messagesRoutes } = await import('../dist/routes/messages.js');

    messageStore = new MessageStore();
    app = Fastify();
    await app.register(messagesRoutes, {
      registry: new InvocationRegistry(),
      messageStore,
      socketManager: { broadcastAgentMessage: () => {} },
      threadStore: new ThreadStore(),
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('returns only messages for the specified thread', async () => {
    messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'thread-a msg',
      mentions: [],
      timestamp: 1000,
      threadId: 'thread-a',
    });
    messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'thread-b msg',
      mentions: [],
      timestamp: 2000,
      threadId: 'thread-b',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?threadId=thread-a',
    });
    const body = JSON.parse(res.body);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].content, 'thread-a msg');
  });

  it('thread query filters by userId (regression: cross-user leak)', async () => {
    messageStore.append({
      userId: 'alice',
      catId: null,
      content: 'alice in thread',
      mentions: [],
      timestamp: 1000,
      threadId: 'shared-thread',
    });
    messageStore.append({
      userId: 'bob',
      catId: null,
      content: 'bob in thread',
      mentions: [],
      timestamp: 2000,
      threadId: 'shared-thread',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?threadId=shared-thread&userId=alice',
    });
    const body = JSON.parse(res.body);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].content, 'alice in thread');
  });

  it('thread-scoped pagination with before cursor', async () => {
    for (let i = 0; i < 5; i++) {
      messageStore.append({
        userId: 'default-user',
        catId: null,
        content: `t-msg ${i}`,
        mentions: [],
        timestamp: 1000 + i * 100,
        threadId: 'paginated-thread',
      });
    }

    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?threadId=paginated-thread&before=1300&limit=10',
    });
    const body = JSON.parse(res.body);
    assert.equal(body.messages.length, 3);
    assert.equal(body.messages[0].content, 't-msg 0');
    assert.equal(body.messages[2].content, 't-msg 2');
  });
});
