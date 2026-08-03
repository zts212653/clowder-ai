import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';

const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
const { callbacksRoutes } = await import('../dist/routes/callbacks.js');

test('wakeWhen persists primary output when daemon PATH omits bundled rg', async () => {
  const registry = new InvocationRegistry();
  const threadStore = new ThreadStore();
  const tasks = [];
  const messages = [];
  const holdBallDeps = {
    registry,
    taskRunner: {
      registerDynamic() {},
      unregister() {
        return true;
      },
    },
    templateRegistry: {
      get(id) {
        return id === 'reminder'
          ? {
              createSpec(taskId, taskParams) {
                return { taskId, taskParams };
              },
            }
          : undefined;
      },
    },
    dynamicTaskStore: {
      insert(record) {
        tasks.push(record);
      },
      getAll() {
        return tasks;
      },
      getById(id) {
        return tasks.find((task) => task.id === id);
      },
      remove() {
        return true;
      },
      updateParams(id, params) {
        const task = tasks.find((candidate) => candidate.id === id);
        if (!task) return false;
        task.params = params;
        return true;
      },
      setEnabled(id, enabled) {
        const task = tasks.find((candidate) => candidate.id === id);
        if (!task) return false;
        task.enabled = enabled;
        return true;
      },
    },
    messageStore: {
      getByIdempotencyKey(_userId, threadId, key) {
        return messages.find((message) => message.threadId === threadId && message.idempotencyKey === key) ?? null;
      },
      async append(message) {
        const stored = { id: `message-${messages.length}`, ...message };
        messages.push(stored);
        return stored;
      },
    },
    socketManager: {
      broadcastToRoom() {},
    },
    invocationRecordStore: {
      getByIdempotencyKey(_threadId, _userId, key) {
        return { id: `invocation-${key}`, userMessageId: key.slice('connector-'.length), status: 'running' };
      },
    },
  };

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

  const originalPath = process.env.PATH;
  process.env.PATH = '/usr/bin:/bin';

  try {
    const thread = await threadStore.create('user-hb-environment', 'hb-environment');
    const { invocationId, callbackToken } = await registry.create('user-hb-environment', 'codex', thread.id);
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        reason: 'environment truth gate',
        nextStep: 'consume primary outcome',
        wakeWhen: { command: 'printf "persisted-primary-outcome\\n" | rg "^persisted-primary-outcome$"' },
      },
    });
    assert.equal(response.statusCode, 200);

    const deadline = Date.now() + 2_000;
    while (!messages.some((message) => message.content?.includes('持球唤醒（命令完成）')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const completion = messages.find((message) => message.content?.includes('持球唤醒（命令完成）'));
    assert.ok(completion, 'wakeWhen completion should be persisted');
    assert.ok(completion.content.includes('结果：✅ 成功'), completion.content);
    assert.ok(completion.content.includes('persisted-primary-outcome'), completion.content);
    assert.equal(completion.content.includes('rg: command not found'), false, completion.content);
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await app.close();
  }
});
