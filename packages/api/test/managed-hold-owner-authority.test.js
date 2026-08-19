import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

const WAIT_SOURCE = {
  kind: 'managed_command',
  value: 'owner-authority-test',
  expectedSignal: 'managed_command_complete',
  slaUntilMs: 3_600_000,
};

describe('managed hold owner authority', () => {
  let registry;
  let threadStore;
  let messageStore;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    registry = new InvocationRegistry();
    threadStore = new ThreadStore();
    messageStore = new MessageStore();
  });

  async function createApp(insertedTasks) {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager: { broadcastAgentMessage() {}, getMessages() {} },
      threadStore,
      evidenceStore: { async store() {}, async search() {} },
      markerQueue: { enqueue() {} },
      reflectionService: { async run() {} },
      holdBallDeps: {
        registry,
        threadStore,
        taskRunner: { registerDynamic() {}, unregister() {} },
        templateRegistry: {
          get() {
            return {
              createSpec(taskId, taskParams) {
                return { taskId, taskParams };
              },
            };
          },
        },
        dynamicTaskStore: {
          insert(task) {
            insertedTasks.push(task);
          },
          getAll() {
            return insertedTasks;
          },
          remove() {},
        },
        messageStore,
        socketManager: { broadcastToRoom() {} },
      },
    });
    return app;
  }

  test('scheduler-auth hold in a user-owned thread preserves the thread owner for recovery', async () => {
    const insertedTasks = [];
    const app = await createApp(insertedTasks);
    const parent = await threadStore.create('user-original', 'parent');
    const thread = await threadStore.create('user-original', 'owner authority', 'default', parent.id);
    const auth = await registry.create('scheduler', 'codex-sol', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: {
        reason: 'managed recovery must report back as the original user',
        nextStep: 'cross-post the final result to the user-owned parent thread',
        wakeAfterMs: 10_000,
        waitSourceRef: WAIT_SOURCE,
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(insertedTasks.length, 1);
    assert.equal(insertedTasks[0].params.triggerUserId, 'user-original');

    const recoveryAuth = await registry.create(insertedTasks[0].params.triggerUserId, 'codex-sol', thread.id);
    const report = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: {
        'x-invocation-id': recoveryAuth.invocationId,
        'x-callback-token': recoveryAuth.callbackToken,
      },
      payload: {
        threadId: parent.id,
        content: 'managed recovery finished',
        targetCats: ['codex-sol'],
        clientMessageId: 'managed-owner-report-back',
      },
    });
    assert.equal(report.statusCode, 200, report.body);
  });

  test('scheduler-auth hold in a system-owned thread does not acquire user authority', async () => {
    const insertedTasks = [];
    const app = await createApp(insertedTasks);
    const thread = await threadStore.create('system', 'system authority');
    const auth = await registry.create('scheduler', 'codex-sol', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: {
        reason: 'system-owned work remains system scoped',
        nextStep: 'continue inside the system thread',
        wakeAfterMs: 10_000,
        waitSourceRef: WAIT_SOURCE,
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(insertedTasks[0].params.triggerUserId, 'scheduler');
  });

  test('user-auth hold keeps the authenticated user instead of borrowing the thread owner', async () => {
    const insertedTasks = [];
    const app = await createApp(insertedTasks);
    const thread = await threadStore.create('user-owner', 'user authority');
    const auth = await registry.create('user-collaborator', 'codex-sol', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: {
        reason: 'ordinary user authority remains invocation bound',
        nextStep: 'continue as the authenticated collaborator',
        wakeAfterMs: 10_000,
        waitSourceRef: WAIT_SOURCE,
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(insertedTasks[0].params.triggerUserId, 'user-collaborator');
  });
});
