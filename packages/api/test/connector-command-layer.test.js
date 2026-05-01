import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

function stubStore(binding) {
  return {
    getByExternal: async () => binding ?? null,
    getByThread: async () => [],
    bind: async (cId, eCId, tId, uId) => ({
      connectorId: cId,
      externalChatId: eCId,
      threadId: tId,
      userId: uId,
      createdAt: Date.now(),
    }),
    remove: async () => true,
    listByUser: async () => [],
  };
}

function stubThreadStore(data) {
  const map = new Map();
  if (data && !Array.isArray(data)) map.set(data.id, data);
  if (Array.isArray(data)) for (const d of data) map.set(d.id, d);
  return {
    create: async (_userId, title) => {
      const id = `thread-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const entry = { id, title, createdAt: Date.now() };
      map.set(id, entry);
      return entry;
    },
    get: async (id) => map.get(id) ?? null,
    list: async () => [...map.values()],
    // F154: updatePreferredCats support
    updatePreferredCats(threadId, catIds) {
      const thread = map.get(threadId);
      if (!thread) return;
      if (catIds.length > 0) {
        thread.preferredCats = [...new Set(catIds)];
      } else {
        delete thread.preferredCats;
      }
    },
  };
}

describe('ConnectorCommandLayer', () => {
  let ConnectorCommandLayer;

  before(async () => {
    const mod = await import('../dist/infrastructure/connectors/ConnectorCommandLayer.js');
    ConnectorCommandLayer = mod.ConnectorCommandLayer;
  });

  it('returns not-command for regular messages', async () => {
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(),
      threadStore: stubThreadStore(),
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', 'hello world');
    assert.equal(result.kind, 'not-command');
  });

  it('returns not-command for unknown /slash commands', async () => {
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(),
      threadStore: stubThreadStore(),
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/unknown');
    assert.equal(result.kind, 'not-command');
  });

  it('/where returns current thread info when binding exists', async () => {
    const binding = {
      connectorId: 'feishu',
      externalChatId: 'chat1',
      threadId: 'thread-abc123def',
      userId: 'user1',
      createdAt: Date.now(),
    };
    const store = stubStore(binding);
    const threadStore = stubThreadStore({ id: 'thread-abc123def', title: '飞书测试' });
    const layer = new ConnectorCommandLayer({
      bindingStore: store,
      threadStore,
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/where');
    assert.equal(result.kind, 'where');
    assert.ok(result.response.includes('thread-a'));
    assert.ok(result.response.includes('飞书测试'));
    assert.ok(result.response.includes('https://cafe.example.com/thread/thread-a'));
  });

  it('/where returns helpful message when no binding exists', async () => {
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(),
      threadStore: stubThreadStore(),
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/where');
    assert.equal(result.kind, 'where');
    assert.ok(result.response.includes('没有'));
  });

  it('/where is case-insensitive on command name', async () => {
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(),
      threadStore: stubThreadStore(),
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/Where');
    assert.equal(result.kind, 'where');
  });

  it('/new creates a new thread and returns confirmation', async () => {
    const bindings = new Map();
    const store = {
      ...stubStore(),
      bind: async (cId, eCId, tId, uId) => {
        const b = { connectorId: cId, externalChatId: eCId, threadId: tId, userId: uId, createdAt: Date.now() };
        bindings.set(`${cId}:${eCId}`, b);
        return b;
      },
      getByExternal: async (cId, eCId) => bindings.get(`${cId}:${eCId}`) ?? null,
    };
    const layer = new ConnectorCommandLayer({
      bindingStore: store,
      threadStore: stubThreadStore(),
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/new 新话题');
    assert.equal(result.kind, 'new');
    assert.ok(result.newActiveThreadId);
    assert.ok(result.response.includes('新话题'));
    assert.ok(result.response.includes('https://cafe.example.com/thread/'));
  });

  it('/new without title still creates thread', async () => {
    const store = {
      ...stubStore(),
      bind: async (cId, eCId, tId, uId) => ({
        connectorId: cId,
        externalChatId: eCId,
        threadId: tId,
        userId: uId,
        createdAt: Date.now(),
      }),
    };
    const layer = new ConnectorCommandLayer({
      bindingStore: store,
      threadStore: stubThreadStore(),
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/new');
    assert.equal(result.kind, 'new');
    assert.ok(result.newActiveThreadId);
  });

  it('/threads lists recent threads with titles (cross-platform)', async () => {
    // Phase C: /threads now uses threadStore.list() — shows ALL user threads
    const threadStore = stubThreadStore([
      { id: 'thread-aaa111', title: '飞书Bug' },
      { id: 'thread-bbb222', title: '新功能讨论' },
    ]);
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(),
      threadStore,
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/threads');
    assert.equal(result.kind, 'threads');
    assert.ok(result.response.includes('飞书Bug'));
    assert.ok(result.response.includes('新功能讨论'));
    assert.ok(result.response.includes('/use'));
  });

  it('/threads shows full thread IDs (not truncated)', async () => {
    const threadStore = stubThreadStore([
      { id: 'thread_mmj4lhqgcy0najsb', title: '飞书Bug' },
      { id: 'thread_mmvjdaq22cdzohww', title: '新功能讨论' },
    ]);
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(),
      threadStore,
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/threads');
    assert.ok(result.response.includes('thread_mmj4lhqgcy0najsb'), 'Should show full ID, not truncated');
    assert.ok(result.response.includes('thread_mmvjdaq22cdzohww'), 'Should show full ID, not truncated');
  });

  it('/threads returns contextThreadId when binding exists (Phase C P1 fix)', async () => {
    const binding = {
      connectorId: 'feishu',
      externalChatId: 'chat1',
      threadId: 'thread-aaa111',
      userId: 'user1',
      createdAt: Date.now(),
    };
    const threadStore = stubThreadStore([
      { id: 'thread-aaa111', title: '飞书Bug' },
      { id: 'thread-bbb222', title: '新功能讨论' },
    ]);
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(binding),
      threadStore,
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/threads');
    assert.equal(result.kind, 'threads');
    assert.equal(result.contextThreadId, 'thread-aaa111');
    assert.ok(result.response.includes('飞书Bug'));
  });

  it('/threads omits contextThreadId when no binding exists', async () => {
    const threadStore = stubThreadStore([{ id: 'thread-aaa111', title: '飞书Bug' }]);
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(),
      threadStore,
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/threads');
    assert.equal(result.kind, 'threads');
    assert.equal(result.contextThreadId, undefined);
  });

  it('/threads returns helpful message when empty', async () => {
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(),
      threadStore: stubThreadStore(),
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/threads');
    assert.equal(result.kind, 'threads');
    assert.ok(result.response.includes('没有'));
  });

  it('/use switches to an existing thread by prefix (cross-platform)', async () => {
    // Phase C: /use now searches threadStore.list() — can switch to any thread
    const bindings = new Map();
    const store = {
      ...stubStore(),
      bind: async (cId, eCId, tId, uId) => {
        const b = { connectorId: cId, externalChatId: eCId, threadId: tId, userId: uId, createdAt: Date.now() };
        bindings.set(`${cId}:${eCId}`, b);
        return b;
      },
    };
    const threadStore = stubThreadStore([
      { id: 'thread-target-xyz', title: '目标Thread' },
      { id: 'thread-other-abc', title: '其他Thread' },
    ]);
    const layer = new ConnectorCommandLayer({
      bindingStore: store,
      threadStore,
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/use thread-ta');
    assert.equal(result.kind, 'use');
    assert.equal(result.newActiveThreadId, 'thread-target-xyz');
    assert.ok(result.response.includes('目标Thread'));
    assert.ok(result.response.includes('https://cafe.example.com/thread/thread-target-xyz'));
  });

  it('/use with no match returns error', async () => {
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(),
      threadStore: stubThreadStore(),
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/use nonexistent');
    assert.equal(result.kind, 'use');
    assert.ok(result.response.includes('找不到'));
  });

  it('/use with no argument returns usage hint', async () => {
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(),
      threadStore: stubThreadStore(),
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/use');
    assert.equal(result.kind, 'use');
    assert.ok(result.response.includes('ID'));
  });

  // --- Phase D: /use fuzzy matching ---

  it('/use F088 matches thread by feat number', async () => {
    const bindings = new Map();
    const store = {
      ...stubStore(),
      bind: async (cId, eCId, tId, uId) => {
        const b = { connectorId: cId, externalChatId: eCId, threadId: tId, userId: uId, createdAt: Date.now() };
        bindings.set(`${cId}:${eCId}`, b);
        return b;
      },
    };
    const threadStore = stubThreadStore([
      { id: 'thread-aaa', title: '飞书Bug', backlogItemId: 'bl-1', lastActiveAt: 100 },
      { id: 'thread-bbb', title: '其他功能', backlogItemId: 'bl-2', lastActiveAt: 200 },
    ]);
    const backlogStore = {
      get: async (itemId) => {
        if (itemId === 'bl-1') return { tags: ['feature:f088'] };
        if (itemId === 'bl-2') return { tags: ['feature:f066'] };
        return null;
      },
    };
    const layer = new ConnectorCommandLayer({
      bindingStore: store,
      threadStore,
      backlogStore,
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/use F088');
    assert.equal(result.kind, 'use');
    assert.equal(result.newActiveThreadId, 'thread-aaa');
    assert.ok(result.response.includes('飞书Bug'));
  });

  it('/use F088 picks most recently active thread when multiple match', async () => {
    const store = {
      ...stubStore(),
      bind: async (cId, eCId, tId, uId) => ({
        connectorId: cId,
        externalChatId: eCId,
        threadId: tId,
        userId: uId,
        createdAt: Date.now(),
      }),
    };
    const threadStore = stubThreadStore([
      { id: 'thread-old', title: '旧讨论', backlogItemId: 'bl-a', lastActiveAt: 100 },
      { id: 'thread-new', title: '新讨论', backlogItemId: 'bl-b', lastActiveAt: 500 },
    ]);
    const backlogStore = {
      get: async (itemId) => {
        if (itemId === 'bl-a' || itemId === 'bl-b') return { tags: ['feature:f088'] };
        return null;
      },
    };
    const layer = new ConnectorCommandLayer({
      bindingStore: store,
      threadStore,
      backlogStore,
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/use f088');
    assert.equal(result.newActiveThreadId, 'thread-new');
  });

  it('/use F999 returns error when no feat match', async () => {
    const threadStore = stubThreadStore([
      { id: 'thread-aaa', title: '飞书Bug', backlogItemId: 'bl-1', lastActiveAt: 100 },
    ]);
    const backlogStore = {
      get: async (itemId) => {
        if (itemId === 'bl-1') return { tags: ['feature:f088'] };
        return null;
      },
    };
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(),
      threadStore,
      backlogStore,
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/use F999');
    assert.equal(result.kind, 'use');
    assert.ok(result.response.includes('找不到'));
  });

  it('/use 2 matches thread by list index', async () => {
    const store = {
      ...stubStore(),
      bind: async (cId, eCId, tId, uId) => ({
        connectorId: cId,
        externalChatId: eCId,
        threadId: tId,
        userId: uId,
        createdAt: Date.now(),
      }),
    };
    const threadStore = stubThreadStore([
      { id: 'thread-first', title: '第一个' },
      { id: 'thread-second', title: '第二个' },
      { id: 'thread-third', title: '第三个' },
    ]);
    const layer = new ConnectorCommandLayer({
      bindingStore: store,
      threadStore,
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/use 2');
    assert.equal(result.kind, 'use');
    assert.equal(result.newActiveThreadId, 'thread-second');
    assert.ok(result.response.includes('第二个'));
  });

  it('/use 99 returns error for out-of-range index', async () => {
    const threadStore = stubThreadStore([{ id: 'thread-only', title: '唯一' }]);
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(),
      threadStore,
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/use 99');
    assert.equal(result.kind, 'use');
    assert.ok(result.response.includes('找不到'));
  });

  it('/use 飞书 matches thread by title substring', async () => {
    const store = {
      ...stubStore(),
      bind: async (cId, eCId, tId, uId) => ({
        connectorId: cId,
        externalChatId: eCId,
        threadId: tId,
        userId: uId,
        createdAt: Date.now(),
      }),
    };
    const threadStore = stubThreadStore([
      { id: 'thread-aaa', title: '飞书登录Bug' },
      { id: 'thread-bbb', title: 'Telegram测试' },
    ]);
    const layer = new ConnectorCommandLayer({
      bindingStore: store,
      threadStore,
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/use 飞书');
    assert.equal(result.kind, 'use');
    assert.equal(result.newActiveThreadId, 'thread-aaa');
    assert.ok(result.response.includes('飞书登录Bug'));
  });

  it('/use multi-word query matches full phrase in title (cloud P1 fix)', async () => {
    const store = {
      ...stubStore(),
      bind: async (cId, eCId, tId, uId) => ({
        connectorId: cId,
        externalChatId: eCId,
        threadId: tId,
        userId: uId,
        createdAt: Date.now(),
      }),
    };
    const threadStore = stubThreadStore([
      { id: 'thread-1', title: 'login bug', lastActiveAt: 100 },
      { id: 'thread-2', title: 'login feature', lastActiveAt: 200 },
    ]);
    const layer = new ConnectorCommandLayer({
      bindingStore: store,
      threadStore,
      frontendBaseUrl: 'https://cafe.example.com',
    });
    // "/use login bug" should match "login bug" exactly, not "login feature" (more recent)
    const result = await layer.handle('feishu', 'chat1', 'user1', '/use login bug');
    assert.equal(result.kind, 'use');
    assert.equal(result.newActiveThreadId, 'thread-1');
  });

  it('/use title match picks most recently active when multiple match', async () => {
    const store = {
      ...stubStore(),
      bind: async (cId, eCId, tId, uId) => ({
        connectorId: cId,
        externalChatId: eCId,
        threadId: tId,
        userId: uId,
        createdAt: Date.now(),
      }),
    };
    const threadStore = stubThreadStore([
      { id: 'thread-old', title: '飞书旧bug', lastActiveAt: 100 },
      { id: 'thread-new', title: '飞书新bug', lastActiveAt: 500 },
    ]);
    const layer = new ConnectorCommandLayer({
      bindingStore: store,
      threadStore,
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/use 飞书');
    assert.equal(result.newActiveThreadId, 'thread-new');
  });

  it('/use gracefully degrades when backlogStore unavailable', async () => {
    // Without backlogStore, /use F088 should fall through to ID prefix / title match
    const store = {
      ...stubStore(),
      bind: async (cId, eCId, tId, uId) => ({
        connectorId: cId,
        externalChatId: eCId,
        threadId: tId,
        userId: uId,
        createdAt: Date.now(),
      }),
    };
    const threadStore = stubThreadStore([{ id: 'thread-aaa', title: 'F088相关', backlogItemId: 'bl-1' }]);
    // No backlogStore provided
    const layer = new ConnectorCommandLayer({
      bindingStore: store,
      threadStore,
      frontendBaseUrl: 'https://cafe.example.com',
    });
    // /use F088 won't match by feat (no backlogStore), won't match by index or ID prefix,
    // but WILL match by title substring since 'F088' appears in title
    const result = await layer.handle('feishu', 'chat1', 'user1', '/use F088');
    assert.equal(result.kind, 'use');
    assert.equal(result.newActiveThreadId, 'thread-aaa');
  });

  it('/threads shows feat badges when backlogStore available', async () => {
    const threadStore = stubThreadStore([
      { id: 'thread-aaa', title: '飞书Bug', backlogItemId: 'bl-1' },
      { id: 'thread-bbb', title: '无feat的thread' },
    ]);
    const backlogStore = {
      get: async (itemId) => {
        if (itemId === 'bl-1') return { tags: ['feature:f088'] };
        return null;
      },
    };
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(),
      threadStore,
      backlogStore,
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/threads');
    assert.equal(result.kind, 'threads');
    assert.ok(result.response.includes('[F088]'), 'Should show feat badge');
    assert.ok(result.response.includes('飞书Bug'));
    assert.ok(result.response.includes('无feat的thread'));
  });

  it('/threads omits feat badges when backlogStore unavailable', async () => {
    const threadStore = stubThreadStore([{ id: 'thread-aaa', title: '飞书Bug', backlogItemId: 'bl-1' }]);
    // No backlogStore
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(),
      threadStore,
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/threads');
    assert.equal(result.kind, 'threads');
    assert.ok(!result.response.includes('[F088]'), 'Should not show feat badge without backlogStore');
    assert.ok(result.response.includes('飞书Bug'));
  });

  it('/use F088 matches thread with multiple feat tags (P1 fix)', async () => {
    const bindings = new Map();
    const store = {
      ...stubStore(),
      bind: async (cId, eCId, tId, uId) => {
        const b = { connectorId: cId, externalChatId: eCId, threadId: tId, userId: uId, createdAt: Date.now() };
        bindings.set(`${cId}:${eCId}`, b);
        return b;
      },
    };
    const threadStore = stubThreadStore([
      { id: 'thread-multi', title: '多feat讨论', backlogItemId: 'bl-multi', lastActiveAt: 300 },
      { id: 'thread-single', title: '单feat', backlogItemId: 'bl-single', lastActiveAt: 100 },
    ]);
    const backlogStore = {
      get: async (itemId) => {
        // bl-multi has TWO feat tags — F088 is the second one
        if (itemId === 'bl-multi') return { tags: ['feature:f066', 'feature:f088'] };
        if (itemId === 'bl-single') return { tags: ['feature:f042'] };
        return null;
      },
    };
    const layer = new ConnectorCommandLayer({
      bindingStore: store,
      threadStore,
      backlogStore,
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/use F088');
    assert.equal(result.kind, 'use');
    assert.equal(result.newActiveThreadId, 'thread-multi');
    assert.ok(result.response.includes('多feat讨论'));
  });

  // --- /thread: cross-thread message routing ---

  it('/thread switches to target thread and returns forwardContent', async () => {
    const bindings = new Map();
    const store = {
      ...stubStore(),
      bind: async (cId, eCId, tId, uId) => {
        const b = { connectorId: cId, externalChatId: eCId, threadId: tId, userId: uId, createdAt: Date.now() };
        bindings.set(`${cId}:${eCId}`, b);
        return b;
      },
    };
    const threadStore = stubThreadStore([
      { id: 'thread_mmvjdaq22cdzohww', title: 'F088讨论' },
      { id: 'thread-other', title: '其他' },
    ]);
    const layer = new ConnectorCommandLayer({
      bindingStore: store,
      threadStore,
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/thread thread_mmvjdaq22cdzohww hi');
    assert.equal(result.kind, 'thread');
    assert.equal(result.newActiveThreadId, 'thread_mmvjdaq22cdzohww');
    assert.equal(result.forwardContent, 'hi');
    assert.ok(result.response.includes('F088讨论'));
  });

  it('/thread matches by ID prefix', async () => {
    const store = {
      ...stubStore(),
      bind: async (cId, eCId, tId, uId) => ({
        connectorId: cId,
        externalChatId: eCId,
        threadId: tId,
        userId: uId,
        createdAt: Date.now(),
      }),
    };
    const threadStore = stubThreadStore([{ id: 'thread_mmvjdaq22cdzohww', title: '目标Thread' }]);
    const layer = new ConnectorCommandLayer({
      bindingStore: store,
      threadStore,
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/thread thread_mmvj 你好呀');
    assert.equal(result.kind, 'thread');
    assert.equal(result.newActiveThreadId, 'thread_mmvjdaq22cdzohww');
    assert.equal(result.forwardContent, '你好呀');
  });

  it('/thread with multi-word message preserves full content', async () => {
    const store = {
      ...stubStore(),
      bind: async (cId, eCId, tId, uId) => ({
        connectorId: cId,
        externalChatId: eCId,
        threadId: tId,
        userId: uId,
        createdAt: Date.now(),
      }),
    };
    const threadStore = stubThreadStore([{ id: 'thread-abc', title: '测试' }]);
    const layer = new ConnectorCommandLayer({
      bindingStore: store,
      threadStore,
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/thread thread-abc hello world 你好');
    assert.equal(result.forwardContent, 'hello world 你好');
  });

  it('/thread rejects thread not owned by user (P1 security fix)', async () => {
    // stubThreadStore.list() returns threads for 'user1', but get() returns any thread
    // The handler must ONLY match within list(userId), not via raw get()
    const foreignThread = { id: 'thread-foreign-secret', title: '别人的Thread' };
    const myThread = { id: 'thread-mine', title: '我的Thread' };
    const threadStore = {
      ...stubThreadStore([myThread]),
      // get() can find any thread (no userId filter)
      get: async (id) => (id === foreignThread.id ? foreignThread : id === myThread.id ? myThread : null),
      // list() only returns user's own threads
      list: async () => [myThread],
    };
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(),
      threadStore,
      frontendBaseUrl: 'https://cafe.example.com',
    });
    // Try to /thread to a foreign thread by exact ID
    const result = await layer.handle('feishu', 'chat1', 'user1', '/thread thread-foreign-secret hi');
    assert.equal(result.kind, 'thread');
    assert.ok(result.response.includes('找不到'), 'Should reject foreign thread');
    assert.equal(result.forwardContent, undefined, 'Should NOT forward to foreign thread');
  });

  it('/thread with unknown thread returns error', async () => {
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(),
      threadStore: stubThreadStore(),
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/thread nonexistent hi');
    assert.equal(result.kind, 'thread');
    assert.ok(result.response.includes('找不到'));
    assert.equal(result.forwardContent, undefined);
  });

  it('/thread with no args returns usage hint', async () => {
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(),
      threadStore: stubThreadStore(),
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/thread');
    assert.equal(result.kind, 'thread');
    assert.ok(result.response.includes('用法'));
  });

  it('/thread with only thread ID but no message returns usage hint', async () => {
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(),
      threadStore: stubThreadStore([{ id: 'thread-abc', title: '测试' }]),
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/thread thread-abc');
    assert.equal(result.kind, 'thread');
    assert.ok(result.response.includes('用法'));
  });

  it('/threads shows all feat badges for multi-feat thread (P1 fix)', async () => {
    const threadStore = stubThreadStore([{ id: 'thread-multi', title: '多feat讨论', backlogItemId: 'bl-multi' }]);
    const backlogStore = {
      get: async (itemId) => {
        if (itemId === 'bl-multi') return { tags: ['feature:f066', 'feature:f088'] };
        return null;
      },
    };
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(),
      threadStore,
      backlogStore,
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/threads');
    assert.equal(result.kind, 'threads');
    assert.ok(result.response.includes('[F066'), 'Should show first feat badge in brackets');
    assert.ok(result.response.includes('F088]'), 'Should show second feat in badge');
  });

  it('/unbind with no binding returns warning', async () => {
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(null),
      threadStore: stubThreadStore(),
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/unbind');
    assert.equal(result.kind, 'unbind');
    assert.ok(result.response.includes('没有绑定'));
  });

  // --- F142: registry-executor consistency ---

  describe('registry-executor consistency (connector scope)', () => {
    it('every connector command dispatched in handle() is reachable', async () => {
      const layer = new ConnectorCommandLayer({
        bindingStore: stubStore(),
        threadStore: stubThreadStore(),
        frontendBaseUrl: 'https://cafe.example.com',
      });
      const connectorCommands = [
        '/where',
        '/new',
        '/threads',
        '/use',
        '/thread',
        '/unbind',
        '/allow-group',
        '/deny-group',
        '/commands',
        '/cats',
        '/status',
      ];
      for (const cmd of connectorCommands) {
        const result = await layer.handle('test', 'chat1', 'user1', cmd);
        assert.notEqual(result.kind, 'not-command', `${cmd} should be handled`);
      }
    });
  });

  it('/unbind removes active binding and returns thread info', async () => {
    let removedKey = null;
    const bindingStore = {
      ...stubStore({ connectorId: 'feishu', externalChatId: 'chat1', threadId: 'thread-x', userId: 'user1' }),
      remove: async (connectorId, externalChatId) => {
        removedKey = `${connectorId}:${externalChatId}`;
        return true;
      },
    };
    const layer = new ConnectorCommandLayer({
      bindingStore,
      threadStore: stubThreadStore({ id: 'thread-x', title: 'My Thread' }),
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/unbind');
    assert.equal(result.kind, 'unbind');
    assert.ok(result.response.includes('已解绑'));
    assert.ok(result.response.includes('My Thread'));
    assert.equal(removedKey, 'feishu:chat1');
  });

  // --- F142: /commands ---

  describe('/commands (F142)', () => {
    it('returns list of available connector commands', async () => {
      const layer = new ConnectorCommandLayer({
        bindingStore: stubStore(),
        threadStore: stubThreadStore(),
        frontendBaseUrl: 'https://cafe.example.com',
      });
      const result = await layer.handle('feishu', 'chat1', 'user1', '/commands');
      assert.equal(result.kind, 'commands');
      assert.ok(result.response);
      assert.ok(result.response.includes('/commands'));
      assert.ok(result.response.includes('/cats'));
      assert.ok(result.response.includes('/where'));
      assert.ok(result.response.includes('/status'));
    });

    it('/commands is case-insensitive', async () => {
      const layer = new ConnectorCommandLayer({
        bindingStore: stubStore(),
        threadStore: stubThreadStore(),
        frontendBaseUrl: 'https://cafe.example.com',
      });
      const result = await layer.handle('feishu', 'chat1', 'user1', '/Commands');
      assert.equal(result.kind, 'commands');
    });
  });

  // --- F142: /cats ---

  describe('/cats (F142)', () => {
    it('returns formatted cat list for bound thread', async () => {
      const layer = new ConnectorCommandLayer({
        bindingStore: stubStore({
          connectorId: 'feishu',
          externalChatId: 'chat1',
          threadId: 't-bound',
          userId: 'user1',
        }),
        threadStore: stubThreadStore({ id: 't-bound', title: '测试' }),
        frontendBaseUrl: 'https://cafe.example.com',
        participantStore: {
          getParticipantsWithActivity: async () => [{ catId: 'opus', lastMessageAt: 1000, messageCount: 5 }],
        },
        agentRegistry: { has: (id) => id === 'opus' },
        catRoster: { opus: { displayName: '布偶猫', available: true } },
      });
      const result = await layer.handle('feishu', 'chat1', 'user1', '/cats');
      assert.equal(result.kind, 'cats');
      assert.ok(result.response);
      assert.ok(result.response.includes('参与猫'));
      assert.equal(result.contextThreadId, 't-bound');
    });

    it('with no binding returns guidance', async () => {
      const layer = new ConnectorCommandLayer({
        bindingStore: stubStore(),
        threadStore: stubThreadStore(),
        frontendBaseUrl: 'https://cafe.example.com',
      });
      const result = await layer.handle('feishu', 'chat1', 'user1', '/cats');
      assert.equal(result.kind, 'cats');
      assert.ok(result.response.includes('没有绑定'));
    });

    it('shows routable-not-joined and not-routable cats', async () => {
      const layer = new ConnectorCommandLayer({
        bindingStore: stubStore({
          connectorId: 'feishu',
          externalChatId: 'chat1',
          threadId: 't-bound',
          userId: 'user1',
        }),
        threadStore: stubThreadStore({ id: 't-bound', title: '测试' }),
        frontendBaseUrl: 'https://cafe.example.com',
        participantStore: { getParticipantsWithActivity: async () => [] },
        agentRegistry: { has: (id) => id === 'gpt52' },
        catRoster: {
          gpt52: { displayName: 'GPT-5.4', available: true },
          gemini: { displayName: '暹罗猫', available: false },
        },
      });
      const result = await layer.handle('feishu', 'chat1', 'user1', '/cats');
      assert.ok(result.response.includes('可调度'));
      assert.ok(result.response.includes('不可调度'));
    });
  });

  // --- F142: /status ---

  describe('/status (F142)', () => {
    it('returns thread overview for bound thread', async () => {
      const layer = new ConnectorCommandLayer({
        bindingStore: stubStore({
          connectorId: 'feishu',
          externalChatId: 'chat1',
          threadId: 't-bound',
          userId: 'user1',
        }),
        threadStore: stubThreadStore({ id: 't-bound', title: 'F142 开发', createdAt: Date.now() - 86400000 }),
        frontendBaseUrl: 'https://cafe.example.com',
        participantStore: {
          getParticipantsWithActivity: async () => [
            { catId: 'opus', lastMessageAt: Date.now(), messageCount: 5 },
            { catId: 'codex', lastMessageAt: Date.now() - 3600000, messageCount: 3 },
          ],
        },
      });
      const result = await layer.handle('feishu', 'chat1', 'user1', '/status');
      assert.equal(result.kind, 'status');
      assert.ok(result.response.includes('F142 开发'));
      assert.ok(result.response.includes('2')); // participant count
      assert.ok(result.response.includes('https://cafe.example.com/thread/t-bound'));
      assert.equal(result.contextThreadId, 't-bound');
    });

    it('with no binding returns guidance', async () => {
      const layer = new ConnectorCommandLayer({
        bindingStore: stubStore(),
        threadStore: stubThreadStore(),
        frontendBaseUrl: 'https://cafe.example.com',
      });
      const result = await layer.handle('feishu', 'chat1', 'user1', '/status');
      assert.equal(result.kind, 'status');
      assert.ok(result.response.includes('没有绑定'));
    });

    it('handles missing thread gracefully', async () => {
      const layer = new ConnectorCommandLayer({
        bindingStore: stubStore({
          connectorId: 'feishu',
          externalChatId: 'chat1',
          threadId: 't-gone',
          userId: 'user1',
        }),
        threadStore: stubThreadStore(), // empty — thread doesn't exist
        frontendBaseUrl: 'https://cafe.example.com',
      });
      const result = await layer.handle('feishu', 'chat1', 'user1', '/status');
      assert.equal(result.kind, 'status');
      assert.ok(result.response.includes('不存在'));
    });
  });

  // --- F142: baseline regression for permission commands ---

  it('/allow-group rejects non-admin sender', async () => {
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(),
      threadStore: stubThreadStore(),
      frontendBaseUrl: 'https://cafe.example.com',
      permissionStore: {
        isAdmin: async () => false,
        allowGroup: async () => {},
        denyGroup: async () => false,
        listAllowedGroups: async () => [],
        isGroupAllowed: async () => false,
      },
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/allow-group', 'sender1');
    assert.equal(result.kind, 'allow-group');
    assert.ok(result.response.includes('管理员'));
  });

  it('/allow-group allows admin sender to whitelist group', async () => {
    const allowed = [];
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(),
      threadStore: stubThreadStore(),
      frontendBaseUrl: 'https://cafe.example.com',
      permissionStore: {
        isAdmin: async () => true,
        allowGroup: async (_cId, chatId) => {
          allowed.push(chatId);
        },
        denyGroup: async () => false,
        listAllowedGroups: async () => allowed,
        isGroupAllowed: async () => true,
      },
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/allow-group target-chat', 'admin1');
    assert.equal(result.kind, 'allow-group');
    assert.ok(result.response.includes('白名单'));
    assert.deepEqual(allowed, ['target-chat']);
  });

  it('/deny-group rejects non-admin sender', async () => {
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(),
      threadStore: stubThreadStore(),
      frontendBaseUrl: 'https://cafe.example.com',
      permissionStore: {
        isAdmin: async () => false,
        allowGroup: async () => {},
        denyGroup: async () => false,
        listAllowedGroups: async () => [],
        isGroupAllowed: async () => false,
      },
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/deny-group', 'sender1');
    assert.equal(result.kind, 'deny-group');
    assert.ok(result.response.includes('管理员'));
  });

  it('/deny-group allows admin to remove group from whitelist', async () => {
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(),
      threadStore: stubThreadStore(),
      frontendBaseUrl: 'https://cafe.example.com',
      permissionStore: {
        isAdmin: async () => true,
        allowGroup: async () => {},
        denyGroup: async () => true,
        listAllowedGroups: async () => [],
        isGroupAllowed: async () => false,
      },
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/deny-group target-chat', 'admin1');
    assert.equal(result.kind, 'deny-group');
    assert.ok(result.response.includes('已从白名单移除'));
  });

  // --- F142 P2: wiring contract — deps must be injected for non-degenerate output ---

  describe('wiring contract: /cats and /status require injected deps (F142 P2)', () => {
    it('/cats without participantStore/agentRegistry/catRoster returns empty categorization', async () => {
      // Simulates the pre-fix bootstrap: deps not wired → degenerate output
      const layer = new ConnectorCommandLayer({
        bindingStore: stubStore({
          connectorId: 'feishu',
          externalChatId: 'chat1',
          threadId: 't-bound',
          userId: 'user1',
        }),
        threadStore: stubThreadStore({ id: 't-bound', title: 'Test' }),
        frontendBaseUrl: 'https://cafe.example.com',
        // NO participantStore, agentRegistry, catRoster — mimics missing wiring
      });
      const result = await layer.handle('feishu', 'chat1', 'user1', '/cats');
      assert.equal(result.kind, 'cats');
      // Without deps, no participant/cat categorization data
      assert.ok(!result.response.includes('参与猫'), 'should not show participants without deps');
    });

    it('/cats WITH all deps returns categorized output', async () => {
      // Simulates correct bootstrap: deps wired → rich output
      const layer = new ConnectorCommandLayer({
        bindingStore: stubStore({
          connectorId: 'feishu',
          externalChatId: 'chat1',
          threadId: 't-bound',
          userId: 'user1',
        }),
        threadStore: stubThreadStore({ id: 't-bound', title: 'Test' }),
        frontendBaseUrl: 'https://cafe.example.com',
        participantStore: {
          getParticipantsWithActivity: async () => [{ catId: 'opus', lastMessageAt: Date.now(), messageCount: 3 }],
        },
        agentRegistry: { has: (id) => id === 'opus' },
        catRoster: { opus: { displayName: '布偶猫', available: true } },
      });
      const result = await layer.handle('feishu', 'chat1', 'user1', '/cats');
      assert.equal(result.kind, 'cats');
      assert.ok(result.response.includes('参与猫'), 'must show participants when deps are wired');
      assert.ok(result.response.includes('布偶猫'), 'must resolve display name from catRoster');
    });

    it('/status without participantStore shows 0 participants', async () => {
      const layer = new ConnectorCommandLayer({
        bindingStore: stubStore({
          connectorId: 'feishu',
          externalChatId: 'chat1',
          threadId: 't-bound',
          userId: 'user1',
        }),
        threadStore: stubThreadStore({ id: 't-bound', title: 'Status Test', createdAt: Date.now() }),
        frontendBaseUrl: 'https://cafe.example.com',
        // NO participantStore
      });
      const result = await layer.handle('feishu', 'chat1', 'user1', '/status');
      assert.equal(result.kind, 'status');
      assert.ok(result.response.includes('0'), 'should show 0 participants without participantStore');
    });
  });
});

// --- F142 Phase B: registry-powered integration tests ---

describe('ConnectorCommandLayer + CommandRegistry (F142-B)', () => {
  let ConnectorCommandLayer;
  let CommandRegistry;

  before(async () => {
    const mod = await import('../dist/infrastructure/connectors/ConnectorCommandLayer.js');
    ConnectorCommandLayer = mod.ConnectorCommandLayer;
    const regMod = await import('../dist/infrastructure/commands/CommandRegistry.js');
    CommandRegistry = regMod.CommandRegistry;
  });

  function buildRegistry(extraSkill) {
    const core = [
      {
        name: '/where',
        usage: '/where',
        description: '查看绑定',
        category: 'connector',
        surface: 'connector',
        source: 'core',
      },
      {
        name: '/new',
        usage: '/new [标题]',
        description: '创建 thread',
        category: 'connector',
        surface: 'connector',
        source: 'core',
      },
      {
        name: '/commands',
        usage: '/commands',
        description: '列出命令',
        category: 'connector',
        surface: 'connector',
        source: 'core',
      },
    ];
    const registry = new CommandRegistry(core);
    if (extraSkill) {
      registry.registerSkillCommands(extraSkill.id, extraSkill.commands, { warn: () => {} });
    }
    return registry;
  }

  it('/commands with registry shows registered skill commands', async () => {
    const registry = buildRegistry({
      id: 'debugging',
      commands: [
        {
          name: '/debug',
          usage: '/debug [query]',
          description: 'Debug helper',
          category: 'general',
          surface: 'connector',
          source: 'skill',
        },
      ],
    });
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(),
      threadStore: stubThreadStore(),
      frontendBaseUrl: 'https://cafe.example.com',
      commandRegistry: registry,
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/commands');
    assert.equal(result.kind, 'commands');
    assert.ok(result.response.includes('/debug'), '/commands output must include skill command');
    assert.ok(result.response.includes('Debug helper'), '/commands output must include skill description');
  });

  it('core command conflict: skill /where rejected', async () => {
    const core = [
      {
        name: '/where',
        usage: '/where',
        description: '查看绑定',
        category: 'connector',
        surface: 'connector',
        source: 'core',
      },
    ];
    const registry = new CommandRegistry(core);
    const warnings = [];
    registry.registerSkillCommands(
      'evil-skill',
      [
        {
          name: '/where',
          usage: '/where',
          description: 'Hijack',
          category: 'general',
          surface: 'connector',
          source: 'skill',
        },
      ],
      { warn: (msg) => warnings.push(msg) },
    );
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('conflicts with core command'));
    // Original core command should still work
    const entry = registry.get('/where');
    assert.equal(entry.source, 'core');
  });

  it('audit log fires for recognized commands (AC-B7)', async () => {
    const registry = buildRegistry();
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(),
      threadStore: stubThreadStore(),
      frontendBaseUrl: 'https://cafe.example.com',
      commandRegistry: registry,
    });
    const logs = [];
    const origLog = console.log;
    console.log = (msg) => {
      if (typeof msg === 'string' && msg.includes('"slash_command"')) logs.push(msg);
    };
    try {
      await layer.handle('feishu', 'chat1', 'user1', '/commands');
      assert.equal(logs.length, 1, 'should emit exactly one audit log');
      const entry = JSON.parse(logs[0]);
      assert.equal(entry.event, 'slash_command');
      assert.equal(entry.command, '/commands');
      assert.equal(entry.surface, 'connector');
      assert.equal(entry.source, 'core');
      assert.equal(entry.success, true);
    } finally {
      console.log = origLog;
    }
  });

  it('unknown /slash still returns not-command (skill passthrough AC-B4)', async () => {
    const registry = buildRegistry();
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(),
      threadStore: stubThreadStore(),
      frontendBaseUrl: 'https://cafe.example.com',
      commandRegistry: registry,
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/unknown-skill-cmd hello');
    assert.equal(result.kind, 'not-command', 'unrecognized slash commands should pass through to cat');
  });

  it('/thread CORE_COMMANDS usage matches handler error hint (P2 regression)', async () => {
    // Lock: CORE_COMMANDS says "/thread <thread_id> <message>" — handler must agree
    const { CORE_COMMANDS } = await import('@cat-cafe/shared');
    const threadDef = CORE_COMMANDS.find((c) => c.name === '/thread');
    assert.ok(threadDef, '/thread must exist in CORE_COMMANDS');
    assert.equal(threadDef.usage, '/thread <thread_id> <message>');

    // Handler's own usage hint must match
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(),
      threadStore: stubThreadStore(),
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/thread');
    assert.ok(
      result.response.includes('/thread <thread_id> <message>'),
      `handler error hint must match CORE_COMMANDS usage, got: ${result.response}`,
    );
  });
});

// ─── F154: /focus + /ask tests ──────────────────────────────────────────
describe('F154: /focus command (AC-A1, AC-A3, AC-A6, AC-A7)', () => {
  let ConnectorCommandLayer;
  const THREAD_ID = 'thread-focus-test';
  const CID = 'feishu';
  const EXT = 'chat-focus';
  const UID = 'user1';

  const binding = { connectorId: CID, externalChatId: EXT, threadId: THREAD_ID, userId: UID, createdAt: Date.now() };

  before(async () => {
    // Set up catRegistry with test cats
    const { catRegistry, createCatId } = await import('@cat-cafe/shared');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
    const allConfigs = toAllCatConfigs(loadCatConfig());
    catRegistry.reset();
    catRegistry.register('opus', { ...allConfigs.opus });
    catRegistry.register('opus-45', {
      ...allConfigs.opus,
      id: createCatId('opus-45'),
      name: '布偶猫 Opus 4.5',
      displayName: '布偶猫 Opus 4.5',
      nickname: undefined,
      mentionPatterns: ['@opus-45'],
    });
    catRegistry.register('codex', { ...allConfigs.codex });

    const mod = await import('../dist/infrastructure/connectors/ConnectorCommandLayer.js');
    ConnectorCommandLayer = mod.ConnectorCommandLayer;
  });

  function makeLayer(threadData) {
    return new ConnectorCommandLayer({
      bindingStore: stubStore(binding),
      threadStore: stubThreadStore(threadData || { id: THREAD_ID, title: 'Focus Test' }),
      frontendBaseUrl: 'https://cafe.example.com',
    });
  }

  it('/focus opus — sets preferredCats to [opus]', async () => {
    const ts = stubThreadStore({ id: THREAD_ID, title: 'Focus Test' });
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(binding),
      threadStore: ts,
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle(CID, EXT, UID, '/focus opus');
    assert.equal(result.kind, 'focus');
    assert.ok(result.response);
    const thread = await ts.get(THREAD_ID);
    assert.deepStrictEqual(thread.preferredCats, ['opus']);
  });

  it('/focus (no args) — shows current preferred cat', async () => {
    const ts = stubThreadStore({ id: THREAD_ID, title: 'Focus Test', preferredCats: ['codex'] });
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(binding),
      threadStore: ts,
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle(CID, EXT, UID, '/focus');
    assert.equal(result.kind, 'focus');
    assert.ok(
      result.response.includes('codex') || result.response.includes('缅因'),
      `should mention codex, got: ${result.response}`,
    );
  });

  it('/focus (no args, no preferred) — shows no preferred cat', async () => {
    const layer = makeLayer();
    const result = await layer.handle(CID, EXT, UID, '/focus');
    assert.equal(result.kind, 'focus');
    // Should indicate no preferred cat is set
    assert.ok(result.response);
  });

  it('/focus clear — clears preferredCats', async () => {
    const ts = stubThreadStore({ id: THREAD_ID, title: 'Focus Test', preferredCats: ['opus'] });
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(binding),
      threadStore: ts,
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle(CID, EXT, UID, '/focus clear');
    assert.equal(result.kind, 'focus');
    const thread = await ts.get(THREAD_ID);
    assert.equal(thread.preferredCats, undefined);
  });

  it('/focus unknown — returns not-found error', async () => {
    const layer = makeLayer();
    const result = await layer.handle(CID, EXT, UID, '/focus nonexistent');
    assert.equal(result.kind, 'focus');
    assert.ok(
      result.response.includes('找不到') || result.response.includes('not found'),
      `should indicate not found, got: ${result.response}`,
    );
  });

  it('/focus ambiguous — returns candidates (AC-A7)', async () => {
    const layer = makeLayer();
    const result = await layer.handle(CID, EXT, UID, '/focus 猫');
    assert.equal(result.kind, 'focus');
    assert.ok(result.response.includes('opus'), `should list opus candidate, got: ${result.response}`);
    assert.ok(result.response.includes('codex'), `should list codex candidate, got: ${result.response}`);
  });

  it('/focus with no binding — returns error', async () => {
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(null),
      threadStore: stubThreadStore(),
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle(CID, EXT, UID, '/focus opus');
    assert.equal(result.kind, 'focus');
    assert.ok(result.response);
  });
});

describe('F154: /ask command (AC-A2, AC-A5, AC-A6)', () => {
  let ConnectorCommandLayer;
  const THREAD_ID = 'thread-ask-test';
  const CID = 'feishu';
  const EXT = 'chat-ask';
  const UID = 'user1';

  const binding = { connectorId: CID, externalChatId: EXT, threadId: THREAD_ID, userId: UID, createdAt: Date.now() };

  before(async () => {
    const { catRegistry } = await import('@cat-cafe/shared');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
    const allConfigs = toAllCatConfigs(loadCatConfig());
    catRegistry.reset();
    catRegistry.register('opus', { ...allConfigs.opus });
    catRegistry.register('codex', { ...allConfigs.codex });

    const mod = await import('../dist/infrastructure/connectors/ConnectorCommandLayer.js');
    ConnectorCommandLayer = mod.ConnectorCommandLayer;
  });

  it('/ask opus 帮我看代码 — returns ask result with forwardContent', async () => {
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(binding),
      threadStore: stubThreadStore({ id: THREAD_ID, title: 'Ask Test' }),
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle(CID, EXT, UID, '/ask opus 帮我看代码');
    assert.equal(result.kind, 'ask');
    assert.equal(result.targetCatId, 'opus');
    assert.equal(result.forwardContent, '帮我看代码');
    assert.ok(result.response);
  });

  it('/ask (no args) — returns usage hint', async () => {
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(binding),
      threadStore: stubThreadStore({ id: THREAD_ID, title: 'Ask Test' }),
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle(CID, EXT, UID, '/ask');
    assert.equal(result.kind, 'ask');
    assert.ok(result.response.includes('/ask'), `should show usage, got: ${result.response}`);
  });

  it('/ask unknown 消息 — returns not-found error', async () => {
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(binding),
      threadStore: stubThreadStore({ id: THREAD_ID, title: 'Ask Test' }),
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle(CID, EXT, UID, '/ask nonexistent hello');
    assert.equal(result.kind, 'ask');
    assert.ok(result.response.includes('找不到') || result.response.includes('not found'));
    assert.equal(result.forwardContent, undefined);
  });

  it('/ask does NOT modify preferredCats', async () => {
    const ts = stubThreadStore({ id: THREAD_ID, title: 'Ask Test', preferredCats: ['codex'] });
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(binding),
      threadStore: ts,
      frontendBaseUrl: 'https://cafe.example.com',
    });
    await layer.handle(CID, EXT, UID, '/ask opus hello');
    const thread = await ts.get(THREAD_ID);
    assert.deepStrictEqual(thread.preferredCats, ['codex'], 'preferredCats must not change');
  });

  it('/ask with multi-word message preserves full message', async () => {
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(binding),
      threadStore: stubThreadStore({ id: THREAD_ID, title: 'Ask Test' }),
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle(CID, EXT, UID, '/ask opus 帮我看一下这段代码 有没有问题');
    assert.equal(result.kind, 'ask');
    assert.equal(result.forwardContent, '帮我看一下这段代码 有没有问题');
  });

  it('/ask with no binding — returns error (P1-2 fix)', async () => {
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(null),
      threadStore: stubThreadStore(),
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle(CID, EXT, UID, '/ask opus hello');
    assert.equal(result.kind, 'ask');
    assert.equal(result.forwardContent, undefined, 'should NOT have forwardContent when no binding');
    assert.ok(result.response, 'should have error response');
  });
});

describe('F154: /focus + /ask with commandRegistry (P1/P2 regression)', () => {
  let ConnectorCommandLayer;
  let CommandRegistry;
  let CORE_COMMANDS;
  const THREAD_ID = 'thread-registry-test';
  const CID = 'feishu';
  const EXT = 'chat-reg';
  const UID = 'user1';
  const binding = { connectorId: CID, externalChatId: EXT, threadId: THREAD_ID, userId: UID, createdAt: Date.now() };

  before(async () => {
    const shared = await import('@cat-cafe/shared');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
    const allConfigs = toAllCatConfigs(loadCatConfig());
    shared.catRegistry.reset();
    shared.catRegistry.register('opus', { ...allConfigs.opus });
    shared.catRegistry.register('codex', { ...allConfigs.codex });
    CORE_COMMANDS = shared.CORE_COMMANDS;

    const mod = await import('../dist/infrastructure/connectors/ConnectorCommandLayer.js');
    ConnectorCommandLayer = mod.ConnectorCommandLayer;
    const regMod = await import('../dist/infrastructure/commands/CommandRegistry.js');
    CommandRegistry = regMod.CommandRegistry;
  });

  function makeLayerWithRegistry(threadData) {
    const registry = new CommandRegistry(CORE_COMMANDS);
    return new ConnectorCommandLayer({
      bindingStore: stubStore(binding),
      threadStore: stubThreadStore(threadData || { id: THREAD_ID, title: 'Registry Test' }),
      frontendBaseUrl: 'https://cafe.example.com',
      commandRegistry: registry,
    });
  }

  it('/focus clear with registry — actually clears preferredCats (P1-1)', async () => {
    const ts = stubThreadStore({ id: THREAD_ID, title: 'Registry Test', preferredCats: ['opus'] });
    const registry = new CommandRegistry(CORE_COMMANDS);
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(binding),
      threadStore: ts,
      frontendBaseUrl: 'https://cafe.example.com',
      commandRegistry: registry,
    });
    const result = await layer.handle(CID, EXT, UID, '/focus clear');
    assert.equal(result.kind, 'focus');
    const thread = await ts.get(THREAD_ID);
    assert.equal(thread.preferredCats, undefined, 'preferredCats must be cleared');
  });

  it('/focus opus with registry — sets preferredCats', async () => {
    const ts = stubThreadStore({ id: THREAD_ID, title: 'Registry Test' });
    const registry = new CommandRegistry(CORE_COMMANDS);
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(binding),
      threadStore: ts,
      frontendBaseUrl: 'https://cafe.example.com',
      commandRegistry: registry,
    });
    const result = await layer.handle(CID, EXT, UID, '/focus opus');
    assert.equal(result.kind, 'focus');
    const thread = await ts.get(THREAD_ID);
    assert.deepStrictEqual(thread.preferredCats, ['opus']);
  });

  it('/ask opus hello with registry — returns forwardContent', async () => {
    const layer = makeLayerWithRegistry();
    const result = await layer.handle(CID, EXT, UID, '/ask opus hello');
    assert.equal(result.kind, 'ask');
    assert.equal(result.targetCatId, 'opus');
    assert.equal(result.forwardContent, 'hello');
  });

  it('/focus updatePreferredCats is awaited (P1-3)', async () => {
    let asyncCallCompleted = false;
    const ts = stubThreadStore({ id: THREAD_ID, title: 'Await Test' });
    const origUpdate = ts.updatePreferredCats.bind(ts);
    ts.updatePreferredCats = async (threadId, catIds) => {
      await new Promise((r) => setTimeout(r, 5));
      origUpdate(threadId, catIds);
      asyncCallCompleted = true;
    };
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore(binding),
      threadStore: ts,
      frontendBaseUrl: 'https://cafe.example.com',
    });
    await layer.handle(CID, EXT, UID, '/focus opus');
    assert.equal(asyncCallCompleted, true, 'updatePreferredCats must be awaited before returning');
  });
});

// ─── F154 Phase B: /status includes preferred cat info (AC-B3) ──────────────
describe('F154 Phase B: /status preferred cat visibility (AC-B3)', () => {
  let ConnectorCommandLayer;
  before(async () => {
    const mod = await import('../dist/infrastructure/connectors/ConnectorCommandLayer.js');
    ConnectorCommandLayer = mod.ConnectorCommandLayer;
  });

  it('/status shows preferred cat name when set', async () => {
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore({
        connectorId: 'feishu',
        externalChatId: 'chat1',
        threadId: 't-pref',
        userId: 'user1',
      }),
      threadStore: stubThreadStore({
        id: 't-pref',
        title: 'F154 测试',
        createdAt: Date.now(),
        preferredCats: ['opus'],
      }),
      frontendBaseUrl: 'https://cafe.example.com',
      catRoster: {
        opus: { displayName: 'opus', available: true },
        codex: { displayName: 'codex', available: true },
      },
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/status');
    assert.equal(result.kind, 'status');
    assert.ok(result.response.includes('首选猫'), '/status should show preferred cat section');
    assert.ok(result.response.includes('opus'), '/status should show the preferred cat name');
  });

  it('/status shows no preferred cat line when preferredCats is empty', async () => {
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore({
        connectorId: 'feishu',
        externalChatId: 'chat1',
        threadId: 't-nopref',
        userId: 'user1',
      }),
      threadStore: stubThreadStore({
        id: 't-nopref',
        title: '空偏好测试',
        createdAt: Date.now(),
        preferredCats: [],
      }),
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/status');
    assert.equal(result.kind, 'status');
    assert.ok(!result.response.includes('首选猫'), '/status should omit preferred cat line when empty');
  });

  it('/status shows no preferred cat line when preferredCats is undefined', async () => {
    const layer = new ConnectorCommandLayer({
      bindingStore: stubStore({
        connectorId: 'feishu',
        externalChatId: 'chat1',
        threadId: 't-undef',
        userId: 'user1',
      }),
      threadStore: stubThreadStore({
        id: 't-undef',
        title: '未设置',
        createdAt: Date.now(),
      }),
      frontendBaseUrl: 'https://cafe.example.com',
    });
    const result = await layer.handle('feishu', 'chat1', 'user1', '/status');
    assert.equal(result.kind, 'status');
    assert.ok(!result.response.includes('首选猫'), '/status should omit preferred cat line when undefined');
  });
});
