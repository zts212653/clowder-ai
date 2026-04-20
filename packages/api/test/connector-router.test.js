import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
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
  const participantActivity = new Map();
  return {
    threads,
    participantActivity,
    create(userId, title, projectPath) {
      counter++;
      const thread = {
        id: `thread-${counter}`,
        createdBy: userId,
        title,
        participants: [],
        lastActiveAt: Date.now(),
        createdAt: Date.now(),
        projectPath: projectPath ?? 'default',
      };
      threads.set(thread.id, thread);
      return thread;
    },
    async get(threadId) {
      return threads.get(threadId) ?? null;
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
    async getParticipantsWithActivity(threadId) {
      return participantActivity.get(threadId) ?? [];
    },
    updateProjectPath(threadId, projectPath) {
      const thread = threads.get(threadId);
      if (thread) thread.projectPath = projectPath;
    },
  };
}

function mockTrigger(outcome = 'dispatched') {
  const calls = [];
  return {
    calls,
    trigger(threadId, catId, userId, message, messageId, policy) {
      calls.push({ threadId, catId, userId, message, messageId, policy });
      return outcome;
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

function ensureMentionRegistry() {
  if (!catRegistry.tryGet('opus')) {
    catRegistry.register('opus', {
      id: 'opus',
      name: 'opus',
      displayName: '布偶猫',
      avatar: '/avatars/opus.png',
      color: { primary: '#000', secondary: '#fff' },
      mentionPatterns: ['@opus', '@布偶猫', '@布偶', '@宪宪'],
      provider: 'anthropic',
      defaultModel: 'test-model',
      mcpSupport: false,
      roleDescription: 'test role',
      personality: 'test personality',
    });
  }
  if (!catRegistry.tryGet('codex')) {
    catRegistry.register('codex', {
      id: 'codex',
      name: 'codex',
      displayName: '缅因猫',
      avatar: '/avatars/codex.png',
      color: { primary: '#111', secondary: '#eee' },
      mentionPatterns: ['@codex', '@缅因猫', '@缅因', '@砚砚'],
      provider: 'openai',
      defaultModel: 'test-model',
      mcpSupport: false,
      roleDescription: 'test role',
      personality: 'test personality',
    });
  }
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
    ensureMentionRegistry();
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

  it('ISSUE-16: lazy-heals projectPath on existing thread with default', async () => {
    // Simulate a legacy thread created before the fix (projectPath='default')
    const legacyThread = threadStore.create('owner-1', 'Legacy IM');
    assert.equal(legacyThread.projectPath, 'default');
    bindingStore.bind('feishu', 'chat-legacy', legacyThread.id, 'owner-1');

    // Route a message through the existing binding
    const result = await router.route('feishu', 'chat-legacy', 'hello', 'ext-heal-1');
    assert.equal(result.kind, 'routed');
    assert.equal(result.threadId, legacyThread.id);

    // projectPath should have been healed
    const healed = threadStore.threads.get(legacyThread.id);
    assert.notEqual(healed.projectPath, 'default', 'projectPath should be lazy-healed from "default"');
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

  it('routes to last-active cat when no @mention is present', async () => {
    const thread = threadStore.create('owner-1', 'existing');
    bindingStore.bind('feishu', 'chat-last-active', thread.id, 'owner-1');
    threadStore.participantActivity.set(thread.id, [
      { catId: 'codex', lastMessageAt: Date.now() - 100, messageCount: 2 },
      { catId: 'opus', lastMessageAt: Date.now() - 1000, messageCount: 10 },
    ]);

    await router.route('feishu', 'chat-last-active', '继续', 'ext-last-active-1');

    assert.equal(trigger.calls.length, 1);
    assert.equal(trigger.calls[0].catId, 'codex');
    assert.deepEqual(messageStore.messages[0].mentions, ['codex']);
  });

  it('keeps explicit @mention priority over last-active cat', async () => {
    const thread = threadStore.create('owner-1', 'existing');
    bindingStore.bind('feishu', 'chat-mention-priority', thread.id, 'owner-1');
    threadStore.participantActivity.set(thread.id, [{ catId: 'codex', lastMessageAt: Date.now(), messageCount: 5 }]);

    await router.route('feishu', 'chat-mention-priority', '@opus 请看', 'ext-mention-priority-1');

    assert.equal(trigger.calls.length, 1);
    assert.equal(trigger.calls[0].catId, 'opus');
    assert.deepEqual(messageStore.messages[0].mentions, ['opus']);
  });

  it('falls back to default cat when no @mention and no participant activity', async () => {
    const thread = threadStore.create('owner-1', 'existing');
    bindingStore.bind('feishu', 'chat-default-fallback', thread.id, 'owner-1');
    threadStore.participantActivity.set(thread.id, []);

    await router.route('feishu', 'chat-default-fallback', '没人被@', 'ext-default-fallback-1');

    assert.equal(trigger.calls.length, 1);
    assert.equal(trigger.calls[0].catId, 'opus');
    assert.deepEqual(messageStore.messages[0].mentions, ['opus']);
  });

  it('skips duplicate messages', async () => {
    const r1 = await router.route('feishu', 'chat-123', 'Hello', 'ext-1');
    const r2 = await router.route('feishu', 'chat-123', 'Hello', 'ext-1');
    assert.equal(r1.kind, 'routed');
    assert.equal(r2.kind, 'skipped');
    assert.equal(messageStore.messages.length, 1);
  });

  it('ISSUE-16: new thread gets monorepo root as projectPath (not default)', async () => {
    const result = await router.route('feishu', 'chat-new-pp', 'Hello', 'ext-pp-1');
    assert.equal(result.kind, 'routed');
    const thread = threadStore.threads.get(result.threadId);
    assert.ok(thread, 'thread should exist');
    assert.notEqual(
      thread.projectPath,
      'default',
      'projectPath must not be "default" — cat cwd would fall back to packages/api',
    );
    assert.ok(thread.projectPath.length > 1, 'projectPath should be a real filesystem path');
  });

  it('broadcasts connector message to websocket', async () => {
    await router.route('feishu', 'chat-123', 'Hello', 'ext-1');
    assert.ok(socketManager.broadcasts.length > 0);
    assert.equal(socketManager.broadcasts[0].event, 'connector_message');
  });

  it('emits nested message protocol (threadId + message.{id,type,content,source,timestamp})', async () => {
    await router.route('feishu', 'chat-123', 'Hi from IM', 'ext-proto-1');
    const bc = socketManager.broadcasts.find((b) => b.event === 'connector_message');
    assert.ok(bc, 'should have a connector_message broadcast');
    const { data } = bc;
    // Must have nested message — frontend guard: if (!data?.message?.id) return;
    assert.ok(data.threadId, 'data.threadId must exist');
    assert.ok(data.message, 'data.message must exist (nested protocol)');
    assert.ok(data.message.id, 'data.message.id must exist');
    assert.equal(data.message.type, 'connector');
    assert.equal(data.message.content, 'Hi from IM');
    assert.ok(data.message.source, 'data.message.source must exist');
    assert.equal(data.message.source.connector, 'feishu');
    assert.equal(typeof data.message.timestamp, 'number');
    // Must NOT have flat legacy fields
    assert.equal(data.messageId, undefined, 'legacy messageId must not exist');
    assert.equal(data.connectorId, undefined, 'legacy connectorId must not exist');
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

    let batchDoneCalls;
    function mockAdapter() {
      adapterSendCalls = [];
      batchDoneCalls = [];
      return {
        async sendReply(externalChatId, content) {
          adapterSendCalls.push({ externalChatId, content });
        },
        async onDeliveryBatchDone(externalChatId, chainDone) {
          batchDoneCalls.push({ externalChatId, chainDone });
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
      // F151: close frame must be sent after command response
      assert.equal(batchDoneCalls.length, 1);
      assert.equal(batchDoneCalls[0].externalChatId, 'chat-123');
      assert.equal(batchDoneCalls[0].chainDone, true);
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

    it('command exchange broadcasts nested protocol (not legacy flat fields)', async () => {
      // Pre-route a normal message so a binding + hub thread exist for chat-cmd-proto
      await commandRouter.route('feishu', 'chat-cmd-proto', 'setup', 'ext-cmd-setup');
      socketManager.broadcasts.length = 0; // clear setup broadcasts

      await commandRouter.route('feishu', 'chat-cmd-proto', '/where', 'ext-cmd-proto-1');
      const cmdBroadcasts = socketManager.broadcasts.filter((b) => b.event === 'connector_message');
      assert.equal(cmdBroadcasts.length, 2, 'should emit command + response');

      // Command message
      const cmd = cmdBroadcasts[0].data;
      assert.ok(cmd.message, 'command broadcast must use nested protocol');
      assert.ok(cmd.message.id, 'command message.id');
      assert.equal(cmd.message.type, 'connector');
      assert.equal(cmd.message.content, '/where');
      assert.equal(cmd.message.source.connector, 'feishu');
      assert.equal(typeof cmd.message.timestamp, 'number');
      assert.equal(cmd.messageId, undefined, 'no legacy messageId');

      // Response message
      const res = cmdBroadcasts[1].data;
      assert.ok(res.message, 'response broadcast must use nested protocol');
      assert.ok(res.message.id, 'response message.id');
      assert.equal(res.message.type, 'connector');
      assert.equal(res.message.content, 'You are here');
      assert.equal(res.message.source.connector, 'system-command');
      assert.ok(res.message.timestamp >= cmd.message.timestamp, 'response timestamp >= command');
      assert.equal(res.messageId, undefined, 'no legacy messageId');
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
      assert.equal(envelopeCalls[0].envelope.header, 'Clowder AI');
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

    it('stores command exchange in Hub thread (ISSUE-8 8A)', async () => {
      // Pre-create a binding so resolveHubThread can find it
      bindingStore.bind('feishu', 'chat-hub-1', 'thread-conv-1', 'owner-1');
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
          '/where': { kind: 'where', response: 'Thread info here' },
        }),
        adapters: new Map([['feishu', mockAdapter()]]),
      });
      const result = await ctxRouter.route('feishu', 'chat-hub-1', '/where', 'ext-ctx-1');
      assert.equal(result.kind, 'command');
      // Hub thread should be lazily created (not the conversation thread)
      assert.ok(result.threadId);
      assert.notEqual(result.threadId, 'thread-conv-1', 'should NOT store in conversation thread');
      assert.ok(result.messageId);
      // Two messages stored: inbound command + outbound response
      assert.equal(messageStore.messages.length, 2);
      assert.equal(messageStore.messages[0].content, '/where');
      assert.equal(messageStore.messages[0].source.connector, 'feishu');
      assert.equal(messageStore.messages[1].content, 'Thread info here');
      assert.equal(messageStore.messages[1].source.connector, 'system-command');
      // Hub thread should be persisted in binding
      const binding = bindingStore.getByExternal('feishu', 'chat-hub-1');
      assert.equal(binding.hubThreadId, result.threadId);
    });

    it('broadcasts command exchange to Hub thread WebSocket (ISSUE-8 8A)', async () => {
      bindingStore.bind('feishu', 'chat-hub-bc', 'thread-conv-bc', 'owner-1');
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
          '/new': { kind: 'new', response: 'Created!', newActiveThreadId: 'thread-new' },
        }),
        adapters: new Map([['feishu', mockAdapter()]]),
      });
      const result = await ctxRouter.route('feishu', 'chat-hub-bc', '/new Test', 'ext-ctx-2');
      const hubThreadId = result.threadId;
      assert.ok(hubThreadId);
      assert.notEqual(hubThreadId, 'thread-conv-bc');
      assert.equal(ctxSocket.broadcasts.length, 2);
      assert.equal(ctxSocket.broadcasts[0].room, `thread:${hubThreadId}`);
      assert.equal(ctxSocket.broadcasts[0].data.message.source.connector, 'feishu');
      assert.equal(ctxSocket.broadcasts[1].room, `thread:${hubThreadId}`);
      assert.equal(ctxSocket.broadcasts[1].data.message.source.connector, 'system-command');
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
      // F151: forward path must NOT close the A2A task (delivery pipeline will)
      assert.equal(batchDoneCalls.length, 0, 'forward path should not call onDeliveryBatchDone');
    });

    it('/thread forward closes task when target queue is full', async () => {
      const fullTrigger = mockTrigger('full');
      const fullSocket = mockSocketManager();
      const fullStore = mockMessageStore();
      const fullRouter = new ConnectorRouter({
        bindingStore,
        dedup: new InboundMessageDedup(),
        messageStore: fullStore,
        threadStore,
        invokeTrigger: fullTrigger,
        socketManager: fullSocket,
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
      const result = await fullRouter.route('feishu', 'chat-full', '/thread thread-target-1 hi there', 'ext-full-1');
      assert.equal(result.kind, 'routed');
      // When queue is full, router must close the task since no invocation will run
      assert.equal(batchDoneCalls.length, 1, 'queue-full forward must close the A2A task');
      assert.equal(batchDoneCalls[0].chainDone, true);
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

    it('skips message storage when no binding exists (ISSUE-8 8A)', async () => {
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
      const result = await ctxRouter.route('feishu', 'chat-no-bind', '/where', 'ext-ctx-3');
      assert.equal(result.kind, 'command');
      assert.equal(result.threadId, undefined);
      assert.equal(messageStore.messages.length, 0);
    });

    it('Hub thread is lazily created once and reused (ISSUE-8 8A)', async () => {
      bindingStore.bind('feishu', 'chat-reuse', 'thread-conv-reuse', 'owner-1');
      const hubRouter = new ConnectorRouter({
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
          '/where': { kind: 'where', response: 'Info' },
          '/threads': { kind: 'threads', response: 'List' },
        }),
        adapters: new Map([['feishu', mockAdapter()]]),
      });

      const r1 = await hubRouter.route('feishu', 'chat-reuse', '/where', 'ext-reuse-1');
      assert.ok(r1.threadId);
      const hubThreadId = r1.threadId;
      assert.notEqual(hubThreadId, 'thread-conv-reuse');

      const r2 = await hubRouter.route('feishu', 'chat-reuse', '/threads', 'ext-reuse-2');
      assert.equal(r2.threadId, hubThreadId, 'second command should reuse same Hub thread');

      const binding = bindingStore.getByExternal('feishu', 'chat-reuse');
      assert.equal(binding.hubThreadId, hubThreadId);
    });

    it('ISSUE-16: Hub thread gets monorepo root as projectPath', async () => {
      bindingStore.bind('feishu', 'chat-hub-pp', 'thread-conv-pp', 'owner-1');
      const hubRouter = new ConnectorRouter({
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
          '/where': { kind: 'where', response: 'info' },
        }),
        adapters: new Map([['feishu', mockAdapter()]]),
      });
      const result = await hubRouter.route('feishu', 'chat-hub-pp', '/where', 'ext-hub-pp-1');
      const hubThread = threadStore.threads.get(result.threadId);
      assert.ok(hubThread);
      assert.notEqual(hubThread.projectPath, 'default', 'Hub thread projectPath must not be "default"');
    });

    it('Hub thread title includes connector display name (ISSUE-8 8A)', async () => {
      bindingStore.bind('feishu', 'chat-title', 'thread-conv-title', 'owner-1');
      const titleRouter = new ConnectorRouter({
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
          '/where': { kind: 'where', response: 'info' },
        }),
        adapters: new Map([['feishu', mockAdapter()]]),
      });

      const result = await titleRouter.route('feishu', 'chat-title', '/where', 'ext-title-1');
      const hubThread = threadStore.threads.get(result.threadId);
      assert.ok(hubThread);
      assert.ok(hubThread.title.includes('IM Hub'), `expected "IM Hub" in title, got: ${hubThread.title}`);
    });

    it('Hub thread has connectorHubState after creation (F088 Phase G)', async () => {
      bindingStore.bind('feishu', 'chat-state', 'thread-conv-state', 'owner-1');
      const stateRouter = new ConnectorRouter({
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
          '/where': { kind: 'where', response: 'info' },
        }),
        adapters: new Map([['feishu', mockAdapter()]]),
      });

      const result = await stateRouter.route('feishu', 'chat-state', '/where', 'ext-state-1');
      const hubThread = threadStore.threads.get(result.threadId);
      assert.ok(hubThread);
      assert.ok(hubThread.connectorHubState, 'Hub thread should have connectorHubState');
      assert.equal(hubThread.connectorHubState.v, 1);
      assert.equal(hubThread.connectorHubState.connectorId, 'feishu');
      assert.equal(hubThread.connectorHubState.externalChatId, 'chat-state');
      assert.ok(hubThread.connectorHubState.createdAt > 0);
    });

    it('storeCommandExchange updates lastCommandAt on Hub thread (G+)', async () => {
      bindingStore.bind('feishu', 'chat-lca', 'thread-conv-lca', 'owner-1');
      const lcaRouter = new ConnectorRouter({
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
          '/where': { kind: 'where', response: 'info' },
        }),
        adapters: new Map([['feishu', mockAdapter()]]),
      });

      const beforeCmd = Date.now();
      await lcaRouter.route('feishu', 'chat-lca', '/where', 'ext-lca-1');

      const hubThread = [...threadStore.threads.values()].find(
        (t) => t.connectorHubState?.externalChatId === 'chat-lca',
      );
      assert.ok(hubThread, 'Hub thread should exist');
      assert.ok(hubThread.connectorHubState.lastCommandAt, 'lastCommandAt should be set');
      assert.ok(hubThread.connectorHubState.lastCommandAt >= beforeCmd, 'lastCommandAt should be recent');
    });

    // F134 regression: group chats must support /commands (KD-8 was incorrectly blocking them)
    it('handles /commands in group chats (F134)', async () => {
      bindingStore.bind('feishu', 'group-chat-1', 'thread-grp-1', 'owner-1');
      const result = await commandRouter.route(
        'feishu',
        'group-chat-1',
        '/where',
        'ext-grp-cmd-1',
        undefined,
        undefined,
        'group',
      );
      assert.equal(result.kind, 'command');
      assert.equal(adapterSendCalls.length, 1);
      assert.equal(adapterSendCalls[0].content, 'You are here');
      assert.equal(cmdTrigger.calls.length, 0);
    });

    // F134 regression: group Hub title includes chatName to distinguish multiple groups
    it('group Hub thread title includes chatName (F134)', async () => {
      bindingStore.bind('feishu', 'grp-hub-1', 'thread-grp-hub-1', 'owner-1');
      const hubRouter = new ConnectorRouter({
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
          '/where': { kind: 'where', response: 'info' },
        }),
        adapters: new Map([['feishu', mockAdapter()]]),
      });

      const result = await hubRouter.route(
        'feishu',
        'grp-hub-1',
        '/where',
        'ext-grp-hub-1',
        undefined,
        undefined,
        'group',
        '猫猫咖啡测试群',
      );
      const hubThread = threadStore.threads.get(result.threadId);
      assert.ok(hubThread);
      assert.ok(hubThread.title.includes('猫猫咖啡测试群'), `expected chatName in Hub title, got: ${hubThread.title}`);
      assert.ok(hubThread.title.includes('IM Hub'));
    });

    // ── Bug-8: platform-specific group chat titles ──

    it('wecom-bot group thread title uses 企业微信群聊 (Bug-8)', async () => {
      const result = await router.route(
        'wecom-bot',
        'wecom-grp-1',
        'hello',
        'ext-wecom-1',
        undefined,
        { id: 'user_1' },
        'group',
      );
      assert.equal(result.kind, 'routed');
      const thread = threadStore.threads.get(result.threadId);
      assert.ok(thread);
      assert.ok(thread.title.includes('企业微信群聊'), `expected 企业微信群聊 in title, got: ${thread.title}`);
      assert.ok(!thread.title.includes('飞书群聊'), `must not contain 飞书群聊, got: ${thread.title}`);
    });

    it('dingtalk group thread title uses 钉钉群聊 (Bug-8)', async () => {
      const result = await router.route(
        'dingtalk',
        'dt-grp-1',
        'hello',
        'ext-dt-1',
        undefined,
        { id: 'user_1' },
        'group',
        '测试群',
      );
      assert.equal(result.kind, 'routed');
      const thread = threadStore.threads.get(result.threadId);
      assert.ok(thread);
      assert.ok(thread.title.includes('钉钉群聊'), `expected 钉钉群聊 in title, got: ${thread.title}`);
      assert.ok(thread.title.includes('测试群'), `expected chatName in title, got: ${thread.title}`);
    });

    it('feishu group thread title still uses 飞书群聊 (Bug-8 regression)', async () => {
      const result = await router.route(
        'feishu',
        'fs-grp-1',
        'hello',
        'ext-fs-1',
        undefined,
        { id: 'user_1' },
        'group',
        '飞书测试群',
      );
      assert.equal(result.kind, 'routed');
      const thread = threadStore.threads.get(result.threadId);
      assert.ok(thread);
      assert.ok(thread.title.includes('飞书群聊'), `expected 飞书群聊 in title, got: ${thread.title}`);
      assert.ok(thread.title.includes('飞书测试群'), `expected chatName in title, got: ${thread.title}`);
    });
  });

  // ── F134 Phase D: Permission tests ──
  describe('Phase D permissions', () => {
    let permRouter;
    let permSendCalls;
    let permTrigger;

    function mockPermCommandLayer(responses) {
      return {
        async handle(_cid, _ecid, _uid, text, _sid) {
          const cmd = text.trim().split(/\s+/)[0].toLowerCase();
          return responses[cmd] ?? { kind: 'not-command' };
        },
      };
    }

    function mockPermAdapter() {
      permSendCalls = [];
      return {
        async sendReply(externalChatId, content) {
          permSendCalls.push({ externalChatId, content });
        },
      };
    }

    beforeEach(async () => {
      permTrigger = mockTrigger();
      const { MemoryConnectorPermissionStore } = await import(
        '../dist/infrastructure/connectors/ConnectorPermissionStore.js'
      );
      const permStore = new MemoryConnectorPermissionStore();
      await permStore.setWhitelistEnabled('feishu', true);
      await permStore.allowGroup('feishu', 'allowed-group');
      await permStore.setAdminOpenIds('feishu', ['admin-user-1']);
      await permStore.setCommandAdminOnly('feishu', true);

      const adaptersMap = new Map();
      adaptersMap.set('feishu', mockPermAdapter());

      permRouter = new ConnectorRouter({
        bindingStore,
        dedup: new InboundMessageDedup(),
        messageStore,
        threadStore,
        invokeTrigger: permTrigger,
        socketManager,
        defaultUserId: 'owner-1',
        defaultCatId: 'opus',
        log: noopLog(),
        commandLayer: mockPermCommandLayer({
          '/where': { kind: 'where', response: 'You are here' },
          '/allow-group': { kind: 'allow-group', response: 'Group allowed' },
        }),
        permissionStore: permStore,
        adapters: adaptersMap,
      });
    });

    it('AC-D1: blocks group messages when group not in whitelist', async () => {
      const result = await permRouter.route(
        'feishu',
        'blocked-group',
        'hello',
        'ext-perm-1',
        undefined,
        { id: 'user-1' },
        'group',
      );
      assert.equal(result.kind, 'skipped');
      assert.equal(result.reason, 'group_not_allowed');
      assert.equal(permSendCalls.length, 1);
      assert.ok(permSendCalls[0].content.includes('未授权'));
    });

    it('AC-D1: allows admin /allow-group in blocked group before whitelist check', async () => {
      const result = await permRouter.route(
        'feishu',
        'blocked-group',
        '/allow-group',
        'ext-perm-allow-1',
        undefined,
        { id: 'admin-user-1' },
        'group',
      );
      assert.equal(result.kind, 'command');
      assert.equal(permSendCalls.length, 1);
      assert.equal(permSendCalls[0].content, 'Group allowed');
    });

    it('AC-D1: allows group messages when group is whitelisted', async () => {
      bindingStore.bind('feishu', 'allowed-group', 'thread-allowed', 'owner-1');
      const result = await permRouter.route(
        'feishu',
        'allowed-group',
        'hello',
        'ext-perm-2',
        undefined,
        { id: 'user-1' },
        'group',
      );
      assert.equal(result.kind, 'routed');
      assert.equal(permTrigger.calls.length, 1);
    });

    it('AC-D3: blocks /command from non-admin in group', async () => {
      bindingStore.bind('feishu', 'allowed-group', 'thread-allowed2', 'owner-1');
      const result = await permRouter.route(
        'feishu',
        'allowed-group',
        '/where',
        'ext-perm-3',
        undefined,
        { id: 'non-admin-user' },
        'group',
      );
      assert.equal(result.kind, 'skipped');
      assert.equal(result.reason, 'command_admin_only');
      assert.ok(permSendCalls[0].content.includes('管理员'));
    });

    it('AC-D3: allows /command from admin in group', async () => {
      bindingStore.bind('feishu', 'allowed-group', 'thread-allowed3', 'owner-1');
      const result = await permRouter.route(
        'feishu',
        'allowed-group',
        '/where',
        'ext-perm-4',
        undefined,
        { id: 'admin-user-1' },
        'group',
      );
      assert.equal(result.kind, 'command');
    });

    it('AC-D5: DM messages bypass whitelist (no restriction on @bot)', async () => {
      const result = await permRouter.route('feishu', 'dm-chat', 'hello', 'ext-perm-5', undefined, undefined, 'p2p');
      assert.equal(result.kind, 'routed');
    });

    it('AC-D5: DM /commands bypass admin check', async () => {
      bindingStore.bind('feishu', 'dm-chat-cmd', 'thread-dm-cmd', 'owner-1');
      const result = await permRouter.route(
        'feishu',
        'dm-chat-cmd',
        '/where',
        'ext-perm-6',
        undefined,
        undefined,
        'p2p',
      );
      assert.equal(result.kind, 'command');
    });
  });
});
