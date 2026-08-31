/**
 * Regression tests for post_message @mention → A2A invocation
 *
 * Validates:
 * - P1-1: No @ → no invocation triggered
 * - P1-2: Inline @ (行中) → no invocation triggered
 * - Line-start @ → mentions stored correctly
 * - P2-1: Deleting race → record marked canceled
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import Fastify from 'fastify';
import { canonicalTestQueueInput } from './helpers/message-from-fixtures.js';

function createMockSocketManager() {
  const messages = [];
  const roomEvents = [];
  const userEvents = [];
  return {
    broadcastAgentMessage(msg) {
      messages.push(msg);
    },
    broadcastToRoom(room, event, data) {
      roomEvents.push({ room, event, data });
    },
    // F-coalesce: production SocketManager has emitToUser (enqueueA2ATargets emits queue_updated on
    // both enqueue AND coalesce). The mock previously omitted it; coalesce path now exercises it.
    emitToUser(userId, event, data) {
      userEvents.push({ userId, event, data });
    },
    getMessages() {
      return messages;
    },
    getRoomEvents() {
      return roomEvents;
    },
    getUserEvents() {
      return userEvents;
    },
  };
}

function createMockInvocationRecordStore() {
  const records = [];
  const updates = [];
  return {
    create(input) {
      const id = `inv-${records.length}`;
      records.push({ id, ...input });
      return { outcome: 'created', invocationId: id };
    },
    update(id, data) {
      updates.push({ id, ...data });
      return { id, ...data };
    },
    getRecords() {
      return records;
    },
    getUpdates() {
      return updates;
    },
  };
}

function createMockRouter() {
  const executions = [];
  return {
    async *routeExecution(userId, message, threadId, _userMessageId, targetCats, _intent) {
      executions.push({ userId, message, threadId, targetCats });
      // Yield a done message
      yield {
        type: 'done',
        catId: targetCats[0],
        isFinal: true,
        timestamp: Date.now(),
      };
    },
    getExecutions() {
      return executions;
    },
  };
}

describe('post_message A2A mention invocation', () => {
  let registry;
  let messageStore;
  let socketManager;
  let invocationRecordStore;
  let mockRouter;
  let invocationQueue;
  let queueProcessor;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');

    registry = new InvocationRegistry();
    messageStore = new MessageStore();
    socketManager = createMockSocketManager();
    invocationRecordStore = createMockInvocationRecordStore();
    mockRouter = createMockRouter();
    invocationQueue = new InvocationQueue();
    queueProcessor = {
      async onInvocationComplete() {},
      async requestDrain() {},
      registerEntryCompleteHook() {},
      unregisterEntryCompleteHook() {},
    };
  });

  async function createApp(opts = {}) {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      router: mockRouter,
      invocationRecordStore,
      invocationQueue,
      queueProcessor,
      ...opts,
    });
    return app;
  }

  // P1-1 regression: no @ → no invocation
  test('post-message without @ does NOT trigger invocation', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 't1');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { content: 'Just a status update, no mentions' },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(
      invocationRecordStore.getRecords().length,
      0,
      'No InvocationRecord should be created for non-@ messages',
    );
    assert.equal(mockRouter.getExecutions().length, 0, 'routeExecution should not be called');
  });

  // P1-2 regression: inline @ → no invocation
  test('post-message with inline @ (行中) does NOT trigger invocation', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 't1');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        content: '这个方案里，之前 @缅因猫 提过类似的思路',
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(
      invocationRecordStore.getRecords().length,
      0,
      'Inline @mentions (行中) must not trigger A2A invocation',
    );
  });

  // P1-2 regression: @ inside code block → no invocation
  test('post-message with @ in code block does NOT trigger invocation', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 't1');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        content: '看看这段代码:\n```\n@缅因猫 这里是注释\n```\n完毕',
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(
      invocationRecordStore.getRecords().length,
      0,
      '@mentions inside code blocks must not trigger invocation',
    );
  });

  // Positive case: line-start @ → mentions stored + canonical Queue carrier created
  test('post-message with line-start @ stores mentions and queues A2A', async () => {
    let observedAppend;
    messageStore.onAppend = (message) => {
      observedAppend = structuredClone(message);
    };
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 't1');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        content: '修复完成了\n@缅因猫\n请帮忙 review',
      },
    });

    assert.equal(response.statusCode, 200);

    // Mentions should be stored on the message
    const recent = messageStore.getRecent(10);
    assert.equal(recent.length, 1);
    assert.ok(recent[0].mentions.includes('codex'), 'Message should store codex as mention (缅因猫 = codex)');
    assert.notEqual(recent[0].deliveryStatus, 'queued', 'agent speech must be public before recipient admission');
    assert.equal(recent[0].lifecycle.kind, 'input');
    assert.deepEqual(recent[0].lifecycle.dispatchRefs, [{ targetId: 'codex', phase: 'assigned' }]);
    assert.deepEqual(observedAppend.queueCustodyAdmission.targetCats, ['codex']);
    assert.deepEqual(
      observedAppend.lifecycle.dispatchRefs,
      [{ targetId: 'codex', phase: 'assigned' }],
      'append listeners must not observe a public A2A message before its wake admission',
    );
    assert.equal(socketManager.getMessages().length, 1, 'public speech must broadcast immediately');

    const entries = invocationQueue.list('t1', 'user-1');
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].targetCats, ['codex']);
    assert.equal(invocationRecordStore.getRecords().length, 0);
    assert.equal(mockRouter.getExecutions().length, 0);
  });

  // F-coalesce: use the real Queue and MessageStore so the merged public source
  // remains durably bound to the existing carrier across restart.
  test('post-message does not claim routed when InvocationQueue coalesces a duplicate queued target', async () => {
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const drainCalls = [];
    const queueProcessor = {
      async onInvocationComplete() {},
      async requestDrain(threadId) {
        drainCalls.push(threadId);
      },
      registerEntryCompleteHook() {},
      unregisterEntryCompleteHook() {},
    };
    const invocationQueue = new InvocationQueue();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 't1');
    const existing = invocationQueue.enqueue(
      canonicalTestQueueInput({
        threadId: 't1',
        userId: 'user-1',
        kind: 'message_wake',
        ownerAuthProvenance: 'unknown',
        content: 'earlier queued handoff',
        messageId: 'earlier-trigger',
        source: 'agent',
        sourceCategory: 'a2a',
        targetCats: ['codex'],
        intent: 'execute',
        autoExecute: true,
        callerCatId: 'opus',
        a2aTriggerMessageId: 'earlier-trigger',
      }),
    ).entry;
    const app = await createApp({ invocationQueue, queueProcessor });

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        content: '修复完成了\n@缅因猫\n请帮忙 review',
      },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    const entries = invocationQueue.list('t1', 'user-1');
    assert.equal(entries.length, 1, 'coalesce must preserve one Queue carrier');
    assert.equal(entries[0].id, existing.id);
    assert.match(entries[0].content, /earlier queued handoff/);
    assert.match(entries[0].content, /修复完成了/);
    assert.deepEqual(entries[0].mergedMessageIds, [body.messageId]);
    const custody = messageStore.getById(body.messageId).queueCustody;
    assert.equal(custody.carrierByTargetCatId.codex.entryId, existing.id);
    assert.deepEqual(custody.pendingTargetCats, ['codex']);
    assert.deepEqual(body.routed, [], 'Response must expose that no new A2A route was enqueued');
    assert.doesNotMatch(body.message, /消息已路由给 @codex/, 'Coalesced duplicate must not be reported as routed');
    assert.match(body.message, /未新增唤醒|已有待处理队列/);
    assert.deepEqual(drainCalls, ['t1'], 'existing queued entry should still signal the thread drain');
    assert.equal(invocationRecordStore.getRecords().length, 0, 'InvocationQueue path must not create legacy records');
  });

  // Content-before-mention regression: 上面写内容，最后一行 @ (缅因猫习惯)
  test('post-message with content-before-mention queues A2A', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 't1');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        content: '这是交接文档，源码目录执行\n是否接受完全禁用 --api-key argv\n@缅因猫',
      },
    });

    assert.equal(response.statusCode, 200);

    const recent = messageStore.getRecent(10);
    const lastMsg = recent[recent.length - 1];
    assert.ok(
      lastMsg.mentions.includes('codex'),
      'Content-before-mention: codex should be mentioned when @缅因猫 is on last line',
    );

    const entries = invocationQueue.list('t1', 'user-1');
    assert.equal(entries.length, 1, 'Content-before-mention should queue A2A for codex');
    assert.deepEqual(entries[0].targetCats, ['codex']);
    assert.equal(mockRouter.getExecutions().length, 0);
  });

  test('post-message skips redundant A2A when target already covered by active parent invocation', async () => {
    const mockInvocationTracker = {
      has() {
        return true;
      },
      getCatIds() {
        return ['opus', 'codex', 'gemini'];
      },
      getActiveSlots() {
        return ['opus', 'codex', 'gemini'];
      },
      start() {
        return new AbortController();
      },
      complete() {},
    };
    const app = await createApp({ invocationTracker: mockInvocationTracker });
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 't1');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        content: '同步一下\n@缅因猫\n这条是冗余提醒',
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(invocationRecordStore.getRecords().length, 0, 'Redundant A2A should not create InvocationRecord');
    assert.equal(mockRouter.getExecutions().length, 0, 'Redundant A2A should not call routeExecution');
  });

  // F108 slot-aware: opus active, @codex in different slot → codex SHOULD be invoked
  test('post-message queues codex when opus is active in a different slot', async () => {
    const mockInvocationTracker = {
      has() {
        return true;
      },
      getActiveSlots() {
        return ['opus']; // only opus is active, codex is NOT
      },
      start() {
        return new AbortController();
      },
      complete() {},
    };
    const app = await createApp({ invocationTracker: mockInvocationTracker });
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 't1');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        content: '修完了，请帮忙 review\n@缅因猫',
      },
    });

    assert.equal(response.statusCode, 200);
    const entries = invocationQueue.list('t1', 'user-1');
    assert.equal(entries.length, 1, 'Should queue codex in its independent slot');
    assert.deepEqual(entries[0].targetCats, ['codex']);
    assert.equal(invocationRecordStore.getRecords().length, 0);
  });

  // F108 slot-aware: opus active, explicit targetCats:["codex"] → codex SHOULD be invoked
  test('post-message with targetCats queues codex when opus is active', async () => {
    const mockInvocationTracker = {
      has() {
        return true;
      },
      getActiveSlots() {
        return ['opus'];
      },
      start() {
        return new AbortController();
      },
      complete() {},
    };
    const app = await createApp({ invocationTracker: mockInvocationTracker });
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 't1');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        content: 'co-creator快看！有事情！',
        targetCats: ['codex'],
      },
    });

    assert.equal(response.statusCode, 200);
    const entries = invocationQueue.list('t1', 'user-1');
    assert.equal(entries.length, 1, 'Should queue codex via targetCats');
    assert.deepEqual(entries[0].targetCats, ['codex']);
    assert.equal(invocationRecordStore.getRecords().length, 0);
  });

  // Invalid catId in explicitTargetCats → filtered out, no A2A crash
  test('post-message with invalid catId in targetCats is filtered gracefully', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 't1');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        content: 'co-creator快看！有事情！',
        targetCats: ['default-user'],
      },
    });

    assert.equal(response.statusCode, 200, 'Should succeed (graceful degradation, not 400)');
    // Message should still be stored
    const recent = messageStore.getRecent(10);
    assert.equal(recent.length, 1, 'Message should still be stored');
    // No A2A invocation should be triggered for invalid catId
    assert.equal(invocationRecordStore.getRecords().length, 0, 'Invalid catId must not trigger A2A');
    assert.equal(mockRouter.getExecutions().length, 0, 'routeExecution should not be called');
  });

  // Mixed valid + invalid targetCats → only valid ones enter A2A
  test('post-message with mixed valid/invalid targetCats keeps only valid ones', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 't1');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        content: '通知一下',
        targetCats: ['codex', 'default-user', 'nonexistent-cat'],
      },
    });

    assert.equal(response.statusCode, 200);
    const entries = invocationQueue.list('t1', 'user-1');
    assert.equal(entries.length, 1, 'Should queue only the valid target');
    assert.deepEqual(entries[0].targetCats, ['codex']);
    assert.equal(invocationRecordStore.getRecords().length, 0);
  });

  test('single line-start mention drops polluted explicit targetCats extras (fail-closed)', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 't1');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        content: '请帮忙复核\n@缅因猫',
        targetCats: ['codex', 'gemini'],
      },
    });

    assert.equal(response.statusCode, 200);
    const entries = invocationQueue.list('t1', 'user-1');
    assert.equal(entries.length, 1, 'single mention should enqueue exactly one target');
    assert.deepEqual(entries[0].targetCats, ['codex'], 'extra explicit target should be dropped');
    assert.equal(invocationRecordStore.getRecords().length, 0);

    const recent = messageStore.getRecent(10);
    assert.equal(recent.length, 1);
    assert.ok(recent[0].mentions.includes('codex'));
    assert.equal(recent[0].mentions.includes('gemini'), false, 'gemini must not be injected into mentions');
  });

  // Self-mention filter: opus @布偶猫 → no invocation (can't invoke self)
  test('post-message self-mention does NOT trigger invocation', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 't1');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        content: '@布偶猫\n这是自我引用测试',
      },
    });

    assert.equal(response.statusCode, 200);
    // parseA2AMentions filters self-mentions, so no invocation
    assert.equal(invocationRecordStore.getRecords().length, 0, 'Self-mention must not trigger invocation');
  });
});

describe('F052: cross-thread A2A mention routing', () => {
  let registry;
  let messageStore;
  let threadStore;
  let socketManager;
  let invocationRecordStore;
  let mockRouter;
  let invocationQueue;
  let queueProcessor;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');

    registry = new InvocationRegistry();
    messageStore = new MessageStore();
    threadStore = new ThreadStore();
    socketManager = createMockSocketManager();
    invocationRecordStore = createMockInvocationRecordStore();
    mockRouter = createMockRouter();
    invocationQueue = new InvocationQueue();
    queueProcessor = { async requestDrain() {} };
  });

  async function createAppWithThreadStore() {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      threadStore,
      socketManager,
      router: mockRouter,
      invocationRecordStore,
      invocationQueue,
      queueProcessor,
    });
    return app;
  }

  test('cross-thread @codex from codex is NOT filtered (includes codex in mentions)', async () => {
    const app = await createAppWithThreadStore();
    const sourceThread = await threadStore.create('user-1', 'A2A Source Thread');
    const targetThread = await threadStore.create('user-1', 'A2A Target Thread');

    const { invocationId, callbackToken } = await registry.create('user-1', 'codex', sourceThread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        content: '@codex 请处理这个跨线程任务',
        threadId: targetThread.id,
      },
    });

    assert.equal(res.statusCode, 200);
    const msgs = messageStore.getByThread(targetThread.id, 10, 'user-1');
    const crossMsg = msgs.find((m) => m.content.includes('跨线程任务'));
    assert.ok(crossMsg, 'cross-thread message should be stored');
    assert.ok(crossMsg.mentions.includes('codex'), 'cross-thread @codex should be in mentions');
  });

  test('same-thread @codex from codex still filtered (self-reference)', async () => {
    const app = await createAppWithThreadStore();
    const thread = await threadStore.create('user-1', 'Self Ref Thread');

    const { invocationId, callbackToken } = await registry.create('user-1', 'codex', thread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        content: '@codex 请处理',
        threadId: thread.id,
      },
    });

    assert.equal(res.statusCode, 200);
    const msgs = messageStore.getByThread(thread.id, 10, 'user-1');
    const msg = msgs.find((m) => m.content.includes('请处理'));
    assert.ok(msg);
    assert.ok(!msg.mentions.includes('codex'), 'same-thread @codex from codex should be filtered');
  });
});
