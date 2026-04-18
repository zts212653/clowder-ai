/**
 * GET /api/messages endpoint tests
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

describe('GET /api/messages', () => {
  let app;
  let messageStore;

  beforeEach(async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { messagesRoutes } = await import('../dist/routes/messages.js');

    messageStore = new MessageStore();
    app = Fastify();
    await app.register(messagesRoutes, {
      registry: new InvocationRegistry(),
      messageStore,
      socketManager: { broadcastAgentMessage: () => {} },
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('returns empty array when no messages', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);
    assert.deepEqual(body.messages, []);
    assert.equal(body.hasMore, false);
  });

  it('returns messages with correct format', async () => {
    messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'hello',
      mentions: ['opus'],
      timestamp: 1000,
    });
    messageStore.append({
      userId: 'default-user',
      catId: 'opus',
      content: 'hi there',
      mentions: [],
      timestamp: 2000,
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);
    assert.equal(body.messages.length, 2);

    // User message
    assert.equal(body.messages[0].type, 'user');
    assert.equal(body.messages[0].catId, null);
    assert.equal(body.messages[0].content, 'hello');

    // Assistant message
    assert.equal(body.messages[1].type, 'assistant');
    assert.equal(body.messages[1].catId, 'opus');
    assert.equal(body.messages[1].content, 'hi there');
  });

  it('maps canonical system messages to type=system', async () => {
    messageStore.append({
      userId: 'system',
      catId: 'system',
      content: '🐺 狼人请睁眼',
      mentions: [],
      timestamp: 1000,
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);

    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].type, 'system');
    assert.equal(body.messages[0].catId, 'system');
  });

  it('returns persisted system error messages with catId=null as type=system', async () => {
    messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'ping gemini',
      mentions: ['gemini'],
      timestamp: 1000,
      threadId: 'thread-1',
    });
    messageStore.append({
      userId: 'system',
      catId: null,
      content: 'Error: stream_idle_stall: Gemini stopped responding',
      mentions: [],
      timestamp: 2000,
      threadId: 'thread-1',
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages?threadId=thread-1' });
    const body = JSON.parse(res.body);

    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[1].type, 'system');
    assert.equal(body.messages[1].catId, null);
    assert.match(body.messages[1].content, /^Error: stream_idle_stall/);
  });

  it('keeps persisted source-backed notices on the connector path even when userId=system', async () => {
    messageStore.append({
      userId: 'system',
      catId: null,
      content: '想交接给 @codex？把它单独放到新起一行开头，才能触发交接。',
      mentions: [],
      timestamp: 2500,
      threadId: 'thread-connector-notice',
      source: {
        connector: 'inline-mention-hint',
        label: '路由提示',
        icon: '💡',
        meta: { presentation: 'system_notice', noticeTone: 'info' },
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?threadId=thread-connector-notice',
    });
    const body = JSON.parse(res.body);

    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].type, 'connector');
    assert.equal(body.messages[0].catId, null);
    assert.equal(body.messages[0].source.connector, 'inline-mention-hint');
    assert.equal(body.messages[0].source.meta.presentation, 'system_notice');
  });

  it('respects limit parameter', async () => {
    for (let i = 0; i < 10; i++) {
      messageStore.append({
        userId: 'default-user',
        catId: null,
        content: `msg ${i}`,
        mentions: [],
        timestamp: 1000 + i,
      });
    }

    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?limit=3',
    });
    const body = JSON.parse(res.body);
    assert.equal(body.messages.length, 3);
    assert.equal(body.hasMore, true);
  });

  it('supports cursor pagination with before', async () => {
    for (let i = 0; i < 5; i++) {
      messageStore.append({
        userId: 'default-user',
        catId: null,
        content: `msg ${i}`,
        mentions: [],
        timestamp: 1000 + i * 100,
      });
    }

    // Get messages before timestamp 1300 (should get msg 0, 1, 2)
    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?before=1300&limit=10',
    });
    const body = JSON.parse(res.body);
    assert.equal(body.messages.length, 3);
    assert.equal(body.messages[0].content, 'msg 0');
    assert.equal(body.messages[2].content, 'msg 2');
    assert.equal(body.hasMore, false);
  });

  it('pagination covers all messages without gaps (regression: slice direction)', async () => {
    // Insert 6 messages with distinct timestamps
    for (let i = 0; i < 6; i++) {
      messageStore.append({
        userId: 'default-user',
        catId: null,
        content: `msg ${i}`,
        mentions: [],
        timestamp: 1000 + i * 100,
      });
    }

    // Page 1: most recent 2
    const page1 = await app.inject({
      method: 'GET',
      url: '/api/messages?limit=2',
    });
    const body1 = JSON.parse(page1.body);
    assert.equal(body1.messages.length, 2);
    assert.equal(body1.hasMore, true);
    // Should be the 2 newest: msg 4 and msg 5
    assert.equal(body1.messages[0].content, 'msg 4');
    assert.equal(body1.messages[1].content, 'msg 5');

    // Page 2: before the oldest message of page 1
    const cursor = body1.messages[0].timestamp;
    const page2 = await app.inject({
      method: 'GET',
      url: `/api/messages?limit=2&before=${cursor}`,
    });
    const body2 = JSON.parse(page2.body);
    assert.equal(body2.messages.length, 2);
    assert.equal(body2.hasMore, true);
    assert.equal(body2.messages[0].content, 'msg 2');
    assert.equal(body2.messages[1].content, 'msg 3');

    // Page 3: before page 2's oldest
    const cursor2 = body2.messages[0].timestamp;
    const page3 = await app.inject({
      method: 'GET',
      url: `/api/messages?limit=2&before=${cursor2}`,
    });
    const body3 = JSON.parse(page3.body);
    assert.equal(body3.messages.length, 2);
    assert.equal(body3.hasMore, false);
    assert.equal(body3.messages[0].content, 'msg 0');
    assert.equal(body3.messages[1].content, 'msg 1');

    // Verify: union of all pages = all 6 messages, no gaps
    const allContents = [...body3.messages, ...body2.messages, ...body1.messages].map((m) => m.content);
    assert.deepEqual(allContents, ['msg 0', 'msg 1', 'msg 2', 'msg 3', 'msg 4', 'msg 5']);
  });

  it('composite cursor handles same-timestamp messages without gaps', async () => {
    // All messages at the same timestamp (simulates burst writes)
    for (let i = 0; i < 4; i++) {
      messageStore.append({
        userId: 'default-user',
        catId: null,
        content: `burst ${i}`,
        mentions: [],
        timestamp: 5000, // all same timestamp
      });
    }

    // First page: most recent 2
    const page1 = await app.inject({
      method: 'GET',
      url: '/api/messages?limit=2',
    });
    const body1 = JSON.parse(page1.body);
    assert.equal(body1.messages.length, 2);
    assert.equal(body1.hasMore, true);

    // Composite cursor: "timestamp:id" of the oldest message on page 1
    const oldest = body1.messages[0];
    const cursor = `${oldest.timestamp}:${oldest.id}`;
    const page2 = await app.inject({
      method: 'GET',
      url: `/api/messages?limit=2&before=${encodeURIComponent(cursor)}`,
    });
    const body2 = JSON.parse(page2.body);
    assert.equal(body2.messages.length, 2);
    assert.equal(body2.hasMore, false);

    // Union should have all 4, no duplicates
    const allIds = [...body2.messages, ...body1.messages].map((m) => m.id);
    assert.equal(new Set(allIds).size, 4, 'All 4 messages should be unique across pages');
  });

  it('returns toolEvents when message has them (缅因猫 R2 P1-2)', async () => {
    messageStore.append({
      userId: 'default-user',
      catId: 'opus',
      content: 'I read the file',
      mentions: [],
      timestamp: 3000,
      toolEvents: [
        { id: 'tool-1', type: 'tool_use', label: 'opus → Read', detail: '{"path":"/a.ts"}', timestamp: 3000 },
        { id: 'toolr-1', type: 'tool_result', label: 'opus ← result', detail: 'file content...', timestamp: 3001 },
      ],
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);
    assert.equal(body.messages.length, 1);

    const msg = body.messages[0];
    assert.ok(msg.toolEvents, 'API response should include toolEvents');
    assert.equal(msg.toolEvents.length, 2);
    assert.equal(msg.toolEvents[0].type, 'tool_use');
    assert.equal(msg.toolEvents[0].label, 'opus → Read');
    assert.equal(msg.toolEvents[1].type, 'tool_result');
  });

  it('omits toolEvents when message has none', async () => {
    messageStore.append({
      userId: 'default-user',
      catId: 'opus',
      content: 'just text',
      mentions: [],
      timestamp: 4000,
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].toolEvents, undefined, 'should not include toolEvents when absent');
  });

  it('preserves stream invocation identity for persisted assistant messages', async () => {
    messageStore.append({
      userId: 'default-user',
      catId: 'opus',
      content: 'persisted stream bubble',
      mentions: [],
      timestamp: 4500,
      origin: 'stream',
      extra: {
        stream: {
          invocationId: 'inv-stream-1',
        },
      },
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);
    assert.equal(body.messages.length, 1);
    assert.deepEqual(body.messages[0].extra?.stream, { invocationId: 'inv-stream-1' });
  });

  it('filters by userId', async () => {
    messageStore.append({
      userId: 'alice',
      catId: null,
      content: 'alice msg',
      mentions: [],
      timestamp: 1000,
    });
    messageStore.append({
      userId: 'bob',
      catId: null,
      content: 'bob msg',
      mentions: [],
      timestamp: 2000,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'alice' },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].content, 'alice msg');
  });

  // ── F97: Connector message type mapping ──────────────────────────

  it('maps message with source field to type=connector', async () => {
    messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'GitHub Review 通知',
      mentions: ['opus'],
      timestamp: 9000,
      source: {
        connector: 'github-review',
        label: 'GitHub Review',
        icon: '🔔',
        url: 'https://github.com/org/repo/pull/42',
      },
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);
    assert.equal(body.messages.length, 1);

    const msg = body.messages[0];
    assert.equal(msg.type, 'connector');
    assert.ok(msg.source, 'should include source in API response');
    assert.equal(msg.source.connector, 'github-review');
    assert.equal(msg.source.label, 'GitHub Review');
    assert.equal(msg.source.icon, '🔔');
    assert.equal(msg.source.url, 'https://github.com/org/repo/pull/42');
  });

  it('includes source.meta in API response (F098-C: needed for direction parsing)', async () => {
    messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'review notification',
      mentions: ['opus'],
      timestamp: 9002,
      source: {
        connector: 'github-review',
        label: 'GitHub Review',
        icon: '🔔',
        url: 'https://github.com/org/repo/pull/42',
        meta: { targets: ['codex', 'gpt52'], initiator: 'opus' },
      },
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);
    const msg = body.messages[0];
    assert.equal(msg.type, 'connector');
    assert.equal(msg.source.connector, 'github-review');
    assert.equal(msg.source.url, 'https://github.com/org/repo/pull/42');
    assert.deepStrictEqual(
      msg.source.meta,
      { targets: ['codex', 'gpt52'], initiator: 'opus' },
      'source.meta must be included — frontend parseDirection reads meta.targets',
    );
  });

  it('serializes deliveredAt when present (F098-D P3 regression)', async () => {
    const stored = messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'queued message',
      mentions: [],
      timestamp: 5000,
      deliveryStatus: 'queued',
    });
    messageStore.markDelivered(stored.id, 12000);

    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);
    const msg = body.messages[0];
    assert.equal(msg.deliveredAt, 12000, 'deliveredAt must be serialized in API response');
  });

  it('omits deliveredAt when not set (F098-D P3 regression)', async () => {
    messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'immediate message',
      mentions: [],
      timestamp: 6000,
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);
    const msg = body.messages[0];
    assert.equal(msg.deliveredAt, undefined, 'deliveredAt must be absent when not set');
  });

  it('serializes extra.targetCats when present (F098-C1 regression)', async () => {
    messageStore.append({
      userId: 'default-user',
      catId: 'opus',
      content: 'review done',
      mentions: ['codex'],
      origin: 'callback',
      timestamp: 7000,
      extra: { targetCats: ['codex', 'gpt52'] },
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);
    const msg = body.messages[0];
    assert.deepStrictEqual(
      msg.extra?.targetCats,
      ['codex', 'gpt52'],
      'extra.targetCats must be serialized for frontend direction rendering',
    );
  });

  it('message without source and without catId is type=user', async () => {
    messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'normal user message',
      mentions: [],
      timestamp: 9001,
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);
    assert.equal(body.messages[0].type, 'user');
    assert.equal(body.messages[0].source, undefined);
  });
});

// Auto-summary disabled (clowder-ai#343): summaries no longer merged into GET timeline.
// SummaryStore still persisted for memory infrastructure / future Thread Recap.
describe('GET /api/messages — summary NOT in timeline (clowder-ai#343)', () => {
  let app;
  let messageStore;
  let summaryStore;

  beforeEach(async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { SummaryStore } = await import('../dist/domains/cats/services/stores/ports/SummaryStore.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { messagesRoutes } = await import('../dist/routes/messages.js');

    messageStore = new MessageStore();
    summaryStore = new SummaryStore();
    app = Fastify();
    await app.register(messagesRoutes, {
      registry: new InvocationRegistry(),
      messageStore,
      socketManager: { broadcastAgentMessage: () => {} },
      summaryStore,
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('summaries exist in store but do NOT appear in timeline', async () => {
    messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'hello',
      mentions: [],
      timestamp: 1000,
    });
    messageStore.append({
      userId: 'default-user',
      catId: 'opus',
      content: 'hi there',
      mentions: [],
      timestamp: 2000,
    });
    summaryStore.create({
      threadId: 'default',
      topic: '测试纪要',
      conclusions: ['结论一'],
      openQuestions: [],
      createdBy: 'system',
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);

    assert.equal(body.messages.length, 2, 'only messages, no summary injection');
    assert.ok(
      body.messages.every((m) => m.type !== 'summary'),
      'no summary type in response',
    );
  });
});

describe('GET /api/messages summary + pagination contract', () => {
  let app;
  let messageStore;
  let summaryStore;

  beforeEach(async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { SummaryStore } = await import('../dist/domains/cats/services/stores/ports/SummaryStore.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { messagesRoutes } = await import('../dist/routes/messages.js');

    messageStore = new MessageStore();
    summaryStore = new SummaryStore();
    app = Fastify();
    await app.register(messagesRoutes, {
      registry: new InvocationRegistry(),
      messageStore,
      socketManager: { broadcastAgentMessage: () => {} },
      summaryStore,
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  // Auto-summary disabled (clowder-ai#343): summaries no longer merged into timeline
  it('timeline does NOT inject summaries (clowder-ai#343)', async () => {
    for (let i = 0; i < 5; i++) {
      messageStore.append({
        userId: 'default-user',
        catId: null,
        content: `msg ${i}`,
        mentions: [],
        timestamp: 1000 + i * 100,
      });
    }
    summaryStore.create({
      threadId: 'default',
      topic: '分页纪要',
      conclusions: [],
      openQuestions: [],
      createdBy: 'system',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?limit=3',
    });
    const body = JSON.parse(res.body);

    assert.equal(body.hasMore, true);
    const sumCount = body.messages.filter((m) => m.type === 'summary').length;
    assert.equal(sumCount, 0, 'summaries should not appear in timeline');
    assert.equal(body.messages.length, 3, 'only messages, no summary injection');
  });
});

describe('POST /api/messages orphan rejection (#21)', () => {
  it('returns 400 when threadId does not exist', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { messagesRoutes } = await import('../dist/routes/messages.js');

    const app = Fastify();
    await app.register(messagesRoutes, {
      registry: new InvocationRegistry(),
      messageStore: new MessageStore(),
      socketManager: { broadcastAgentMessage: () => {}, broadcastToRoom: () => {} },
      threadStore: new ThreadStore(),
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: {
        content: 'hello',
        userId: 'alice',
        threadId: 'nonexistent-thread',
      },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'THREAD_NOT_FOUND');

    await app.close();
  });
});

describe('POST /api/messages rejects soft-deleted thread (Phase D P1)', () => {
  it('returns 400 THREAD_NOT_FOUND when threadId is soft-deleted', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { messagesRoutes } = await import('../dist/routes/messages.js');

    const threadStore = new ThreadStore();
    const thread = threadStore.create('alice', 'Will Be Deleted');
    threadStore.softDelete(thread.id);

    const app = Fastify();
    await app.register(messagesRoutes, {
      registry: new InvocationRegistry(),
      messageStore: new MessageStore(),
      socketManager: { broadcastAgentMessage: () => {}, broadcastToRoom: () => {} },
      threadStore,
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: {
        content: 'should be rejected',
        userId: 'alice',
        threadId: thread.id,
      },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'THREAD_NOT_FOUND');

    await app.close();
  });
});

describe('POST /api/messages delete-guard protection', () => {
  it('returns 409 and does not persist message when thread is being deleted', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
    const { messagesRoutes } = await import('../dist/routes/messages.js');

    const threadId = 'thread-delete-guard';
    const tracker = new InvocationTracker();
    const guard = tracker.guardDelete(threadId);
    assert.ok(guard.acquired, 'test setup: delete guard should be acquired');

    const messageStore = new MessageStore();
    const threadStore = {
      async get(id) {
        if (id !== threadId) return null;
        return {
          id: threadId,
          projectPath: 'default',
          title: 'Guarded Thread',
          createdBy: 'alice',
          participants: [],
          lastActiveAt: Date.now(),
          createdAt: Date.now(),
        };
      },
      async updateTitle() {},
      async updateLastActive() {},
      async getParticipants() {
        return [];
      },
      async addParticipants() {},
    };

    const app = Fastify();
    await app.register(messagesRoutes, {
      registry: new InvocationRegistry(),
      messageStore,
      socketManager: { broadcastAgentMessage: () => {}, broadcastToRoom: () => {} },
      threadStore,
      invocationTracker: tracker,
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: {
        content: 'should be blocked',
        userId: 'alice',
        threadId,
      },
    });

    // Wait briefly to ensure background path would have had time to append.
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(res.statusCode, 409);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'THREAD_DELETING');
    assert.equal(messageStore.getByThread(threadId).length, 0);

    guard.release();
    await app.close();
  });
});
