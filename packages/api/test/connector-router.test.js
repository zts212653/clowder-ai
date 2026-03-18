import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
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
      counter++;
      const thread = {
        id: `thread-${counter}`,
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

describe('ConnectorRouter', () => {
  let bindingStore;
  let dedup;
  let messageStore;
  let threadStore;
  let trigger;
  let socketManager;
  let router;

  beforeEach(() => {
    bindingStore = new MemoryConnectorThreadBindingStore();
    dedup = new InboundMessageDedup();
    messageStore = mockMessageStore();
    threadStore = mockThreadStore();
    trigger = mockTrigger();
    socketManager = mockSocketManager();

    router = new ConnectorRouter({
      bindingStore,
      dedup,
      messageStore,
      threadStore,
      invokeTrigger: trigger,
      socketManager,
      defaultUserId: 'owner-1',
      defaultCatId: 'opus',
      log: noopLog(),
    });
  });

  it('routes new message and creates thread + binding', async () => {
    const result = await router.route('feishu', 'chat-123', 'Hello cat!', 'msg-001');
    assert.equal(result.kind, 'routed');
    assert.ok(result.threadId);
    assert.ok(result.messageId);

    // Binding should exist
    const binding = bindingStore.getByExternal('feishu', 'chat-123');
    assert.ok(binding);
    assert.equal(binding.threadId, result.threadId);
  });

  it('reuses existing thread for same external chat', async () => {
    const r1 = await router.route('feishu', 'chat-123', 'msg 1', 'ext-1');
    const r2 = await router.route('feishu', 'chat-123', 'msg 2', 'ext-2');
    assert.equal(r1.threadId, r2.threadId);
  });

  it('posts message to message store with ConnectorSource', async () => {
    await router.route('feishu', 'chat-123', 'Hello', 'ext-1');
    assert.equal(messageStore.messages.length, 1);
    assert.equal(messageStore.messages[0].source.connector, 'feishu');
    assert.equal(messageStore.messages[0].source.label, '飞书');
  });

  it('triggers cat invocation', async () => {
    await router.route('feishu', 'chat-123', 'Hello', 'ext-1');
    assert.equal(trigger.calls.length, 1);
    assert.equal(trigger.calls[0].catId, 'opus');
    assert.ok(trigger.calls[0].threadId);
  });

  it('skips duplicate messages', async () => {
    const r1 = await router.route('feishu', 'chat-123', 'Hello', 'ext-1');
    const r2 = await router.route('feishu', 'chat-123', 'Hello', 'ext-1');
    assert.equal(r1.kind, 'routed');
    assert.equal(r2.kind, 'skipped');
    assert.equal(messageStore.messages.length, 1);
  });

  it('broadcasts connector message to websocket', async () => {
    await router.route('feishu', 'chat-123', 'Hello', 'ext-1');
    assert.ok(socketManager.broadcasts.length > 0);
    assert.equal(socketManager.broadcasts[0].event, 'connector_message');
  });

  describe('command interception', () => {
    let commandRouter;
    let adapterSendCalls;
    let cmdTrigger;

    function mockCommandLayer(responses) {
      return {
        async handle(_connectorId, _externalChatId, _userId, text) {
          const trimmed = text.trim();
          const cmd = trimmed.split(/\s+/)[0].toLowerCase();
          return responses[cmd] ?? { kind: 'not-command' };
        },
      };
    }

    function mockAdapter() {
      adapterSendCalls = [];
      return {
        async sendReply(externalChatId, content) {
          adapterSendCalls.push({ externalChatId, content });
        },
      };
    }

    beforeEach(() => {
      cmdTrigger = mockTrigger();
      const adaptersMap = new Map();
      adaptersMap.set('feishu', mockAdapter());

      commandRouter = new ConnectorRouter({
        bindingStore,
        dedup,
        messageStore,
        threadStore,
        invokeTrigger: cmdTrigger,
        socketManager,
        defaultUserId: 'owner-1',
        defaultCatId: 'opus',
        log: noopLog(),
        commandLayer: mockCommandLayer({
          '/where': { kind: 'where', response: 'You are here' },
          '/new': { kind: 'new', response: 'Thread created', newActiveThreadId: 'thread-99' },
        }),
        adapters: adaptersMap,
      });
    });

    it('routes /where command without triggering invocation', async () => {
      const result = await commandRouter.route('feishu', 'chat-123', '/where', 'ext-cmd-1');
      assert.equal(result.kind, 'command');
      // Adapter should have received the response
      assert.equal(adapterSendCalls.length, 1);
      assert.equal(adapterSendCalls[0].externalChatId, 'chat-123');
      assert.equal(adapterSendCalls[0].content, 'You are here');
      // invokeTrigger should NOT have been called
      assert.equal(cmdTrigger.calls.length, 0);
      // Message should NOT be stored
      assert.equal(messageStore.messages.length, 0);
    });

    it('routes unknown /command as normal message', async () => {
      const result = await commandRouter.route('feishu', 'chat-123', '/unknown foo', 'ext-cmd-2');
      assert.equal(result.kind, 'routed');
      // invokeTrigger should have been called (normal routing)
      assert.equal(cmdTrigger.calls.length, 1);
      // No command response sent
      assert.equal(adapterSendCalls.length, 0);
    });

    it('handles /new command and sends response', async () => {
      const result = await commandRouter.route('feishu', 'chat-123', '/new My Topic', 'ext-cmd-3');
      assert.equal(result.kind, 'command');
      assert.equal(adapterSendCalls.length, 1);
      assert.ok(adapterSendCalls[0].content.includes('Thread created'));
      assert.equal(cmdTrigger.calls.length, 0);
    });

    it('uses sendFormattedReply (MessageEnvelope) when adapter supports it', async () => {
      // Replace adapter with one that has sendFormattedReply
      const envelopeCalls = [];
      const formattedAdapter = {
        async sendReply() {
          throw new Error('should not be called');
        },
        async sendFormattedReply(externalChatId, envelope) {
          envelopeCalls.push({ externalChatId, envelope });
        },
      };
      const adaptersMap = new Map();
      adaptersMap.set('feishu', formattedAdapter);
      const router2 = new ConnectorRouter({
        bindingStore,
        dedup: new InboundMessageDedup(),
        messageStore,
        threadStore,
        invokeTrigger: cmdTrigger,
        socketManager,
        defaultUserId: 'owner-1',
        defaultCatId: 'opus',
        log: noopLog(),
        commandLayer: mockCommandLayer({
          '/where': { kind: 'where', response: 'You are here' },
        }),
        adapters: adaptersMap,
      });

      const result = await router2.route('feishu', 'chat-123', '/where', 'ext-fmt-1');
      assert.equal(result.kind, 'command');
      assert.equal(envelopeCalls.length, 1);
      assert.equal(envelopeCalls[0].envelope.header, '⚙️ Cat Café');
      assert.equal(envelopeCalls[0].envelope.body, 'You are here');
      assert.ok(envelopeCalls[0].envelope.footer); // has timestamp
    });

    it('falls back to sendReply when adapter lacks sendFormattedReply', async () => {
      // Default mockAdapter has no sendFormattedReply
      const result = await commandRouter.route('feishu', 'chat-123', '/where', 'ext-fb-1');
      assert.equal(result.kind, 'command');
      assert.equal(adapterSendCalls.length, 1);
      assert.equal(adapterSendCalls[0].content, 'You are here');
    });

    it('still dedup-checks before command handling', async () => {
      await commandRouter.route('feishu', 'chat-123', '/where', 'ext-dup');
      const r2 = await commandRouter.route('feishu', 'chat-123', '/where', 'ext-dup');
      assert.equal(r2.kind, 'skipped');
      assert.equal(r2.reason, 'duplicate');
    });

    it('stores command exchange in messageStore when contextThreadId present (Phase C)', async () => {
      const ctxRouter = new ConnectorRouter({
        bindingStore,
        dedup: new InboundMessageDedup(),
        messageStore,
        threadStore,
        invokeTrigger: cmdTrigger,
        socketManager,
        defaultUserId: 'owner-1',
        defaultCatId: 'opus',
        log: noopLog(),
        commandLayer: mockCommandLayer({
          '/where': { kind: 'where', response: 'Thread info here', contextThreadId: 'thread-ctx-1' },
        }),
        adapters: new Map([['feishu', mockAdapter()]]),
      });
      const result = await ctxRouter.route('feishu', 'chat-123', '/where', 'ext-ctx-1');
      assert.equal(result.kind, 'command');
      assert.equal(result.threadId, 'thread-ctx-1');
      assert.ok(result.messageId);
      // Two messages stored: inbound command + outbound response
      assert.equal(messageStore.messages.length, 2);
      assert.equal(messageStore.messages[0].content, '/where');
      assert.equal(messageStore.messages[0].source.connector, 'feishu');
      assert.equal(messageStore.messages[1].content, 'Thread info here');
      assert.equal(messageStore.messages[1].source.connector, 'system-command');
    });

    it('broadcasts command exchange to WebSocket (Phase C)', async () => {
      const ctxSocket = mockSocketManager();
      const ctxRouter = new ConnectorRouter({
        bindingStore,
        dedup: new InboundMessageDedup(),
        messageStore,
        threadStore,
        invokeTrigger: cmdTrigger,
        socketManager: ctxSocket,
        defaultUserId: 'owner-1',
        defaultCatId: 'opus',
        log: noopLog(),
        commandLayer: mockCommandLayer({
          '/new': { kind: 'new', response: 'Created!', newActiveThreadId: 'thread-new', contextThreadId: 'thread-new' },
        }),
        adapters: new Map([['feishu', mockAdapter()]]),
      });
      await ctxRouter.route('feishu', 'chat-123', '/new Test', 'ext-ctx-2');
      // Two broadcasts: inbound command + outbound response
      assert.equal(ctxSocket.broadcasts.length, 2);
      assert.equal(ctxSocket.broadcasts[0].room, 'thread:thread-new');
      assert.equal(ctxSocket.broadcasts[0].data.connectorId, 'feishu');
      assert.equal(ctxSocket.broadcasts[1].room, 'thread:thread-new');
      assert.equal(ctxSocket.broadcasts[1].data.connectorId, 'system-command');
    });

    it('/thread command forwards message to target thread and triggers invocation', async () => {
      const fwdTrigger = mockTrigger();
      const fwdSocket = mockSocketManager();
      const fwdStore = mockMessageStore();
      const fwdRouter = new ConnectorRouter({
        bindingStore,
        dedup: new InboundMessageDedup(),
        messageStore: fwdStore,
        threadStore,
        invokeTrigger: fwdTrigger,
        socketManager: fwdSocket,
        defaultUserId: 'owner-1',
        defaultCatId: 'opus',
        log: noopLog(),
        commandLayer: mockCommandLayer({
          '/thread': {
            kind: 'thread',
            response: '📨 已路由到 目标Thread',
            newActiveThreadId: 'thread-target-1',
            contextThreadId: 'thread-target-1',
            forwardContent: 'hi there',
          },
        }),
        adapters: new Map([['feishu', mockAdapter()]]),
      });
      const result = await fwdRouter.route('feishu', 'chat-123', '/thread thread-target-1 hi there', 'ext-fwd-1');
      assert.equal(result.kind, 'routed');
      assert.equal(result.threadId, 'thread-target-1');
      // Forward content should be stored (not the /thread command)
      const fwdMsg = fwdStore.messages.find((m) => m.content === 'hi there');
      assert.ok(fwdMsg, 'forwarded message should be stored');
      assert.equal(fwdMsg.threadId, 'thread-target-1');
      // Cat invocation should be triggered for the target thread
      assert.equal(fwdTrigger.calls.length, 1);
      assert.equal(fwdTrigger.calls[0].threadId, 'thread-target-1');
      assert.equal(fwdTrigger.calls[0].message, 'hi there');
    });

    it('/thread command sends confirmation response to adapter', async () => {
      const fwdRouter = new ConnectorRouter({
        bindingStore,
        dedup: new InboundMessageDedup(),
        messageStore,
        threadStore,
        invokeTrigger: mockTrigger(),
        socketManager,
        defaultUserId: 'owner-1',
        defaultCatId: 'opus',
        log: noopLog(),
        commandLayer: mockCommandLayer({
          '/thread': {
            kind: 'thread',
            response: '📨 已路由',
            newActiveThreadId: 'thread-t1',
            contextThreadId: 'thread-t1',
            forwardContent: 'hello',
          },
        }),
        adapters: new Map([['feishu', mockAdapter()]]),
      });
      await fwdRouter.route('feishu', 'chat-123', '/thread thread-t1 hello', 'ext-fwd-2');
      // Adapter should receive confirmation
      assert.equal(adapterSendCalls.length, 1);
      assert.ok(adapterSendCalls[0].content.includes('已路由'));
    });

    it('skips messageStore when contextThreadId absent (Phase C)', async () => {
      // /where without binding → no contextThreadId → no messages stored
      const ctxRouter = new ConnectorRouter({
        bindingStore,
        dedup: new InboundMessageDedup(),
        messageStore,
        threadStore,
        invokeTrigger: cmdTrigger,
        socketManager,
        defaultUserId: 'owner-1',
        defaultCatId: 'opus',
        log: noopLog(),
        commandLayer: mockCommandLayer({
          '/where': { kind: 'where', response: 'No binding' },
        }),
        adapters: new Map([['feishu', mockAdapter()]]),
      });
      const result = await ctxRouter.route('feishu', 'chat-123', '/where', 'ext-ctx-3');
      assert.equal(result.kind, 'command');
      assert.equal(result.threadId, undefined);
      assert.equal(messageStore.messages.length, 0);
    });
  });
});
