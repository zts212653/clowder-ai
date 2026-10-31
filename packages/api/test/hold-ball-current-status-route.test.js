/**
 * F167 #1449 Slice 1 — GET /api/callbacks/hold-ball/current route test.
 *
 * Tests the task-ID-independent hold observability endpoint.
 * An MCP caller can query "do I have an active hold?" without knowing
 * the internal task ID — this was the gap reported by mindfn.
 *
 * [宪宪/claude-opus-4-6🐾]
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

describe('F167 #1449 Slice 1: GET /api/callbacks/hold-ball/current', () => {
  let registry;
  let threadStore;

  /** Minimal hold-ball task fixture. */
  function makeHoldTask(id, threadId, catId, overrides = {}) {
    return {
      id,
      templateId: 'reminder',
      trigger: { type: 'once', fireAt: Date.now() + 60_000 },
      params: {
        message: '持球唤醒',
        targetCatId: catId,
        triggerUserId: 'user1',
        holdLifecycle: {
          mode: 'timer',
          status: 'active',
          createdBy: `hold-ball:${catId}`,
        },
        ...overrides.params,
      },
      display: { label: `持球唤醒 (${catId})`, category: 'system', description: '...' },
      deliveryThreadId: threadId,
      enabled: true,
      createdBy: `hold-ball:${catId}`,
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  function makeStubDeps(tasks = [], threadOwners = {}) {
    const dynamicTaskStore = {
      getById(id) {
        return tasks.find((t) => t.id === id) ?? null;
      },
      getAll() {
        return [...tasks];
      },
      findByDeliveryThreadAndCreatedBy(threadId, createdBy) {
        return tasks.filter((t) => t.deliveryThreadId === threadId && t.createdBy === createdBy);
      },
      remove() {
        return true;
      },
      setEnabled() {
        return true;
      },
      updateParams() {
        return true;
      },
    };
    return {
      registry,
      ownerUserId: 'test-user',
      taskRunner: {
        registerDynamic() {},
        unregister() {},
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
      dynamicTaskStore,
      scheduleMutationAuditStore: {
        deleteTaskWithAudit() {
          return true;
        },
        setTaskEnabledWithAudit() {
          return true;
        },
        updateTaskParamsAndEnabledWithAudit() {
          return true;
        },
      },
      messageStore: {
        async append(msg) {
          return { id: 'msg-1', ...msg };
        },
      },
      socketManager: {
        broadcastToRoom() {},
      },
      threadStore: {
        get(threadId) {
          const owner = threadOwners[threadId];
          return owner ? { id: threadId, createdBy: owner, participants: [] } : null;
        },
        list(userId) {
          return Object.entries(threadOwners)
            .filter(([, owner]) => owner === userId)
            .map(([threadId, owner]) => ({ id: threadId, createdBy: owner, participants: [] }));
        },
      },
      cancelManagedWakeIfTaskMatches() {
        return true;
      },
    };
  }

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    registry = new InvocationRegistry();
    threadStore = new ThreadStore();
  });

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

  test('returns current hold status via invocation auth', async () => {
    const task = makeHoldTask('hold-ball-abc-123', 'thread-obs', 'codex');
    const deps = makeStubDeps([task], { 'thread-obs': 'test-user' });
    const app = await createApp(deps);

    const thread = await threadStore.create('test-user', 'obs-thread');
    // Re-bind task to real thread ID
    task.deliveryThreadId = thread.id;

    const { invocationId, callbackToken } = await registry.create('test-user', 'codex', thread.id);
    const headers = {
      'x-invocation-id': invocationId,
      'x-callback-token': callbackToken,
    };
    // Also make threadOwners match the real thread ID
    deps.threadStore.get = (id) =>
      id === thread.id ? { id: thread.id, createdBy: 'test-user', participants: [] } : null;
    deps.threadStore.list = () => [{ id: thread.id, createdBy: 'test-user', participants: [] }];
    deps.dynamicTaskStore.findByDeliveryThreadAndCreatedBy = (threadId, createdBy) =>
      [task].filter((t) => t.deliveryThreadId === threadId && t.createdBy === createdBy);

    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/hold-ball/current',
      headers,
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.hasActiveHold, true);
    assert.equal(body.taskId, 'hold-ball-abc-123');
    assert.equal(body.catId, 'codex');
    assert.ok(body.lifecycle, 'should include lifecycle projection');
    assert.equal(body.lifecycle.status, 'active');
  });

  test('returns empty when no hold exists', async () => {
    const deps = makeStubDeps([], { 'thread-empty': 'test-user' });
    const app = await createApp(deps);

    const thread = await threadStore.create('test-user', 'empty-thread');
    const { invocationId, callbackToken } = await registry.create('test-user', 'codex', thread.id);
    const headers = {
      'x-invocation-id': invocationId,
      'x-callback-token': callbackToken,
    };

    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/hold-ball/current',
      headers,
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.hasActiveHold, false);
    assert.equal(body.taskId, null);
  });

  test('rejects unauthenticated requests', async () => {
    const deps = makeStubDeps([], {});
    const app = await createApp(deps);

    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/hold-ball/current',
    });

    assert.equal(res.statusCode, 401);
  });

  // ── P1-1 RED tests: access policy enforcement ──

  test('different user + same cat + default thread returns 403 with no hold leak', async () => {
    // Hold created by user1/codex on default thread
    const task = makeHoldTask('hold-ball-fence-001', 'default', 'codex', {
      params: { triggerUserId: 'user1' },
    });
    // deps.threadStore stubs: default thread is owned by user1
    const deps = makeStubDeps([task], { default: 'user1' });
    const app = await createApp(deps);

    // Create invocation as user2 (different user!) but same cat codex on default thread
    const { invocationId, callbackToken } = await registry.create('user2', 'codex', 'default');
    const headers = {
      'x-invocation-id': invocationId,
      'x-callback-token': callbackToken,
    };
    // threadStore.list for user2 returns default thread (default thread visible to all users)
    deps.threadStore.list = () => [{ id: 'default', createdBy: 'user1', participants: [] }];

    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/hold-ball/current',
      headers,
    });

    // Must be 403 — not 200 with another user's hold data
    assert.equal(res.statusCode, 403, 'cross-user hold on default thread must be denied');
    const body = JSON.parse(res.body);
    // Must not leak hold details
    assert.equal(body.taskId, undefined, 'must not leak taskId');
    assert.equal(body.lifecycle, undefined, 'must not leak lifecycle');
  });

  test('non-owner collaborator sees only summary lifecycle (mode+status)', async (t) => {
    // Hold created by original-user/codex on a non-default thread
    const thread = await threadStore.create('test-user', 'collab-thread');
    const task = makeHoldTask('hold-ball-collab-001', thread.id, 'codex', {
      params: {
        triggerUserId: 'original-user',
        holdLifecycle: {
          mode: 'wake_when',
          status: 'active',
          createdBy: 'hold-ball:codex',
          waitSourceRef: { kind: 'github_issue', value: 'org/repo#42' },
          expectedSignalKey: 'ci_complete',
          wakeAt: Date.now() + 60_000,
        },
      },
    });
    const deps = makeStubDeps([task], { [thread.id]: 'test-user' });
    const app = await createApp(deps);

    // Create invocation as DIFFERENT user but same cat codex on non-default thread
    // → isTriggerPrincipal returns false (userId mismatch)
    // → role = thread_collaborator → lifecycleVisibility = summary
    const { invocationId, callbackToken } = await registry.create('test-user', 'codex', thread.id);
    const headers = {
      'x-invocation-id': invocationId,
      'x-callback-token': callbackToken,
    };
    deps.dynamicTaskStore.findByDeliveryThreadAndCreatedBy = (tid, cb) =>
      [task].filter((t) => t.deliveryThreadId === tid && t.createdBy === cb);
    deps.threadStore.get = (id) =>
      id === thread.id ? { id: thread.id, createdBy: 'test-user', participants: [] } : null;
    deps.threadStore.list = () => [{ id: thread.id, createdBy: 'test-user', participants: [] }];

    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/hold-ball/current',
      headers,
    });

    // Collaborator can see the hold exists but lifecycle is projected to summary
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.hasActiveHold, true);
    assert.equal(body.access.role, 'thread_collaborator');
    assert.equal(body.access.lifecycleVisibility, 'summary');
    // Summary lifecycle: only mode + status, no waitSourceRef/expectedSignalKey/wakeAt
    assert.deepEqual(body.lifecycle, { mode: 'wake_when', status: 'active' });
    // Owner projection: no userId for non-full visibility
    assert.equal(body.owner.catId, 'codex');
    assert.equal(body.owner.userId, undefined, 'non-full visibility must not expose userId');

    // Job cancellation is principal-scoped even when the surrounding hold is
    // visible to a collaborator. Both read surfaces must match DELETE.
    const { ManagedJobService } = await import('../dist/domains/managed-job/ManagedJobService.js');
    const root = await mkdtemp(join(tmpdir(), 'managed-job-access-'));
    const priorRoot = process.env.CAT_CAFE_DATA_DIR;
    process.env.CAT_CAFE_DATA_DIR = root;
    t.after(async () => {
      if (priorRoot === undefined) delete process.env.CAT_CAFE_DATA_DIR;
      else process.env.CAT_CAFE_DATA_DIR = priorRoot;
      await app.close();
      await rm(root, { recursive: true, force: true });
    });
    const service = new ManagedJobService(root);
    const job = await service.submit(
      { userId: 'original-user', catId: 'codex', threadId: thread.id },
      {
        command: 'node --version',
        cwd: process.cwd(),
        originInvocationId: 'job-owner',
        originTaskId: task.id,
        executionSlaMs: 10000,
        idempotencyKey: 'cancel-permission',
        wakeTarget: { threadId: thread.id, catId: 'codex', userId: 'original-user' },
      },
    );
    service.admit({ userId: 'original-user', catId: 'codex', threadId: thread.id }, job.jobId, 'visible-job-card');
    task.params.holdLifecycle.managedCommand = {
      state: 'command_running',
      command: 'node --version',
      startedAt: Date.now(),
      jobId: job.jobId,
    };
    for (const url of ['/api/callbacks/hold-ball/current', `/api/callbacks/hold-ball/${task.id}/status`]) {
      const response = await app.inject({ method: 'GET', url, headers });
      assert.equal(response.statusCode, 200);
      const status = response.json();
      assert.equal(status.cancelable, false, url);
      if (url.endsWith('/status')) assert.equal(status.access.canCancel, false);
    }
    assert.equal(
      (await app.inject({ method: 'DELETE', url: `/api/callbacks/hold-ball/${task.id}`, headers })).statusCode,
      403,
    );
    const internal = await registry.create('scheduler', 'codex', thread.id);
    const internalRead = await app.inject({
      method: 'GET',
      url: `/api/callbacks/hold-ball/${task.id}/status?tailBytes=100`,
      headers: { 'x-invocation-id': internal.invocationId, 'x-callback-token': internal.callbackToken },
    });
    assert.equal(internalRead.statusCode, 403, 'internal actor cannot borrow a different stored job owner');
  });

  for (const actorUserId of ['scheduler', 'system']) {
    test(`internal ${actorUserId} invocation retains its thread-owned job read/cancel authority`, async (t) => {
      const thread = await threadStore.create('test-user', 'internal-owner-job');
      const task = makeHoldTask(`hold-ball-internal-${actorUserId}`, thread.id, 'codex', {
        params: {
          triggerUserId: 'test-user',
          holdLifecycle: { mode: 'wake_when', status: 'active', createdBy: 'hold-ball:codex' },
        },
      });
      const deps = makeStubDeps([task], { [thread.id]: 'test-user' });
      const app = await createApp(deps);
      const root = await mkdtemp(join(tmpdir(), 'managed-internal-access-'));
      const priorRoot = process.env.CAT_CAFE_DATA_DIR;
      process.env.CAT_CAFE_DATA_DIR = root;
      t.after(async () => {
        await app.close();
        if (priorRoot === undefined) delete process.env.CAT_CAFE_DATA_DIR;
        else process.env.CAT_CAFE_DATA_DIR = priorRoot;
        await rm(root, { recursive: true, force: true });
      });
      const { ManagedJobService } = await import('../dist/domains/managed-job/ManagedJobService.js');
      const service = new ManagedJobService(root);
      const principal = { userId: 'test-user', catId: 'codex', threadId: thread.id };
      const job = await service.submit(principal, {
        command: 'node --version',
        cwd: process.cwd(),
        originInvocationId: 'internal-owner',
        originTaskId: task.id,
        executionSlaMs: 10000,
        idempotencyKey: actorUserId,
        wakeTarget: principal,
      });
      service.admit(principal, job.jobId, `visible-${actorUserId}-job`);
      task.params.holdLifecycle.managedCommand = {
        state: 'command_running',
        command: 'node --version',
        startedAt: Date.now(),
        jobId: job.jobId,
      };
      const auth = await registry.create(actorUserId, 'codex', thread.id);
      const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
      const response = await app.inject({
        method: 'GET',
        url: `/api/callbacks/hold-ball/${task.id}/status?tailBytes=100`,
        headers,
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().access.role, 'trigger_principal');
      assert.equal(response.json().job.jobId, job.jobId);
      const cancelled = await app.inject({ method: 'DELETE', url: `/api/callbacks/hold-ball/${task.id}`, headers });
      assert.equal(cancelled.statusCode, 200, cancelled.body);
      assert.equal(service.get(principal, job.jobId).state, 'cancelled');
    });
  }

  // ── P1-2 RED tests: retired-with-running-managed-command observability ──

  test('retired hold with running managed command is discoverable and cancelable', async () => {
    const thread = await threadStore.create('test-user', 'managed-thread');
    // Retired carrier: enabled=false, lifecycle status=retired_by_replacement,
    // but managed command state=command_running
    const task = makeHoldTask('hold-ball-managed-001', thread.id, 'codex', {
      enabled: false,
      params: {
        triggerUserId: 'test-user',
        holdLifecycle: {
          mode: 'wake_when',
          status: 'retired_by_replacement',
          createdBy: 'hold-ball:codex',
          managedCommand: {
            state: 'command_running',
            command: 'pnpm test',
            startedAt: Date.now() - 30_000,
          },
        },
      },
    });
    const deps = makeStubDeps([task], { [thread.id]: 'test-user' });
    const app = await createApp(deps);

    const { invocationId, callbackToken } = await registry.create('test-user', 'codex', thread.id);
    const headers = {
      'x-invocation-id': invocationId,
      'x-callback-token': callbackToken,
    };
    deps.dynamicTaskStore.findByDeliveryThreadAndCreatedBy = (tid, cb) =>
      [task].filter((t) => t.deliveryThreadId === tid && t.createdBy === cb);

    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/hold-ball/current',
      headers,
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    // Not "active" (carrier retired) but still observable
    assert.equal(body.hasActiveHold, false, 'retired carrier should not be "active"');
    assert.equal(body.taskId, 'hold-ball-managed-001', 'must expose task ID');
    assert.equal(body.cancelable, true, 'running managed command must be cancelable');
    assert.ok(body.lifecycle, 'must expose lifecycle');
    assert.equal(body.lifecycle.status, 'retired_by_replacement');
  });

  test('fully retired tombstone (no running command) is not observable', async () => {
    const thread = await threadStore.create('test-user', 'tombstone-thread');
    // Retired AND no running managed command → true tombstone, not observable
    const task = makeHoldTask('hold-ball-tombstone-001', thread.id, 'codex', {
      enabled: false,
      params: {
        triggerUserId: 'test-user',
        holdLifecycle: {
          mode: 'timer',
          status: 'retired_by_event',
          createdBy: 'hold-ball:codex',
        },
      },
    });
    const deps = makeStubDeps([task], { [thread.id]: 'test-user' });
    const app = await createApp(deps);

    const { invocationId, callbackToken } = await registry.create('test-user', 'codex', thread.id);
    const headers = {
      'x-invocation-id': invocationId,
      'x-callback-token': callbackToken,
    };
    deps.dynamicTaskStore.findByDeliveryThreadAndCreatedBy = (tid, cb) =>
      [task].filter((t) => t.deliveryThreadId === tid && t.createdBy === cb);

    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/hold-ball/current',
      headers,
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.hasActiveHold, false);
    assert.equal(body.taskId, null, 'tombstone must not be observable');
    assert.equal(body.lifecycle, null);
  });
});
