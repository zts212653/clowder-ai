import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

describe('F167 default-thread hold user fence', () => {
  let registry;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    registry = new InvocationRegistry();
  });

  function makeHoldTask(id, ownerUserId = 'owner-user') {
    return {
      id,
      templateId: 'reminder',
      trigger: { type: 'once', fireAt: Date.now() + 60_000 },
      params: {
        message: 'managed hold wake',
        targetCatId: 'codex-sol',
        triggerUserId: ownerUserId,
        holdLifecycle: {
          mode: 'wake_when',
          status: 'active',
          createdBy: 'hold-ball:codex-sol',
          managedCommand: { state: 'command_running', command: 'private command', cwd: '/private' },
        },
      },
      display: { label: 'hold', category: 'system', description: 'private hold' },
      deliveryThreadId: 'default',
      enabled: true,
      createdBy: 'hold-ball:codex-sol',
      createdAt: new Date().toISOString(),
    };
  }

  function makeHarness(tasks) {
    const liveTasks = [...tasks];
    const unregistered = [];
    const managedCancelCalls = [];
    const audits = [];
    const defaultThread = {
      id: 'default',
      createdBy: 'system',
      participants: ['codex-sol', 'codex-terra'],
    };
    const dynamicTaskStore = {
      getById(id) {
        return liveTasks.find((task) => task.id === id) ?? null;
      },
      getAll() {
        return [...liveTasks];
      },
      remove(id) {
        const index = liveTasks.findIndex((task) => task.id === id);
        if (index < 0) return false;
        liveTasks.splice(index, 1);
        return true;
      },
    };
    const threadStore = {
      get(threadId) {
        return threadId === 'default' ? defaultThread : null;
      },
      list() {
        return [defaultThread];
      },
    };
    return {
      threadStore,
      liveTasks,
      unregistered,
      managedCancelCalls,
      audits,
      deps: {
        ownerUserId: 'operator-user',
        dynamicTaskStore,
        taskRunner: {
          unregister(taskId) {
            unregistered.push(taskId);
          },
        },
        messageStore: {
          async append(message) {
            return { id: 'message-1', ...message };
          },
        },
        socketManager: { broadcastToRoom() {} },
        threadStore,
        scheduleMutationAuditStore: {
          deleteTaskWithAudit(taskId, audit) {
            if (!dynamicTaskStore.remove(taskId)) return false;
            audits.push(audit);
            return true;
          },
        },
        cancelManagedWakeIfTaskMatches(taskId, threadId, catId) {
          managedCancelCalls.push({ taskId, threadId, catId });
          return true;
        },
      },
    };
  }

  async function createApp(harness, agentKeyRecord = null) {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      ...(agentKeyRecord
        ? {
            agentKeyRegistry: {
              async verify(secret) {
                return secret === 'agent-key-secret'
                  ? { ok: true, record: agentKeyRecord }
                  : { ok: false, reason: 'agent_key_unknown' };
              },
            },
          }
        : {}),
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
      threadStore: harness.threadStore,
      evidenceStore: {
        async store() {},
        async search() {
          return [];
        },
      },
      markerQueue: { enqueue() {} },
      reflectionService: { async run() {} },
      holdBallDeps: harness.deps,
    });
    return app;
  }

  async function callbackHeaders(userId) {
    const auth = await registry.create(userId, 'codex-terra', 'default');
    return { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  }

  function assertNoCancelSideEffects(harness, expectedTaskCount) {
    assert.equal(harness.liveTasks.length, expectedTaskCount);
    assert.deepEqual(harness.audits, []);
    assert.deepEqual(harness.unregistered, []);
    assert.deepEqual(harness.managedCancelCalls, []);
  }

  test('rejects cross-user invocation reads and cancellation without side effects', async () => {
    const task = makeHoldTask('hold-ball-default-cross-user');
    const harness = makeHarness([task]);
    const app = await createApp(harness);
    const headers = await callbackHeaders('attacker-user');

    const status = await app.inject({ method: 'GET', url: `/api/callbacks/hold-ball/${task.id}/status`, headers });
    assert.equal(status.statusCode, 403, status.body);
    const cancel = await app.inject({ method: 'DELETE', url: `/api/callbacks/hold-ball/${task.id}`, headers });
    assert.equal(cancel.statusCode, 403, cancel.body);
    assertNoCancelSideEffects(harness, 1);
  });

  test('fails closed when the hold has no trigger user identity', async () => {
    const task = makeHoldTask('hold-ball-default-ownerless', null);
    const harness = makeHarness([task]);
    const app = await createApp(harness);
    const headers = await callbackHeaders('owner-user');

    const status = await app.inject({ method: 'GET', url: `/api/callbacks/hold-ball/${task.id}/status`, headers });
    assert.equal(status.statusCode, 403, status.body);
    const cancel = await app.inject({ method: 'DELETE', url: `/api/callbacks/hold-ball/${task.id}`, headers });
    assert.equal(cancel.statusCode, 403, cancel.body);
    assertNoCancelSideEffects(harness, 1);
  });

  test('applies the fence to agent keys while preserving same-user rescue', async () => {
    const deniedTask = makeHoldTask('hold-ball-default-agent-key-denied');
    const allowedTask = makeHoldTask('hold-ball-default-agent-key-allowed');
    const harness = makeHarness([deniedTask, allowedTask]);
    const attackerApp = await createApp(harness, {
      agentKeyId: 'ak-attacker',
      catId: 'codex-terra',
      userId: 'attacker-user',
      scope: 'user-bound',
    });
    const denied = await attackerApp.inject({
      method: 'DELETE',
      url: `/api/callbacks/hold-ball/${deniedTask.id}`,
      headers: { 'x-agent-key-secret': 'agent-key-secret' },
    });
    assert.equal(denied.statusCode, 403, denied.body);
    assertNoCancelSideEffects(harness, 2);
    await attackerApp.close();

    const ownerApp = await createApp(harness, {
      agentKeyId: 'ak-owner',
      catId: 'codex-terra',
      userId: 'owner-user',
      scope: 'user-bound',
    });
    const allowed = await ownerApp.inject({
      method: 'DELETE',
      url: `/api/callbacks/hold-ball/${allowedTask.id}`,
      headers: { 'x-agent-key-secret': 'agent-key-secret' },
    });
    assert.equal(allowed.statusCode, 200, allowed.body);
    assert.equal(JSON.parse(allowed.body).actor.role, 'thread_collaborator');
    assert.equal(harness.audits.length, 1);
    assert.equal(harness.audits[0].actorId, 'codex-terra');
    assert.equal(harness.audits[0].detail.ownerUserId, 'owner-user');
  });
});
