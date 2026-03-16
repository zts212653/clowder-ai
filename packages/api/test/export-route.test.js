/**
 * Export Route Tests
 * 测试聊天记录导出为 Markdown / 纯文本
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { formatThreadAsMarkdown, formatThreadAsText } = await import('../dist/routes/export.js');

/** Helper to create a minimal thread object */
function makeThread(overrides = {}) {
  return {
    id: 'thread-1',
    projectPath: '/test',
    title: '测试对话',
    createdBy: 'user-1',
    participants: [],
    lastActiveAt: Date.now(),
    createdAt: Date.now(),
    ...overrides,
  };
}

/** Helper to create a stored message */
function makeMessage(overrides = {}) {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    userId: 'user-1',
    catId: null,
    content: '你好',
    mentions: [],
    timestamp: new Date('2026-02-07T10:30:00').getTime(),
    ...overrides,
  };
}

describe('formatThreadAsMarkdown', () => {
  test('formats thread with title and messages', () => {
    const thread = makeThread({ title: '第一次测试', participants: ['opus'] });
    const messages = [
      makeMessage({ content: '你好布偶猫', timestamp: new Date('2026-02-07T10:30:00').getTime() }),
      makeMessage({
        catId: 'opus',
        content: '你好铲屎官！',
        timestamp: new Date('2026-02-07T10:31:00').getTime(),
        id: 'msg-2',
      }),
    ];

    const md = formatThreadAsMarkdown(thread, messages);

    assert.ok(md.includes('# 对话记录: 第一次测试'));
    assert.ok(md.includes('thread-1'));
    assert.ok(md.includes('布偶猫'));
    assert.ok(md.includes('你好布偶猫'));
    assert.ok(md.includes('你好铲屎官！'));
    assert.ok(md.includes('铲屎官'));
  });

  test('handles empty messages with only header', () => {
    const thread = makeThread();
    const md = formatThreadAsMarkdown(thread, []);

    assert.ok(md.includes('# 对话记录: 测试对话'));
    assert.ok(md.includes('**消息数**: 0'));
    assert.ok(md.includes('---'));
  });

  test('uses 未命名对话 when title is null', () => {
    const thread = makeThread({ title: null });
    const md = formatThreadAsMarkdown(thread, []);

    assert.ok(md.includes('# 对话记录: 未命名对话'));
  });

  test('includes both user and cat messages', () => {
    const thread = makeThread({ participants: ['opus', 'codex'] });
    const messages = [
      makeMessage({ content: '请问一下', catId: null }),
      makeMessage({ catId: 'opus', content: '我来回答', id: 'msg-2' }),
      makeMessage({ catId: 'codex', content: '我也来', id: 'msg-3' }),
    ];

    const md = formatThreadAsMarkdown(thread, messages);

    assert.ok(md.includes('铲屎官'));
    assert.ok(md.includes('布偶猫'));
    assert.ok(md.includes('缅因猫'));
    assert.ok(md.includes('请问一下'));
    assert.ok(md.includes('我来回答'));
    assert.ok(md.includes('我也来'));
  });

  test('shows metadata tags for cat messages', () => {
    const thread = makeThread();
    const messages = [
      makeMessage({
        catId: 'opus',
        content: '有 metadata 的消息',
        metadata: { provider: 'anthropic', model: 'claude-opus-4-5-20250514' },
      }),
    ];

    const md = formatThreadAsMarkdown(thread, messages);

    assert.ok(md.includes('*[anthropic/claude-opus-4-5-20250514]*'));
  });

  test('Content-Disposition filename pattern', () => {
    // This tests the formatThreadAsMarkdown returns proper md content
    // The route sets Content-Disposition header — tested via integration or manual
    const thread = makeThread({ id: 'abc-123' });
    const md = formatThreadAsMarkdown(thread, []);

    assert.ok(md.includes('abc-123'));
    assert.ok(md.includes('导出时间'));
  });
});

describe('formatThreadAsText', () => {
  test('formats thread as plain text without Markdown syntax', () => {
    const thread = makeThread({ title: '纯文本测试', participants: ['opus'] });
    const messages = [
      makeMessage({ content: '你好布偶猫', timestamp: new Date('2026-02-07T10:30:00').getTime() }),
      makeMessage({
        catId: 'opus',
        content: '你好铲屎官！',
        timestamp: new Date('2026-02-07T10:31:00').getTime(),
        id: 'msg-2',
      }),
    ];

    const txt = formatThreadAsText(thread, messages);

    // Should have title without Markdown heading
    assert.ok(txt.includes('对话记录: 纯文本测试'));
    assert.ok(!txt.includes('# '), 'Should not contain Markdown heading markers');

    // Should have meta without bold markers
    assert.ok(txt.includes('ID: thread-1'));
    assert.ok(!txt.includes('**'), 'Should not contain Markdown bold markers');

    // Should include message content
    assert.ok(txt.includes('你好布偶猫'));
    assert.ok(txt.includes('你好铲屎官！'));
  });

  test('handles empty messages', () => {
    const thread = makeThread();
    const txt = formatThreadAsText(thread, []);

    assert.ok(txt.includes('对话记录: 测试对话'));
    assert.ok(txt.includes('消息数: 0'));
    assert.ok(!txt.includes('**'));
  });

  test('uses 未命名对话 when title is null', () => {
    const thread = makeThread({ title: null });
    const txt = formatThreadAsText(thread, []);

    assert.ok(txt.includes('对话记录: 未命名对话'));
  });

  test('shows metadata tags without italic markers', () => {
    const thread = makeThread();
    const messages = [
      makeMessage({
        catId: 'opus',
        content: '有 metadata 的消息',
        metadata: { provider: 'anthropic', model: 'claude-opus-4-5-20250514' },
      }),
    ];

    const txt = formatThreadAsText(thread, messages);

    // Should have metadata without italic markers
    assert.ok(txt.includes('[anthropic/claude-opus-4-5-20250514]'));
    assert.ok(!txt.includes('*['), 'Should not wrap metadata in italic markers');
  });

  test('export timestamp without italic markers', () => {
    const thread = makeThread();
    const txt = formatThreadAsText(thread, []);

    assert.ok(txt.includes('导出时间:'));
    assert.ok(!txt.includes('*导出时间'), 'Should not wrap timestamp in italic markers');
  });
});

describe('Export Route (endpoint)', () => {
  // Route-level test using Fastify inject
  async function buildApp(threadStore, messageStore) {
    const Fastify = (await import('fastify')).default;
    const { exportRoutes } = await import('../dist/routes/export.js');
    const app = Fastify();
    await app.register(exportRoutes, { messageStore, threadStore });
    return app;
  }

  function mockThreadStore(threads = {}) {
    return {
      get: async (id) => threads[id] ?? null,
      create: async () => {},
      list: async () => [],
      listByProject: async () => [],
      addParticipants: async () => {},
      getParticipants: async () => [],
      updateTitle: async () => {},
      updateLastActive: async () => {},
      delete: async () => false,
    };
  }

  function mockMessageStore(messages = []) {
    return {
      append: async () => ({
        id: '1',
        threadId: 'x',
        userId: 'u',
        catId: null,
        content: '',
        mentions: [],
        timestamp: 0,
      }),
      getRecent: () => [],
      getByThread: async () => messages,
      getById: async () => null,
      getPendingMentions: async () => [],
    };
  }

  test('GET existing thread returns 200 with markdown', async () => {
    const thread = makeThread();
    const messages = [makeMessage({ content: 'hello' })];
    const app = await buildApp(mockThreadStore({ 'thread-1': thread }), mockMessageStore(messages));

    const res = await app.inject({
      method: 'GET',
      url: '/api/export/thread/thread-1?format=md',
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('text/markdown'));
    assert.ok(res.headers['content-disposition'].includes('thread-thread-1.md'));
    assert.ok(res.body.includes('hello'));
  });

  test('GET non-existent thread returns 404', async () => {
    const app = await buildApp(mockThreadStore(), mockMessageStore());

    const res = await app.inject({
      method: 'GET',
      url: '/api/export/thread/nope?format=md',
    });

    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'Thread not found');
  });

  test('GET with unsupported format returns 400', async () => {
    const thread = makeThread();
    const app = await buildApp(mockThreadStore({ 'thread-1': thread }), mockMessageStore());

    const res = await app.inject({
      method: 'GET',
      url: '/api/export/thread/thread-1?format=json',
    });

    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('Unsupported format'));
  });

  test('GET with format=txt returns 200 with plain text', async () => {
    const thread = makeThread();
    const messages = [makeMessage({ content: 'hello txt' })];
    const app = await buildApp(mockThreadStore({ 'thread-1': thread }), mockMessageStore(messages));

    const res = await app.inject({
      method: 'GET',
      url: '/api/export/thread/thread-1?format=txt',
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('text/plain'));
    assert.ok(res.headers['content-disposition'].includes('thread-thread-1.txt'));
    assert.ok(res.body.includes('hello txt'));
    assert.ok(!res.body.includes('# '), 'txt format should not contain Markdown headings');
  });

  test('GET default format (no query) returns markdown', async () => {
    const thread = makeThread();
    const messages = [makeMessage({ content: 'default format' })];
    const app = await buildApp(mockThreadStore({ 'thread-1': thread }), mockMessageStore(messages));

    const res = await app.inject({
      method: 'GET',
      url: '/api/export/thread/thread-1',
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('text/markdown'));
  });
});
