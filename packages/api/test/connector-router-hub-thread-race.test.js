import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConnectorRouter } from '../dist/infrastructure/connectors/ConnectorRouter.js';
import { MemoryConnectorThreadBindingStore } from '../dist/infrastructure/connectors/ConnectorThreadBindingStore.js';
import { InboundMessageDedup } from '../dist/infrastructure/connectors/InboundMessageDedup.js';

function noopLog() {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => noopLog(),
  };
}

function mockMessageStore() {
  const messages = [];
  return {
    messages,
    async append(input) {
      const msg = { id: `msg-${messages.length + 1}`, ...input };
      messages.push(msg);
      return msg;
    },
  };
}

function mockThreadStore() {
  let counter = 0;
  const threads = new Map();
  return {
    threads,
    create(userId, title) {
      const thread = {
        id: `thread-${++counter}`,
        createdBy: userId,
        title,
        participants: [],
        lastActiveAt: Date.now(),
        createdAt: Date.now(),
        projectPath: 'default',
      };
      threads.set(thread.id, thread);
      return thread;
    },
    updateConnectorHubState(threadId, state) {
      const thread = threads.get(threadId);
      if (!thread) return;
      if (state === null) {
        delete thread.connectorHubState;
      } else {
        thread.connectorHubState = state;
      }
    },
  };
}

function mockTrigger() {
  const calls = [];
  return {
    calls,
    trigger(threadId, catId, userId, message, messageId, policy) {
      calls.push({ threadId, catId, userId, message, messageId, policy });
    },
  };
}

function mockSocketManager() {
  const broadcasts = [];
  return {
    broadcasts,
    broadcastToRoom(room, event, data) {
      broadcasts.push({ room, event, data });
    },
  };
}

function mockCommandLayer(responses) {
  return {
    async handle(_connectorId, _externalChatId, _userId, text) {
      const cmd = text.trim().split(/\s+/)[0].toLowerCase();
      return responses[cmd] ?? { kind: 'not-command' };
    },
  };
}

function mockAdapter() {
  return {
    async sendReply() {},
  };
}

describe('ConnectorRouter Hub thread race protection', () => {
  it('serializes concurrent Hub thread creation for the same connector chat', async () => {
    const bindingStore = new MemoryConnectorThreadBindingStore();
    bindingStore.bind('feishu', 'chat-race', 'thread-conv-race', 'owner-1');

    let createCalls = 0;
    let releaseCreate;
    let firstCreateEnteredResolve;
    const firstCreateEntered = new Promise((resolve) => {
      firstCreateEnteredResolve = resolve;
    });
    const createBarrier = new Promise((resolve) => {
      releaseCreate = resolve;
    });

    const baseThreadStore = mockThreadStore();
    const racingThreadStore = {
      ...baseThreadStore,
      async create(userId, title) {
        createCalls += 1;
        firstCreateEnteredResolve();
        await createBarrier;
        return baseThreadStore.create(userId, title);
      },
    };

    const router = new ConnectorRouter({
      bindingStore,
      dedup: new InboundMessageDedup(),
      messageStore: mockMessageStore(),
      threadStore: racingThreadStore,
      invokeTrigger: mockTrigger(),
      socketManager: mockSocketManager(),
      defaultUserId: 'owner-1',
      defaultCatId: 'opus',
      log: noopLog(),
      commandLayer: mockCommandLayer({
        '/where': { kind: 'where', response: 'Info' },
        '/threads': { kind: 'threads', response: 'List' },
      }),
      adapters: new Map([['feishu', mockAdapter()]]),
    });

    const first = router.route('feishu', 'chat-race', '/where', 'ext-race-1');
    await firstCreateEntered;

    const second = router.route('feishu', 'chat-race', '/threads', 'ext-race-2');
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(createCalls, 1, 'second command should wait on the in-flight Hub thread creation');

    releaseCreate();
    const [r1, r2] = await Promise.all([first, second]);

    assert.equal(r1.kind, 'command');
    assert.equal(r2.kind, 'command');
    assert.equal(r1.threadId, r2.threadId);
    assert.equal(createCalls, 1);
    assert.equal(bindingStore.getByExternal('feishu', 'chat-race')?.hubThreadId, r1.threadId);
  });

  it('does not reuse a no-binding hub lookup once a concurrent command creates the binding', async () => {
    const baseBindingStore = new MemoryConnectorThreadBindingStore();

    let releaseFirstLookup;
    let firstLookupEnteredResolve;
    const firstLookupEntered = new Promise((resolve) => {
      firstLookupEnteredResolve = resolve;
    });
    const firstLookupBarrier = new Promise((resolve) => {
      releaseFirstLookup = resolve;
    });

    let lookupCount = 0;
    const bindingStore = {
      bind(...args) {
        return baseBindingStore.bind(...args);
      },
      async getByExternal(connectorId, externalChatId) {
        lookupCount += 1;
        if (lookupCount === 1) {
          firstLookupEnteredResolve();
          await firstLookupBarrier;
          return null;
        }
        return baseBindingStore.getByExternal(connectorId, externalChatId);
      },
      getByThread(...args) {
        return baseBindingStore.getByThread(...args);
      },
      remove(...args) {
        return baseBindingStore.remove(...args);
      },
      listByUser(...args) {
        return baseBindingStore.listByUser(...args);
      },
      setHubThread(...args) {
        return baseBindingStore.setHubThread(...args);
      },
    };

    const threadStore = mockThreadStore();
    const router = new ConnectorRouter({
      bindingStore,
      dedup: new InboundMessageDedup(),
      messageStore: mockMessageStore(),
      threadStore,
      invokeTrigger: mockTrigger(),
      socketManager: mockSocketManager(),
      defaultUserId: 'owner-1',
      defaultCatId: 'opus',
      log: noopLog(),
      commandLayer: {
        async handle(connectorId, externalChatId, userId, text) {
          const cmd = text.trim().split(/\s+/)[0].toLowerCase();
          if (cmd === '/where') {
            return { kind: 'where', response: 'Info' };
          }
          if (cmd === '/new') {
            baseBindingStore.bind(connectorId, externalChatId, 'thread-conv-new', userId);
            return { kind: 'new', response: 'Created', newActiveThreadId: 'thread-conv-new' };
          }
          return { kind: 'not-command' };
        },
      },
      adapters: new Map([['feishu', mockAdapter()]]),
    });

    const first = router.route('feishu', 'chat-1', '/where', 'm1');
    await firstLookupEntered;

    const second = router.route('feishu', 'chat-1', '/new demo', 'm2');
    await new Promise((resolve) => setImmediate(resolve));

    releaseFirstLookup();
    const [, secondResult] = await Promise.all([first, second]);

    assert.equal(secondResult.kind, 'command');
    assert.ok(secondResult.threadId, 'the /new command should still create and reuse one Hub thread');
    assert.equal(baseBindingStore.getByExternal('feishu', 'chat-1')?.hubThreadId, secondResult.threadId);
  });

  it('does not create a second Hub thread from a stale binding snapshot after the first creation finishes', async () => {
    const baseBindingStore = new MemoryConnectorThreadBindingStore();
    baseBindingStore.bind('feishu', 'chat-stale', 'thread-conv-stale', 'owner-1');

    let lookupCount = 0;
    let releaseFirstLookup;
    let firstLookupEnteredResolve;
    let secondLookupCapturedResolve;
    const firstLookupEntered = new Promise((resolve) => {
      firstLookupEnteredResolve = resolve;
    });
    const secondLookupCaptured = new Promise((resolve) => {
      secondLookupCapturedResolve = resolve;
    });
    const firstLookupBarrier = new Promise((resolve) => {
      releaseFirstLookup = resolve;
    });
    let firstRouteCompletedResolve;
    const firstRouteCompleted = new Promise((resolve) => {
      firstRouteCompletedResolve = resolve;
    });
    const bindingStore = {
      bind(...args) {
        return baseBindingStore.bind(...args);
      },
      async getByExternal(connectorId, externalChatId) {
        lookupCount += 1;
        if (lookupCount === 1) {
          firstLookupEnteredResolve();
          await firstLookupBarrier;
          return baseBindingStore.getByExternal(connectorId, externalChatId);
        }
        if (lookupCount === 2) {
          const stale = baseBindingStore.getByExternal(connectorId, externalChatId);
          secondLookupCapturedResolve();
          await firstRouteCompleted;
          return stale ? { ...stale } : stale;
        }
        return baseBindingStore.getByExternal(connectorId, externalChatId);
      },
      getByThread(...args) {
        return baseBindingStore.getByThread(...args);
      },
      remove(...args) {
        return baseBindingStore.remove(...args);
      },
      listByUser(...args) {
        return baseBindingStore.listByUser(...args);
      },
      setHubThread(...args) {
        return baseBindingStore.setHubThread(...args);
      },
    };

    let createCalls = 0;
    const baseThreadStore = mockThreadStore();
    const threadStore = {
      ...baseThreadStore,
      async create(userId, title) {
        createCalls += 1;
        return baseThreadStore.create(userId, title);
      },
    };

    const router = new ConnectorRouter({
      bindingStore,
      dedup: new InboundMessageDedup(),
      messageStore: mockMessageStore(),
      threadStore,
      invokeTrigger: mockTrigger(),
      socketManager: mockSocketManager(),
      defaultUserId: 'owner-1',
      defaultCatId: 'opus',
      log: noopLog(),
      commandLayer: mockCommandLayer({
        '/where': { kind: 'where', response: 'Info' },
        '/threads': { kind: 'threads', response: 'List' },
      }),
      adapters: new Map([['feishu', mockAdapter()]]),
    });

    const first = router.route('feishu', 'chat-stale', '/where', 'stale-1');
    await firstLookupEntered;

    const second = router.route('feishu', 'chat-stale', '/threads', 'stale-2');
    await secondLookupCaptured;

    releaseFirstLookup();
    const firstResult = await first;
    firstRouteCompletedResolve();
    const secondResult = await second;

    assert.equal(firstResult.kind, 'command');
    assert.equal(secondResult.kind, 'command');
    assert.equal(createCalls, 1, 'stale binding snapshots must not create a second Hub thread');
    assert.equal(firstResult.threadId, secondResult.threadId);
    assert.equal(baseBindingStore.getByExternal('feishu', 'chat-stale')?.hubThreadId, firstResult.threadId);
  });
});
