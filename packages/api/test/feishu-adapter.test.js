import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FeishuAdapter } from '../dist/infrastructure/connectors/adapters/FeishuAdapter.js';

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

describe('FeishuAdapter', () => {
  describe('parseEvent()', () => {
    it('extracts text message from im.message.receive_v1 event', () => {
      const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog());
      const event = {
        header: {
          event_type: 'im.message.receive_v1',
          event_id: 'evt-001',
        },
        event: {
          sender: {
            sender_id: { open_id: 'ou_sender_123' },
            sender_type: 'user',
          },
          message: {
            message_id: 'om_msg_456',
            chat_id: 'oc_chat_789',
            chat_type: 'p2p',
            content: JSON.stringify({ text: 'Hello cat!' }),
            message_type: 'text',
          },
        },
      };
      const result = adapter.parseEvent(event);
      assert.ok(result);
      assert.equal(result.chatId, 'oc_chat_789');
      assert.equal(result.text, 'Hello cat!');
      assert.equal(result.messageId, 'om_msg_456');
      assert.equal(result.senderId, 'ou_sender_123');
    });

    it('returns null for unsupported message type', () => {
      const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog());
      const event = {
        header: { event_type: 'im.message.receive_v1', event_id: 'evt-002' },
        event: {
          sender: {
            sender_id: { open_id: 'ou_sender' },
            sender_type: 'user',
          },
          message: {
            message_id: 'om_msg',
            chat_id: 'oc_chat',
            chat_type: 'p2p',
            content: JSON.stringify({ sticker_id: 'abc' }),
            message_type: 'sticker',
          },
        },
      };
      assert.equal(adapter.parseEvent(event), null);
    });

    it('returns null for group messages (MVP = DM only)', () => {
      const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog());
      const event = {
        header: { event_type: 'im.message.receive_v1', event_id: 'evt-003' },
        event: {
          sender: {
            sender_id: { open_id: 'ou_sender' },
            sender_type: 'user',
          },
          message: {
            message_id: 'om_msg',
            chat_id: 'oc_chat',
            chat_type: 'group',
            content: JSON.stringify({ text: 'group msg' }),
            message_type: 'text',
          },
        },
      };
      assert.equal(adapter.parseEvent(event), null);
    });

    it('returns null for unknown event type', () => {
      const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog());
      assert.equal(
        adapter.parseEvent({
          header: { event_type: 'some.other.event' },
          event: {},
        }),
        null,
      );
    });
  });

  // ── Phase 5: Media message parsing ──
  describe('parseEvent() with media types', () => {
    it('extracts image message with image_key', () => {
      const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog());
      const event = {
        header: { event_type: 'im.message.receive_v1' },
        event: {
          sender: { sender_id: { open_id: 'ou_sender' } },
          message: {
            message_id: 'om_img_001',
            chat_id: 'oc_chat',
            chat_type: 'p2p',
            content: JSON.stringify({ image_key: 'img-key-abc' }),
            message_type: 'image',
          },
        },
      };
      const result = adapter.parseEvent(event);
      assert.ok(result);
      assert.equal(result.text, '[图片]');
      assert.deepEqual(result.attachments, [{ type: 'image', feishuKey: 'img-key-abc' }]);
    });

    it('extracts file message with file_key and file_name', () => {
      const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog());
      const event = {
        header: { event_type: 'im.message.receive_v1' },
        event: {
          sender: { sender_id: { open_id: 'ou_sender' } },
          message: {
            message_id: 'om_file_001',
            chat_id: 'oc_chat',
            chat_type: 'p2p',
            content: JSON.stringify({ file_key: 'file-key-xyz', file_name: 'doc.pdf' }),
            message_type: 'file',
          },
        },
      };
      const result = adapter.parseEvent(event);
      assert.ok(result);
      assert.equal(result.text, '[文件] doc.pdf');
      assert.deepEqual(result.attachments, [{ type: 'file', feishuKey: 'file-key-xyz', fileName: 'doc.pdf' }]);
    });

    it('extracts audio message with file_key', () => {
      const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog());
      const event = {
        header: { event_type: 'im.message.receive_v1' },
        event: {
          sender: { sender_id: { open_id: 'ou_sender' } },
          message: {
            message_id: 'om_audio_001',
            chat_id: 'oc_chat',
            chat_type: 'p2p',
            content: JSON.stringify({ file_key: 'audio-key-123', duration: 5000 }),
            message_type: 'audio',
          },
        },
      };
      const result = adapter.parseEvent(event);
      assert.ok(result);
      assert.equal(result.text, '[语音]');
      assert.deepEqual(result.attachments, [{ type: 'audio', feishuKey: 'audio-key-123', duration: 5000 }]);
    });

    it('still handles text messages normally', () => {
      const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog());
      const event = {
        header: { event_type: 'im.message.receive_v1' },
        event: {
          sender: { sender_id: { open_id: 'ou_sender' } },
          message: {
            message_id: 'om_text_001',
            chat_id: 'oc_chat',
            chat_type: 'p2p',
            content: JSON.stringify({ text: 'hello' }),
            message_type: 'text',
          },
        },
      };
      const result = adapter.parseEvent(event);
      assert.ok(result);
      assert.equal(result.text, 'hello');
      assert.equal(result.attachments, undefined);
    });
  });

  describe('sendMedia()', () => {
    it('sends image via Lark API', async () => {
      const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog());
      const sendCalls = [];
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });

      await adapter.sendMedia('oc_chat', { type: 'image', imageKey: 'img-key-123' });
      assert.equal(sendCalls.length, 1);
      assert.equal(sendCalls[0].msgType, 'image');
      const content = JSON.parse(sendCalls[0].content);
      assert.equal(content.image_key, 'img-key-123');
    });

    it('sends file via Lark API', async () => {
      const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog());
      const sendCalls = [];
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });

      await adapter.sendMedia('oc_chat', { type: 'file', fileKey: 'file-key-abc' });
      assert.equal(sendCalls.length, 1);
      assert.equal(sendCalls[0].msgType, 'file');
      const content = JSON.parse(sendCalls[0].content);
      assert.equal(content.file_key, 'file-key-abc');
    });

    it('sends audio via Lark API', async () => {
      const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog());
      const sendCalls = [];
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });

      await adapter.sendMedia('oc_chat', { type: 'audio', fileKey: 'audio-key-xyz' });
      assert.equal(sendCalls.length, 1);
      assert.equal(sendCalls[0].msgType, 'audio');
      const content = JSON.parse(sendCalls[0].content);
      assert.equal(content.file_key, 'audio-key-xyz');
    });
  });

  describe('isVerificationChallenge()', () => {
    it('detects url_verification event', () => {
      const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog());
      const body = {
        type: 'url_verification',
        challenge: 'test-challenge-token',
      };
      const result = adapter.isVerificationChallenge(body);
      assert.ok(result);
      assert.equal(result.challenge, 'test-challenge-token');
    });

    it('returns null for non-verification body', () => {
      const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog());
      assert.equal(adapter.isVerificationChallenge({ header: {}, event: {} }), null);
    });
  });

  describe('sendReply()', () => {
    it('calls Lark API with correct params', async () => {
      const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog());
      const sendCalls = [];
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });

      await adapter.sendReply('oc_chat_789', 'Hello from cat!');
      assert.equal(sendCalls.length, 1);
      assert.equal(sendCalls[0].chatId, 'oc_chat_789');
      assert.equal(sendCalls[0].content, JSON.stringify({ text: 'Hello from cat!' }));
      assert.equal(sendCalls[0].msgType, 'text');
    });
  });

  describe('connectorId', () => {
    it('is feishu', () => {
      const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog());
      assert.equal(adapter.connectorId, 'feishu');
    });
  });

  describe('sendRichMessage()', () => {
    it('sends interactive card via Lark API', async () => {
      const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog());
      const sendCalls = [];
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });

      const blocks = [{ id: 'b1', kind: 'card', v: 1, title: 'Review', bodyMarkdown: 'LGTM' }];
      await adapter.sendRichMessage('oc_chat_789', 'text', blocks, '布偶猫');

      assert.equal(sendCalls.length, 1);
      assert.equal(sendCalls[0].msgType, 'interactive');
      assert.equal(sendCalls[0].chatId, 'oc_chat_789');
      const card = JSON.parse(sendCalls[0].content);
      assert.ok(card.header.title.content.includes('布偶猫'));
      assert.ok(card.header.title.content.includes('Review'));
    });

    it('includes all block types in card elements', async () => {
      const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog());
      const sendCalls = [];
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });

      const blocks = [
        { id: 'b1', kind: 'card', v: 1, title: 'Summary', bodyMarkdown: 'Done' },
        { id: 'b2', kind: 'checklist', v: 1, items: [{ id: 'i1', text: 'Task A', checked: true }] },
      ];
      await adapter.sendRichMessage('oc_chat', 'text', blocks, '缅因猫');

      const card = JSON.parse(sendCalls[0].content);
      assert.ok(card.elements.length >= 2);
    });
  });

  describe('verifyEventToken()', () => {
    it('returns true when header.token matches verificationToken', () => {
      const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog(), { verificationToken: 'my-secret-token' });
      const body = {
        header: { event_type: 'im.message.receive_v1', token: 'my-secret-token' },
        event: {},
      };
      assert.equal(adapter.verifyEventToken(body), true);
    });

    it('returns false when header.token does not match', () => {
      const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog(), { verificationToken: 'my-secret-token' });
      const body = {
        header: { event_type: 'im.message.receive_v1', token: 'wrong-token' },
        event: {},
      };
      assert.equal(adapter.verifyEventToken(body), false);
    });

    it('returns true when no verificationToken configured (skip verification)', () => {
      const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog());
      const body = {
        header: { event_type: 'im.message.receive_v1', token: 'any-token' },
        event: {},
      };
      assert.equal(adapter.verifyEventToken(body), true);
    });

    it('returns false when body has no header', () => {
      const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog(), { verificationToken: 'my-secret-token' });
      assert.equal(adapter.verifyEventToken({}), false);
    });
  });

  describe('sendFormattedReply()', () => {
    it('sends interactive card from MessageEnvelope', async () => {
      const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog());
      const sendCalls = [];
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });

      await adapter.sendFormattedReply('oc_chat_123', {
        header: '🐱 布偶猫/宪宪',
        subtitle: 'T12 飞书登录bug排查 · F088',
        body: '看了一下回调逻辑，问题出在 OAuth token 过期。',
        footer: '📎 https://cafe.clowder-ai.com/t/abc123 · 01:22',
      });

      assert.equal(sendCalls.length, 1);
      assert.equal(sendCalls[0].msgType, 'interactive');
      assert.equal(sendCalls[0].chatId, 'oc_chat_123');

      const card = JSON.parse(sendCalls[0].content);
      assert.equal(card.header.title.content, '🐱 布偶猫/宪宪');
      assert.equal(card.header.template, 'blue');
      // Should have subtitle, body, hr, footer as elements
      const allContent = JSON.stringify(card.elements);
      assert.ok(allContent.includes('T12 飞书登录bug排查'), 'subtitle should be in elements');
      assert.ok(allContent.includes('OAuth token'), 'body should be in elements');
      assert.ok(allContent.includes('cafe.clowder-ai.com'), 'footer with deep link should be in elements');
    });

    it('renders body with markdown support', async () => {
      const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog());
      const sendCalls = [];
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });

      await adapter.sendFormattedReply('oc_chat', {
        header: '🐱 Cat',
        subtitle: 'T1',
        body: '**bold** and `code`',
        footer: '12:00',
      });

      const card = JSON.parse(sendCalls[0].content);
      const bodyEl = card.elements.find((e) => e.content?.includes('**bold**'));
      assert.ok(bodyEl, 'body element should preserve markdown');
      assert.equal(bodyEl.tag, 'markdown');
    });
  });

  it('skips subtitle and footer elements when empty (Phase E minimal card)', async () => {
    const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog());
    const sendCalls = [];
    adapter._injectSendMessage(async (params) => {
      sendCalls.push(params);
    });

    await adapter.sendFormattedReply('oc_chat', {
      header: '🐱 布偶猫',
      subtitle: '',
      body: 'Hello from cat!',
      footer: '',
    });

    const card = JSON.parse(sendCalls[0].content);
    assert.equal(card.header.title.content, '🐱 布偶猫');
    // Should only have the body markdown element, no subtitle/hr/footer
    assert.equal(card.elements.length, 1, 'minimal card should have only body element');
    assert.equal(card.elements[0].content, 'Hello from cat!');
  });

  // P1-2: textContent must not be discarded when both text and blocks present
  describe('sendRichMessage() text preservation', () => {
    it('includes textContent in card elements alongside blocks', async () => {
      const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog());
      const sendCalls = [];
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });

      const blocks = [{ id: 'b1', kind: 'card', v: 1, title: 'Review', bodyMarkdown: 'LGTM' }];
      await adapter.sendRichMessage('oc_chat', 'Cat reply text here', blocks, '布偶猫');

      const card = JSON.parse(sendCalls[0].content);
      const allContent = JSON.stringify(card.elements);
      assert.ok(allContent.includes('Cat reply text here'), 'textContent must appear in card elements');
      assert.ok(allContent.includes('LGTM'), 'block content must also appear');
    });
  });

  // ── AC-14: Card action callback ──
  describe('parseCardAction()', () => {
    it('extracts button action from card.action.trigger event', () => {
      const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog());
      const body = {
        header: { event_type: 'card.action.trigger', event_id: 'evt-card-001' },
        event: {
          operator: { open_id: 'ou_operator_123' },
          action: { value: { action: 'approve_review', threadId: 'th_abc' }, tag: 'button' },
          context: { open_chat_id: 'oc_chat_999' },
        },
      };
      const result = adapter.parseCardAction(body);
      assert.ok(result);
      assert.equal(result.chatId, 'oc_chat_999');
      assert.equal(result.senderId, 'ou_operator_123');
      assert.equal(result.actionValue.action, 'approve_review');
      assert.equal(result.actionValue.threadId, 'th_abc');
    });

    it('returns null for non-card-action events', () => {
      const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog());
      const body = {
        header: { event_type: 'im.message.receive_v1' },
        event: {},
      };
      assert.equal(adapter.parseCardAction(body), null);
    });

    it('returns null when action has no value', () => {
      const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog());
      const body = {
        header: { event_type: 'card.action.trigger' },
        event: {
          operator: { open_id: 'ou_op' },
          action: { tag: 'button' },
          context: { open_chat_id: 'oc_chat' },
        },
      };
      assert.equal(adapter.parseCardAction(body), null);
    });
  });

  describe('sendPlaceholder()', () => {
    it('sends interactive card and returns message_id', async () => {
      const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog());
      const sendCalls = [];
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
        return { data: { message_id: 'om_placeholder_123' } };
      });

      const messageId = await adapter.sendPlaceholder('oc_chat_789', '思考中...');
      assert.equal(messageId, 'om_placeholder_123');
      assert.equal(sendCalls.length, 1);
      assert.equal(sendCalls[0].chatId, 'oc_chat_789');
      assert.equal(sendCalls[0].msgType, 'interactive');
      const card = JSON.parse(sendCalls[0].content);
      assert.equal(card.header.title.content, '思考中...');
      assert.equal(card.header.template, 'grey');
      assert.equal(card.config.update_multi, true);
    });

    it('returns empty string when mock returns no message_id', async () => {
      const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog());
      adapter._injectSendMessage(async () => ({}));

      const messageId = await adapter.sendPlaceholder('oc_chat', 'placeholder');
      assert.equal(messageId, '');
    });
  });

  describe('editMessage()', () => {
    it('calls edit with correct messageId and content', async () => {
      const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog());
      const editCalls = [];
      adapter._injectEditMessage(async (params) => {
        editCalls.push(params);
      });

      await adapter.editMessage('oc_chat_789', 'om_msg_456', '更新后的内容');
      assert.equal(editCalls.length, 1);
      assert.equal(editCalls[0].messageId, 'om_msg_456');
      assert.equal(editCalls[0].content, '更新后的内容');
    });

    it('ignores externalChatId (patch only needs message_id)', async () => {
      const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog());
      const editCalls = [];
      adapter._injectEditMessage(async (params) => {
        editCalls.push(params);
      });

      await adapter.editMessage('any_chat', 'om_msg_789', 'text');
      assert.equal(editCalls.length, 1);
      assert.equal(editCalls[0].messageId, 'om_msg_789');
    });
  });

  describe('deleteMessage()', () => {
    it('calls delete with correct messageId', async () => {
      const adapter = new FeishuAdapter('app-id', 'app-secret', noopLog());
      const deleteCalls = [];
      adapter._injectDeleteMessage(async (params) => {
        deleteCalls.push(params);
      });

      await adapter.deleteMessage('om_msg_to_delete');
      assert.equal(deleteCalls.length, 1);
      assert.equal(deleteCalls[0].messageId, 'om_msg_to_delete');
    });
  });
});
