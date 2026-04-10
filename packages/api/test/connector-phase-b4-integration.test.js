/**
 * Integration test for F088 Phase B (Command Layer) + Phase 4 (Streaming).
 *
 * Tests the full flow:
 * - ConnectorCommandLayer → ConnectorRouter command interception
 * - /new → /threads → /use → /where lifecycle
 * - StreamingOutboundHook → placeholder → edits → final
 * - FeishuAdapter + TelegramAdapter sendPlaceholder/editMessage
 *
 * F088 Multi-Platform Chat Gateway
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { ConnectorCommandLayer } from '../dist/infrastructure/connectors/ConnectorCommandLayer.js';
import { ConnectorRouter } from '../dist/infrastructure/connectors/ConnectorRouter.js';
import { MemoryConnectorThreadBindingStore } from '../dist/infrastructure/connectors/ConnectorThreadBindingStore.js';
import { InboundMessageDedup } from '../dist/infrastructure/connectors/InboundMessageDedup.js';
import { StreamingOutboundHook } from '../dist/infrastructure/connectors/StreamingOutboundHook.js';

function noopLog() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop, child: () => noopLog() };
}

function mockThreadStore() {
  let counter = 0;
  const threads = new Map();
  return {
    threads,
    create(_userId, title) {
      counter++;
      const thread = { id: `thread-${counter}`, title: title ?? null, createdAt: Date.now() };
      threads.set(thread.id, thread);
      return thread;
    },
    get(id) {
      return threads.get(id) ?? null;
    },
    list() {
      return [...threads.values()];
    },
    updateConnectorHubState() {},
  };
}

function mockStreamableAdapter(connectorId) {
  const sent = [];
  const edits = [];
  return {
    connectorId,
    sent,
    edits,
    async sendReply(chatId, content) {
      sent.push({ chatId, content, type: 'reply' });
    },
    async sendPlaceholder(chatId, text) {
      const msgId = `pmsg-${sent.length + 1}`;
      sent.push({ chatId, text, type: 'placeholder', msgId });
      return msgId;
    },
    async editMessage(chatId, msgId, text) {
      edits.push({ chatId, msgId, text });
    },
  };
}

describe('F088 Phase B+4 Integration', () => {
  let bindingStore;
  let threadStore;
  let commandLayer;
  let adapter;
  let router;
  let triggerCalls;

  beforeEach(() => {
    bindingStore = new MemoryConnectorThreadBindingStore();
    threadStore = mockThreadStore();
    adapter = mockStreamableAdapter('feishu');
    triggerCalls = [];

    commandLayer = new ConnectorCommandLayer({
      bindingStore,
      threadStore,
      frontendBaseUrl: 'https://cafe.test',
    });

    const adapters = new Map();
    adapters.set('feishu', adapter);

    router = new ConnectorRouter({
      bindingStore,
      dedup: new InboundMessageDedup(),
      messageStore: {
        async append(_input) {
          return { id: `msg-${Date.now()}` };
        },
      },
      threadStore,
      invokeTrigger: {
        trigger(...args) {
          triggerCalls.push(args);
        },
      },
      socketManager: { broadcastToRoom() {} },
      defaultUserId: 'owner-1',
      defaultCatId: 'opus',
      log: noopLog(),
      commandLayer,
      adapters,
    });
  });

  describe('command lifecycle: /new → /threads → /use → /where', () => {
    it('full command cycle works end-to-end', async () => {
      // 1. /new creates a thread and binds it
      const r1 = await router.route('feishu', 'chat-a', '/new My First Thread', 'cmd-1');
      assert.equal(r1.kind, 'command');
      assert.equal(adapter.sent.length, 1);
      assert.ok(adapter.sent[0].content.includes('新 thread'));
      assert.ok(adapter.sent[0].content.includes('My First Thread'));

      // Capture the first thread ID for later /use
      const firstThreadId = [...threadStore.threads.keys()][0];

      // 2. /where shows the current binding
      const r2 = await router.route('feishu', 'chat-a', '/where', 'cmd-2');
      assert.equal(r2.kind, 'command');
      assert.ok(adapter.sent[1].content.includes('当前 thread'));
      assert.ok(adapter.sent[1].content.includes('My First Thread'));
      assert.ok(adapter.sent[1].content.includes('cafe.test'));

      // 3. Create a binding from a different chat to build up user index
      // (MemoryStore is keyed by chat, so second /new from same chat overwrites first)
      await bindingStore.bind('feishu', 'chat-b', firstThreadId, 'owner-1');

      // 4. /new from chat-a creates second thread (overwrites chat-a binding)
      const r3 = await router.route('feishu', 'chat-a', '/new Second Thread', 'cmd-3');
      assert.equal(r3.kind, 'command');
      assert.ok(adapter.sent[2].content.includes('Second Thread'));

      // 5. /threads lists threads for this user
      const r4 = await router.route('feishu', 'chat-a', '/threads', 'cmd-4');
      assert.equal(r4.kind, 'command');
      const threadsResponse = adapter.sent[3].content;
      assert.ok(threadsResponse.includes('最近的 threads'));

      // 6. /use switches back to first thread via chat-b's binding in user index
      // Use full threadId as prefix since mock IDs are similar (thread-1, thread-2)
      const r5 = await router.route('feishu', 'chat-a', `/use ${firstThreadId}`, 'cmd-5');
      assert.equal(r5.kind, 'command');
      assert.ok(adapter.sent[4].content.includes('已切换到'), `Expected "已切换到" in: ${adapter.sent[4].content}`);
      assert.ok(
        adapter.sent[4].content.includes('My First Thread'),
        `Expected "My First Thread" in: ${adapter.sent[4].content}`,
      );

      // 7. /where confirms we're back on first thread
      const r6 = await router.route('feishu', 'chat-a', '/where', 'cmd-6');
      assert.equal(r6.kind, 'command');
      assert.ok(adapter.sent[5].content.includes('My First Thread'));

      // 7. No invocations triggered for any commands
      assert.equal(triggerCalls.length, 0);
    });

    it('normal message routes to agent after command', async () => {
      // Create thread via command
      await router.route('feishu', 'chat-a', '/new', 'cmd-1');
      assert.equal(triggerCalls.length, 0);

      // Normal message routes to agent
      const r = await router.route('feishu', 'chat-a', 'Hello cat!', 'msg-1');
      assert.equal(r.kind, 'routed');
      assert.equal(triggerCalls.length, 1);
    });
  });

  describe('streaming: placeholder → chunks → final', () => {
    it('full streaming lifecycle works end-to-end', async () => {
      // Setup: create binding so streaming knows where to send
      await bindingStore.bind('feishu', 'chat-a', 'thread-stream-1', 'owner-1');

      const streamableAdapters = new Map();
      streamableAdapters.set('feishu', adapter);

      const streamingHook = new StreamingOutboundHook({
        bindingStore,
        adapters: streamableAdapters,
        log: noopLog(),
        updateIntervalMs: 50, // fast for test
        minDeltaChars: 10, // low threshold for test
      });

      // 1. Stream start: sends placeholder
      await streamingHook.onStreamStart('thread-stream-1', 'opus');
      assert.equal(adapter.sent.length, 1);
      assert.equal(adapter.sent[0].type, 'placeholder');
      // F157: Feishu gets cat-personality receipt text, not generic "思考中"
      assert.ok(adapter.sent[0].text.length > 0, 'placeholder text must be non-empty');
      assert.ok(!adapter.sent[0].text.includes('思考中'), 'Feishu should get receipt, not generic placeholder');

      // 2. First chunk: too soon, should be skipped (rate limit)
      await streamingHook.onStreamChunk('thread-stream-1', 'Hello');
      assert.equal(adapter.edits.length, 0); // skipped — too soon + too short

      // 3. Wait for rate limit window, then send longer chunk
      await new Promise((r) => setTimeout(r, 60));
      await streamingHook.onStreamChunk('thread-stream-1', 'Hello, this is a longer message from the cat');
      assert.equal(adapter.edits.length, 1);
      assert.ok(adapter.edits[0].text.includes('▌')); // cursor indicator

      // 4. Stream end: final edit without cursor
      await streamingHook.onStreamEnd('thread-stream-1', 'Hello, this is the final complete reply from the cat.');
      assert.equal(adapter.edits.length, 2);
      assert.ok(!adapter.edits[1].text.includes('▌')); // no cursor on final

      // 5. Verify cleanup: second end call is no-op
      await streamingHook.onStreamEnd('thread-stream-1', 'should not send');
      assert.equal(adapter.edits.length, 2); // unchanged
    });
  });

  describe('commands + streaming coexistence', () => {
    it('command does not interfere with ongoing stream', async () => {
      // Bind chat-a to a thread
      await bindingStore.bind('feishu', 'chat-a', 'thread-coex', 'owner-1');

      const streamableAdapters = new Map();
      streamableAdapters.set('feishu', adapter);

      const streamingHook = new StreamingOutboundHook({
        bindingStore,
        adapters: streamableAdapters,
        log: noopLog(),
      });

      // Start streaming on the bound thread
      await streamingHook.onStreamStart('thread-coex', 'opus');
      const placeholderCount = adapter.sent.length;

      // Meanwhile, /where command arrives — should work independently
      const r = await router.route('feishu', 'chat-a', '/where', 'cmd-coex');
      assert.equal(r.kind, 'command');
      // Command response sent via sendReply, not affecting streaming
      assert.equal(adapter.sent.length, placeholderCount + 1); // +1 for command reply

      // Stream can still end normally
      await streamingHook.onStreamEnd('thread-coex', 'Final text');
      assert.ok(adapter.edits.length >= 1);
    });
  });
});
