import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

describe('F167 hold-ball rescue authorization', () => {
  let registry;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    registry = new InvocationRegistry();
  });

  function makeHoldTask(id, threadId = 'thread-shared', ownerCatId = 'codex-sol', ownerUserId = 'owner-user') {
    return {
      id,
      templateId: 'reminder',
      trigger: { type: 'once', fireAt: Date.now() + 60_000 },
      params: {
        message: 'managed hold wake',
        targetCatId: ownerCatId,
        triggerUserId: ownerUserId,
        holdLifecycle: {
          mode: 'wake_when',
          status: 'active',
          wakeAt: Date.now() + 60_000,
          createdBy: `hold-ball:${ownerCatId}`,
          waitSourceRef: {
            kind: 'managed_command',
            value: 'private-build',
            expectedSignal: 'managed_command_complete',
            slaUntilMs: Date.now() + 60_000,
          },
          managedCommand: {
            state: 'command_running',
            command: 'deploy --token super-secret',
            cwd: '/private/worktree',
            startedAt: Date.now() - 1_000,
          },
        },
      },
      display: { label: `持球唤醒 (${ownerCatId})`, category: 'system', description: 'private hold' },
      deliveryThreadId: threadId,
      enabled: true,
      createdBy: `hold-ball:${ownerCatId}`,
      createdAt: new Date().toISOString(),
    };
  }

  function makeHarness({
    tasks = [],
    threads = [],
    visibleThreadIds = {},
    auditedDeleteOutcome = true,
    auditedDeleteError = null,
  } = {}) {
    const liveTasks = [...tasks];
    const unregistered = [];
    const managedCancelCalls = [];
    const audits = [];
    const messages = [];
    const threadById = new Map(threads.map((thread) => [thread.id, thread]));
    const dynamicTaskStore = {
      insert(task) {
        liveTasks.push(task);
      },
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
        return threadById.get(threadId) ?? null;
      },
      list(userId) {
        const allowed = new Set(visibleThreadIds[userId] ?? []);
        return threads.filter((thread) => allowed.has(thread.id));
      },
    };
    return {
      deps: {
        registry,
        ownerUserId: 'operator-user',
        taskRunner: {
          registerDynamic() {},
          unregister(taskId) {
            unregistered.push(taskId);
          },
        },
        templateRegistry: {
          get() {
            return { createSpec: (taskId, taskParams) => ({ taskId, taskParams }) };
          },
        },
        dynamicTaskStore,
        scheduleMutationAuditStore: {
          deleteTaskWithAudit(taskId, audit) {
            if (auditedDeleteError) throw auditedDeleteError;
            if (!auditedDeleteOutcome) return false;
            const removed = dynamicTaskStore.remove(taskId);
            if (removed) audits.push(audit);
            return removed;
          },
        },
        messageStore: {
          async append(message) {
            const stored = { id: `message-${messages.length + 1}`, ...message };
            messages.push(stored);
            return stored;
          },
        },
        socketManager: { broadcastToRoom() {} },
        threadStore,
        cancelManagedWakeIfTaskMatches(taskId, threadId, catId) {
          managedCancelCalls.push({ taskId, threadId, catId });
          return true;
        },
      },
      threadStore,
      liveTasks,
      unregistered,
      managedCancelCalls,
      audits,
      messages,
    };
  }

  async function createApp(harness) {
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

  async function callbackHeaders(userId, catId, threadId) {
    const auth = await registry.create(userId, catId, threadId);
    return { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  }

  test('trigger principal keeps full lifecycle access and records exact owner audit on cancel', async () => {
    const task = makeHoldTask('hold-ball-owner');
    const harness = makeHarness({
      tasks: [task],
      threads: [{ id: 'thread-shared', createdBy: 'system', participants: ['codex-sol', 'codex-terra'] }],
    });
    const app = await createApp(harness);
    const headers = await callbackHeaders('owner-user', 'codex-sol', 'thread-shared');

    const status = await app.inject({ method: 'GET', url: `/api/callbacks/hold-ball/${task.id}/status`, headers });
    assert.equal(status.statusCode, 200, status.body);
    const statusBody = JSON.parse(status.body);
    assert.deepEqual(statusBody.access, {
      role: 'trigger_principal',
      canCancel: true,
      lifecycleVisibility: 'full',
    });
    assert.deepEqual(statusBody.owner, { catId: 'codex-sol', userId: 'owner-user' });
    assert.equal(statusBody.lifecycle.managedCommand.command, 'deploy --token super-secret');

    const cancel = await app.inject({ method: 'DELETE', url: `/api/callbacks/hold-ball/${task.id}`, headers });
    assert.equal(cancel.statusCode, 200, cancel.body);
    const cancelBody = JSON.parse(cancel.body);
    assert.deepEqual(cancelBody.actor, { kind: 'cat', id: 'codex-sol', role: 'trigger_principal' });
    assert.deepEqual(cancelBody.owner, { catId: 'codex-sol', userId: 'owner-user' });
    assert.equal(harness.audits.length, 1);
    assert.equal(harness.audits[0].actorKind, 'cat');
    assert.equal(harness.audits[0].actorId, 'codex-sol');
    assert.deepEqual(harness.audits[0].detail, {
      resourceKind: 'hold_ball',
      threadId: 'thread-shared',
      ownerCatId: 'codex-sol',
      ownerUserId: 'owner-user',
      accessRole: 'trigger_principal',
      authKind: 'invocation',
    });
  });

  test('same-thread collaborator gets a safe projection and can rescue-cancel with its own actor identity', async () => {
    const task = makeHoldTask('hold-ball-rescue');
    const harness = makeHarness({
      tasks: [task],
      threads: [{ id: 'thread-shared', createdBy: 'system', participants: ['codex-sol', 'codex-terra'] }],
    });
    const app = await createApp(harness);
    const headers = await callbackHeaders('collaborator-user', 'codex-terra', 'thread-shared');

    const status = await app.inject({ method: 'GET', url: `/api/callbacks/hold-ball/${task.id}/status`, headers });
    assert.equal(status.statusCode, 200, status.body);
    const statusBody = JSON.parse(status.body);
    assert.deepEqual(statusBody.access, {
      role: 'thread_collaborator',
      canCancel: true,
      lifecycleVisibility: 'summary',
    });
    assert.deepEqual(statusBody.owner, { catId: 'codex-sol' });
    assert.deepEqual(statusBody.lifecycle, { mode: 'wake_when', status: 'active' });
    assert.doesNotMatch(status.body, /deploy --token|super-secret|private\/worktree|waitSourceRef/);

    const cancel = await app.inject({ method: 'DELETE', url: `/api/callbacks/hold-ball/${task.id}`, headers });
    assert.equal(cancel.statusCode, 200, cancel.body);
    assert.deepEqual(JSON.parse(cancel.body).actor, {
      kind: 'cat',
      id: 'codex-terra',
      role: 'thread_collaborator',
    });
    assert.equal(harness.audits[0].actorId, 'codex-terra');
    assert.equal(harness.audits[0].detail.accessRole, 'thread_collaborator');
  });

  test('callback principal cannot borrow operator authority and wrong-thread cats fail closed', async () => {
    const task = makeHoldTask('hold-ball-wrong-thread');
    const harness = makeHarness({
      tasks: [task],
      threads: [{ id: 'thread-shared', createdBy: 'system', participants: ['codex-sol'] }],
      visibleThreadIds: { 'operator-user': ['thread-shared'] },
    });
    const app = await createApp(harness);
    const headers = {
      ...(await callbackHeaders('operator-user', 'codex-terra', 'thread-other')),
      'x-cat-cafe-user': 'operator-user',
    };

    const response = await app.inject({ method: 'DELETE', url: `/api/callbacks/hold-ball/${task.id}`, headers });
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(harness.liveTasks.length, 1);
    assert.deepEqual(harness.audits, []);
    assert.deepEqual(harness.unregistered, []);
  });

  test('system ownership is not an operator pass when the canonical thread list denies access', async () => {
    const task = makeHoldTask('hold-ball-hidden-system');
    const harness = makeHarness({
      tasks: [task],
      threads: [{ id: 'thread-shared', createdBy: 'system', participants: ['codex-sol'] }],
      visibleThreadIds: { 'operator-user': [] },
    });
    const app = await createApp(harness);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/callbacks/hold-ball/${task.id}`,
      headers: { 'x-cat-cafe-user': 'operator-user' },
    });
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(harness.liveTasks.length, 1);
    assert.deepEqual(harness.audits, []);
  });

  test('audited delete race returns 409 and never touches a replacement runner', async () => {
    const task = makeHoldTask('hold-ball-stale-task');
    const harness = makeHarness({
      tasks: [task],
      threads: [{ id: 'thread-shared', createdBy: 'system', participants: ['codex-sol'] }],
      visibleThreadIds: { 'operator-user': ['thread-shared'] },
      auditedDeleteOutcome: false,
    });
    const app = await createApp(harness);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/callbacks/hold-ball/${task.id}`,
      headers: { 'x-cat-cafe-user': 'operator-user' },
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(JSON.parse(response.body).code, 'HOLD_TASK_REPLACED');
    assert.deepEqual(harness.unregistered, []);
    assert.deepEqual(harness.managedCancelCalls, []);
  });

  test('audit transaction failure leaves the hold and runner untouched', async () => {
    const task = makeHoldTask('hold-ball-audit-failure');
    const harness = makeHarness({
      tasks: [task],
      threads: [{ id: 'thread-shared', createdBy: 'system', participants: ['codex-sol'] }],
      visibleThreadIds: { 'operator-user': ['thread-shared'] },
      auditedDeleteError: new Error('audit store unavailable'),
    });
    const app = await createApp(harness);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/callbacks/hold-ball/${task.id}`,
      headers: { 'x-cat-cafe-user': 'operator-user' },
    });
    assert.equal(response.statusCode, 500, response.body);
    assert.equal(harness.liveTasks.length, 1);
    assert.deepEqual(harness.unregistered, []);
    assert.deepEqual(harness.managedCancelCalls, []);
  });
});
