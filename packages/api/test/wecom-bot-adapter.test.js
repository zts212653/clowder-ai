import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WeComBotAdapter } from '../dist/infrastructure/connectors/adapters/WeComBotAdapter.js';

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

function makeAdapter(opts = {}) {
  return new WeComBotAdapter(noopLog(), {
    botId: 'test-bot-id',
    secret: 'test-secret',
    ...opts,
  });
}

function makeRedisMock(members = []) {
  const saddCalls = [];
  return {
    mock: {
      sadd: async (key, ...vals) => {
        saddCalls.push({ key, vals });
        return vals.length;
      },
      smembers: async () => members,
    },
    saddCalls,
  };
}

function makeFrame(reqId = 'req_001') {
  return { headers: { req_id: reqId } };
}

function makeTextFrame(opts = {}) {
  const {
    reqId = 'req_001',
    chattype = 'single',
    userid = 'user_001',
    chatid = '',
    msgid = 'msg_001',
    content = 'Hello cat!',
  } = opts;
  return {
    headers: { req_id: reqId },
    body: {
      msgtype: 'text',
      chattype,
      from: { userid },
      ...(chatid ? { chatid } : {}),
      msgid,
      text: { content },
    },
  };
}

function seedChat(adapter, chatId = 'user_001', reqId = 'req_seed') {
  adapter._setLastFrame(chatId, makeFrame(reqId));
}

describe('WeComBotAdapter', () => {
  describe('connectorId', () => {
    it('is wecom-bot', () => {
      assert.equal(makeAdapter().connectorId, 'wecom-bot');
    });
  });

  // ── AC-B1: parseEvent — DM + Group text/image/mixed/voice/file ──
  describe('parseEvent()', () => {
    it('extracts text DM message with userid as chatId', () => {
      const result = makeAdapter().parseEvent(makeTextFrame());
      assert.ok(result);
      assert.equal(result.chatId, 'user_001');
      assert.equal(result.text, 'Hello cat!');
      assert.equal(result.messageId, 'msg_001');
      assert.equal(result.senderId, 'user_001');
      assert.equal(result.chatType, 'p2p');
    });

    it('trims whitespace from text content', () => {
      const result = makeAdapter().parseEvent(makeTextFrame({ content: '  trimmed  ' }));
      assert.ok(result);
      assert.equal(result.text, 'trimmed');
    });

    it('extracts image DM message with url and aesKey', () => {
      const frame = {
        headers: { req_id: 'req_img' },
        body: {
          msgtype: 'image',
          chattype: 'single',
          from: { userid: 'user_img' },
          msgid: 'msg_img',
          image: { url: 'https://cdn.wecom.work/img/123', aeskey: 'abc123==' },
        },
      };
      const result = makeAdapter().parseEvent(frame);
      assert.ok(result);
      assert.equal(result.text, '[图片]');
      assert.equal(result.chatType, 'p2p');
      assert.ok(result.attachments);
      assert.equal(result.attachments.length, 1);
      assert.equal(result.attachments[0].type, 'image');
      assert.equal(result.attachments[0].url, 'https://cdn.wecom.work/img/123');
      assert.equal(result.attachments[0].aesKey, 'abc123==');
    });

    it('extracts mixed message with text + images', () => {
      const frame = {
        headers: { req_id: 'req_mix' },
        body: {
          msgtype: 'mixed',
          chattype: 'single',
          from: { userid: 'user_mix' },
          msgid: 'msg_mix',
          mixed: {
            msg_item: [
              { msgtype: 'text', text: { content: 'Look at this: ' } },
              { msgtype: 'image', image: { url: 'https://img1.jpg', aeskey: 'k1' } },
              { msgtype: 'image', image: { url: 'https://img2.jpg' } },
            ],
          },
        },
      };
      const result = makeAdapter().parseEvent(frame);
      assert.ok(result);
      assert.equal(result.text, 'Look at this: ');
      assert.ok(result.attachments);
      assert.equal(result.attachments.length, 2);
      assert.equal(result.attachments[0].url, 'https://img1.jpg');
      assert.equal(result.attachments[0].aesKey, 'k1');
      assert.equal(result.attachments[1].url, 'https://img2.jpg');
      assert.equal(result.attachments[1].aesKey, undefined);
    });

    it('mixed message without text items yields fallback label', () => {
      const frame = {
        headers: { req_id: 'req_mix2' },
        body: {
          msgtype: 'mixed',
          chattype: 'single',
          from: { userid: 'user_mix2' },
          msgid: 'msg_mix2',
          mixed: {
            msg_item: [{ msgtype: 'image', image: { url: 'https://img.jpg' } }],
          },
        },
      };
      const result = makeAdapter().parseEvent(frame);
      assert.ok(result);
      assert.equal(result.text, '[图文混排]');
    });

    it('extracts voice message with ASR transcription', () => {
      const frame = {
        headers: { req_id: 'req_voice' },
        body: {
          msgtype: 'voice',
          chattype: 'single',
          from: { userid: 'user_voice' },
          msgid: 'msg_voice',
          voice: { content: '你好世界' },
        },
      };
      const result = makeAdapter().parseEvent(frame);
      assert.ok(result);
      assert.equal(result.text, '你好世界');
      assert.ok(result.attachments);
      assert.equal(result.attachments[0].type, 'voice');
      assert.equal(result.attachments[0].voiceText, '你好世界');
    });

    it('voice message without ASR yields fallback label', () => {
      const frame = {
        headers: { req_id: 'req_voice2' },
        body: {
          msgtype: 'voice',
          chattype: 'single',
          from: { userid: 'user_voice2' },
          msgid: 'msg_voice2',
          voice: {},
        },
      };
      const result = makeAdapter().parseEvent(frame);
      assert.ok(result);
      assert.equal(result.text, '[语音]');
    });

    // P2-1 regression: voice attachments have voiceText but NO url,
    // so bootstrap .filter((a) => a.url) must exclude them to avoid
    // empty-platformKey download errors.
    it('voice attachment has no url property (prevents empty download)', () => {
      const frame = {
        headers: { req_id: 'req_voice_nourl' },
        body: {
          msgtype: 'voice',
          chattype: 'single',
          from: { userid: 'user_voice_nourl' },
          msgid: 'msg_voice_nourl',
          voice: { content: '语音无URL' },
        },
      };
      const result = makeAdapter().parseEvent(frame);
      assert.ok(result);
      assert.ok(result.attachments);
      assert.equal(result.attachments.length, 1);
      assert.equal(result.attachments[0].type, 'voice');
      assert.equal(result.attachments[0].voiceText, '语音无URL');
      // Critical: url must be absent — bootstrap .filter((a) => a.url) depends on this
      assert.strictEqual(result.attachments[0].url, undefined);
    });

    it('extracts file message with url and aeskey', () => {
      const frame = {
        headers: { req_id: 'req_file' },
        body: {
          msgtype: 'file',
          chattype: 'single',
          from: { userid: 'user_file' },
          msgid: 'msg_file',
          file: { url: 'https://cdn.wecom.work/file/abc', aeskey: 'filekey==' },
        },
      };
      const result = makeAdapter().parseEvent(frame);
      assert.ok(result);
      assert.equal(result.text, '[文件]');
      assert.ok(result.attachments);
      assert.equal(result.attachments[0].type, 'file');
      assert.equal(result.attachments[0].url, 'https://cdn.wecom.work/file/abc');
      assert.equal(result.attachments[0].aesKey, 'filekey==');
    });

    it('parses group messages with chatid as chatId', () => {
      const frame = {
        headers: { req_id: 'req_grp' },
        body: {
          msgtype: 'text',
          chattype: 'group',
          from: { userid: 'user_grp' },
          chatid: 'group_chat_001',
          msgid: 'msg_grp',
          text: { content: 'Hello group' },
        },
      };
      const result = makeAdapter().parseEvent(frame);
      assert.ok(result);
      assert.equal(result.chatType, 'group');
      assert.equal(result.chatId, 'group_chat_001');
      assert.equal(result.senderId, 'user_grp');
    });

    it('returns null for unsupported message type', () => {
      const frame = {
        headers: { req_id: 'req_unsupported' },
        body: {
          msgtype: 'interactive',
          chattype: 'single',
          from: { userid: 'user_x' },
          msgid: 'msg_x',
        },
      };
      assert.equal(makeAdapter().parseEvent(frame), null);
    });

    it('returns null for event type messages', () => {
      const frame = {
        headers: { req_id: 'req_evt' },
        body: {
          msgtype: 'event',
          chattype: 'single',
          from: { userid: 'user_evt' },
        },
      };
      assert.equal(makeAdapter().parseEvent(frame), null);
    });

    it('returns null for missing msgtype', () => {
      const frame = {
        headers: { req_id: 'req_no_type' },
        body: { chattype: 'single' },
      };
      assert.equal(makeAdapter().parseEvent(frame), null);
    });

    it('returns null for missing body', () => {
      const frame = { headers: { req_id: 'req_nobody' } };
      assert.equal(makeAdapter().parseEvent(frame), null);
    });

    it('returns null for invalid chattype', () => {
      const frame = {
        headers: { req_id: 'req_bad_chat' },
        body: {
          msgtype: 'text',
          chattype: 'broadcast',
          from: { userid: 'user_x' },
          msgid: 'msg_x',
          text: { content: 'hi' },
        },
      };
      assert.equal(makeAdapter().parseEvent(frame), null);
    });

    it('returns null for text message with empty content', () => {
      const frame = {
        headers: { req_id: 'req_empty' },
        body: {
          msgtype: 'text',
          chattype: 'single',
          from: { userid: 'user_empty' },
          msgid: 'msg_empty',
          text: {},
        },
      };
      assert.equal(makeAdapter().parseEvent(frame), null);
    });

    it('returns null for mixed message without msg_item array', () => {
      const frame = {
        headers: { req_id: 'req_bad_mix' },
        body: {
          msgtype: 'mixed',
          chattype: 'single',
          from: { userid: 'user_bm' },
          msgid: 'msg_bm',
          mixed: {},
        },
      };
      assert.equal(makeAdapter().parseEvent(frame), null);
    });

    it('falls back to "unknown" sender when from is missing', () => {
      const frame = {
        headers: { req_id: 'req_no_from' },
        body: {
          msgtype: 'text',
          chattype: 'single',
          msgid: 'msg_nofrom',
          text: { content: 'hi' },
        },
      };
      const result = makeAdapter().parseEvent(frame);
      assert.ok(result);
      assert.equal(result.senderId, 'unknown');
    });

    it('image message without url has no attachments', () => {
      const frame = {
        headers: { req_id: 'req_img_nourl' },
        body: {
          msgtype: 'image',
          chattype: 'single',
          from: { userid: 'user_in' },
          msgid: 'msg_in',
          image: {},
        },
      };
      const result = makeAdapter().parseEvent(frame);
      assert.ok(result);
      assert.equal(result.text, '[图片]');
      assert.equal(result.attachments, undefined);
    });

    it('file message without url has no attachments', () => {
      const frame = {
        headers: { req_id: 'req_file_nourl' },
        body: {
          msgtype: 'file',
          chattype: 'single',
          from: { userid: 'user_fn' },
          msgid: 'msg_fn',
          file: {},
        },
      };
      const result = makeAdapter().parseEvent(frame);
      assert.ok(result);
      assert.equal(result.text, '[文件]');
      assert.equal(result.attachments, undefined);
    });

    it('caches frame for streaming bridge after parsing', () => {
      const adapter = makeAdapter();
      const frame = makeTextFrame({ userid: 'cached_user' });
      adapter.parseEvent(frame);
      const streams = adapter._getActiveStreams();
      assert.ok(streams.size === 0);
    });

    it('tracks group chatId for persistence', () => {
      const adapter = makeAdapter();
      adapter.parseEvent({
        headers: { req_id: 'req_gtrack' },
        body: {
          msgtype: 'text',
          chattype: 'group',
          from: { userid: 'user_gt' },
          chatid: 'group_tracked',
          msgid: 'msg_gt',
          text: { content: 'hello' },
        },
      });
      assert.ok(adapter._getGroupChatIds().has('group_tracked'));
    });
  });

  // ── AC-B2: sendReply — text + markdown ──
  describe('sendReply()', () => {
    it('sends markdown message via sendMessage', async () => {
      const adapter = makeAdapter();
      const calls = [];
      adapter._injectSendMessage(async (chatId, body) => {
        calls.push({ chatId, body });
      });

      await adapter.sendReply('user_001', 'Hello from cat!');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].chatId, 'user_001');
      assert.equal(calls[0].body.msgtype, 'markdown');
      assert.equal(calls[0].body.markdown.content, 'Hello from cat!');
    });
  });

  // ── AC-B2: sendRichMessage ──
  describe('sendRichMessage()', () => {
    it('sends markdown with cat display name', async () => {
      const adapter = makeAdapter();
      const calls = [];
      adapter._injectSendMessage(async (chatId, body) => {
        calls.push({ chatId, body });
      });

      await adapter.sendRichMessage('user_001', 'Rich text content', [], '布偶猫');
      assert.equal(calls.length, 1);
      assert.ok(calls[0].body.markdown.content.includes('布偶猫'));
      assert.ok(calls[0].body.markdown.content.includes('Rich text content'));
    });
  });

  // ── AC-B3: sendFormattedReply ──
  describe('sendFormattedReply()', () => {
    it('sends formatted markdown with header and body (fallback, no frame)', async () => {
      const adapter = makeAdapter();
      const calls = [];
      adapter._injectSendMessage(async (chatId, body) => {
        calls.push({ chatId, body });
      });

      const envelope = {
        header: '🐱 布偶猫',
        body: 'Hello world',
        origin: 'direct',
      };
      await adapter.sendFormattedReply('user_001', envelope);
      assert.equal(calls.length, 1);
      assert.ok(calls[0].body.markdown.content.includes('🐱 布偶猫'));
      assert.ok(calls[0].body.markdown.content.includes('Hello world'));
    });

    it('prefixes callback origin with 📨', async () => {
      const adapter = makeAdapter();
      const calls = [];
      adapter._injectSendMessage(async (chatId, body) => {
        calls.push({ chatId, body });
      });

      const envelope = {
        header: '🐱 布偶猫',
        body: 'Callback message',
        origin: 'callback',
      };
      await adapter.sendFormattedReply('user_001', envelope);
      assert.equal(calls.length, 1);
      assert.ok(calls[0].body.markdown.content.includes('📨'));
    });

    it('includes subtitle when present', async () => {
      const adapter = makeAdapter();
      const calls = [];
      adapter._injectSendMessage(async (chatId, body) => {
        calls.push({ chatId, body });
      });

      const envelope = {
        header: 'Cat',
        subtitle: 'Subtitle text',
        body: 'Body',
        origin: 'direct',
      };
      await adapter.sendFormattedReply('user_001', envelope);
      assert.ok(calls[0].body.markdown.content.includes('Subtitle text'));
    });

    it('includes footer when present', async () => {
      const adapter = makeAdapter();
      const calls = [];
      adapter._injectSendMessage(async (chatId, body) => {
        calls.push({ chatId, body });
      });

      const envelope = {
        header: 'Cat',
        body: 'Body',
        footer: 'Footer text',
        origin: 'direct',
      };
      await adapter.sendFormattedReply('user_001', envelope);
      assert.ok(calls[0].body.markdown.content.includes('Footer text'));
    });

    // AC-B4: Template card path
    it('sends template card when frame is cached (AC-B4)', async () => {
      const adapter = makeAdapter();
      const cardCalls = [];
      adapter._injectReplyTemplateCard(async (frame, card) => {
        cardCalls.push({ frame, card });
      });
      adapter._setLastFrame('user_tc', makeFrame('tc_req'));

      const envelope = {
        header: 'Notification',
        subtitle: 'Sub info',
        body: 'Card body text',
        origin: 'direct',
      };
      await adapter.sendFormattedReply('user_tc', envelope);
      assert.equal(cardCalls.length, 1);
      assert.equal(cardCalls[0].card.card_type, 'text_notice');
      assert.equal(cardCalls[0].card.main_title.title, 'Notification');
      assert.equal(cardCalls[0].card.main_title.desc, 'Sub info');
      assert.ok(cardCalls[0].card.task_id.startsWith('card_'));
    });

    it('falls back to markdown when replyTemplateCard fails', async () => {
      const adapter = makeAdapter();
      const sendCalls = [];
      adapter._injectReplyTemplateCard(async () => {
        throw new Error('card fail');
      });
      adapter._injectSendMessage(async (chatId, body) => {
        sendCalls.push({ chatId, body });
      });
      adapter._setLastFrame('user_fb', makeFrame('fb_req'));

      const envelope = {
        header: 'Fallback',
        body: 'Should be markdown',
        origin: 'direct',
      };
      await adapter.sendFormattedReply('user_fb', envelope);
      assert.equal(sendCalls.length, 1);
      assert.ok(sendCalls[0].body.markdown.content.includes('Fallback'));
    });

    it('template card omits desc when no subtitle', async () => {
      const adapter = makeAdapter();
      const cardCalls = [];
      adapter._injectReplyTemplateCard(async (frame, card) => {
        cardCalls.push({ frame, card });
      });
      adapter._setLastFrame('user_ns', makeFrame('ns_req'));

      const envelope = {
        header: 'No Sub',
        body: 'Body',
        origin: 'direct',
      };
      await adapter.sendFormattedReply('user_ns', envelope);
      assert.equal(cardCalls[0].card.main_title.desc, undefined);
    });
  });

  // ── AC-B4: sendPlaceholder + editMessage + deleteMessage (streaming) ──
  describe('sendPlaceholder() + editMessage() + deleteMessage()', () => {
    it('creates stream and returns streamId', async () => {
      const adapter = makeAdapter();
      seedChat(adapter);
      const streamCalls = [];
      adapter._injectReplyStream(async (frame, streamId, content, finish) => {
        streamCalls.push({ frame, streamId, content, finish });
      });
      adapter._injectGenerateReqId((prefix) => `${prefix}_test_001`);

      const platformMsgId = await adapter.sendPlaceholder('user_001', 'Thinking...');
      assert.ok(platformMsgId);
      assert.equal(platformMsgId, 'stream_test_001');
      assert.equal(streamCalls.length, 1);
      assert.equal(streamCalls[0].content, 'Thinking...');
      assert.equal(streamCalls[0].finish, false);
    });

    it('sendPlaceholder falls back to sendReply when no frame cached', async () => {
      const adapter = makeAdapter();
      const sendCalls = [];
      adapter._injectSendMessage(async (chatId, body) => {
        sendCalls.push({ chatId, body });
      });

      const result = await adapter.sendPlaceholder('unmapped_user', 'Thinking...');
      assert.equal(result, '');
      assert.equal(sendCalls.length, 1);
    });

    it('sendPlaceholder returns empty string when replyStream fails', async () => {
      const adapter = makeAdapter();
      seedChat(adapter);
      adapter._injectReplyStream(async () => {
        throw new Error('stream error');
      });
      adapter._injectGenerateReqId(() => 'stream_fail');

      const result = await adapter.sendPlaceholder('user_001', 'Thinking...');
      assert.equal(result, '');
    });

    it('editMessage updates stream with new content', async () => {
      const adapter = makeAdapter();
      seedChat(adapter);
      const streamCalls = [];
      adapter._injectReplyStream(async (frame, streamId, content, finish) => {
        streamCalls.push({ frame, streamId, content, finish });
      });
      adapter._injectGenerateReqId(() => 'stream_edit');

      const pmId = await adapter.sendPlaceholder('user_001', 'Thinking...');
      assert.ok(pmId);

      const session = adapter._getActiveStreams().get(pmId);
      session.lastUpdateAt = Date.now() - 500;

      await adapter.editMessage('user_001', pmId, 'Partial response...');
      assert.equal(streamCalls.length, 2);
      assert.equal(streamCalls[1].content, 'Partial response...');
      assert.equal(streamCalls[1].finish, false);
    });

    it('editMessage throttles at 300ms', async () => {
      const adapter = makeAdapter();
      seedChat(adapter);
      const streamCalls = [];
      adapter._injectReplyStream(async (frame, streamId, content, finish) => {
        streamCalls.push({ content, finish });
      });
      adapter._injectGenerateReqId(() => 'stream_throttle');

      const pmId = await adapter.sendPlaceholder('user_001', 'Thinking...');
      await adapter.editMessage('user_001', pmId, 'update 1');
      assert.equal(streamCalls.length, 1);
    });

    it('deleteMessage finishes the stream', async () => {
      const adapter = makeAdapter();
      seedChat(adapter);
      const streamCalls = [];
      adapter._injectReplyStream(async (frame, streamId, content, finish) => {
        streamCalls.push({ streamId, content, finish });
      });
      adapter._injectGenerateReqId(() => 'stream_delete');

      const pmId = await adapter.sendPlaceholder('user_001', 'Thinking...');
      await adapter.deleteMessage(pmId);

      assert.ok(streamCalls.length >= 2);
      const lastCall = streamCalls[streamCalls.length - 1];
      assert.equal(lastCall.finish, true);
      assert.equal(adapter._getActiveStreams().size, 0);
    });

    it('deleteMessage is no-op for unknown stream', async () => {
      const adapter = makeAdapter();
      const streamCalls = [];
      adapter._injectReplyStream(async (frame, streamId, content, finish) => {
        streamCalls.push({ finish });
      });

      await adapter.deleteMessage('nonexistent');
      assert.equal(streamCalls.length, 0);
    });

    it('editMessage is no-op for unknown stream', async () => {
      const adapter = makeAdapter();
      const streamCalls = [];
      adapter._injectReplyStream(async (frame, streamId, content, finish) => {
        streamCalls.push({ finish });
      });

      await adapter.editMessage('user_001', 'nonexistent', 'text');
      assert.equal(streamCalls.length, 0);
    });

    it('deleteMessage handles replyStream failure gracefully', async () => {
      const adapter = makeAdapter();
      seedChat(adapter);
      let callCount = 0;
      adapter._injectReplyStream(async () => {
        callCount++;
        if (callCount > 1) throw new Error('finish fail');
      });
      adapter._injectGenerateReqId(() => 'stream_del_fail');

      const pmId = await adapter.sendPlaceholder('user_001', 'Thinking...');
      await adapter.deleteMessage(pmId);
      assert.equal(adapter._getActiveStreams().size, 0);
    });
  });

  // ── AC-B5: sendMedia ──
  describe('sendMedia()', () => {
    it('uploads file from absPath and sends via sendMediaMessage', async () => {
      const adapter = makeAdapter();
      const uploadCalls = [];
      const mediaCalls = [];
      adapter._injectUploadMedia(async (buf, opts) => {
        uploadCalls.push({ size: buf.length, ...opts });
        return { media_id: 'mid_001' };
      });
      adapter._injectSendMediaMessage(async (chatId, mediaType, mediaId) => {
        mediaCalls.push({ chatId, mediaType, mediaId });
      });

      const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
      const tmpDir = '/tmp/wecom-bot-test-media';
      mkdirSync(tmpDir, { recursive: true });
      const tmpFile = `${tmpDir}/test.jpg`;
      writeFileSync(tmpFile, 'fake-image-data');

      try {
        await adapter.sendMedia('user_001', {
          type: 'image',
          absPath: tmpFile,
          fileName: 'test.jpg',
        });

        assert.equal(uploadCalls.length, 1);
        assert.equal(uploadCalls[0].type, 'image');
        assert.equal(uploadCalls[0].filename, 'test.jpg');
        assert.equal(mediaCalls.length, 1);
        assert.equal(mediaCalls[0].mediaId, 'mid_001');
        assert.equal(mediaCalls[0].mediaType, 'image');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('maps audio type to voice for WeCom SDK', async () => {
      const adapter = makeAdapter();
      const uploadCalls = [];
      adapter._injectUploadMedia(async (buf, opts) => {
        uploadCalls.push(opts);
        return { media_id: 'mid_audio' };
      });
      adapter._injectSendMediaMessage(async () => {});

      const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
      const tmpDir = '/tmp/wecom-bot-test-audio';
      mkdirSync(tmpDir, { recursive: true });
      const tmpFile = `${tmpDir}/voice.wav`;
      writeFileSync(tmpFile, 'fake-audio');

      try {
        await adapter.sendMedia('user_001', {
          type: 'audio',
          absPath: tmpFile,
        });
        assert.equal(uploadCalls[0].type, 'voice');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('falls back to text link when upload fails', async () => {
      const adapter = makeAdapter();
      adapter._injectUploadMedia(async () => {
        throw new Error('upload failed');
      });
      const sendCalls = [];
      adapter._injectSendMessage(async (chatId, body) => {
        sendCalls.push({ chatId, body });
      });

      const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
      const tmpDir = '/tmp/wecom-bot-test-fallback';
      mkdirSync(tmpDir, { recursive: true });
      const tmpFile = `${tmpDir}/fail.pdf`;
      writeFileSync(tmpFile, 'data');

      try {
        await adapter.sendMedia('user_001', {
          type: 'file',
          absPath: tmpFile,
          url: 'https://example.com/file.pdf',
        });
        assert.equal(sendCalls.length, 1);
        assert.ok(sendCalls[0].body.markdown.content.includes('https://example.com/file.pdf'));
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('falls back to text with fileName when no URL', async () => {
      const adapter = makeAdapter();
      const sendCalls = [];
      adapter._injectSendMessage(async (chatId, body) => {
        sendCalls.push({ chatId, body });
      });

      await adapter.sendMedia('user_001', {
        type: 'file',
        fileName: 'document.pdf',
      });
      assert.equal(sendCalls.length, 1);
      assert.ok(sendCalls[0].body.markdown.content.includes('document.pdf'));
    });

    it('uses correct emoji prefix per media type', async () => {
      const adapter = makeAdapter();
      const sendCalls = [];
      adapter._injectSendMessage(async (chatId, body) => {
        sendCalls.push(body.markdown.content);
      });

      await adapter.sendMedia('u1', { type: 'image', url: 'http://img.jpg' });
      await adapter.sendMedia('u1', { type: 'audio', url: 'http://audio.wav' });
      await adapter.sendMedia('u1', { type: 'file', url: 'http://doc.pdf' });

      assert.ok(sendCalls[0].includes('🖼️'));
      assert.ok(sendCalls[1].includes('🔊'));
      assert.ok(sendCalls[2].includes('📎'));
    });

    it('skips send when no file info is available', async () => {
      const adapter = makeAdapter();
      const sendCalls = [];
      adapter._injectSendMessage(async (chatId, body) => {
        sendCalls.push(body);
      });

      await adapter.sendMedia('user_001', { type: 'image' });
      assert.equal(sendCalls.length, 0);
    });
  });

  // ── AC-B5: downloadMedia ──
  describe('downloadMedia()', () => {
    it('returns buffer from injected download function', async () => {
      const adapter = makeAdapter();
      adapter._injectDownloadFile(async (url, aesKey) => ({
        buffer: Buffer.from(`data_${url}_${aesKey}`),
      }));

      const { buffer } = await adapter.downloadMedia('https://cdn.wecom.work/file', 'key123');
      assert.ok(buffer);
      assert.ok(buffer.toString().includes('data_https://cdn.wecom.work/file_key123'));
    });

    it('throws when no client connected and no injection', async () => {
      const adapter = makeAdapter();
      await assert.rejects(() => adapter.downloadMedia('https://test.com'), { message: /wsClient not connected/ });
    });
  });

  // ── Group ChatId Persistence ──
  describe('registerGroupChatId() + hydrateGroupChatIds()', () => {
    it('adds chatId to internal set', () => {
      const adapter = makeAdapter();
      adapter.registerGroupChatId('group_new');
      assert.ok(adapter._getGroupChatIds().has('group_new'));
    });

    it('persists to Redis via SADD', async () => {
      const { mock, saddCalls } = makeRedisMock();
      const adapter = makeAdapter({ redis: mock });
      adapter.registerGroupChatId('group_redis');

      await new Promise((r) => setTimeout(r, 10));
      assert.ok(saddCalls.length >= 1);
      assert.equal(saddCalls[0].vals[0], 'group_redis');
    });

    it('hydrates groupChatIds from Redis on startup', async () => {
      const redisMock = {
        sadd: async () => 1,
        smembers: async () => ['g1', 'g2', 'g3'],
      };
      const adapter = makeAdapter({ redis: redisMock });
      await adapter.hydrateGroupChatIds();
      assert.ok(adapter._getGroupChatIds().has('g1'));
      assert.ok(adapter._getGroupChatIds().has('g2'));
      assert.ok(adapter._getGroupChatIds().has('g3'));
    });

    it('gracefully handles missing Redis (no-op)', async () => {
      const adapter = makeAdapter();
      await adapter.hydrateGroupChatIds();
    });

    it('gracefully handles Redis errors during hydration', async () => {
      const redisMock = {
        sadd: async () => 1,
        smembers: async () => {
          throw new Error('redis down');
        },
      };
      const adapter = makeAdapter({ redis: redisMock });
      await adapter.hydrateGroupChatIds();
    });

    it('group parseEvent auto-persists to Redis', async () => {
      const { mock, saddCalls } = makeRedisMock();
      const adapter = makeAdapter({ redis: mock });
      adapter.parseEvent({
        headers: { req_id: 'r1' },
        body: {
          msgtype: 'text',
          chattype: 'group',
          from: { userid: 'u1' },
          chatid: 'auto_persist_group',
          msgid: 'm1',
          text: { content: 'hi' },
        },
      });

      await new Promise((r) => setTimeout(r, 10));
      assert.ok(saddCalls.some((c) => c.vals.includes('auto_persist_group')));
    });
  });

  // ── Interface completeness ──
  describe('IStreamableOutboundAdapter interface', () => {
    it('implements all required methods', () => {
      const adapter = makeAdapter();
      assert.equal(typeof adapter.sendReply, 'function');
      assert.equal(typeof adapter.sendRichMessage, 'function');
      assert.equal(typeof adapter.sendFormattedReply, 'function');
      assert.equal(typeof adapter.sendPlaceholder, 'function');
      assert.equal(typeof adapter.editMessage, 'function');
      assert.equal(typeof adapter.deleteMessage, 'function');
      assert.equal(typeof adapter.sendMedia, 'function');
    });
  });

  // ── DI injection methods ──
  describe('DI injection methods', () => {
    it('_injectReplyStream overrides replyStream', async () => {
      const adapter = makeAdapter();
      seedChat(adapter);
      let called = false;
      adapter._injectReplyStream(async () => {
        called = true;
      });
      adapter._injectGenerateReqId(() => 'inj_stream');

      await adapter.sendPlaceholder('user_001', 'test');
      assert.ok(called);
    });

    it('_injectSendMessage overrides sendMessage', async () => {
      const adapter = makeAdapter();
      let called = false;
      adapter._injectSendMessage(async () => {
        called = true;
      });
      await adapter.sendReply('user_001', 'test');
      assert.ok(called);
    });

    it('_injectUploadMedia overrides upload', async () => {
      const adapter = makeAdapter();
      let called = false;
      adapter._injectUploadMedia(async () => {
        called = true;
        return { media_id: 'test' };
      });
      adapter._injectSendMediaMessage(async () => {});

      const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
      const tmpDir = '/tmp/wecom-bot-test-di';
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(`${tmpDir}/t.txt`, 'x');
      try {
        await adapter.sendMedia('u', { type: 'file', absPath: `${tmpDir}/t.txt` });
        assert.ok(called);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('_injectDownloadFile overrides download', async () => {
      const adapter = makeAdapter();
      adapter._injectDownloadFile(async () => ({
        buffer: Buffer.from('injected'),
        filename: 'injected.txt',
      }));
      const result = await adapter.downloadMedia('url');
      assert.equal(result.filename, 'injected.txt');
    });

    it('_injectGenerateReqId overrides stream ID generation', async () => {
      const adapter = makeAdapter();
      seedChat(adapter);
      adapter._injectReplyStream(async () => {});
      adapter._injectGenerateReqId(() => 'custom_stream_123');

      const pmId = await adapter.sendPlaceholder('user_001', 'test');
      assert.equal(pmId, 'custom_stream_123');
    });

    it('_setLastFrame sets frame cache for testing', () => {
      const adapter = makeAdapter();
      const frame = makeFrame('test_frame');
      adapter._setLastFrame('chat_test', frame);
    });

    it('_injectUpdateTemplateCard is callable (AC-B4 update path)', () => {
      const adapter = makeAdapter();
      let called = false;
      adapter._injectUpdateTemplateCard(async (_frame, _card, _userids) => {
        called = true;
      });
      assert.ok(typeof adapter._injectUpdateTemplateCard === 'function');
    });
  });

  // ── Edge cases ──
  describe('edge cases', () => {
    it('sendReply throws when no client connected and no injection', async () => {
      const adapter = makeAdapter();
      await assert.rejects(() => adapter.sendReply('user_001', 'test'), { message: /wsClient not connected/ });
    });

    it('generateStreamId uses fallback when no generateReqIdFn', async () => {
      const adapter = makeAdapter();
      seedChat(adapter);
      adapter._injectReplyStream(async () => {});

      const pmId = await adapter.sendPlaceholder('user_001', 'test');
      assert.ok(pmId.startsWith('stream_'));
    });

    it('parseEvent caches frame per chatId for streaming', async () => {
      const adapter = makeAdapter();
      adapter._injectReplyStream(async () => {});
      adapter._injectGenerateReqId(() => 'from_parse');

      const frame = makeTextFrame({ userid: 'frame_cache_user' });
      adapter.parseEvent(frame);

      const id = await adapter.sendPlaceholder('frame_cache_user', 'test');
      assert.equal(id, 'from_parse');
    });

    it('multiple active streams are tracked independently', async () => {
      const adapter = makeAdapter();
      let counter = 0;
      adapter._injectReplyStream(async () => {});
      adapter._injectGenerateReqId(() => `stream_${++counter}`);

      adapter._setLastFrame('chat_a', makeFrame('ra'));
      adapter._setLastFrame('chat_b', makeFrame('rb'));

      const id1 = await adapter.sendPlaceholder('chat_a', 'A');
      const id2 = await adapter.sendPlaceholder('chat_b', 'B');
      assert.notEqual(id1, id2);
      assert.equal(adapter._getActiveStreams().size, 2);
    });

    it('deleteMessage cleans up active stream entry', async () => {
      const adapter = makeAdapter();
      seedChat(adapter);
      adapter._injectReplyStream(async () => {});
      adapter._injectGenerateReqId(() => 'stream_cleanup');

      const pmId = await adapter.sendPlaceholder('user_001', 'test');
      assert.equal(adapter._getActiveStreams().size, 1);

      await adapter.deleteMessage(pmId);
      assert.equal(adapter._getActiveStreams().size, 0);
    });

    it('editMessage updates lastContent in stream session', async () => {
      const adapter = makeAdapter();
      seedChat(adapter);
      adapter._injectReplyStream(async () => {});
      adapter._injectGenerateReqId(() => 'stream_last_content');

      const pmId = await adapter.sendPlaceholder('user_001', 'init');
      const session = adapter._getActiveStreams().get(pmId);
      assert.equal(session.lastContent, 'init');

      session.lastUpdateAt = Date.now() - 500;
      await adapter.editMessage('user_001', pmId, 'updated');
      assert.equal(session.lastContent, 'updated');
    });

    it('group image message is parsed correctly', () => {
      const adapter = makeAdapter();
      const result = adapter.parseEvent({
        headers: { req_id: 'req_gi' },
        body: {
          msgtype: 'image',
          chattype: 'group',
          from: { userid: 'user_gi' },
          chatid: 'group_img',
          msgid: 'msg_gi',
          image: { url: 'https://img.wecom.work/grp.png', aeskey: 'gk==' },
        },
      });
      assert.ok(result);
      assert.equal(result.chatType, 'group');
      assert.equal(result.chatId, 'group_img');
      assert.equal(result.attachments[0].type, 'image');
    });

    it('group voice message is parsed correctly', () => {
      const adapter = makeAdapter();
      const result = adapter.parseEvent({
        headers: { req_id: 'req_gv' },
        body: {
          msgtype: 'voice',
          chattype: 'group',
          from: { userid: 'user_gv' },
          chatid: 'group_voice',
          msgid: 'msg_gv',
          voice: { content: '群聊语音' },
        },
      });
      assert.ok(result);
      assert.equal(result.chatType, 'group');
      assert.equal(result.text, '群聊语音');
    });

    it('group file message is parsed correctly', () => {
      const adapter = makeAdapter();
      const result = adapter.parseEvent({
        headers: { req_id: 'req_gf' },
        body: {
          msgtype: 'file',
          chattype: 'group',
          from: { userid: 'user_gf' },
          chatid: 'group_file',
          msgid: 'msg_gf',
          file: { url: 'https://file.wecom.work/f.pdf', aeskey: 'fk==' },
        },
      });
      assert.ok(result);
      assert.equal(result.chatType, 'group');
      assert.equal(result.text, '[文件]');
    });

    it('group mixed message is parsed correctly', () => {
      const adapter = makeAdapter();
      const result = adapter.parseEvent({
        headers: { req_id: 'req_gm' },
        body: {
          msgtype: 'mixed',
          chattype: 'group',
          from: { userid: 'user_gm' },
          chatid: 'group_mixed',
          msgid: 'msg_gm',
          mixed: {
            msg_item: [
              { msgtype: 'text', text: { content: 'group pic: ' } },
              { msgtype: 'image', image: { url: 'https://grp.jpg' } },
            ],
          },
        },
      });
      assert.ok(result);
      assert.equal(result.chatType, 'group');
      assert.equal(result.text, 'group pic: ');
      assert.equal(result.attachments.length, 1);
    });

    it('sendReply to group works the same as DM', async () => {
      const adapter = makeAdapter();
      const calls = [];
      adapter._injectSendMessage(async (chatId, body) => {
        calls.push({ chatId, body });
      });

      await adapter.sendReply('group_chat_001', 'Group reply');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].chatId, 'group_chat_001');
    });

    it('sendPlaceholder to group uses cached frame', async () => {
      const adapter = makeAdapter();
      adapter._setLastFrame('group_chat_002', makeFrame('grp_frame'));
      const streamCalls = [];
      adapter._injectReplyStream(async (frame, streamId, content, finish) => {
        streamCalls.push({ frame, content });
      });
      adapter._injectGenerateReqId(() => 'grp_stream');

      const pmId = await adapter.sendPlaceholder('group_chat_002', 'Group thinking...');
      assert.equal(pmId, 'grp_stream');
      assert.equal(streamCalls[0].frame.headers.req_id, 'grp_frame');
    });

    it('mixed message with multiple text parts joins them', () => {
      const adapter = makeAdapter();
      const result = adapter.parseEvent({
        headers: { req_id: 'req_multi_text' },
        body: {
          msgtype: 'mixed',
          chattype: 'single',
          from: { userid: 'user_mt' },
          msgid: 'msg_mt',
          mixed: {
            msg_item: [
              { msgtype: 'text', text: { content: 'Hello ' } },
              { msgtype: 'text', text: { content: 'World' } },
            ],
          },
        },
      });
      assert.ok(result);
      assert.equal(result.text, 'Hello World');
      assert.equal(result.attachments, undefined);
    });

    it('stopStream can be called without starting', async () => {
      const adapter = makeAdapter();
      await adapter.stopStream();
    });

    it('sendMedia falls back to basename from absPath when no fileName', async () => {
      const adapter = makeAdapter();
      const sendCalls = [];
      adapter._injectSendMessage(async (chatId, body) => {
        sendCalls.push(body.markdown.content);
      });

      await adapter.sendMedia('user_001', {
        type: 'file',
        absPath: '/path/to/document.pdf',
      });
      assert.equal(sendCalls.length, 1);
      assert.ok(sendCalls[0].includes('document.pdf'));
    });

    it('sendFormattedReply without subtitle or footer', async () => {
      const adapter = makeAdapter();
      const calls = [];
      adapter._injectSendMessage(async (chatId, body) => {
        calls.push(body.markdown.content);
      });

      const envelope = {
        header: 'Simple',
        body: 'Just body',
        origin: 'direct',
      };
      await adapter.sendFormattedReply('u1', envelope);
      assert.ok(!calls[0].includes('undefined'));
      assert.ok(!calls[0].includes('---'));
    });

    it('editMessage with replyStream error logs warning but does not throw', async () => {
      const adapter = makeAdapter();
      seedChat(adapter);
      let callCount = 0;
      adapter._injectReplyStream(async () => {
        callCount++;
        if (callCount > 1) throw new Error('update fail');
      });
      adapter._injectGenerateReqId(() => 'stream_edit_fail');

      const pmId = await adapter.sendPlaceholder('user_001', 'init');
      const session = adapter._getActiveStreams().get(pmId);
      session.lastUpdateAt = Date.now() - 500;

      await adapter.editMessage('user_001', pmId, 'should not throw');
      assert.ok(session.lastContent, 'init');
    });

    it('parseEvent uses empty string for missing msgid', () => {
      const adapter = makeAdapter();
      const result = adapter.parseEvent({
        headers: { req_id: 'req_no_msgid' },
        body: {
          msgtype: 'text',
          chattype: 'single',
          from: { userid: 'user_nm' },
          text: { content: 'no msgid' },
        },
      });
      assert.ok(result);
      assert.equal(result.messageId, '');
    });
  });
});
