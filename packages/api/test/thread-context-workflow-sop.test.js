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
          sopDefinitionId: 'development',
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

  function seedWorkflowSop(backlogItemId, capsuleChars) {
    workflowSopStore._store.set(backlogItemId, {
      featureId: 'F236',
      backlogItemId,
      sopDefinitionId: 'development',
      stage: 'impl',
      batonHolder: 'opus',
      nextSkill: 'tdd',
      resumeCapsule: {
        goal: 'g'.repeat(capsuleChars),
        done: [],
        currentFocus: '',
      },
      checks: {
        remoteMainSynced: 'verified',
        qualityGatePassed: 'unknown',
        reviewApproved: 'unknown',
        visionGuardDone: 'unknown',
      },
      version: 1,
      updatedAt: Date.now(),
      updatedBy: 'opus',
    });
  }

  function seedOversizedWorkflowSop(backlogItemId) {
    seedWorkflowSop(backlogItemId, 90_000);
  }

  test('returns workflowSop when thread has linked backlogItemId', async () => {
    const app = await createApp();

    // Create a thread with linked backlog item
    const thread = threadStore.create('user-1', 'F073 test', 'default');
    threadStore.linkBacklogItem(thread.id, 'item-73');

    // Create invocation for this thread
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', thread.id);

    // Seed workflow SOP for the backlog item
    await workflowSopStore.upsert('item-73', 'F073', {}, 'opus', 'test-user');

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
    assert.equal(body.workflowSop.sopDefinitionId, 'development');
    assert.equal(body.workflowSop.stage, 'impl');
    assert.equal(body.workflowSop.batonHolder, 'opus');
    assert.equal(body.workflowSop.nextSkill, 'tdd');
    assert.equal(body.workflowSop.suggestedSkill, 'tdd');
    assert.equal(body.workflowSop.suggestedSkillSource, 'override');
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

  test('bounds an oversized workflowSop even when the thread has no messages', async () => {
    const app = await createApp();
    const thread = threadStore.create('user-1', 'F236 oversized workflow SOP', 'default');
    threadStore.linkBacklogItem(thread.id, 'item-f236-oversized-empty');
    seedOversizedWorkflowSop('item-f236-oversized-empty');
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', thread.id);

    const response = await app.inject({
      method: 'GET',
      url: '/api/callbacks/thread-context?responseMode=full',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.ok(Buffer.byteLength(response.body, 'utf8') <= 24_000);
    const body = JSON.parse(response.body);
    assert.deepEqual(body.messages, []);
    assert.equal(body.workflowSop.oversized, true);
    assert.equal(body.workflowSop.truncated, true);
    assert.equal(body.workflowSop.serializedBytes > 24_000, true);
    assert.equal('resumeCapsule' in body.workflowSop, false);
    assert.deepEqual(body.workflowSop.drillDown, {
      kind: 'workflow_sop',
      tool: 'cat_cafe_get_workflow_sop',
      args: { threadId: thread.id },
    });
  });

  test('keeps full-message paging bounded when workflowSop itself is oversized', async () => {
    const app = await createApp();
    const thread = threadStore.create('user-1', 'F236 oversized workflow SOP paging', 'default');
    threadStore.linkBacklogItem(thread.id, 'item-f236-oversized-paging');
    seedOversizedWorkflowSop('item-f236-oversized-paging');
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', thread.id);
    const expectedIds = [];
    for (let index = 0; index < 3; index += 1) {
      const message = messageStore.append({
        userId: 'user-1',
        catId: null,
        threadId: thread.id,
        content: `workflow-sop-page-${index}-${'m'.repeat(10_000)}`,
        mentions: [],
        timestamp: index + 1,
      });
      expectedIds.push(message.id);
    }

    const returnedIds = [];
    let cursor;
    for (let page = 0; page < 3; page += 1) {
      const params = new URLSearchParams({ responseMode: 'full' });
      if (cursor) params.set('cursor', cursor);
      const response = await app.inject({
        method: 'GET',
        url: `/api/callbacks/thread-context?${params}`,
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      });

      assert.equal(response.statusCode, 200, response.body);
      assert.ok(Buffer.byteLength(response.body, 'utf8') <= 24_000);
      const body = JSON.parse(response.body);
      assert.equal(body.workflowSop.oversized, true);
      assert.equal(body.workflowSop.truncated, true);
      for (const message of body.messages) {
        assert.equal(typeof message.content, 'string', 'ordinary paged messages remain complete');
        assert.equal(message.truncated, false);
        returnedIds.push(message.id);
      }
      if (!body.hasMore) break;
      assert.equal(typeof body.nextCursor, 'string');
      cursor = body.nextCursor;
    }

    assert.deepEqual(returnedIds, expectedIds);
    assert.equal(new Set(returnedIds).size, expectedIds.length);
  });

  test('uses the bounded SOP base when it preserves later ordinary full messages', async () => {
    const app = await createApp();
    const thread = threadStore.create('user-1', 'F236 moderate workflow SOP paging', 'default');
    threadStore.linkBacklogItem(thread.id, 'item-f236-moderate-paging');
    seedWorkflowSop('item-f236-moderate-paging', 15_000);
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', thread.id);
    const expectedContents = [`${'a'.repeat(500)}`, `${'b'.repeat(10_000)}`];
    const expectedIds = expectedContents.map(
      (content, index) =>
        messageStore.append({
          userId: 'user-1',
          catId: null,
          threadId: thread.id,
          content,
          mentions: [],
          timestamp: index + 1,
        }).id,
    );

    const response = await app.inject({
      method: 'GET',
      url: '/api/callbacks/thread-context?responseMode=full',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.ok(Buffer.byteLength(response.body, 'utf8') <= 24_000);
    const body = JSON.parse(response.body);
    assert.equal(body.workflowSop.oversized, true);
    assert.equal(body.workflowSop.truncated, true);
    assert.equal(body.hasMore, false);
    assert.equal(body.nextCursor, undefined);
    assert.deepEqual(
      body.messages.map((message) => message.id),
      expectedIds,
    );
    assert.deepEqual(
      body.messages.map((message) => message.content),
      expectedContents,
    );
    assert.equal(
      body.messages.every((message) => message.truncated === false),
      true,
    );
    assert.equal(new Set(body.messages.map((message) => message.id)).size, expectedIds.length);
  });

  test('returns thread context without workflowSop when stored SOP stage is invalid even with nextSkill override', async () => {
    const app = await createApp();

    const thread = threadStore.create('user-1', 'F073 test', 'default');
    threadStore.linkBacklogItem(thread.id, 'item-invalid-sop');
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', thread.id);

    workflowSopStore._store.set('item-invalid-sop', {
      featureId: 'F073',
      backlogItemId: 'item-invalid-sop',
      sopDefinitionId: 'development',
      stage: 'retired_stage',
      batonHolder: 'opus',
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
      updatedBy: 'opus',
    });

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
    assert.equal(body.workflowSop, undefined, 'invalid stored SOP data should not break thread-context');
    assert.equal(body.messages[0].preview, 'Hello'); // F236: anchor preview replaces full content
  });

  test('does not return workflowSop when thread has no backlogItemId', async () => {
    const app = await createApp();

    // Thread without linked backlog item
    const thread = threadStore.create('user-1', 'plain thread', 'default');
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', thread.id);

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
    await workflowSopStore.upsert('item-73', 'F073', {}, 'opus', 'test-user');

    // Create invocation for user-1 in their own thread
    const ownThread = threadStore.create('user-1', 'My thread', 'default');
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', ownThread.id);

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
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', thread.id);

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
