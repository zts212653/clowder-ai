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
    assert.ok(result.response.includes('cafe.example.com'));
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
    assert.ok(result.response.includes('cafe.example.com'));
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
});
