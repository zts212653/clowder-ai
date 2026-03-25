/**
 * F088 Gateway Integration Smoke Test
 * Tests the full flow with mocked platform SDKs:
 *   Inbound message → ConnectorRouter → agent mock → outbound delivery
 */
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FeishuAdapter } from '../dist/infrastructure/connectors/adapters/FeishuAdapter.js';
import { TelegramAdapter } from '../dist/infrastructure/connectors/adapters/TelegramAdapter.js';
import { ConnectorRouter } from '../dist/infrastructure/connectors/ConnectorRouter.js';
import { MemoryConnectorThreadBindingStore } from '../dist/infrastructure/connectors/ConnectorThreadBindingStore.js';
import { InboundMessageDedup } from '../dist/infrastructure/connectors/InboundMessageDedup.js';
import { OutboundDeliveryHook } from '../dist/infrastructure/connectors/OutboundDeliveryHook.js';

function assertFeishuCardContains(content, expectedHeader, expectedBody) {
  const parsed = JSON.parse(content);
  assert.equal(parsed.header?.title?.content, expectedHeader);
  const bodyEntry = parsed.elements?.find((item) => item.tag === 'markdown' && item.content === expectedBody);
  assert.ok(bodyEntry, `Expected Feishu card to contain body "${expectedBody}"`);
}

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

function buildTestHarness() {
  const log = noopLog();
  const bindingStore = new MemoryConnectorThreadBindingStore();
  const dedup = new InboundMessageDedup();
  const messageStore = {
    messages: [],
    async append(input) {
      const msg = {
        id: `msg-${this.messages.length + 1}`,
        ...input,
      };
      this.messages.push(msg);
      return msg;
    },
  };
  let threadCounter = 0;
  const threadStore = {
    create(userId, title) {
      threadCounter++;
      return { id: `thread-${threadCounter}`, createdBy: userId, title };
    },
  };
  const triggerCalls = [];
  const invokeTrigger = {
    trigger(threadId, catId, userId, message, messageId) {
      triggerCalls.push({ threadId, catId, userId, message, messageId });
    },
  };
  const broadcasts = [];
  const socketManager = {
    broadcastToRoom(room, event, data) {
      broadcasts.push({ room, event, data });
    },
  };

  // Adapters
  const telegramAdapter = new TelegramAdapter('test-token', log);
  const telegramSent = [];
  telegramAdapter._injectSendMessage(async (chatId, text) => {
    telegramSent.push({ chatId, text });
  });

  const feishuAdapter = new FeishuAdapter('app-id', 'app-secret', log);
  const feishuSent = [];
  feishuAdapter._injectSendMessage(async (params) => {
    feishuSent.push(params);
  });

  const adapters = new Map([
    ['telegram', telegramAdapter],
    ['feishu', feishuAdapter],
  ]);

  const outboundHook = new OutboundDeliveryHook({
    bindingStore,
    adapters,
    log,
  });

  const router = new ConnectorRouter({
    bindingStore,
    dedup,
    messageStore,
    threadStore,
    invokeTrigger,
    socketManager,
    defaultUserId: 'owner-1',
    defaultCatId: 'opus',
    log,
  });

  return {
    router,
    outboundHook,
    bindingStore,
    messageStore,
    triggerCalls,
    telegramSent,
    feishuSent,
    broadcasts,
  };
}

describe('F088 Gateway Integration', () => {
  describe('Telegram full flow', () => {
    it('inbound → route → outbound', async () => {
      const h = buildTestHarness();

      // 1. Simulate inbound Telegram message
      const telegramAdapter = new TelegramAdapter('test-token', noopLog());
      const parsed = telegramAdapter.parseUpdate({
        update_id: 1,
        message: {
          message_id: 100,
          from: { id: 42, is_bot: false, first_name: 'User' },
          chat: { id: 12345, type: 'private' },
          date: Date.now(),
          text: 'Hello from Telegram!',
        },
      });
      assert.ok(parsed, 'Should parse valid Telegram update');

      // 2. Route the message
      const result = await h.router.route('telegram', parsed.chatId, parsed.text, parsed.messageId);
      assert.equal(result.kind, 'routed');
      assert.ok(result.threadId);

      // 3. Verify message posted to store
      assert.equal(h.messageStore.messages.length, 1);
      assert.equal(h.messageStore.messages[0].source.connector, 'telegram');
      assert.equal(h.messageStore.messages[0].content, 'Hello from Telegram!');

      // 4. Verify cat invocation triggered
      assert.equal(h.triggerCalls.length, 1);
      assert.equal(h.triggerCalls[0].threadId, result.threadId);

      // 5. Simulate outbound delivery (agent reply completed)
      await h.outboundHook.deliver(result.threadId, 'Reply from cat!');
      assert.equal(h.telegramSent.length, 1);
      assert.equal(h.telegramSent[0].chatId, parsed.chatId);
      assert.equal(h.telegramSent[0].text, 'Reply from cat!');
    });
  });

  describe('Feishu full flow', () => {
    it('inbound → route → outbound', async () => {
      const h = buildTestHarness();

      // 1. Simulate inbound Feishu event
      const feishuAdapter = new FeishuAdapter('app-id', 'app-secret', noopLog());
      const parsed = feishuAdapter.parseEvent({
        header: {
          event_type: 'im.message.receive_v1',
          event_id: 'evt-1',
        },
        event: {
          sender: {
            sender_id: { open_id: 'ou_user_1' },
            sender_type: 'user',
          },
          message: {
            message_id: 'om_msg_1',
            chat_id: 'oc_chat_1',
            chat_type: 'p2p',
            content: JSON.stringify({ text: '你好猫猫！' }),
            message_type: 'text',
          },
        },
      });
      assert.ok(parsed, 'Should parse valid Feishu event');

      // 2. Route
      const result = await h.router.route('feishu', parsed.chatId, parsed.text, parsed.messageId);
      assert.equal(result.kind, 'routed');

      // 3. Verify connector source
      assert.equal(h.messageStore.messages[0].source.connector, 'feishu');
      assert.equal(h.messageStore.messages[0].source.label, '飞书');

      // 4. Outbound delivery
      await h.outboundHook.deliver(result.threadId, '猫猫回复！');
      assert.equal(h.feishuSent.length, 1);
      assert.equal(h.feishuSent[0].chatId, 'oc_chat_1');
      assertFeishuCardContains(h.feishuSent[0].content, '🐱 Cat', '猫猫回复！');
    });
  });

  describe('Idempotency', () => {
    it('duplicate message ID does not trigger second invocation', async () => {
      const h = buildTestHarness();

      const r1 = await h.router.route('telegram', 'chat-1', 'Hello', 'ext-msg-1');
      const r2 = await h.router.route('telegram', 'chat-1', 'Hello', 'ext-msg-1');

      assert.equal(r1.kind, 'routed');
      assert.equal(r2.kind, 'skipped');
      assert.equal(h.triggerCalls.length, 1);
      assert.equal(h.messageStore.messages.length, 1);
    });
  });

  describe('Thread reuse', () => {
    it('second message from same chat reuses thread', async () => {
      const h = buildTestHarness();

      const r1 = await h.router.route('telegram', 'chat-1', 'First message', 'ext-1');
      const r2 = await h.router.route('telegram', 'chat-1', 'Second message', 'ext-2');

      assert.equal(r1.kind, 'routed');
      assert.equal(r2.kind, 'routed');
      assert.equal(r1.threadId, r2.threadId);
      assert.equal(h.messageStore.messages.length, 2);
    });
  });

  describe('Cross-platform binding isolation', () => {
    it('same user on different platforms gets different threads', async () => {
      const h = buildTestHarness();

      const r1 = await h.router.route('telegram', 'chat-1', 'From Telegram', 'tg-1');
      const r2 = await h.router.route('feishu', 'chat-1', 'From Feishu', 'fs-1');

      assert.equal(r1.kind, 'routed');
      assert.equal(r2.kind, 'routed');
      assert.notEqual(r1.threadId, r2.threadId);
    });
  });

  describe('Outbound multi-platform delivery', () => {
    it('delivers to both platforms when thread has both bindings', async () => {
      const h = buildTestHarness();

      // Route from telegram
      const r1 = await h.router.route('telegram', 'tg-chat', 'msg', 'tg-1');

      // Manually bind feishu to same thread (simulates dual-platform user)
      h.bindingStore.bind('feishu', 'fs-chat', r1.threadId, 'owner-1');

      // Deliver outbound
      await h.outboundHook.deliver(r1.threadId, 'Reply to both!');

      assert.equal(h.telegramSent.length, 1);
      assert.equal(h.feishuSent.length, 1);
      assert.equal(h.telegramSent[0].text, 'Reply to both!');
      assertFeishuCardContains(h.feishuSent[0].content, '🐱 Cat', 'Reply to both!');
    });

    it('prefixes reply with cat identity when catId provided', async () => {
      const h = buildTestHarness();
      const r = await h.router.route('telegram', 'tg-chat', 'hello', 'tg-1');

      await h.outboundHook.deliver(r.threadId, 'Hello!', 'opus');

      assert.equal(h.telegramSent.length, 1);
      assert.match(h.telegramSent[0].text, /^\[布偶猫🐱\] Hello!$/);
    });
  });

  describe('Phase 2: @-mention routing + identity prefix', () => {
    it('@codex in Telegram → triggers codex + prefixed reply', async () => {
      const h = buildTestHarness();

      // 1. Inbound message with @codex mention
      const r = await h.router.route('telegram', 'tg-chat', '@codex please review this PR', 'tg-mention-1');
      assert.equal(r.kind, 'routed');

      // 2. Verify cat invocation targeted codex (not default opus)
      assert.equal(h.triggerCalls.length, 1);
      assert.equal(h.triggerCalls[0].catId, 'codex');

      // 3. Verify mentions stored in message
      assert.deepEqual(h.messageStore.messages[0].mentions, ['codex']);

      // 4. Simulate outbound with codex identity
      await h.outboundHook.deliver(r.threadId, 'LGTM!', 'codex');
      assert.equal(h.telegramSent.length, 1);
      assert.match(h.telegramSent[0].text, /^\[缅因猫🐱\] LGTM!$/);
    });

    it('@布偶猫 in Feishu → triggers opus + prefixed reply', async () => {
      const h = buildTestHarness();

      const r = await h.router.route('feishu', 'fs-chat', '@布偶猫 帮我看看这个', 'fs-mention-1');
      assert.equal(r.kind, 'routed');
      assert.equal(h.triggerCalls[0].catId, 'opus');
      assert.deepEqual(h.messageStore.messages[0].mentions, ['opus']);

      await h.outboundHook.deliver(r.threadId, '好的！', 'opus');
      assertFeishuCardContains(h.feishuSent[0].content, '🐱 布偶猫', '好的！');
    });

    it('no mention → default cat (opus) invoked', async () => {
      const h = buildTestHarness();

      await h.router.route('telegram', 'tg-chat', 'hello cats!', 'tg-no-mention');
      assert.equal(h.triggerCalls[0].catId, 'opus');
    });
  });
});
