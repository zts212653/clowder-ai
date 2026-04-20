/**
 * Tests for thread-context returning workflowSop (F073 P1)
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

function createMockSocketManager() {
  return {
    broadcastAgentMessage() {},
  };
}

describe('GET thread-context with workflowSop', () => {
  let registry;
  let messageStore;
  let threadStore;
  let socketManager;
  let workflowSopStore;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    registry = new InvocationRegistry();
    messageStore = new MessageStore();
    threadStore = new ThreadStore();
    socketManager = createMockSocketManager();
    workflowSopStore = createInMemoryWorkflowSopStore();
  });

  function createInMemoryWorkflowSopStore() {
    const store = new Map();
    return {
      async get(backlogItemId) {
        return store.get(backlogItemId) ?? null;
      },
      async upsert(backlogItemId, featureId, _input, updatedBy) {
        const sop = {
          featureId,
          backlogItemId,
          stage: 'impl',
          batonHolder: updatedBy,
          nextSkill: 'tdd',
          resumeCapsule: { goal: 'Build F073', done: ['types'], currentFocus: 'Redis store' },
          checks: {
            remoteMainSynced: 'attested',
            qualityGatePassed: 'unknown',
            reviewApproved: 'unknown',
            visionGuardDone: 'unknown',
          },
          version: 1,
          updatedAt: Date.now(),
          updatedBy,
        };
        store.set(backlogItemId, sop);
        return sop;
      },
      async delete(backlogItemId) {
        return store.delete(backlogItemId);
      },
      _store: store,
    };
  }

  async function createApp() {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      threadStore,
      workflowSopStore,
    });
    return app;
  }

  test('returns workflowSop when thread has linked backlogItemId', async () => {
    const app = await createApp();

    // Create a thread with linked backlog item
    const thread = threadStore.create('user-1', 'F073 test', 'default');
    threadStore.linkBacklogItem(thread.id, 'item-73');

    // Create invocation for this thread
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', thread.id);

    // Seed workflow SOP for the backlog item
    await workflowSopStore.upsert('item-73', 'F073', {}, 'opus');

    // Add a message so we have content
    messageStore.append({
      userId: 'user-1',
      catId: null,
      threadId: thread.id,
      content: 'Hello',
      mentions: [],
      timestamp: Date.now(),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/callbacks/thread-context',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.ok(body.workflowSop, 'workflowSop should be present');
    assert.equal(body.workflowSop.featureId, 'F073');
    assert.equal(body.workflowSop.stage, 'impl');
    assert.equal(body.workflowSop.batonHolder, 'opus');
    assert.equal(body.workflowSop.nextSkill, 'tdd');
    assert.deepEqual(body.workflowSop.resumeCapsule, {
      goal: 'Build F073',
      done: ['types'],
      currentFocus: 'Redis store',
    });
    assert.equal(body.workflowSop.checks.remoteMainSynced, 'attested');
    // version and updatedAt should NOT be in the response
    assert.equal(body.workflowSop.version, undefined);
    assert.equal(body.workflowSop.updatedAt, undefined);
  });

  test('does not return workflowSop when thread has no backlogItemId', async () => {
    const app = await createApp();

    // Thread without linked backlog item
    const thread = threadStore.create('user-1', 'plain thread', 'default');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', thread.id);

    messageStore.append({
      userId: 'user-1',
      catId: null,
      threadId: thread.id,
      content: 'Hello',
      mentions: [],
      timestamp: Date.now(),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/callbacks/thread-context',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.workflowSop, undefined, 'workflowSop should not be present');
  });

  test('does not return workflowSop when using overrideThreadId for another user thread', async () => {
    const app = await createApp();

    // Create a thread owned by user-2
    const otherThread = threadStore.create('user-2', 'Other user thread', 'default');
    threadStore.linkBacklogItem(otherThread.id, 'item-73');

    // Seed SOP for the backlog item
    await workflowSopStore.upsert('item-73', 'F073', {}, 'opus');

    // Create invocation for user-1 in their own thread
    const ownThread = threadStore.create('user-1', 'My thread', 'default');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', ownThread.id);

    // Add a message so thread-context has content
    messageStore.append({
      userId: 'user-2',
      catId: null,
      threadId: otherThread.id,
      content: 'Hello from other user',
      mentions: [],
      timestamp: Date.now(),
    });

    // Try to read other user's thread context with override
    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/thread-context?threadId=${otherThread.id}`,
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    // workflowSop should NOT be returned for cross-user thread override
    assert.equal(body.workflowSop, undefined, 'workflowSop should not leak to other user');
  });

  test('does not return workflowSop when no SOP exists for backlog item', async () => {
    const app = await createApp();

    const thread = threadStore.create('user-1', 'F073 test', 'default');
    threadStore.linkBacklogItem(thread.id, 'item-no-sop');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', thread.id);

    messageStore.append({
      userId: 'user-1',
      catId: null,
      threadId: thread.id,
      content: 'Hello',
      mentions: [],
      timestamp: Date.now(),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/callbacks/thread-context',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.workflowSop, undefined, 'workflowSop should not be present');
  });
});
