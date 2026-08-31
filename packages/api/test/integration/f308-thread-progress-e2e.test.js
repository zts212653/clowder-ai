import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import Fastify from 'fastify';
import '../helpers/setup-cat-registry.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from '../helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const SKIP = redisIsolationSkipReason(REDIS_URL);
const KEY_PREFIX = 'cat-cafe-f308-e2e:';
let redis;
let originalEnv;

before(async () => {
  if (SKIP) return;
  assertRedisIsolationOrThrow(REDIS_URL, 'f308-thread-progress-e2e');
  const { createRedisClient } = await import('@cat-cafe/shared/utils');
  redis = createRedisClient({ url: REDIS_URL, keyPrefix: KEY_PREFIX });
  await cleanupClientKeyspace(redis);
  originalEnv = { ...process.env };
});

after(async () => {
  if (redis) {
    await cleanupClientKeyspace(redis);
    await redis.quit();
  }
  if (originalEnv) {
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  }
});

describe('F308 Phase A vertical acceptance', { skip: SKIP }, () => {
  test('MCP → authenticated callback → Redis → Brief/read API → restart read', async () => {
    const [
      { InvocationRegistry },
      { ThreadStore },
      { MessageStore },
      { TaskStore },
      { RedisThreadProgressReceiptStore },
      { ThreadBriefAssembler },
      { registerCallbackThreadProgressRoutes },
      { threadProgressRoutes },
      { handleRecordThreadProgress },
    ] = await Promise.all([
      import('../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'),
      import('../../dist/domains/cats/services/stores/ports/ThreadStore.js'),
      import('../../dist/domains/cats/services/stores/ports/MessageStore.js'),
      import('../../dist/domains/cats/services/stores/ports/TaskStore.js'),
      import('../../dist/domains/thread-progress/RedisThreadProgressReceiptStore.js'),
      import('../../dist/domains/thread-progress/ThreadBriefAssembler.js'),
      import('../../dist/routes/callback-thread-progress-routes.js'),
      import('../../dist/routes/thread-progress-routes.js'),
      import('../../../mcp-server/dist/tools/callback-tools.js'),
    ]);

    const ownerUserId = 'f308-acceptance-owner';
    const catId = 'opus';
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const taskStore = new TaskStore();
    const receiptStore = new RedisThreadProgressReceiptStore(redis);
    const thread = threadStore.create(ownerUserId, 'Runtime harness 深入学习');
    const registry = new InvocationRegistry();
    const credentials = await registry.create(ownerUserId, catId, thread.id);
    const invalidations = [];
    const socketManager = {
      broadcastToRoom(room, event, payload) {
        invalidations.push({ room, event, payload });
      },
    };
    const assembler = new ThreadBriefAssembler({
      receiptStore,
      taskStore,
      taskProgressStore: {
        getThreadSnapshots: async () => ({
          [catId]: {
            threadId: thread.id,
            catId,
            status: 'running',
            updatedAt: Date.now(),
            lastInvocationId: credentials.invocationId,
            tasks: [
              {
                id: 'acceptance-step',
                subject: '完成端到端验收',
                status: 'in_progress',
                activeForm: '验证 Receipt 到 UI 的完整链路',
              },
            ],
          },
        }),
      },
      readLiveExecutions: async () => [
        {
          catId,
          startedAt: Date.now() - 2_000,
          turnInvocationId: credentials.invocationId,
          degraded: false,
        },
      ],
      readAttention: async () => [],
      readWaits: async () => [],
    });
    const app = Fastify();
    registerCallbackThreadProgressRoutes(app, {
      registry,
      receiptStore,
      threadStore,
      messageStore,
      taskStore,
      socketManager,
    });
    await app.register(threadProgressRoutes, { threadStore, receiptStore, assembler, messageStore, taskStore });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });

    try {
      delete process.env.CAT_CAFE_CREDENTIAL_FILE;
      delete process.env.CAT_CAFE_AGENT_KEY_SECRET;
      delete process.env.CAT_CAFE_AGENT_KEY_FILE;
      delete process.env.CAT_CAFE_AGENT_KEY_FILES;
      process.env.CAT_CAFE_API_URL = origin;
      process.env.CAT_CAFE_INVOCATION_ID = credentials.invocationId;
      process.env.CAT_CAFE_CALLBACK_TOKEN = credentials.callbackToken;

      const before = await fetch(`${origin}/api/threads/${thread.id}/brief`, {
        headers: { 'x-cat-cafe-user': ownerUserId },
      }).then((response) => response.json());
      assert.equal(before.hasHistory, false, 'invocation start alone must abstain from progress history');

      const toolResult = await handleRecordThreadProgress({
        kind: 'milestone',
        impactAxes: ['verified_outcome', 'next_action'],
        headline: '完成 Thread Progress Phase A 垂直链路',
        detail: 'MCP callback、Redis Receipt 与 ThreadBrief 已连接。',
        nextStep: '完成真实浏览器交互验收',
        provenance: [{ kind: 'invocation', invocationId: credentials.invocationId }],
      });
      assert.equal(toolResult.isError, undefined);

      const briefResponse = await fetch(`${origin}/api/threads/${thread.id}/brief`, {
        headers: { 'x-cat-cafe-user': ownerUserId },
      });
      assert.equal(briefResponse.status, 200);
      const brief = await briefResponse.json();
      assert.equal(brief.presentationState, 'running');
      assert.equal(brief.currentExecutions[0].action, '验证 Receipt 到 UI 的完整链路');
      assert.equal(brief.recentProgress[0].headline, '完成 Thread Progress Phase A 垂直链路');
      assert.equal(brief.nextStep, '完成真实浏览器交互验收');
      assert.equal(brief.openWorkTaskCount, 0, 'research receipt must not depend on Task creation');

      const progress = await fetch(`${origin}/api/threads/${thread.id}/progress`, {
        headers: { 'x-cat-cafe-user': ownerUserId },
      }).then((response) => response.json());
      assert.equal(progress.items.length, 1);
      assert.equal(progress.items[0].ownerUserId, ownerUserId);
      assert.equal(invalidations.length, 1);
      assert.equal(invalidations[0].event, 'thread_brief_invalidated');

      const restartedStore = new RedisThreadProgressReceiptStore(redis);
      const persisted = await restartedStore.listByThread(ownerUserId, thread.id);
      assert.equal(persisted.length, 1);
      assert.equal(persisted[0].headline, '完成 Thread Progress Phase A 垂直链路');
      assert.equal(await redis.pttl(`thread-progress:receipt:${persisted[0].id}`), -1);
    } finally {
      await app.close();
    }
  });
});
