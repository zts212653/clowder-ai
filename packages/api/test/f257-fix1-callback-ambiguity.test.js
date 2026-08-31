/**
 * F257 修复清单 #1 增补 — callback 路径的拒绝语义完整化（sol F7 + scope 增补）。
 *
 * 1. formatter：post_message 响应的人类可读 message 必须把 mention_ambiguous
 *    说成「同时匹配多只猫 + 显式 handle 提示」，而不是「不存在，已跳过」。
 *    两种 auth 路径（invocation-token / agent-key）共享同一 formatter。
 * 2. routing mismatch HELD（平行 Fable kickoff 增补，operator 22:17 痛点）：
 *    声明 targetCats 与 content 行首 @ 解析结果不一致（content 拉进声明外的猫）
 *    → HELD（freshness gate 同形态），不落库不路由不静默仲裁。
 *    活体证据：kickoff 消息声明 sol、content @砚砚 → 旧逻辑静默丢弃声明目标
 *    只路由 codex（callbacks.ts content-wins 仲裁）。
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { catRegistry, createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';

function mkConfig(catId, patterns, nickname) {
  return {
    id: createCatId(catId),
    name: `${catId}-name`,
    displayName: `${catId}-display`,
    ...(nickname ? { nickname } : {}),
    avatar: `/avatars/${catId}.png`,
    color: { primary: '#000000', secondary: '#ffffff' },
    mentionPatterns: patterns,
    clientId: 'anthropic',
    defaultModel: 'claude-sonnet-4-5-20250929',
    mcpSupport: true,
  };
}

// 歧义对（callback 场景专用 token，避免与其他测试文件的注入猫冲突）
for (const [catId, patterns] of [
  ['cbk-amb-a', ['@cbk-amb-a', '@回名']],
  ['cbk-amb-b', ['@cbk-amb-b', '@回名']],
]) {
  if (!catRegistry.has(catId)) catRegistry.register(catId, mkConfig(catId, patterns));
}

function createMockSocketManager() {
  const messages = [];
  return {
    broadcastAgentMessage(msg) {
      messages.push(msg);
    },
    broadcastToRoom() {},
    emitToUser() {},
    getMessages() {
      return messages;
    },
  };
}

function createMockRouter() {
  const executions = [];
  return {
    async *routeExecution(userId, message, threadId, _userMessageId, targetCats) {
      executions.push({ userId, message, threadId, targetCats });
      yield { type: 'done', catId: targetCats[0], isFinal: true, timestamp: Date.now() };
    },
    getExecutions() {
      return executions;
    },
  };
}

function createMockInvocationRecordStore() {
  const records = [];
  return {
    create(input) {
      const id = `inv-${records.length}`;
      records.push({ id, ...input });
      return { outcome: 'created', invocationId: id };
    },
    update() {},
    getRecords() {
      return records;
    },
  };
}

function makeThreadStore() {
  // agent-key callers pass explicit threadId → handler requires a thread store;
  // createdBy must match the agent-key principal's userId (canAccessScopedThread)
  const thread = { id: 't-cbk', title: 'cbk', preferredCats: [], createdBy: 'user-1' };
  return {
    get: (id) => (id === 't-cbk' ? thread : null),
    getParticipants: () => ['opus', 'cbk-amb-a', 'cbk-amb-b'],
    addParticipants: () => {},
    getParticipantsWithActivity: () => [],
    updateParticipantActivity: () => {},
    updateLastActive: () => {},
  };
}

function makeAgentKeyRegistry() {
  return {
    async verify() {
      return {
        ok: true,
        record: {
          agentKeyId: 'ak_test1',
          catId: 'opus',
          userId: 'user-1',
          secretHash: 'x',
          salt: 'y',
          scope: 'user-bound',
          issuedAt: Date.now(),
          expiresAt: Date.now() + 86400000,
        },
      };
    },
  };
}

describe('F257 callback ambiguity + routing mismatch', () => {
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
    queueProcessor = { async requestDrain() {} };
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

  test('invocation-token 路径：@回名（歧义）→ message 提示多只猫 + 显式 handle，不说「不存在」', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 't-cbk');
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { content: '@回名 请接球' },
    });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.match(body.message, /同时匹配多只猫/, 'human-readable message must state ambiguity');
    assert.match(body.message, /@cbk-amb-a|@cbk-amb-b/, 'must offer explicit handles');
    assert.doesNotMatch(body.message, /不存在/, 'must NOT misreport ambiguity as not-found');
    assert.equal(mockRouter.getExecutions().length, 0, 'ambiguous mention must not dispatch');
    assert.equal(invocationRecordStore.getRecords().length, 0);
  });

  test('agent-key 路径：同 formatter 覆盖（双 auth 路径一致）', async () => {
    const app = await createApp({ agentKeyRegistry: makeAgentKeyRegistry(), threadStore: makeThreadStore() });
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': 'valid-secret' },
      payload: { content: '@回名 请接球', threadId: 't-cbk' },
    });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.match(body.message, /同时匹配多只猫/);
    assert.doesNotMatch(body.message, /不存在/);
    assert.equal(mockRouter.getExecutions().length, 0);
  });

  test('routing mismatch：声明 targetCats=[cbk-amb-a] + content 行首 @cbk-amb-b → HELD 不静默仲裁', async () => {
    const app = await createApp({ agentKeyRegistry: makeAgentKeyRegistry(), threadStore: makeThreadStore() });
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': 'valid-secret' },
      payload: { content: '@cbk-amb-b 这个给你', threadId: 't-cbk', targetCats: ['cbk-amb-a'] },
    });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.status, 'held', 'declared/parsed mismatch must be HELD, not silently arbitrated');
    assert.equal(body.reason, 'routing_mismatch');
    assert.deepEqual(body.unexpectedTargets, ['cbk-amb-b']);
    assert.equal(mockRouter.getExecutions().length, 0, 'no dispatch on mismatch');
    assert.equal(messageStore.getByThread('t-cbk').length, 0, 'held message must not be stored');
  });

  test('声明 targetCats + content 解析目标是声明子集 → 正常（无 mismatch）', async () => {
    const app = await createApp({ agentKeyRegistry: makeAgentKeyRegistry(), threadStore: makeThreadStore() });
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': 'valid-secret' },
      payload: { content: '@cbk-amb-a 这个给你', threadId: 't-cbk', targetCats: ['cbk-amb-a', 'cbk-amb-b'] },
    });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.notEqual(body.status, 'held');
  });

  // ── sol R2 P1-1: HELD 必须零副作用——claim/consume 在 gate 之后 ──

  test('P1-1 agent-key：HELD 后同 clientMessageId 重试必须成功，不被判 duplicate', async () => {
    const app = await createApp({ agentKeyRegistry: makeAgentKeyRegistry(), threadStore: makeThreadStore() });
    const clientMessageId = 'cmid-retry-after-held';

    // Step 1: mismatch → HELD（当前实现在此已 claim 了 clientMessageId）
    const held = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': 'valid-secret' },
      payload: { content: '@cbk-amb-b 给你', threadId: 't-cbk', targetCats: ['cbk-amb-a'], clientMessageId },
    });
    assert.equal(JSON.parse(held.body).status, 'held', 'precondition: first attempt must be HELD');

    // Step 2: 修正 content 后同 clientMessageId 重试 → 必须成功
    const retry = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': 'valid-secret' },
      payload: { content: '@cbk-amb-a 给你', threadId: 't-cbk', targetCats: ['cbk-amb-a'], clientMessageId },
    });
    const retryBody = JSON.parse(retry.body);
    assert.notEqual(retryBody.status, 'duplicate', 'retry after HELD must NOT be treated as duplicate');
    assert.notEqual(retryBody.status, 'held', 'corrected retry must not be HELD again');
  });

  test('P1-1 invocation-token：HELD 后同 clientMessageId 重试必须成功，不被判 duplicate', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 't-cbk');
    const clientMessageId = 'cmid-inv-retry-after-held';

    // Step 1: mismatch → HELD
    const held = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { content: '@cbk-amb-b 给你', targetCats: ['cbk-amb-a'], clientMessageId },
    });
    assert.equal(JSON.parse(held.body).status, 'held', 'precondition: first attempt must be HELD');

    // Step 2: 修正 content 后同 clientMessageId 重试
    const retry = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { content: '@cbk-amb-a 给你', targetCats: ['cbk-amb-a'], clientMessageId },
    });
    const retryBody = JSON.parse(retry.body);
    assert.notEqual(retryBody.status, 'duplicate', 'retry after HELD must NOT be treated as duplicate');
  });

  // ── sol R2 P1-2: 声明存在性与可路由性分离 ──

  test('P1-2：声明全部无效 targetCats + content @real-cat → HELD（gate 不 fail-open）', async () => {
    const app = await createApp({ agentKeyRegistry: makeAgentKeyRegistry(), threadStore: makeThreadStore() });
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': 'valid-secret' },
      payload: { content: '@cbk-amb-a 接球', threadId: 't-cbk', targetCats: ['nonexistent-cat-xyz'] },
    });
    const body = JSON.parse(response.body);
    assert.equal(body.status, 'held', 'all-invalid declared targets + content @mention = HELD, not fail-open');
    assert.equal(body.reason, 'routing_mismatch');
    assert.deepEqual(body.unexpectedTargets, ['cbk-amb-a']);
  });

  test('P1-2：声明全部 disabled + content @real-cat → HELD', async () => {
    // 注册一只 disabled 猫用于测试
    if (!catRegistry.has('cbk-disabled')) {
      catRegistry.register('cbk-disabled', mkConfig('cbk-disabled', ['@cbk-disabled']));
    }
    const { getRoster } = await import('../dist/config/cat-config-loader.js');
    const roster = getRoster();
    const savedEntry = roster['cbk-disabled'];
    roster['cbk-disabled'] = { ...savedEntry, available: false };
    try {
      const app = await createApp({ agentKeyRegistry: makeAgentKeyRegistry(), threadStore: makeThreadStore() });
      const response = await app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers: { 'x-agent-key-secret': 'valid-secret' },
        payload: { content: '@cbk-amb-a 接球', threadId: 't-cbk', targetCats: ['cbk-disabled'] },
      });
      const body = JSON.parse(response.body);
      assert.equal(body.status, 'held', 'all-disabled declared targets + content @mention = HELD');
      assert.equal(body.reason, 'routing_mismatch');
    } finally {
      if (savedEntry) roster['cbk-disabled'] = savedEntry;
      else delete roster['cbk-disabled'];
    }
  });

  // ── sol R2 P1-2 补缺：声明三类无效之 ambiguous-alias ──

  test('P1-2：声明歧义别名 targetCats + content @real-cat → HELD（三类无效声明全覆盖）', async () => {
    const app = await createApp({ agentKeyRegistry: makeAgentKeyRegistry(), threadStore: makeThreadStore() });
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': 'valid-secret' },
      // '回名' is ambiguous — matches both cbk-amb-a and cbk-amb-b (L36-41)
      payload: { content: '@cbk-amb-a 接球', threadId: 't-cbk', targetCats: ['回名'] },
    });
    const body = JSON.parse(response.body);
    assert.equal(body.status, 'held', 'ambiguous-alias declared target + content @mention = HELD');
    assert.equal(body.reason, 'routing_mismatch');
    assert.deepEqual(body.unexpectedTargets, ['cbk-amb-a']);
  });

  // ── sol R2 P1-1 补缺：HELD 时 buffered rich block 不被 consume ──

  test('P1-1 invocation-token：HELD 时 buffered rich block 不被 consume（buffer 存活验证）', async () => {
    const { getRichBlockBuffer } = await import('../dist/domains/cats/services/agents/invocation/RichBlockBuffer.js');
    const app = await createApp();
    const threadId = 't-buffer-held';
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', threadId);

    // Pre: add a rich block to the buffer for this invocation
    const testBlock = {
      kind: 'file',
      v: 1,
      id: `blk-${invocationId}`,
      name: 'test.txt',
      url: 'https://example.com/test.txt',
    };
    getRichBlockBuffer().add(threadId, 'opus', testBlock, invocationId);

    // Step 1: send mismatch → HELD (consume at L1614 must NOT fire)
    const held = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { content: '@cbk-amb-b 给你', targetCats: ['cbk-amb-a'] },
    });
    assert.equal(JSON.parse(held.body).status, 'held', 'precondition: must be HELD');

    // Step 2: verify buffer NOT consumed — blocks still available
    const surviving = getRichBlockBuffer().consume(threadId, 'opus', invocationId);
    assert.ok(surviving.length > 0, 'buffered rich block must survive HELD — consume must not fire before gate');
    assert.equal(surviving[0].id, testBlock.id, 'the exact block must be the one we buffered');
  });

  test('无声明 targetCats：content 唯一 @ 正常路由（无 mismatch 语义，回归保护）', async () => {
    const app = await createApp({ agentKeyRegistry: makeAgentKeyRegistry(), threadStore: makeThreadStore() });
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': 'valid-secret' },
      payload: { content: '@cbk-amb-a 这个给你', threadId: 't-cbk' },
    });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.notEqual(body.status, 'held');
  });
});
