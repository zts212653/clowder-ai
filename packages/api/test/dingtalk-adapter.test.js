import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DingTalkAdapter } from '../dist/infrastructure/connectors/adapters/DingTalkAdapter.js';

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
  return new DingTalkAdapter(noopLog(), {
    appKey: 'test-key',
    appSecret: 'test-secret',
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

function seedConversation(adapter, staffId = 'staff_001', conversationId = 'conv_seed') {
  adapter.parseEvent({
    msgtype: 'text',
    conversationType: '1',
    conversationId,
    msgId: `msg_seed_${staffId}`,
    senderStaffId: staffId,
    text: { content: 'seed' },
  });
}

describe('DingTalkAdapter', () => {
  describe('connectorId', () => {
    it('is dingtalk', () => {
      assert.equal(makeAdapter().connectorId, 'dingtalk');
    });
  });

  // ── AC-A1: parseEvent — DM text + richText + media ──
  describe('parseEvent()', () => {
    it('extracts text DM message with senderStaffId as chatId', () => {
      const result = makeAdapter().parseEvent({
        msgtype: 'text',
        conversationType: '1',
        conversationId: 'conv_001',
        msgId: 'msg_001',
        senderStaffId: 'staff_123',
        text: { content: '  Hello cat!  ' },
      });
      assert.ok(result);
      assert.equal(result.chatId, 'staff_123');
      assert.equal(result.conversationId, 'conv_001');
      assert.equal(result.text, 'Hello cat!');
      assert.equal(result.messageId, 'msg_001');
      assert.equal(result.senderId, 'staff_123');
      assert.equal(result.chatType, 'p2p');
    });

    it('extracts richText message (flat array format)', () => {
      const result = makeAdapter().parseEvent({
        msgtype: 'richText',
        conversationType: '1',
        conversationId: 'conv_002',
        msgId: 'msg_002',
        senderStaffId: 'staff_456',
        richText: [{ text: 'Hello ' }, { text: 'world' }],
      });
      assert.ok(result);
      assert.equal(result.text, 'Hello world');
      assert.equal(result.chatId, 'staff_456');
      assert.equal(result.conversationId, 'conv_002');
    });

    it('extracts embedded picture downloadCode from richText', () => {
      const result = makeAdapter().parseEvent({
        msgtype: 'richText',
        conversationType: '1',
        conversationId: 'conv_rt',
        msgId: 'msg_rt',
        senderStaffId: 'staff_rt',
        richText: [
          { text: 'Look at this: ' },
          { type: 'picture', downloadCode: 'dl_rt_pic', pictureDownloadCode: 'x' },
        ],
      });
      assert.ok(result);
      assert.equal(result.text, 'Look at this: ');
      assert.ok(result.attachments);
      assert.equal(result.attachments.length, 1);
      assert.equal(result.attachments[0].type, 'image');
      assert.equal(result.attachments[0].downloadCode, 'dl_rt_pic');
    });

    it('extracts picture message with downloadCode', () => {
      const result = makeAdapter().parseEvent({
        msgtype: 'picture',
        conversationType: '1',
        conversationId: 'conv_003',
        msgId: 'msg_003',
        senderStaffId: 'staff_789',
        content: { downloadCode: 'dl_img_001' },
      });
      assert.ok(result);
      assert.equal(result.text, '[图片]');
      assert.equal(result.chatId, 'staff_789');
      assert.deepEqual(result.attachments, [{ type: 'image', downloadCode: 'dl_img_001' }]);
    });

    it('extracts audio message with downloadCode and duration', () => {
      const result = makeAdapter().parseEvent({
        msgtype: 'audio',
        conversationType: '1',
        conversationId: 'conv_004',
        msgId: 'msg_004',
        senderStaffId: 'staff_abc',
        content: { downloadCode: 'dl_audio_001', duration: 5 },
      });
      assert.ok(result);
      assert.equal(result.text, '[语音]');
      assert.deepEqual(result.attachments, [{ type: 'audio', downloadCode: 'dl_audio_001', duration: 5 }]);
    });

    it('extracts file message with downloadCode and fileName', () => {
      const result = makeAdapter().parseEvent({
        msgtype: 'file',
        conversationType: '1',
        conversationId: 'conv_005',
        msgId: 'msg_005',
        senderStaffId: 'staff_def',
        content: { downloadCode: 'dl_file_001', fileName: 'report.pdf' },
      });
      assert.ok(result);
      assert.equal(result.text, '[文件] report.pdf');
      assert.deepEqual(result.attachments, [{ type: 'file', downloadCode: 'dl_file_001', fileName: 'report.pdf' }]);
    });

    it('parses group messages (conversationType=2) after Phase A.2', () => {
      const result = makeAdapter().parseEvent({
        msgtype: 'text',
        conversationType: '2',
        conversationId: 'conv_group',
        openConversationId: 'oci_group_legacy',
        msgId: 'msg_grp',
        senderStaffId: 'staff_grp',
        text: { content: 'Hello group' },
      });
      assert.ok(result, 'group message should now be parsed');
      assert.equal(result.chatType, 'group');
      assert.equal(result.chatId, 'oci_group_legacy');
    });

    it('returns null for unsupported message type', () => {
      const result = makeAdapter().parseEvent({
        msgtype: 'interactive',
        conversationType: '1',
        conversationId: 'conv_006',
        msgId: 'msg_006',
        senderStaffId: 'staff_ghi',
      });
      assert.equal(result, null);
    });

    it('returns null for missing msgtype', () => {
      assert.equal(makeAdapter().parseEvent({ conversationType: '1' }), null);
    });

    it('returns null for null/undefined input', () => {
      assert.equal(makeAdapter().parseEvent(null), null);
      assert.equal(makeAdapter().parseEvent(undefined), null);
    });

    it('returns null for non-object input', () => {
      assert.equal(makeAdapter().parseEvent('not an object'), null);
      assert.equal(makeAdapter().parseEvent(42), null);
    });

    it('falls back to senderId when senderStaffId is missing', () => {
      const result = makeAdapter().parseEvent({
        msgtype: 'text',
        conversationType: '1',
        conversationId: 'conv_007',
        msgId: 'msg_007',
        senderId: 'sender_fallback',
        text: { content: 'hi' },
      });
      assert.ok(result);
      assert.equal(result.senderId, 'sender_fallback');
      assert.equal(result.chatId, 'sender_fallback');
    });

    it('returns null for text message with empty content', () => {
      const result = makeAdapter().parseEvent({
        msgtype: 'text',
        conversationType: '1',
        conversationId: 'conv_008',
        msgId: 'msg_008',
        senderStaffId: 'staff_jkl',
        text: {},
      });
      assert.equal(result, null);
    });

    it('returns null for richText that is not an array', () => {
      const result = makeAdapter().parseEvent({
        msgtype: 'richText',
        conversationType: '1',
        conversationId: 'conv_009',
        msgId: 'msg_009',
        senderStaffId: 'staff_mno',
        richText: { richTextList: [{ text: 'nested' }] },
      });
      assert.equal(result, null);
    });
  });

  // ── AC-A2: sendReply — text + markdown ──
  describe('sendReply()', () => {
    it('calls sendMessage with text msgType', async () => {
      const adapter = makeAdapter();
      const calls = [];
      adapter._injectSendMessage(async (params) => {
        calls.push(params);
      });

      await adapter.sendReply('staff_001', 'Hello from cat!');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].chatId, 'staff_001');
      assert.equal(calls[0].msgType, 'text');
      assert.ok(calls[0].content.includes('Hello from cat!'));
    });
  });

  describe('sendMarkdown()', () => {
    it('calls sendMessage with markdown msgType', async () => {
      const adapter = makeAdapter();
      const calls = [];
      adapter._injectSendMessage(async (params) => {
        calls.push(params);
      });

      await adapter.sendMarkdown('staff_001', 'Title', '**Bold** text');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].chatId, 'staff_001');
      assert.equal(calls[0].msgType, 'markdown');
      assert.ok(calls[0].content.includes('Title'));
      assert.ok(calls[0].content.includes('**Bold** text'));
    });
  });

  // ── AC-A3: sendFormattedReply — AI Card with fallback ──
  describe('sendFormattedReply()', () => {
    it('attempts AI Card, falls back to markdown on error', async () => {
      const adapter = makeAdapter();
      seedConversation(adapter);
      adapter._injectAccessToken(async () => 'test-token');

      const sendCalls = [];
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });

      let createCardCalled = false;
      adapter._injectCreateCard(async () => {
        createCardCalled = true;
        throw new Error('card API unavailable');
      });

      const envelope = {
        header: '🐱 布偶猫',
        body: 'Hello world',
        origin: 'direct',
      };
      await adapter.sendFormattedReply('staff_001', envelope);

      // Must reach createCardFn (not short-circuit via cold-restart path)
      assert.ok(createCardCalled, 'createCardFn must be called to exercise the API-error fallback');
      assert.equal(sendCalls.length, 1);
      assert.equal(sendCalls[0].msgType, 'markdown');
    });

    it('sends via AI Card when available', async () => {
      const adapter = makeAdapter();
      seedConversation(adapter);
      const cardCalls = [];
      const streamCalls = [];
      adapter._injectCreateCard(async (params) => {
        cardCalls.push(params);
      });
      adapter._injectStreamingCard(async (params) => {
        streamCalls.push(params);
      });

      const envelope = {
        header: '🐱 布偶猫',
        body: 'Hello world',
        origin: 'direct',
      };
      await adapter.sendFormattedReply('staff_001', envelope);

      assert.equal(cardCalls.length, 1);
      assert.equal(streamCalls.length, 1);
      assert.equal(streamCalls[0].state, 'FINISHED');
    });

    it('AI Card uses real conversationId from inbound parseEvent, not staffId', async () => {
      const adapter = makeAdapter();
      const cardCalls = [];
      adapter._injectCreateCard(async (params) => {
        cardCalls.push(params);
      });
      adapter._injectStreamingCard(async () => {});

      adapter.parseEvent({
        msgtype: 'text',
        conversationType: '1',
        conversationId: 'cidABCxyz123',
        msgId: 'msg_map',
        senderStaffId: 'staff_map',
        text: { content: 'hi' },
      });

      const envelope = { header: 'Cat', body: 'Reply', origin: 'direct' };
      await adapter.sendFormattedReply('staff_map', envelope);

      assert.equal(cardCalls.length, 1);
      assert.equal(cardCalls[0].cardData.conversationId, 'cidABCxyz123');
    });

    it('falls back to markdown when no conversationId mapped (cold restart)', async () => {
      const adapter = makeAdapter();
      const sendCalls = [];
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });
      adapter._injectCreateCard(async () => {});
      adapter._injectStreamingCard(async () => {});

      const envelope = { header: 'Cat', body: 'Reply after restart', origin: 'direct' };
      await adapter.sendFormattedReply('staff_no_map', envelope);

      assert.equal(sendCalls.length, 1);
      assert.equal(sendCalls[0].msgType, 'markdown');
    });

    it('prefixes callback origin with 📨', async () => {
      const adapter = makeAdapter();
      seedConversation(adapter);
      const cardCalls = [];
      adapter._injectCreateCard(async (params) => {
        cardCalls.push(params);
      });
      adapter._injectStreamingCard(async () => {});

      const envelope = {
        header: '🐱 布偶猫',
        body: 'Callback message',
        origin: 'callback',
      };
      await adapter.sendFormattedReply('staff_001', envelope);

      assert.equal(cardCalls.length, 1);
      assert.ok(cardCalls[0].cardData.headerText.includes('📨'));
    });
  });

  // ── AC-A4: AI Card streaming (create → update → finish) ──
  describe('sendPlaceholder() + editMessage() + deleteMessage()', () => {
    it('creates AI Card and returns outTrackId', async () => {
      const adapter = makeAdapter();
      seedConversation(adapter);
      const cardCalls = [];
      adapter._injectCreateCard(async (params) => {
        cardCalls.push(params);
      });

      const outTrackId = await adapter.sendPlaceholder('staff_001', 'Thinking...');
      assert.ok(outTrackId.startsWith('cc-'));
      assert.equal(cardCalls.length, 1);
    });

    it('sendPlaceholder resolves conversationId from prior inbound message', async () => {
      const adapter = makeAdapter();
      const cardCalls = [];
      adapter._injectCreateCard(async (params) => {
        cardCalls.push(params);
      });

      adapter.parseEvent({
        msgtype: 'text',
        conversationType: '1',
        conversationId: 'cidPlaceholder999',
        msgId: 'msg_ph',
        senderStaffId: 'staff_ph',
        text: { content: 'hi' },
      });

      await adapter.sendPlaceholder('staff_ph', 'Thinking...');
      assert.equal(cardCalls.length, 1);
      assert.equal(cardCalls[0].cardData.conversationId, 'cidPlaceholder999');
    });

    it('sendPlaceholder returns empty when no conversationId mapped (cold restart)', async () => {
      const adapter = makeAdapter();
      adapter._injectCreateCard(async () => {});

      const result = await adapter.sendPlaceholder('staff_unmapped', 'Thinking...');
      assert.equal(result, '');
    });

    it('returns empty string when createCard fails', async () => {
      const adapter = makeAdapter();
      adapter._injectCreateCard(async () => {
        throw new Error('fail');
      });

      const result = await adapter.sendPlaceholder('staff_001', 'Thinking...');
      assert.equal(result, '');
    });

    it('editMessage updates AI Card with content', async () => {
      const adapter = makeAdapter();
      seedConversation(adapter);
      const streamCalls = [];
      adapter._injectCreateCard(async () => {});
      adapter._injectStreamingCard(async (params) => {
        streamCalls.push(params);
      });

      const outTrackId = await adapter.sendPlaceholder('staff_001', 'Thinking...');
      assert.ok(outTrackId);

      await adapter.editMessage('staff_001', outTrackId, 'Partial response...');
      assert.equal(streamCalls.length, 1);
      assert.equal(streamCalls[0].content, 'Partial response...');
      assert.equal(streamCalls[0].state, 'INPUTING');
    });

    it('editMessage throttles at 300ms', async () => {
      const adapter = makeAdapter();
      seedConversation(adapter);
      const streamCalls = [];
      adapter._injectCreateCard(async () => {});
      adapter._injectStreamingCard(async (params) => {
        streamCalls.push(params);
      });

      const outTrackId = await adapter.sendPlaceholder('staff_001', 'Thinking...');

      await adapter.editMessage('staff_001', outTrackId, 'update 1');
      assert.equal(streamCalls.length, 1);

      await adapter.editMessage('staff_001', outTrackId, 'update 2');
      assert.equal(streamCalls.length, 1);
    });

    it('deleteMessage finishes AI Card', async () => {
      const adapter = makeAdapter();
      seedConversation(adapter);
      const streamCalls = [];
      adapter._injectCreateCard(async () => {});
      adapter._injectStreamingCard(async (params) => {
        streamCalls.push(params);
      });

      const outTrackId = await adapter.sendPlaceholder('staff_001', 'Thinking...');
      await adapter.deleteMessage(outTrackId);

      assert.ok(streamCalls.length >= 1);
      const lastCall = streamCalls[streamCalls.length - 1];
      assert.equal(lastCall.state, 'FINISHED');
    });

    it('deleteMessage is no-op for unknown card', async () => {
      const adapter = makeAdapter();
      const streamCalls = [];
      adapter._injectStreamingCard(async (params) => {
        streamCalls.push(params);
      });

      await adapter.deleteMessage('nonexistent');
      assert.equal(streamCalls.length, 0);
    });

    it('editMessage is no-op for unknown card', async () => {
      const adapter = makeAdapter();
      const streamCalls = [];
      adapter._injectStreamingCard(async (params) => {
        streamCalls.push(params);
      });

      await adapter.editMessage('staff_001', 'nonexistent', 'text');
      assert.equal(streamCalls.length, 0);
    });
  });

  // ── AC-A5: sendMedia + downloadMedia ──
  describe('sendMedia()', () => {
    it('sends image via sampleImageMsg when URL is provided', async () => {
      const adapter = makeAdapter();
      const sendCalls = [];
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });

      await adapter.sendMedia('staff_001', { type: 'image', url: 'https://example.com/photo.png' });
      assert.equal(sendCalls.length, 1);
      assert.equal(sendCalls[0].msgType, 'image');
      assert.ok(sendCalls[0].content.includes('https://example.com/photo.png'));
    });

    it('falls back to text link for audio URL', async () => {
      const adapter = makeAdapter();
      const sendCalls = [];
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });

      await adapter.sendMedia('staff_001', { type: 'audio', url: 'https://example.com/voice.mp3' });
      assert.equal(sendCalls.length, 1);
      assert.equal(sendCalls[0].msgType, 'text');
      assert.ok(sendCalls[0].content.includes('🔊'));
    });

    it('falls back to fileName when absPath is provided without URL', async () => {
      const adapter = makeAdapter();
      const sendCalls = [];
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });

      await adapter.sendMedia('staff_001', { type: 'file', absPath: '/tmp/report.pdf', fileName: 'report.pdf' });
      assert.equal(sendCalls.length, 1);
      assert.equal(sendCalls[0].msgType, 'text');
      assert.ok(sendCalls[0].content.includes('📎'));
      assert.ok(sendCalls[0].content.includes('report.pdf'));
    });

    it('falls back to absPath basename for local images without URL', async () => {
      const adapter = makeAdapter();
      const sendCalls = [];
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });

      await adapter.sendMedia('staff_001', { type: 'image', absPath: '/tmp/generated-photo.png' });
      assert.equal(sendCalls.length, 1);
      assert.equal(sendCalls[0].msgType, 'text');
      assert.ok(sendCalls[0].content.includes('🖼️'));
      assert.ok(sendCalls[0].content.includes('generated-photo.png'));
    });

    it('handles missing URL gracefully', async () => {
      const adapter = makeAdapter();
      const sendCalls = [];
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });

      await adapter.sendMedia('staff_001', { type: 'file' });
      assert.equal(sendCalls.length, 0);
    });
  });

  // ── AC-A1.1~A1.5: Phase A.1 — Native media sending via upload + mediaId ──
  describe('sendMedia() — Phase A.1 native upload', () => {
    // AC-A1.1: Audio sends natively via sampleAudio msgKey (not text fallback)
    it('uploads audio file and sends via sampleAudio with mediaId + duration', async () => {
      const adapter = makeAdapter();
      const uploadCalls = [];
      const sendCalls = [];

      adapter._injectUploadMedia(async ({ filePath, type }) => {
        uploadCalls.push({ filePath, type });
        return 'media_audio_001';
      });
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });

      await adapter.sendMedia('staff_001', {
        type: 'audio',
        absPath: '/tmp/voice.mp3',
        duration: 5200,
      });

      assert.equal(uploadCalls.length, 1);
      assert.equal(uploadCalls[0].filePath, '/tmp/voice.mp3');
      assert.equal(sendCalls.length, 1);
      assert.equal(sendCalls[0].msgType, 'sampleAudio');
      const parsed = JSON.parse(sendCalls[0].content);
      assert.equal(parsed.mediaId, 'media_audio_001');
      assert.equal(parsed.duration, '5200');
    });

    // AC-A1.2: File sends natively via sampleFile msgKey (not text fallback)
    it('uploads file and sends via sampleFile with mediaId + fileName + fileType', async () => {
      const adapter = makeAdapter();
      const uploadCalls = [];
      const sendCalls = [];

      adapter._injectUploadMedia(async ({ filePath, type }) => {
        uploadCalls.push({ filePath, type });
        return 'media_file_001';
      });
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });

      await adapter.sendMedia('staff_001', {
        type: 'file',
        absPath: '/tmp/report.pdf',
        fileName: 'report.pdf',
      });

      assert.equal(uploadCalls.length, 1);
      assert.equal(uploadCalls[0].filePath, '/tmp/report.pdf');
      assert.equal(sendCalls.length, 1);
      assert.equal(sendCalls[0].msgType, 'sampleFile');
      const parsed = JSON.parse(sendCalls[0].content);
      assert.equal(parsed.mediaId, 'media_file_001');
      assert.equal(parsed.fileName, 'report.pdf');
      assert.equal(parsed.fileType, 'pdf');
    });

    // AC-A1.3: Image with absPath uploads and sends via sampleImageMsg
    it('uploads image from absPath and sends via sampleImageMsg', async () => {
      const adapter = makeAdapter();
      const uploadCalls = [];
      const sendCalls = [];

      adapter._injectUploadMedia(async ({ filePath, type }) => {
        uploadCalls.push({ filePath, type });
        return 'media_img_001';
      });
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });

      await adapter.sendMedia('staff_001', {
        type: 'image',
        absPath: '/tmp/generated-photo.png',
      });

      assert.equal(uploadCalls.length, 1);
      assert.equal(uploadCalls[0].filePath, '/tmp/generated-photo.png');
      assert.equal(sendCalls.length, 1);
      assert.equal(sendCalls[0].msgType, 'sampleImageMsg');
      const parsed = JSON.parse(sendCalls[0].content);
      assert.ok(parsed.photoURL, 'Must include photoURL (mediaId as photoURL)');
    });

    // AC-A1.5: Image with URL still sends via sampleImageMsg (fast path preserved)
    it('image with URL still uses the direct photoURL fast path', async () => {
      const adapter = makeAdapter();
      const sendCalls = [];

      // No upload injected — should use direct URL path
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });

      await adapter.sendMedia('staff_001', { type: 'image', url: 'https://example.com/cat.jpg' });
      assert.equal(sendCalls.length, 1);
      assert.equal(sendCalls[0].msgType, 'image');
      assert.ok(sendCalls[0].content.includes('https://example.com/cat.jpg'));
    });

    // AC-A1.5: Upload failure gracefully falls back to text
    it('falls back to text if upload fails', async () => {
      const adapter = makeAdapter();
      const sendCalls = [];

      adapter._injectUploadMedia(async () => {
        throw new Error('upload network error');
      });
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });

      await adapter.sendMedia('staff_001', {
        type: 'audio',
        absPath: '/tmp/voice.mp3',
        url: 'https://example.com/voice.mp3',
      });

      // Should fall back to text with the URL
      assert.equal(sendCalls.length, 1);
      assert.equal(sendCalls[0].msgType, 'text');
      assert.ok(sendCalls[0].content.includes('🔊'));
      assert.ok(sendCalls[0].content.includes('https://example.com/voice.mp3'));
    });

    // AC-A1.4: File extension extraction for sampleFile
    it('extracts file extension correctly for sampleFile fileType', async () => {
      const adapter = makeAdapter();
      const sendCalls = [];

      adapter._injectUploadMedia(async () => 'media_doc_001');
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });

      await adapter.sendMedia('staff_001', {
        type: 'file',
        absPath: '/tmp/presentation.pptx',
        fileName: 'presentation.pptx',
      });

      assert.equal(sendCalls.length, 1);
      const parsed = JSON.parse(sendCalls[0].content);
      assert.equal(parsed.fileType, 'pptx');
    });

    // AC-A1.5: Audio with URL but no absPath — falls back to text (no upload without absPath)
    it('audio with URL only falls back to text when no upload function available', async () => {
      const adapter = makeAdapter();
      const sendCalls = [];
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });

      await adapter.sendMedia('staff_001', { type: 'audio', url: 'https://example.com/voice.mp3' });
      assert.equal(sendCalls.length, 1);
      assert.equal(sendCalls[0].msgType, 'text');
      assert.ok(sendCalls[0].content.includes('🔊'));
    });
  });

  describe('downloadMedia()', () => {
    it('returns download URL from injected function', async () => {
      const adapter = makeAdapter();
      adapter._injectDownloadMedia(async (code) => `https://cdn.dingtalk.com/${code}`);

      const url = await adapter.downloadMedia('dl_code_123');
      assert.equal(url, 'https://cdn.dingtalk.com/dl_code_123');
    });
  });

  // ── AC-A6: Public layer zero change ──
  describe('IStreamableOutboundAdapter compliance', () => {
    it('implements all required methods', () => {
      const adapter = makeAdapter();
      assert.equal(typeof adapter.sendReply, 'function');
      assert.equal(typeof adapter.sendFormattedReply, 'function');
      assert.equal(typeof adapter.sendRichMessage, 'function');
      assert.equal(typeof adapter.sendPlaceholder, 'function');
      assert.equal(typeof adapter.editMessage, 'function');
      assert.equal(typeof adapter.deleteMessage, 'function');
      assert.equal(typeof adapter.sendMedia, 'function');
      assert.equal(typeof adapter.downloadMedia, 'function');
    });
  });

  // ── sendRichMessage ──
  describe('sendRichMessage()', () => {
    it('sends markdown with cat display name', async () => {
      const adapter = makeAdapter();
      const sendCalls = [];
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });

      await adapter.sendRichMessage('staff_001', 'Some text', [], '布偶猫');
      assert.equal(sendCalls.length, 1);
      assert.equal(sendCalls[0].msgType, 'markdown');
      assert.ok(sendCalls[0].content.includes('布偶猫'));
    });
  });

  // ══════════════════════════════════════════════════════
  // Phase A.2: Group Chat Support (AC-A2.1 ~ AC-A2.7)
  // ══════════════════════════════════════════════════════

  // ── AC-A2.1: Group message inbound parsing ──
  describe('parseEvent() — group chat', () => {
    it('parses group text message (conversationType=2)', () => {
      const adapter = makeAdapter();
      const result = adapter.parseEvent({
        msgtype: 'text',
        conversationType: '2',
        conversationId: 'cidXXXXXXXXX',
        openConversationId: 'oci_group_001',
        conversationTitle: '产品讨论群',
        msgId: 'msg_g001',
        senderStaffId: 'staff_sender_1',
        senderNick: '张三',
        senderId: '$:LWCP_v1:$encrypted',
        text: { content: '你好猫猫' },
        isInAtList: true,
        atUsers: [{ dingtalkId: 'bot123' }],
      });
      assert.ok(result, 'group message should be parsed, not null');
      assert.equal(result.chatType, 'group');
      assert.equal(result.text, '你好猫猫');
      assert.equal(result.senderId, 'staff_sender_1');
      assert.equal(result.senderNick, '张三');
      assert.equal(result.chatId, 'oci_group_001', 'group chatId should be openConversationId');
      assert.equal(result.conversationTitle, '产品讨论群');
    });

    it('still parses DM messages (conversationType=1) correctly', () => {
      const adapter = makeAdapter();
      const result = adapter.parseEvent({
        msgtype: 'text',
        conversationType: '1',
        conversationId: 'conv_001',
        msgId: 'msg_d001',
        senderStaffId: 'staff_dm_1',
        text: { content: 'DM message' },
      });
      assert.ok(result);
      assert.equal(result.chatType, 'p2p');
      assert.equal(result.chatId, 'staff_dm_1', 'DM chatId should still be staffId');
    });

    it('returns senderNick from group event payload', () => {
      const adapter = makeAdapter();
      const result = adapter.parseEvent({
        msgtype: 'text',
        conversationType: '2',
        openConversationId: 'oci_group_002',
        conversationId: 'cid002',
        conversationTitle: '测试群',
        msgId: 'msg_g002',
        senderStaffId: 'staff_s2',
        senderNick: '李四',
        text: { content: 'hello' },
      });
      assert.ok(result);
      assert.equal(result.senderNick, '李四');
    });

    it('parses group richText message', () => {
      const adapter = makeAdapter();
      const result = adapter.parseEvent({
        msgtype: 'richText',
        conversationType: '2',
        openConversationId: 'oci_group_003',
        conversationId: 'cid003',
        msgId: 'msg_g003',
        senderStaffId: 'staff_s3',
        senderNick: '王五',
        richText: [{ text: 'Group ' }, { text: 'rich text' }],
      });
      assert.ok(result);
      assert.equal(result.chatType, 'group');
      assert.equal(result.text, 'Group rich text');
    });

    it('parses group image message', () => {
      const adapter = makeAdapter();
      const result = adapter.parseEvent({
        msgtype: 'picture',
        conversationType: '2',
        openConversationId: 'oci_group_004',
        conversationId: 'cid004',
        msgId: 'msg_g004',
        senderStaffId: 'staff_s4',
        senderNick: '赵六',
        content: { downloadCode: 'dc_img_group' },
      });
      assert.ok(result);
      assert.equal(result.chatType, 'group');
      assert.equal(result.chatId, 'oci_group_004');
      assert.equal(result.attachments?.[0]?.downloadCode, 'dc_img_group');
    });

    it('rejects unknown conversationType', () => {
      const adapter = makeAdapter();
      const result = adapter.parseEvent({
        msgtype: 'text',
        conversationType: '3',
        conversationId: 'cid_unknown',
        msgId: 'msg_u001',
        senderStaffId: 'staff_u1',
        text: { content: 'unknown type' },
      });
      assert.equal(result, null, 'should reject unknown conversationType');
    });
  });

  // ── AC-A2.2: Group message outbound via orgGroupSend ──
  describe('sendReply() — group chat', () => {
    it('sends to orgGroupSend for group chatId (openConversationId)', async () => {
      const adapter = makeAdapter();
      const sendCalls = [];
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });
      // Seed a group conversation so the adapter knows oci_group_001 is a group
      adapter.parseEvent({
        msgtype: 'text',
        conversationType: '2',
        openConversationId: 'oci_group_001',
        conversationId: 'cid001',
        msgId: 'msg_seed_g',
        senderStaffId: 'staff_1',
        senderNick: '张三',
        text: { content: 'seed' },
      });

      await adapter.sendReply('oci_group_001', 'Hello group!');
      assert.equal(sendCalls.length, 1);
      assert.equal(sendCalls[0].chatId, 'oci_group_001');
      assert.equal(sendCalls[0].chatType, 'group');
    });

    it('still sends via batchSendOTO for DM chatId', async () => {
      const adapter = makeAdapter();
      const sendCalls = [];
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });
      seedConversation(adapter, 'staff_dm_2', 'conv_dm_2');

      await adapter.sendReply('staff_dm_2', 'Hello DM!');
      assert.equal(sendCalls.length, 1);
      assert.equal(sendCalls[0].chatId, 'staff_dm_2');
      // DM should not have chatType 'group'
      assert.notEqual(sendCalls[0].chatType, 'group');
    });
  });

  // ── AC-A2.4: @sender mention in group replies ──
  describe('sendReply() — @sender in group chat', () => {
    it('prepends @senderNick when metadata.replyToSender is provided', async () => {
      const adapter = makeAdapter();
      const sendCalls = [];
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });
      // Seed group
      adapter.parseEvent({
        msgtype: 'text',
        conversationType: '2',
        openConversationId: 'oci_at_group',
        conversationId: 'cid_at',
        msgId: 'msg_at_seed',
        senderStaffId: 'staff_at_1',
        senderNick: '张三',
        text: { content: 'seed' },
      });

      await adapter.sendReply('oci_at_group', '这是回复', {
        replyToSender: { id: 'staff_at_1', name: '张三' },
      });
      assert.equal(sendCalls.length, 1);
      const content = JSON.parse(sendCalls[0].content);
      assert.ok(content.content.includes('张三'), `reply should mention sender name, got: ${content.content}`);
    });

    it('does NOT prepend @sender for DM replies', async () => {
      const adapter = makeAdapter();
      const sendCalls = [];
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });
      seedConversation(adapter, 'staff_no_at', 'conv_no_at');

      await adapter.sendReply('staff_no_at', 'DM reply', {
        replyToSender: { id: 'staff_no_at', name: '李四' },
      });
      assert.equal(sendCalls.length, 1);
      const content = JSON.parse(sendCalls[0].content);
      // DM should NOT have @mention prepended
      assert.ok(!content.content.includes('@'), `DM reply should not @mention, got: ${content.content}`);
    });
  });

  // ── AC-A2.3: AI Card group delivery ──
  describe('sendPlaceholder() — group AI Card', () => {
    it('creates AI Card with imGroupOpenDeliverModel for group chat', async () => {
      const adapter = makeAdapter();
      const cardCalls = [];
      adapter._injectCreateCard(async (params) => {
        cardCalls.push(params);
      });
      // Seed group conversation
      adapter.parseEvent({
        msgtype: 'text',
        conversationType: '2',
        openConversationId: 'oci_card_group',
        conversationId: 'cid_card',
        msgId: 'msg_card_seed',
        senderStaffId: 'staff_card_1',
        senderNick: '王五',
        text: { content: 'seed' },
      });

      const outTrackId = await adapter.sendPlaceholder('oci_card_group', '🐱 猫猫思考中...');
      assert.ok(outTrackId, 'should return non-empty outTrackId');
      assert.equal(cardCalls.length, 1);
      // Verify the card call includes group-specific data
      assert.equal(cardCalls[0].cardData.chatType, 'group');
      assert.equal(cardCalls[0].cardData.openConversationId, 'oci_card_group');
    });
  });

  // ── AC-A2.5: Name resolution with TTL cache ──
  describe('resolveSenderName()', () => {
    it('returns senderNick from cached inbound event data', () => {
      const adapter = makeAdapter();
      // Parse a group message to cache the sender name
      adapter.parseEvent({
        msgtype: 'text',
        conversationType: '2',
        openConversationId: 'oci_name_group',
        conversationId: 'cid_name',
        msgId: 'msg_name_001',
        senderStaffId: 'staff_name_1',
        senderNick: '赵六',
        text: { content: 'hello' },
      });

      const name = adapter.resolveSenderName('staff_name_1');
      assert.equal(name, '赵六');
    });

    it('returns undefined for unknown staffId', () => {
      const adapter = makeAdapter();
      const name = adapter.resolveSenderName('unknown_staff');
      assert.equal(name, undefined);
    });
  });

  describe('resolveConversationTitle()', () => {
    it('returns conversationTitle from cached inbound event data', () => {
      const adapter = makeAdapter();
      adapter.parseEvent({
        msgtype: 'text',
        conversationType: '2',
        openConversationId: 'oci_title_group',
        conversationId: 'cid_title',
        conversationTitle: '产品讨论群',
        msgId: 'msg_title_001',
        senderStaffId: 'staff_t1',
        senderNick: '钱七',
        text: { content: 'hello' },
      });

      const title = adapter.resolveConversationTitle('oci_title_group');
      assert.equal(title, '产品讨论群');
    });

    it('returns undefined for unknown openConversationId', () => {
      const adapter = makeAdapter();
      const title = adapter.resolveConversationTitle('unknown_oci');
      assert.equal(title, undefined);
    });
  });

  // ── AC-A2.2: Group media sending via orgGroupSend ──
  describe('sendMedia() — group chat', () => {
    it('sends image to group via orgGroupSend path', async () => {
      const adapter = makeAdapter();
      const sendCalls = [];
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });
      // Seed group
      adapter.parseEvent({
        msgtype: 'text',
        conversationType: '2',
        openConversationId: 'oci_media_group',
        conversationId: 'cid_media',
        msgId: 'msg_media_seed',
        senderStaffId: 'staff_m1',
        senderNick: '孙八',
        text: { content: 'seed' },
      });

      await adapter.sendMedia('oci_media_group', {
        type: 'image',
        url: 'https://example.com/cat.jpg',
      });
      assert.equal(sendCalls.length, 1);
      assert.equal(sendCalls[0].chatId, 'oci_media_group');
      assert.equal(sendCalls[0].chatType, 'group');
    });
  });

  // ── AC-A2.6: chatId mapping — group uses openConversationId ──
  describe('chatId mapping for groups', () => {
    it('maps staffToConversation for DM (staffId → conversationId)', () => {
      const adapter = makeAdapter();
      const parsed = adapter.parseEvent({
        msgtype: 'text',
        conversationType: '1',
        conversationId: 'conv_map_dm',
        msgId: 'msg_map_1',
        senderStaffId: 'staff_map_1',
        text: { content: 'hi' },
      });
      assert.ok(parsed);
      assert.equal(parsed.chatId, 'staff_map_1', 'DM chatId = staffId');
    });

    it('maps openConversationId as chatId for group', () => {
      const adapter = makeAdapter();
      const parsed = adapter.parseEvent({
        msgtype: 'text',
        conversationType: '2',
        conversationId: 'cid_map_g',
        openConversationId: 'oci_map_group',
        conversationTitle: '映射测试群',
        msgId: 'msg_map_2',
        senderStaffId: 'staff_map_2',
        senderNick: '映射者',
        text: { content: 'group msg' },
      });
      assert.ok(parsed);
      assert.equal(parsed.chatId, 'oci_map_group', 'group chatId = openConversationId');
    });
  });

  // ── P1-2 fix: Cold-start outbound — metadata.chatType fallback ──
  describe('sendReply() — cold-start group routing', () => {
    it('routes to group when metadata.chatType=group even without prior parseEvent', async () => {
      const adapter = makeAdapter();
      const sendCalls = [];
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });
      // NO parseEvent — simulating cold start with no inbound history
      await adapter.sendReply('oci_cold_group', 'Cold start reply', { chatType: 'group' });
      assert.equal(sendCalls.length, 1);
      assert.equal(sendCalls[0].chatType, 'group', 'should route as group via metadata fallback');
    });

    it('routes to DM when metadata.chatType is absent and no prior parseEvent', async () => {
      const adapter = makeAdapter();
      const sendCalls = [];
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });
      seedConversation(adapter, 'staff_cold_dm', 'conv_cold_dm');
      await adapter.sendReply('staff_cold_dm', 'Cold DM reply');
      assert.equal(sendCalls.length, 1);
      assert.equal(sendCalls[0].chatType, 'p2p', 'should route as DM by default');
    });

    it('@sender prepend works from metadata.chatType even without inbound cache', async () => {
      const adapter = makeAdapter();
      const sendCalls = [];
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });
      await adapter.sendReply('oci_cold_at', 'test reply', {
        chatType: 'group',
        replyToSender: { id: 'staff_cold_at', name: '冷启动用户' },
      });
      assert.equal(sendCalls.length, 1);
      const content = JSON.parse(sendCalls[0].content);
      assert.ok(content.content.includes('冷启动用户'), `should @mention from metadata, got: ${content.content}`);
    });
  });

  // ── P1-2 fix: Cold-start AI Card group delivery ──
  describe('sendPlaceholder() — cold-start group AI Card', () => {
    it('creates group AI Card when metadata provides chatType=group', async () => {
      const adapter = makeAdapter();
      const cardCalls = [];
      adapter._injectCreateCard(async (params) => {
        cardCalls.push(params);
      });
      // NO parseEvent — adapter doesn't know this chatId is a group from inbound
      // But we can register it explicitly for the card path
      adapter.registerGroupChatId('oci_cold_card_group');

      const outTrackId = await adapter.sendPlaceholder('oci_cold_card_group', '🐱 思考中...');
      assert.ok(outTrackId);
      assert.equal(cardCalls.length, 1);
      assert.equal(cardCalls[0].cardData.chatType, 'group');
      assert.equal(cardCalls[0].cardData.openConversationId, 'oci_cold_card_group');
    });
  });

  // ── P1-2 fix: sendMedia cold-start group routing ──
  describe('sendMedia() — cold-start group routing', () => {
    it('routes image to group via metadata.chatType', async () => {
      const adapter = makeAdapter();
      const sendCalls = [];
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });
      // Register as group without parseEvent
      adapter.registerGroupChatId('oci_cold_media');
      await adapter.sendMedia('oci_cold_media', {
        type: 'image',
        url: 'https://example.com/cat.jpg',
      });
      assert.equal(sendCalls.length, 1);
      assert.equal(sendCalls[0].chatType, 'group');
    });
  });

  // ── P1-2 fix round 2: sendFormattedReply cold-start group routing ──
  describe('sendFormattedReply() — cold-start group routing', () => {
    it('routes AI Card to group via metadata.chatType on cold start', async () => {
      const adapter = makeAdapter();
      const cardCalls = [];
      const streamCalls = [];
      adapter._injectCreateCard(async (params) => {
        cardCalls.push(params);
      });
      adapter._injectStreamingCard(async (params) => {
        streamCalls.push(params);
      });
      // NO parseEvent, NO registerGroupChatId — pure metadata-driven
      const envelope = { header: '🐱 猫猫', body: 'Cold start group reply', origin: 'direct' };
      await adapter.sendFormattedReply('oci_cold_formatted', envelope, { chatType: 'group' });

      assert.equal(cardCalls.length, 1, 'AI Card should be created');
      assert.equal(cardCalls[0].cardData.chatType, 'group', 'should route as group card');
      assert.equal(cardCalls[0].cardData.openConversationId, 'oci_cold_formatted');
    });

    it('falls back to group markdown when AI Card fails on cold start', async () => {
      const adapter = makeAdapter();
      const sendCalls = [];
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });
      adapter._injectCreateCard(async () => {
        throw new Error('card API unavailable');
      });

      const envelope = { header: '🐱 猫猫', body: 'Fallback test', origin: 'direct' };
      await adapter.sendFormattedReply('oci_cold_fallback', envelope, { chatType: 'group' });

      assert.equal(sendCalls.length, 1, 'markdown fallback should fire');
      assert.equal(sendCalls[0].chatType, 'group', 'fallback should still route as group');
    });

    it('still routes as DM when metadata.chatType is absent', async () => {
      const adapter = makeAdapter();
      seedConversation(adapter, 'staff_fmt_dm', 'conv_fmt_dm');
      const cardCalls = [];
      adapter._injectCreateCard(async (params) => {
        cardCalls.push(params);
      });
      adapter._injectStreamingCard(async () => {});

      const envelope = { header: '🐱 猫猫', body: 'DM reply', origin: 'direct' };
      await adapter.sendFormattedReply('staff_fmt_dm', envelope);

      assert.equal(cardCalls.length, 1);
      assert.equal(cardCalls[0].cardData.chatType, 'p2p', 'should route as DM card');
    });
  });

  // ── Redis persistence for group chatId set (cold-restart survival) ──
  describe('hydrateGroupChatIds() — Redis persistence', () => {
    it('hydrates groupConversationIds from Redis on startup', async () => {
      const { mock } = makeRedisMock(['oci_persisted_1', 'oci_persisted_2']);
      const adapter = makeAdapter({ redis: mock });
      const sendCalls = [];
      adapter._injectSendMessage(async (params) => {
        sendCalls.push(params);
      });

      await adapter.hydrateGroupChatIds();

      // After hydration, sending to oci_persisted_1 should route as group
      await adapter.sendReply('oci_persisted_1', 'Hello group!');
      assert.equal(sendCalls[0].chatType, 'group', 'hydrated chatId should route as group');
    });

    it('registerGroupChatId persists to Redis via SADD', async () => {
      const { mock, saddCalls } = makeRedisMock();
      const adapter = makeAdapter({ redis: mock });

      adapter.registerGroupChatId('oci_new_group');

      assert.equal(saddCalls.length, 1);
      assert.equal(saddCalls[0].key, 'dingtalk-group-chat-ids');
      assert.deepEqual(saddCalls[0].vals, ['oci_new_group']);
    });

    it('cold-start sendFormattedReply works with hydrated Redis data (no metadata needed)', async () => {
      const { mock } = makeRedisMock(['oci_hydrated_group']);
      const adapter = makeAdapter({ redis: mock });
      await adapter.hydrateGroupChatIds();

      const cardCalls = [];
      adapter._injectCreateCard(async (params) => {
        cardCalls.push(params);
      });
      adapter._injectStreamingCard(async () => {});

      // NO metadata.chatType — purely relying on hydrated groupConversationIds
      const envelope = { header: '🐱 猫猫', body: 'Hydrated group reply', origin: 'direct' };
      await adapter.sendFormattedReply('oci_hydrated_group', envelope);

      assert.equal(cardCalls.length, 1, 'AI Card should be created');
      assert.equal(cardCalls[0].cardData.chatType, 'group', 'should route as group from hydrated set');
      assert.equal(cardCalls[0].cardData.openConversationId, 'oci_hydrated_group');
    });

    it('gracefully handles missing Redis (no-op)', async () => {
      const adapter = makeAdapter(); // no redis
      await adapter.hydrateGroupChatIds(); // should not throw
    });
  });
});
