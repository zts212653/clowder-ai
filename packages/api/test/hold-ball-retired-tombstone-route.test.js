/**
 * F167 Phase Q — retired hold tombstones stay readable after later destructive paths.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

const VALID_WAIT_SOURCE_REF = {
  kind: 'github_issue',
  value: 'AgeOfLearning/cat-cafe#2690',
  expectedSignal: 'review_posted',
  slaUntilMs: 3_600_000,
};

describe('F167 Phase Q: retired hold tombstones', () => {
  let registry;
  let threadStore;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    registry = new InvocationRegistry();
    threadStore = new ThreadStore();
  });

  function makeRetiredHoldTask(id, threadId, catId = 'codex') {
    return {
      id,
      templateId: 'reminder',
      trigger: { type: 'once', fireAt: Date.now() + 60_000 },
      params: {
        message: 'retired wake',
        targetCatId: catId,
        triggerUserId: 'user-retired',
        holdLifecycle: {
          mode: 'timer',
          status: 'retired_by_event',
          subjectKey: 'ageoflearning/cat-cafe#2690',
          expectedSignalKey: 'review_posted',
          wakeAt: Date.now() + 60_000,
          createdBy: `hold-ball:${catId}`,
        },
      },
      display: { label: `持球唤醒 (${catId})`, category: 'system', description: 'retired wake' },
      deliveryThreadId: threadId,
      enabled: false,
      createdBy: `hold-ball:${catId}`,
      createdAt: new Date().toISOString(),
    };
  }

  function makeStubDeps(tasks = []) {
    const insertedTasks = [...tasks];
    const registeredDynamic = [];
    const unregisteredIds = [];
    const removedIds = [];
    return {
      registry,
      taskRunner: {
        registerDynamic(spec, taskId) {
          registeredDynamic.push({ spec, taskId });
        },
        unregister(taskId) {
          unregisteredIds.push(taskId);
          return true;
        },
      },
      templateRegistry: {
        get(id) {
          return id === 'reminder' ? { createSpec: (taskId, taskParams) => ({ taskId, taskParams }) } : undefined;
        },
      },
      dynamicTaskStore: {
        insert(record) {
          insertedTasks.push(record);
        },
        getById(id) {
          return insertedTasks.find((task) => task.id === id && !removedIds.includes(task.id)) ?? null;
        },
        getAll() {
          return insertedTasks.filter((task) => !removedIds.includes(task.id));
        },
        remove(id) {
          removedIds.push(id);
          return true;
        },
      },
      messageStore: {
        async append(msg) {
          return { id: `test-msg-${insertedTasks.length}`, ...msg };
        },
      },
      socketManager: { broadcastToRoom() {} },
      _insertedTasks: insertedTasks,
      _registeredDynamic: registeredDynamic,
      _unregisteredIds: unregisteredIds,
      _removedIds: removedIds,
    };
  }

  async function createApp(holdBallDeps) {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore: {
        async getMessagesForThread() {
          return [];
        },
      },
      socketManager: {
        broadcastAgentMessage() {},
        getMessages() {
          return [];
        },
      },
      threadStore,
      evidenceStore: {
        async store() {},
        async search() {
          return [];
        },
      },
      markerQueue: { enqueue() {} },
      reflectionService: { async run() {} },
      holdBallDeps,
    });
    return app;
  }

  test('single-slot replacement leaves retired tombstone readable', async () => {
    const thread = await threadStore.create('user-retired-replace', 'retired-replace');
    const retired = makeRetiredHoldTask('hold-ball-retired-replace', thread.id);
    const deps = makeStubDeps([retired]);
    const app = await createApp(deps);
    const { invocationId, callbackToken } = await registry.create('user-retired-replace', 'codex', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'wait for follow-up',
        nextStep: 'check review',
        wakeAfterMs: 10_000,
        waitSourceRef: VALID_WAIT_SOURCE_REF,
      },
    });

    assert.equal(response.statusCode, 200);
    assert.ok(!deps._unregisteredIds.includes(retired.id), 'retired tombstone must not be unregistered');
    assert.ok(!deps._removedIds.includes(retired.id), 'retired tombstone must not be removed');
    assert.equal(deps.dynamicTaskStore.getById(retired.id), retired);
    assert.equal(deps.dynamicTaskStore.getAll().length, 2, 'retired tombstone and new active hold both remain');
  });

  test('DELETE treats retired tombstone as no longer cancelable without deleting it', async () => {
    const thread = await threadStore.create('user-retired-delete', 'retired-delete');
    const retired = makeRetiredHoldTask('hold-ball-retired-delete', thread.id);
    const deps = makeStubDeps([retired]);
    const app = await createApp(deps);

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/callbacks/hold-ball/hold-ball-retired-delete',
      headers: { 'x-cat-cafe-user': 'user-retired-delete' },
    });

    assert.equal(response.statusCode, 404);
    assert.ok(!deps._unregisteredIds.includes(retired.id), 'retired tombstone must not be unregistered');
    assert.ok(!deps._removedIds.includes(retired.id), 'retired tombstone must not be removed');
    assert.equal(deps.dynamicTaskStore.getById(retired.id), retired);
  });
});
