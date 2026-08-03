/**
 * WorkflowSop featureId → backlogItemId resolver tests (F073 follow-up)
 *
 * Red tests for the server-side resolver that allows cats to call
 * cat_cafe_update_workflow with only featureId (no backlogItemId).
 *
 * Invariants (from Sol's review, refined during implementation):
 * 1. Thread binding is strong truth source — no silent fallback on mismatch
 * 2. Fallback scans user-scoped items; multiple matches → ambiguous (fail).
 *    Single match within user's own backlog is treated as unambiguous —
 *    cross-project collision requires explicit backlogItemId to disambiguate.
 * 3. Feature tag validation covers both callback and PUT write paths
 */

import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const INVOCATION_ID = 'inv-resolver-001';
const CALLBACK_TOKEN = 'token-resolver-001';
const USER_ID = 'user-resolver';
const THREAD_ID = 'thread-resolver-1';

// --- Stubs ---

function createStubRegistry({ threadId = THREAD_ID } = {}) {
  return {
    async verify(invId, token) {
      if (invId !== INVOCATION_ID) return { ok: false, reason: 'unknown_invocation' };
      if (token !== CALLBACK_TOKEN) return { ok: false, reason: 'invalid_token' };
      return {
        ok: true,
        record: { catId: 'opus', threadId, userId: USER_ID, ownerAuthProvenance: 'strict' },
      };
    },
  };
}

function createStubBacklogStore(items = []) {
  const map = new Map(items.map((i) => [i.id, i]));
  return {
    map,
    get(itemId, userId) {
      const item = map.get(itemId) ?? null;
      if (item && userId && item.userId !== userId) return null;
      return item;
    },
    listByUser(userId) {
      return [...map.values()].filter((i) => i.userId === userId);
    },
    ensureTaskBackedItem(input) {
      const id = `task:${input.taskId}`;
      const existing = map.get(id);
      if (existing) return existing;
      const item = makeBacklogItem({
        id,
        userId: input.userId,
        featureId: input.featureId,
        tags: ['source:task', `feature:${input.featureId.toLowerCase()}`],
      });
      map.set(id, {
        ...item,
        title: input.title,
        summary: input.summary,
        priority: 'p2',
        createdBy: input.createdBy,
      });
      return map.get(id);
    },
  };
}

function createStubTaskStore(tasks = []) {
  const map = new Map(tasks.map((task) => [task.id, task]));
  return {
    get(taskId) {
      return map.get(taskId) ?? null;
    },
    listByThread(threadId) {
      return [...map.values()].filter((task) => task.threadId === threadId);
    },
  };
}

function createStubThreadStore(threads = []) {
  const map = new Map(threads.map((t) => [t.id, t]));
  return {
    get(threadId) {
      return map.get(threadId) ?? null;
    },
  };
}

function createInMemoryWorkflowSopStore() {
  const store = new Map();
  return {
    store,
    async get(backlogItemId) {
      return store.get(backlogItemId) ?? null;
    },
    async upsert(backlogItemId, featureId, input, updatedBy) {
      const existing = store.get(backlogItemId);
      const now = Date.now();
      const sop = existing
        ? {
            ...existing,
            stage: input.stage ?? existing.stage,
            version: existing.version + 1,
            updatedAt: now,
            updatedBy,
          }
        : {
            featureId,
            backlogItemId,
            sopDefinitionId: 'development',
            stage: input.stage ?? 'kickoff',
            version: 1,
            updatedAt: now,
            updatedBy,
          };
      store.set(backlogItemId, sop);
      return sop;
    },
  };
}

// Helper to make a backlog item with proper production-format tags
function makeBacklogItem({ id, userId = USER_ID, featureId, projectId, tags } = {}) {
  return {
    id,
    userId,
    title: `Feature ${featureId}`,
    summary: 'Test item',
    priority: 'p1',
    tags: tags ?? ['source:docs-backlog', `feature:${featureId.toLowerCase()}`, 'status:active'],
    projectId,
    status: 'open',
    createdBy: 'user',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    audit: [],
  };
}

function makeTask({ id, userId = USER_ID, threadId = THREAD_ID, featureId, kind = 'work', detectedFeatureIds } = {}) {
  return {
    id,
    userId,
    threadId,
    kind,
    subjectKey: null,
    title: `Task for ${featureId}`,
    why: `Durable task truth for ${featureId}`,
    ownerCatId: 'opus',
    status: 'done',
    createdBy: 'opus',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...(featureId ? { relatedFeatureId: featureId } : {}),
    ...(detectedFeatureIds ? { detectedFeatureIds } : {}),
  };
}

function authHeaders() {
  return {
    'content-type': 'application/json',
    'x-invocation-id': INVOCATION_ID,
    'x-callback-token': CALLBACK_TOKEN,
  };
}

// --- Tests ---

describe('WorkflowSop resolver: featureId → backlogItemId', () => {
  let app;
  let workflowSopStore;

  describe('Callback route — backlogItemId omitted (resolver path)', () => {
    before(async () => {
      const module = await import('../dist/routes/callback-workflow-sop-routes.js');
      const { registerCallbackAuthHook } = await import('../dist/routes/callback-auth-prehandler.js');

      const backlogStore = createStubBacklogStore([
        makeBacklogItem({ id: 'item-f261', featureId: 'F261', projectId: 'cat-cafe' }),
      ]);

      const threadStore = createStubThreadStore([{ id: THREAD_ID, backlogItemId: 'item-f261', userId: USER_ID }]);

      workflowSopStore = createInMemoryWorkflowSopStore();

      app = Fastify();
      registerCallbackAuthHook(app, createStubRegistry());
      module.registerCallbackWorkflowSopRoutes(app, {
        workflowSopStore,
        backlogStore,
        threadStore,
      });
      await app.ready();
    });

    beforeEach(() => {
      workflowSopStore.store.clear();
    });

    it('resolves featureId via thread-bound backlog item (unique match)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/update-workflow-sop',
        headers: authHeaders(),
        payload: {
          featureId: 'F261',
          stage: 'impl',
        },
      });
      assert.equal(res.statusCode, 200, `Expected 200 but got ${res.statusCode}: ${res.payload}`);
      const sop = JSON.parse(res.payload);
      assert.equal(sop.featureId, 'F261');
      assert.equal(sop.backlogItemId, 'item-f261');
    });
  });

  describe('Callback route — zero match (not imported)', () => {
    let app2;

    before(async () => {
      const module = await import('../dist/routes/callback-workflow-sop-routes.js');
      const { registerCallbackAuthHook } = await import('../dist/routes/callback-auth-prehandler.js');

      // Empty backlog — no items at all
      const backlogStore = createStubBacklogStore([]);
      const threadStore = createStubThreadStore([{ id: THREAD_ID, userId: USER_ID }]);

      app2 = Fastify();
      registerCallbackAuthHook(app2, createStubRegistry());
      module.registerCallbackWorkflowSopRoutes(app2, {
        workflowSopStore: createInMemoryWorkflowSopStore(),
        backlogStore,
        threadStore,
      });
      await app2.ready();
    });

    it('returns structured backlog_not_imported when no match', async () => {
      const res = await app2.inject({
        method: 'POST',
        url: '/api/callbacks/update-workflow-sop',
        headers: authHeaders(),
        payload: {
          featureId: 'F999',
          stage: 'kickoff',
        },
      });
      assert.equal(res.statusCode, 404);
      const body = JSON.parse(res.payload);
      assert.equal(body.code, 'backlog_not_imported');
      assert.ok(body.hint, 'Should include actionable hint');
    });
  });

  describe('Callback route — task-backed Mission Hub import', () => {
    it('materializes one durable backlog item from the unique exact same-thread work task', async () => {
      const module = await import('../dist/routes/callback-workflow-sop-routes.js');
      const { registerCallbackAuthHook } = await import('../dist/routes/callback-auth-prehandler.js');
      const backlogStore = createStubBacklogStore([]);
      const taskStore = createStubTaskStore([makeTask({ id: 'task-f287', featureId: 'F287' })]);
      const app = Fastify();
      registerCallbackAuthHook(app, createStubRegistry());
      module.registerCallbackWorkflowSopRoutes(app, {
        workflowSopStore: createInMemoryWorkflowSopStore(),
        backlogStore,
        taskStore,
        threadStore: createStubThreadStore([{ id: THREAD_ID, userId: USER_ID }]),
      });
      await app.ready();

      for (const stage of ['impl', 'quality_gate']) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/callbacks/update-workflow-sop',
          headers: authHeaders(),
          payload: { featureId: 'F287', stage },
        });
        assert.equal(res.statusCode, 200, `Expected 200 but got ${res.statusCode}: ${res.payload}`);
        assert.equal(JSON.parse(res.payload).backlogItemId, 'task:task-f287');
      }

      const projected = backlogStore.listByUser(USER_ID);
      assert.equal(projected.length, 1, 'retries must reuse the deterministic task-backed item');
      assert.deepEqual(projected[0].tags, ['source:task', 'feature:f287']);
      await app.close();
    });

    it('requires taskId when multiple exact same-thread work tasks match the feature', async () => {
      const module = await import('../dist/routes/callback-workflow-sop-routes.js');
      const { registerCallbackAuthHook } = await import('../dist/routes/callback-auth-prehandler.js');
      const backlogStore = createStubBacklogStore([]);
      const taskStore = createStubTaskStore([
        makeTask({ id: 'task-f287-a', featureId: 'F287' }),
        makeTask({ id: 'task-f287-b', featureId: 'f287' }),
      ]);
      const app = Fastify();
      registerCallbackAuthHook(app, createStubRegistry());
      module.registerCallbackWorkflowSopRoutes(app, {
        workflowSopStore: createInMemoryWorkflowSopStore(),
        backlogStore,
        taskStore,
        threadStore: createStubThreadStore([{ id: THREAD_ID, userId: USER_ID }]),
      });
      await app.ready();

      const ambiguous = await app.inject({
        method: 'POST',
        url: '/api/callbacks/update-workflow-sop',
        headers: authHeaders(),
        payload: { featureId: 'F287', stage: 'impl' },
      });
      assert.equal(ambiguous.statusCode, 409);
      assert.equal(JSON.parse(ambiguous.payload).code, 'ambiguous_task_backlog_source');

      const selected = await app.inject({
        method: 'POST',
        url: '/api/callbacks/update-workflow-sop',
        headers: authHeaders(),
        payload: { featureId: 'F287', taskId: 'task-f287-b', stage: 'impl' },
      });
      assert.equal(selected.statusCode, 200, selected.payload);
      assert.equal(JSON.parse(selected.payload).backlogItemId, 'task:task-f287-b');
      await app.close();
    });

    it('does not treat detected feature text, tracking tasks, another thread, or another user as import authority', async () => {
      const module = await import('../dist/routes/callback-workflow-sop-routes.js');
      const { registerCallbackAuthHook } = await import('../dist/routes/callback-auth-prehandler.js');
      const taskStore = createStubTaskStore([
        makeTask({ id: 'task-detected', detectedFeatureIds: ['F287'] }),
        makeTask({ id: 'task-tracking', featureId: 'F287', kind: 'pr_tracking' }),
        makeTask({ id: 'task-other-thread', featureId: 'F287', threadId: 'thread-other' }),
        makeTask({ id: 'task-other-user', featureId: 'F287', userId: 'user-other' }),
      ]);
      const app = Fastify();
      registerCallbackAuthHook(app, createStubRegistry());
      module.registerCallbackWorkflowSopRoutes(app, {
        workflowSopStore: createInMemoryWorkflowSopStore(),
        backlogStore: createStubBacklogStore([]),
        taskStore,
        threadStore: createStubThreadStore([{ id: THREAD_ID, userId: USER_ID }]),
      });
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/update-workflow-sop',
        headers: authHeaders(),
        payload: { featureId: 'F287', stage: 'impl' },
      });
      assert.equal(res.statusCode, 404);
      assert.equal(JSON.parse(res.payload).code, 'backlog_not_imported');

      const crossUserSelection = await app.inject({
        method: 'POST',
        url: '/api/callbacks/update-workflow-sop',
        headers: authHeaders(),
        payload: { featureId: 'F287', taskId: 'task-other-user', stage: 'impl' },
      });
      assert.equal(crossUserSelection.statusCode, 422);
      assert.equal(JSON.parse(crossUserSelection.payload).code, 'task_backlog_source_invalid');
      await app.close();
    });
  });

  describe('Callback route — ambiguous (multiple matches)', () => {
    let app3;

    before(async () => {
      const module = await import('../dist/routes/callback-workflow-sop-routes.js');
      const { registerCallbackAuthHook } = await import('../dist/routes/callback-auth-prehandler.js');

      // Two items with same feature tag in different projects
      const backlogStore = createStubBacklogStore([
        makeBacklogItem({ id: 'item-a', featureId: 'F001', projectId: 'project-alpha' }),
        makeBacklogItem({ id: 'item-b', featureId: 'F001', projectId: 'project-beta' }),
      ]);
      // Thread has no backlog binding
      const threadStore = createStubThreadStore([{ id: THREAD_ID, userId: USER_ID }]);

      app3 = Fastify();
      registerCallbackAuthHook(app3, createStubRegistry());
      module.registerCallbackWorkflowSopRoutes(app3, {
        workflowSopStore: createInMemoryWorkflowSopStore(),
        backlogStore,
        threadStore,
      });
      await app3.ready();
    });

    it('returns structured ambiguous_backlog_item with candidates', async () => {
      const res = await app3.inject({
        method: 'POST',
        url: '/api/callbacks/update-workflow-sop',
        headers: authHeaders(),
        payload: {
          featureId: 'F001',
          stage: 'impl',
        },
      });
      assert.equal(res.statusCode, 409);
      const body = JSON.parse(res.payload);
      assert.equal(body.code, 'ambiguous_backlog_item');
      assert.ok(Array.isArray(body.candidates));
      assert.equal(body.candidates.length, 2);
    });
  });

  describe('Callback route — explicit backlogItemId with feature mismatch', () => {
    let app4;

    before(async () => {
      const module = await import('../dist/routes/callback-workflow-sop-routes.js');
      const { registerCallbackAuthHook } = await import('../dist/routes/callback-auth-prehandler.js');

      const backlogStore = createStubBacklogStore([
        makeBacklogItem({ id: 'item-f073', featureId: 'F073', projectId: 'cat-cafe' }),
      ]);
      const threadStore = createStubThreadStore([{ id: THREAD_ID, userId: USER_ID }]);

      app4 = Fastify();
      registerCallbackAuthHook(app4, createStubRegistry());
      module.registerCallbackWorkflowSopRoutes(app4, {
        workflowSopStore: createInMemoryWorkflowSopStore(),
        backlogStore,
        threadStore,
      });
      await app4.ready();
    });

    it('rejects when backlogItemId feature tag does not match featureId', async () => {
      const res = await app4.inject({
        method: 'POST',
        url: '/api/callbacks/update-workflow-sop',
        headers: authHeaders(),
        payload: {
          backlogItemId: 'item-f073',
          featureId: 'F999', // mismatch! item has feature:f073
          stage: 'impl',
        },
      });
      assert.equal(res.statusCode, 422);
      const body = JSON.parse(res.payload);
      assert.equal(body.code, 'feature_mismatch');
    });
  });

  describe('Callback route — explicit backlogItemId with thread binding conflict', () => {
    let app4b;

    before(async () => {
      const module = await import('../dist/routes/callback-workflow-sop-routes.js');
      const { registerCallbackAuthHook } = await import('../dist/routes/callback-auth-prehandler.js');

      // Thread is bound to item-f073, but cat explicitly provides item-f261
      const backlogStore = createStubBacklogStore([
        makeBacklogItem({ id: 'item-f073', featureId: 'F073', projectId: 'cat-cafe' }),
        makeBacklogItem({ id: 'item-f261', featureId: 'F261', projectId: 'cat-cafe' }),
      ]);
      const threadStore = createStubThreadStore([{ id: THREAD_ID, backlogItemId: 'item-f073', userId: USER_ID }]);

      app4b = Fastify();
      registerCallbackAuthHook(app4b, createStubRegistry());
      module.registerCallbackWorkflowSopRoutes(app4b, {
        workflowSopStore: createInMemoryWorkflowSopStore(),
        backlogStore,
        threadStore,
      });
      await app4b.ready();
    });

    it('rejects explicit backlogItemId that conflicts with thread binding', async () => {
      const res = await app4b.inject({
        method: 'POST',
        url: '/api/callbacks/update-workflow-sop',
        headers: authHeaders(),
        payload: {
          backlogItemId: 'item-f261', // thread is bound to item-f073!
          featureId: 'F261',
          stage: 'impl',
        },
      });
      assert.equal(res.statusCode, 422);
      const body = JSON.parse(res.payload);
      assert.equal(body.code, 'thread_binding_conflict');
    });

    it('allows explicit backlogItemId that matches thread binding', async () => {
      const res = await app4b.inject({
        method: 'POST',
        url: '/api/callbacks/update-workflow-sop',
        headers: authHeaders(),
        payload: {
          backlogItemId: 'item-f073',
          featureId: 'F073',
          stage: 'impl',
        },
      });
      assert.equal(res.statusCode, 200, `Expected 200 but got ${res.statusCode}: ${res.payload}`);
      const sop = JSON.parse(res.payload);
      assert.equal(sop.backlogItemId, 'item-f073');
    });
  });

  describe('Callback route — stale thread binding allows explicit backlogItemId', () => {
    let app4c;

    before(async () => {
      const module = await import('../dist/routes/callback-workflow-sop-routes.js');
      const { registerCallbackAuthHook } = await import('../dist/routes/callback-auth-prehandler.js');

      // Thread is bound to a stale item (no longer in backlog), cat provides a valid explicit ID
      const backlogStore = createStubBacklogStore([
        makeBacklogItem({ id: 'item-f261', featureId: 'F261', projectId: 'cat-cafe' }),
        // NOTE: 'item-stale-f073' is NOT in the store — stale binding
      ]);
      const threadStore = createStubThreadStore([{ id: THREAD_ID, backlogItemId: 'item-stale-f073', userId: USER_ID }]);

      app4c = Fastify();
      registerCallbackAuthHook(app4c, createStubRegistry());
      module.registerCallbackWorkflowSopRoutes(app4c, {
        workflowSopStore: createInMemoryWorkflowSopStore(),
        backlogStore,
        threadStore,
      });
      await app4c.ready();
    });

    it('allows explicit backlogItemId when thread binding is stale (item no longer exists)', async () => {
      const res = await app4c.inject({
        method: 'POST',
        url: '/api/callbacks/update-workflow-sop',
        headers: authHeaders(),
        payload: {
          backlogItemId: 'item-f261',
          featureId: 'F261',
          stage: 'impl',
        },
      });
      assert.equal(res.statusCode, 200, `Expected 200 but got ${res.statusCode}: ${res.payload}`);
      const sop = JSON.parse(res.payload);
      assert.equal(sop.backlogItemId, 'item-f261');
    });
  });

  describe('Callback route — cross-user isolation', () => {
    let app5;

    before(async () => {
      const module = await import('../dist/routes/callback-workflow-sop-routes.js');
      const { registerCallbackAuthHook } = await import('../dist/routes/callback-auth-prehandler.js');

      // Item belongs to a different user
      const backlogStore = createStubBacklogStore([
        makeBacklogItem({ id: 'item-other', featureId: 'F100', userId: 'other-user' }),
      ]);
      const threadStore = createStubThreadStore([{ id: THREAD_ID, userId: USER_ID }]);

      app5 = Fastify();
      registerCallbackAuthHook(app5, createStubRegistry());
      module.registerCallbackWorkflowSopRoutes(app5, {
        workflowSopStore: createInMemoryWorkflowSopStore(),
        backlogStore,
        threadStore,
      });
      await app5.ready();
    });

    it("cannot resolve to another user's backlog item", async () => {
      const res = await app5.inject({
        method: 'POST',
        url: '/api/callbacks/update-workflow-sop',
        headers: authHeaders(),
        payload: {
          featureId: 'F100',
          stage: 'kickoff',
        },
      });
      assert.equal(res.statusCode, 404);
      const body = JSON.parse(res.payload);
      assert.equal(body.code, 'backlog_not_imported');
    });
  });

  describe('Callback route — thread binding mismatch must NOT fallback', () => {
    let app6;

    before(async () => {
      const module = await import('../dist/routes/callback-workflow-sop-routes.js');
      const { registerCallbackAuthHook } = await import('../dist/routes/callback-auth-prehandler.js');

      // Thread is bound to item-f073, but we're asking for F261
      // F261 also exists in backlog — but resolver MUST NOT fallback to scan
      const backlogStore = createStubBacklogStore([
        makeBacklogItem({ id: 'item-f073', featureId: 'F073', projectId: 'cat-cafe' }),
        makeBacklogItem({ id: 'item-f261', featureId: 'F261', projectId: 'cat-cafe' }),
      ]);
      const threadStore = createStubThreadStore([{ id: THREAD_ID, backlogItemId: 'item-f073', userId: USER_ID }]);

      app6 = Fastify();
      registerCallbackAuthHook(app6, createStubRegistry());
      module.registerCallbackWorkflowSopRoutes(app6, {
        workflowSopStore: createInMemoryWorkflowSopStore(),
        backlogStore,
        threadStore,
      });
      await app6.ready();
    });

    it('fails when thread binding does not match featureId — no fallback to scan', async () => {
      const res = await app6.inject({
        method: 'POST',
        url: '/api/callbacks/update-workflow-sop',
        headers: authHeaders(),
        payload: {
          featureId: 'F261',
          stage: 'impl',
        },
      });
      // Must NOT succeed (would mean it fell through to scan and found item-f261)
      assert.notEqual(res.statusCode, 200, 'Must not silently fallback to scan path');
      const body = JSON.parse(res.payload);
      // Should indicate the thread binding conflict
      assert.equal(body.code, 'feature_mismatch');
    });
  });

  describe('Callback route — single match without thread binding resolves OK', () => {
    let app7;

    before(async () => {
      const module = await import('../dist/routes/callback-workflow-sop-routes.js');
      const { registerCallbackAuthHook } = await import('../dist/routes/callback-auth-prehandler.js');

      // Single candidate in user's backlog, thread has no binding
      const backlogStore = createStubBacklogStore([
        makeBacklogItem({ id: 'item-sole', featureId: 'F050', projectId: 'cat-cafe' }),
      ]);
      const threadStore = createStubThreadStore([{ id: THREAD_ID, userId: USER_ID }]);

      app7 = Fastify();
      registerCallbackAuthHook(app7, createStubRegistry());
      module.registerCallbackWorkflowSopRoutes(app7, {
        workflowSopStore: createInMemoryWorkflowSopStore(),
        backlogStore,
        threadStore,
      });
      await app7.ready();
    });

    it('resolves a unique match from user backlog scan when thread has no binding', async () => {
      // Single match within user's own backlog is unambiguous —
      // the user-scope filter already provides isolation
      const res = await app7.inject({
        method: 'POST',
        url: '/api/callbacks/update-workflow-sop',
        headers: authHeaders(),
        payload: {
          featureId: 'F050',
          stage: 'kickoff',
        },
      });
      assert.equal(res.statusCode, 200, `Expected 200 but got ${res.statusCode}: ${res.payload}`);
      const sop = JSON.parse(res.payload);
      assert.equal(sop.backlogItemId, 'item-sole');
    });
  });

  describe('Callback route — thread-bound resolve takes priority over scan', () => {
    let app8;

    before(async () => {
      const module = await import('../dist/routes/callback-workflow-sop-routes.js');
      const { registerCallbackAuthHook } = await import('../dist/routes/callback-auth-prehandler.js');

      // Two items with same featureId in same project (edge case)
      // Thread is bound to one of them — that one wins
      const backlogStore = createStubBacklogStore([
        makeBacklogItem({ id: 'item-correct', featureId: 'F200', projectId: 'cat-cafe' }),
        makeBacklogItem({ id: 'item-wrong', featureId: 'F200', projectId: 'cat-cafe' }),
      ]);
      const threadStore = createStubThreadStore([{ id: THREAD_ID, backlogItemId: 'item-correct', userId: USER_ID }]);

      app8 = Fastify();
      registerCallbackAuthHook(app8, createStubRegistry());
      module.registerCallbackWorkflowSopRoutes(app8, {
        workflowSopStore: createInMemoryWorkflowSopStore(),
        backlogStore,
        threadStore,
      });
      await app8.ready();
    });

    beforeEach(() => {});

    it('uses thread-bound item even when scan would find ambiguous results', async () => {
      const res = await app8.inject({
        method: 'POST',
        url: '/api/callbacks/update-workflow-sop',
        headers: authHeaders(),
        payload: {
          featureId: 'F200',
          stage: 'review',
        },
      });
      assert.equal(res.statusCode, 200, `Expected 200 but got ${res.statusCode}: ${res.payload}`);
      const sop = JSON.parse(res.payload);
      assert.equal(sop.backlogItemId, 'item-correct');
    });
  });

  describe('Callback route — multi-feature-tag backlog item', () => {
    let app9;

    before(async () => {
      const module = await import('../dist/routes/callback-workflow-sop-routes.js');
      const { registerCallbackAuthHook } = await import('../dist/routes/callback-auth-prehandler.js');

      // Item carries two feature tags — should match either featureId
      const backlogStore = createStubBacklogStore([
        makeBacklogItem({
          id: 'item-multi',
          featureId: 'F066',
          tags: ['source:docs-backlog', 'feature:f066', 'feature:f088', 'status:active'],
        }),
      ]);
      const threadStore = createStubThreadStore([]);

      app9 = Fastify();
      registerCallbackAuthHook(app9, createStubRegistry());
      module.registerCallbackWorkflowSopRoutes(app9, {
        workflowSopStore: createInMemoryWorkflowSopStore(),
        backlogStore,
        threadStore,
      });
      await app9.ready();
    });

    it('resolves via second feature tag on multi-tag item', async () => {
      const res = await app9.inject({
        method: 'POST',
        url: '/api/callbacks/update-workflow-sop',
        headers: authHeaders(),
        payload: {
          featureId: 'F088',
          stage: 'kickoff',
        },
      });
      assert.equal(res.statusCode, 200, `Expected 200 but got ${res.statusCode}: ${res.payload}`);
      const sop = JSON.parse(res.payload);
      assert.equal(sop.backlogItemId, 'item-multi');
    });
  });
});
