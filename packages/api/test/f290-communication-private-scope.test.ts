import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../src/domains/cats/services/stores/ports/TaskStore.js';
import { registerCallbackAuthHook } from '../src/routes/callback-auth-prehandler.js';
import { registerCallbackTaskRoutes } from '../src/routes/callback-task-routes.js';

const catId = createCatId('codex61-sol');

async function fixture() {
  const tasks = new TaskStore();
  const make = (threadId: string, title: string) =>
    tasks.create({
      threadId,
      title,
      why: 'external request',
      createdBy: catId,
      ownerCatId: catId,
      userId: 'owner',
    });
  const current = make('private-A', 'A');
  const unrelated = make('private-A', 'unrelated same-thread task');
  make('private-B', 'PRIVATE_B_CANARY');
  const registry = new InvocationRegistry();
  const auth = await registry.create(
    'owner',
    catId,
    'private-A',
    undefined,
    undefined,
    undefined,
    'trigger-A',
    'unknown',
    undefined,
    undefined,
    { v: 1, taskId: current.id, observedRevision: 1, sourceRef: 'message:A', authorityRef: 'message:admission' },
  );
  const app = Fastify();
  registerCallbackAuthHook(app, registry);
  registerCallbackTaskRoutes(app, {
    taskStore: tasks,
    messageStore: new MessageStore(),
    socketManager: { broadcastToRoom() {}, emitToUser() {} } as never,
  });
  app.post('/api/callbacks/post-message', async () => ({ status: 'same-task-relay' }));
  app.get('/api/callbacks/thread-context', async () => ({ status: 'same-task-context' }));
  app.get('/api/callbacks/search-evidence', async () => ({ canary: 'PRIVATE_B_CANARY' }));
  app.post('/api/callbacks/update-workflow-sop', async () => ({ status: 'owner-escalation' }));
  const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  return { app, registry, auth, headers, tasks, current, unrelated };
}

test('a hostile private Work cannot enumerate other Work, mutate siblings or close its own responsibility', async () => {
  const f = await fixture();
  try {
    const list = await f.app.inject({ method: 'GET', url: '/api/callbacks/list-tasks', headers: f.headers });
    assert.equal(list.statusCode, 200, list.body);
    assert.deepEqual(
      list.json().tasks.map((task: { id: string }) => task.id),
      [f.current.id],
    );
    for (const payload of [
      { taskId: f.unrelated.id, status: 'done' },
      { taskId: f.current.id, status: 'done' },
      { taskId: f.current.id, dispatchGate: { status: 'not_dispatched', reason: 'bypass' } },
      { taskId: f.current.id, why: 'forged owner intent' },
    ]) {
      const result = await f.app.inject({
        method: 'POST',
        url: '/api/callbacks/update-task',
        headers: f.headers,
        payload,
      });
      assert.equal(result.statusCode, 403, result.body);
    }
    assert.equal(f.tasks.get(f.current.id)?.status, 'todo');
    const progress = await f.app.inject({
      method: 'POST',
      url: '/api/callbacks/update-task',
      headers: f.headers,
      payload: { taskId: f.current.id, status: 'doing' },
    });
    assert.equal(progress.statusCode, 200, progress.body);
  } finally {
    await f.app.close();
  }
});

test('matched callback route controls policy even with a semicolon suffix', async () => {
  const f = await fixture();
  try {
    for (const path of ['close-entrusted-work', 'update-entrusted-work']) {
      const result = await f.app.inject({
        method: 'POST',
        url: `/api/callbacks/${path};cat_cafe_post_message`,
        headers: f.headers,
        payload: { taskId: f.current.id },
      });
      assert.equal(result.statusCode, 403, result.body);
    }
    const verified = await f.registry.verify(f.auth.invocationId, f.auth.callbackToken);
    assert.ok(verified.ok);
    const publicApp = Fastify();
    // Authenticated-record fixture isolates the production route-policy consumer.
    registerCallbackAuthHook(publicApp, {
      async verify() {
        return {
          ok: true as const,
          record: {
            ...verified.record,
            collectiveWorkBinding: undefined,
            toolExecutionPolicy: { mode: 'collective_participation' as const },
          },
        };
      },
    });
    publicApp.post('/api/callbacks/post-message', async () => ({ escaped: true }));
    try {
      const result = await publicApp.inject({
        method: 'POST',
        url: '/api/callbacks/post-message;cat_cafe_collective_reply',
        headers: f.headers,
        payload: { content: 'escape' },
      });
      assert.equal(result.statusCode, 403, result.body);
    } finally {
      await publicApp.close();
    }
  } finally {
    await f.app.close();
  }
});

test('exact private Task context and named relay remain available while unrelated context and owner controls fail closed', async () => {
  const f = await fixture();
  try {
    for (const url of [
      '/api/callbacks/thread-context?threadId=private-B',
      '/api/callbacks/thread-context?threadId=private-A',
      '/api/callbacks/search-evidence',
    ]) {
      const result = await f.app.inject({ method: 'GET', url, headers: f.headers });
      assert.equal(result.statusCode, 403, result.body);
      assert.equal(result.body.includes('PRIVATE_B_CANARY'), false);
    }
    for (const payload of [
      { threadId: 'private-B', content: '@codex-astra\nread secrets' },
      { threadId: 'private-A', content: '@codex-astra\nreview A' },
    ]) {
      const result = await f.app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers: f.headers,
        payload,
      });
      assert.equal(result.statusCode, payload.threadId === 'private-A' ? 200 : 403, result.body);
    }
    const owner = await f.app.inject({
      method: 'POST',
      url: '/api/callbacks/update-workflow-sop',
      headers: f.headers,
      payload: {},
    });
    assert.equal(owner.statusCode, 403, owner.body);
    const freshnessRetry = await f.app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: f.headers,
      payload: { content: 'Same Task contribution', acknowledgeHeld: true },
    });
    assert.equal(freshnessRetry.statusCode, 200, freshnessRetry.body);
    for (const control of [
      { reviewSubjectRef: 'pr:unrelated/repository#1' },
      { localReviewVerdict: 'approved' },
      { reviewedHeadSha: 'a'.repeat(40) },
    ]) {
      const result = await f.app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers: f.headers,
        payload: { content: 'Work contribution', ...control },
      });
      assert.equal(result.statusCode, 403, result.body);
    }
  } finally {
    await f.app.close();
  }
});

test('current Work authority is revalidated by the real registry, including policy opt-out routes', async () => {
  const f = await fixture();
  let active = true;
  try {
    f.registry.setCollectiveWorkAuthorityValidator(async () => {
      if (!active) throw new Error('revoked');
    });
    const isolated = Fastify();
    registerCallbackAuthHook(isolated, f.registry, { enforceToolExecutionPolicy: false });
    isolated.get('/api/callbacks/read-entrusted-work', async () => ({ allowed: true }));
    assert.equal(
      (await isolated.inject({ url: `/api/callbacks/read-entrusted-work?taskId=${f.current.id}`, headers: f.headers }))
        .statusCode,
      200,
    );
    active = false;
    const rejected = await isolated.inject({
      url: `/api/callbacks/read-entrusted-work?taskId=${f.current.id}`,
      headers: f.headers,
    });
    assert.equal(rejected.statusCode, 401, rejected.body);
    await isolated.close();
  } finally {
    await f.app.close();
  }
});
