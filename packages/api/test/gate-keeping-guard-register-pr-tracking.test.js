/**
 * F167 gate-keeping thread guard — register-pr-tracking endpoint
 *
 * Root cause (主 thread thread_mp3ab0r9xqxrkrc5 诊断)：opensource-ops SKILL.md
 * 文字层 100%「守门 thread 不修 bug / 不替下游 hold」但 trigger-time 0
 * enforcement，同 session 同天 2 只猫连续在守门 thread 误挂 PR tracking +
 * hold_ball → 双 owner 球权死锁。
 *
 * Guard 行为矩阵：
 *   thread.threadKind=undefined         + no override → 200 (regression cover, INV-G4)
 *   thread.threadKind='gate-keeping'    + no override → 400 (INV-G2)
 *   thread.threadKind='gate-keeping'    + override='i-am-the-downstream-owner' → 200 (INV-G3)
 *   threadStore.get throws              + no override → 200 (fail-open, INV-G7)
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

describe('F167 gate-keeping guard: POST /api/callbacks/register-pr-tracking', () => {
  let registry;
  let messageStore;
  let socketManager;
  let evidenceStore;
  let reflectionService;
  let markerQueue;
  let threadStore;
  let taskStore;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');

    registry = new InvocationRegistry();
    messageStore = new MessageStore();
    threadStore = new ThreadStore();
    taskStore = new TaskStore();
    socketManager = {
      broadcastAgentMessage() {},
      broadcastToRoom() {},
      getMessages() {
        return [];
      },
    };
    evidenceStore = {
      search: async () => [],
      health: async () => true,
      initialize: async () => {},
      upsert: async () => {},
      deleteByAnchor: async () => {},
      getByAnchor: async () => null,
    };
    reflectionService = { reflect: async () => '' };
    markerQueue = {
      submit: async (marker) => ({ id: 'mk-1', createdAt: new Date().toISOString(), ...marker }),
      list: async () => [],
      transition: async () => {},
    };
  });

  async function createApp(overrides = {}) {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    const options = {
      registry,
      messageStore,
      socketManager,
      threadStore: overrides.threadStore ?? threadStore,
      evidenceStore,
      reflectionService,
      markerQueue,
      taskStore: overrides.taskStore ?? taskStore,
      fetchPrTrackingBoundary: async () => ({
        review: { lastCommentCursor: 0, lastDecisionCursor: 0 },
        ci: { headSha: 'test-head' },
      }),
    };
    await app.register(callbacksRoutes, options);
    return app;
  }

  function createInvocation(threadId, managedWorkBinding, userId = 'user-1', catId = 'opus') {
    return registry.create(
      userId,
      catId,
      threadId,
      undefined,
      undefined,
      undefined,
      undefined,
      'strict',
      managedWorkBinding,
    );
  }

  test('INV-G4: non-gate-keeping thread → 200 (regression cover)', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', 'normal-thread');
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-pr-tracking',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { repoFullName: 'owner/repo', prNumber: 100 },
    });

    assert.equal(response.statusCode, 200, 'normal thread tracking must still succeed');
    const body = JSON.parse(response.body);
    assert.equal(body.status, 'ok');
    assert.equal(body.task.subjectKey, 'pr:owner/repo#100');
  });

  test('F275: strict invocation binds private managed-work identity without public egress', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', 'managed-pr-tracking');
    const binding = { workId: 'work-private-1', attemptId: 'attempt-private-1' };
    const { invocationId, callbackToken } = await createInvocation(thread.id, binding);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-pr-tracking',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { repoFullName: 'owner/repo', prNumber: 501 },
    });

    assert.equal(response.statusCode, 200);
    const task = taskStore.getBySubject('pr:owner/repo#501');
    assert.deepEqual(taskStore.getManagedWorkBinding(task.id), binding);
    assert.equal(response.body.includes(binding.workId), false);
    assert.equal(response.body.includes(binding.attemptId), false);
  });

  test('F275: re-registration without a binding preserves the existing private identity', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', 'managed-pr-tracking');
    const binding = { workId: 'work-private-2', attemptId: 'attempt-private-2' };
    const managed = await createInvocation(thread.id, binding);

    const first = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-pr-tracking',
      headers: { 'x-invocation-id': managed.invocationId, 'x-callback-token': managed.callbackToken },
      payload: { repoFullName: 'owner/repo', prNumber: 502 },
    });
    assert.equal(first.statusCode, 200);

    const unbound = await createInvocation(thread.id);
    const second = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-pr-tracking',
      headers: { 'x-invocation-id': unbound.invocationId, 'x-callback-token': unbound.callbackToken },
      payload: { repoFullName: 'owner/repo', prNumber: 502 },
    });

    assert.equal(second.statusCode, 200);
    const task = taskStore.getBySubject('pr:owner/repo#502');
    assert.deepEqual(taskStore.getManagedWorkBinding(task.id), binding);
    assert.equal(second.body.includes(binding.workId), false);
    assert.equal(second.body.includes(binding.attemptId), false);
  });

  test('F275: re-registration with a different binding conflicts and preserves the first identity', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', 'managed-pr-tracking');
    const firstBinding = { workId: 'work-private-3', attemptId: 'attempt-private-3' };
    const secondBinding = { workId: 'work-private-4', attemptId: 'attempt-private-4' };
    const firstInvocation = await createInvocation(thread.id, firstBinding);
    const secondInvocation = await createInvocation(thread.id, secondBinding);

    const first = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-pr-tracking',
      headers: {
        'x-invocation-id': firstInvocation.invocationId,
        'x-callback-token': firstInvocation.callbackToken,
      },
      payload: { repoFullName: 'owner/repo', prNumber: 503 },
    });
    assert.equal(first.statusCode, 200);

    const second = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-pr-tracking',
      headers: {
        'x-invocation-id': secondInvocation.invocationId,
        'x-callback-token': secondInvocation.callbackToken,
      },
      payload: { repoFullName: 'owner/repo', prNumber: 503 },
    });

    assert.equal(second.statusCode, 409);
    const task = taskStore.getBySubject('pr:owner/repo#503');
    assert.deepEqual(taskStore.getManagedWorkBinding(task.id), firstBinding);
    assert.equal(second.body.includes(secondBinding.workId), false);
    assert.equal(second.body.includes(secondBinding.attemptId), false);
  });

  test('F275: rejected cross-owner registration cannot bind the existing task', async () => {
    const app = await createApp();
    const ownerThread = await threadStore.create('user-1', 'owner-pr-tracking');
    const attackerThread = await threadStore.create('user-2', 'other-owner-pr-tracking');
    const ownerInvocation = await createInvocation(ownerThread.id);
    const attackerBinding = { workId: 'work-other-owner', attemptId: 'attempt-other-owner' };
    const attackerInvocation = await createInvocation(attackerThread.id, attackerBinding, 'user-2', 'codex');

    const first = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-pr-tracking',
      headers: {
        'x-invocation-id': ownerInvocation.invocationId,
        'x-callback-token': ownerInvocation.callbackToken,
      },
      payload: { repoFullName: 'owner/repo', prNumber: 504 },
    });
    assert.equal(first.statusCode, 200);

    const second = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-pr-tracking',
      headers: {
        'x-invocation-id': attackerInvocation.invocationId,
        'x-callback-token': attackerInvocation.callbackToken,
      },
      payload: { repoFullName: 'owner/repo', prNumber: 504 },
    });

    assert.equal(second.statusCode, 409);
    const task = taskStore.getBySubject('pr:owner/repo#504');
    assert.equal(task.userId, 'user-1');
    assert.equal(taskStore.getManagedWorkBinding(task.id), null);
    assert.equal(second.body.includes(attackerBinding.workId), false);
    assert.equal(second.body.includes(attackerBinding.attemptId), false);
  });

  test('F275: conflicting concurrent managed registrations leave only the winner mutation', async () => {
    const threadA = await threadStore.create('user-1', 'managed-pr-race-a');
    const threadB = await threadStore.create('user-1', 'managed-pr-race-b');
    const candidates = [
      {
        thread: threadA,
        binding: { workId: 'work-race-a', attemptId: 'attempt-race-a' },
        instructions: 'winner-a-instructions',
      },
      {
        thread: threadB,
        binding: { workId: 'work-race-b', attemptId: 'attempt-race-b' },
        instructions: 'winner-b-instructions',
      },
    ];
    const invocations = await Promise.all(
      candidates.map(({ thread, binding }) => createInvocation(thread.id, binding)),
    );

    let preflightReads = 0;
    let releasePreflight;
    const bothPreflightsReached = new Promise((resolve) => {
      releasePreflight = resolve;
    });
    const racingTaskStore = {
      getBySubject: async (subjectKey) => {
        const existing = taskStore.getBySubject(subjectKey);
        if (subjectKey === 'pr:owner/repo#506' && !existing) {
          preflightReads += 1;
          if (preflightReads === 2) releasePreflight();
          await bothPreflightsReached;
        }
        return existing;
      },
      upsertBySubject: taskStore.upsertBySubject.bind(taskStore),
      upsertBySubjectWithManagedWorkBinding: (...args) => taskStore.upsertBySubjectWithManagedWorkBinding(...args),
      bindManagedWorkBinding: taskStore.bindManagedWorkBinding.bind(taskStore),
      getManagedWorkBinding: taskStore.getManagedWorkBinding.bind(taskStore),
      patchAutomationState: taskStore.patchAutomationState.bind(taskStore),
    };
    const app = await createApp({ taskStore: racingTaskStore });

    const responses = await Promise.all(
      candidates.map((candidate, index) =>
        app.inject({
          method: 'POST',
          url: '/api/callbacks/register-pr-tracking',
          headers: {
            'x-invocation-id': invocations[index].invocationId,
            'x-callback-token': invocations[index].callbackToken,
          },
          payload: {
            repoFullName: 'owner/repo',
            prNumber: 506,
            instructions: candidate.instructions,
          },
        }),
      ),
    );

    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
    const winnerIndex = responses.findIndex((response) => response.statusCode === 200);
    const winner = candidates[winnerIndex];
    const stored = taskStore.getBySubject('pr:owner/repo#506');
    assert.ok(stored);
    assert.equal(stored.threadId, winner.thread.id);
    assert.equal(stored.automationState.trackingInstructions, winner.instructions);
    assert.deepEqual(taskStore.getManagedWorkBinding(stored.id), winner.binding);
  });

  test('F275: binds the TaskItem returned by upsert when a stale anchor is replaced', async () => {
    const thread = await threadStore.create('user-1', 'managed-pr-tracking-replacement');
    const binding = { workId: 'work-replacement', attemptId: 'attempt-replacement' };
    const invocation = await createInvocation(thread.id, binding);
    const stale = taskStore.create({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#505',
      threadId: thread.id,
      title: 'stale PR tracking anchor',
      why: 'simulate expiry between lookup and upsert',
      createdBy: 'codex',
      ownerCatId: 'codex',
      userId: 'user-1',
    });
    taskStore.update(stale.id, { status: 'done' });
    const replacement = {
      ...stale,
      id: 'task-replacement',
      status: 'todo',
      updatedAt: stale.updatedAt + 1,
    };
    const calls = [];
    const racingTaskStore = {
      getBySubject: () => stale,
      upsertBySubject: () => {
        calls.push(`upsert:${replacement.id}`);
        return replacement;
      },
      upsertBySubjectWithManagedWorkBinding: (_input, nextBinding) => {
        calls.push(`managed-upsert:${replacement.id}:${nextBinding.workId}`);
        return replacement;
      },
      bindManagedWorkBinding: (taskId, nextBinding) => {
        calls.push(`bind:${taskId}`);
        return nextBinding;
      },
      getManagedWorkBinding: () => null,
      patchAutomationState: () => replacement,
    };
    const app = await createApp({ taskStore: racingTaskStore });

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-pr-tracking',
      headers: {
        'x-invocation-id': invocation.invocationId,
        'x-callback-token': invocation.callbackToken,
      },
      payload: { repoFullName: 'owner/repo', prNumber: 505 },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls, [`managed-upsert:${replacement.id}:${binding.workId}`]);
  });

  test('INV-G2: gate-keeping thread + no override → 400 gate_keeping_thread_default_blocked', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', 'repo-inbox');
    await threadStore.updateThreadKind(thread.id, 'gate-keeping');
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-pr-tracking',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { repoFullName: 'owner/repo', prNumber: 200 },
    });

    assert.equal(response.statusCode, 400, 'gate-keeping thread must default-block');
    const body = JSON.parse(response.body);
    assert.equal(body.error, 'gate_keeping_thread_default_blocked');
    assert.equal(body.threadKind, 'gate-keeping');
    assert.match(body.remediation, /override|cross_post|propose/);

    // 关键：guard 必须在 taskStore.upsertBySubject 之前 short-circuit，task 不可创建
    const stored = taskStore.getBySubject('pr:owner/repo#200');
    assert.equal(stored, null, 'task must NOT be created when guard blocks');
  });

  test("INV-G3': gate-keeping thread has NO override escape — override claim is silently ignored, guard still blocks (R1 review fix: removed override mechanism)", async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', 'repo-inbox');
    await threadStore.updateThreadKind(thread.id, 'gate-keeping');
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', thread.id);

    // Even if a cat tries to pass the old override literal, schema strips it
    // (no `override` field in schema) and guard still hard-blocks.
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-pr-tracking',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        repoFullName: 'owner/repo',
        prNumber: 300,
        override: 'i-am-the-downstream-owner',
      },
    });

    assert.equal(response.statusCode, 400, 'override claim must NOT escape — gate-keeping is hard-block');
    const body = JSON.parse(response.body);
    assert.equal(body.error, 'gate_keeping_thread_default_blocked');
    assert.equal(body.threadKind, 'gate-keeping');
    // Remediation must point cats to traffic-redirect (cross_post / propose / 分发),
    // and explicitly state no override channel exists.
    assert.match(body.remediation, /cross_post|propose|分发/);
    assert.match(body.remediation, /没有 override 通道/);

    // No task persisted.
    const stored = taskStore.getBySubject('pr:owner/repo#300');
    assert.equal(stored, null, 'task must NOT be created when guard blocks');
  });

  test('INV-G7: threadStore.get throws → fail-open (200), guard does not block prod', async () => {
    // 用真 store 创建 thread/invocation 再换 store；这样 callbacks 路由的其他 threadStore.get 调用走真 store
    const thread = await threadStore.create('user-1', 'normal-thread');
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', thread.id);

    // 用一个 guard 路径下 throw 的 threadStore 替换，模拟 store 抖动
    const flakyStore = new Proxy(threadStore, {
      get(target, prop) {
        if (prop === 'get') {
          return async () => {
            throw new Error('redis down');
          };
        }
        return target[prop];
      },
    });
    const app = await createApp({ threadStore: flakyStore });

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-pr-tracking',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { repoFullName: 'owner/repo', prNumber: 400 },
    });

    assert.equal(response.statusCode, 200, 'guard must fail-open on threadStore error');
  });
});
