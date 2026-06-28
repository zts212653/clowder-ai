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
      taskStore,
      fetchPrTrackingBoundary: async () => ({
        review: { lastCommentCursor: 0, lastDecisionCursor: 0 },
        ci: { headSha: 'test-head' },
      }),
    };
    await app.register(callbacksRoutes, options);
    return app;
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
