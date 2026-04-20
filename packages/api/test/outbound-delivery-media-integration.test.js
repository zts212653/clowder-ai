import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('OutboundDeliveryHook — media delivery integration', () => {
  it('sends synthesized audio via sendMedia when audio block has url', async () => {
    const { OutboundDeliveryHook } = await import('../dist/infrastructure/connectors/OutboundDeliveryHook.js');

    const sendMediaCalls = [];
    const mockAdapter = {
      connectorId: 'feishu',
      async sendReply() {},
      async sendMedia(chatId, payload) {
        sendMediaCalls.push({ chatId, payload });
      },
      async sendRichMessage() {},
    };

    const hook = new OutboundDeliveryHook({
      bindingStore: {
        async getByThread() {
          return [{ connectorId: 'feishu', externalChatId: 'chat1', threadId: 'T1', userId: 'u1', createdAt: 0 }];
        },
      },
      adapters: new Map([['feishu', mockAdapter]]),
      log: { info() {}, warn() {}, error() {}, debug() {} },
    });

    await hook.deliver('T1', 'Here is the voice message', 'opus', [
      { id: 'block1', kind: 'audio', v: 1, url: '/api/tts/audio/abc123.wav', text: '你好' },
    ]);

    assert.equal(sendMediaCalls.length, 1);
    assert.equal(sendMediaCalls[0].chatId, 'chat1');
    assert.equal(sendMediaCalls[0].payload.type, 'audio');
    assert.equal(sendMediaCalls[0].payload.url, '/api/tts/audio/abc123.wav');
  });

  it('sends media_gallery image blocks via sendMedia for https URLs', async () => {
    const { OutboundDeliveryHook } = await import('../dist/infrastructure/connectors/OutboundDeliveryHook.js');

    const sendMediaCalls = [];
    const mockAdapter = {
      connectorId: 'telegram',
      async sendReply() {},
      async sendMedia(chatId, payload) {
        sendMediaCalls.push({ chatId, payload });
      },
      async sendRichMessage() {},
    };

    const hook = new OutboundDeliveryHook({
      bindingStore: {
        async getByThread() {
          return [{ connectorId: 'telegram', externalChatId: 'chat2', threadId: 'T2', userId: 'u1', createdAt: 0 }];
        },
      },
      adapters: new Map([['telegram', mockAdapter]]),
      log: { info() {}, warn() {}, error() {}, debug() {} },
    });

    await hook.deliver('T2', 'Check this image', undefined, [
      {
        id: 'block1',
        kind: 'media_gallery',
        v: 1,
        items: [
          { url: 'https://example.com/photo.jpg', type: 'image' },
          { url: 'https://example.com/doc.pdf', type: 'file' },
        ],
      },
    ]);

    // Only the image item should be sent, not the file item
    assert.equal(sendMediaCalls.length, 1);
    assert.equal(sendMediaCalls[0].payload.type, 'image');
    assert.equal(sendMediaCalls[0].payload.url, 'https://example.com/photo.jpg');
  });

  it('skips media_gallery local image URL when resolver cannot resolve absPath', async () => {
    const { OutboundDeliveryHook } = await import('../dist/infrastructure/connectors/OutboundDeliveryHook.js');

    const sendMediaCalls = [];
    const mockAdapter = {
      connectorId: 'telegram',
      async sendReply() {},
      async sendMedia(chatId, payload) {
        sendMediaCalls.push({ chatId, payload });
      },
      async sendRichMessage() {},
    };

    const hook = new OutboundDeliveryHook({
      bindingStore: {
        async getByThread() {
          return [{ connectorId: 'telegram', externalChatId: 'chat2', threadId: 'T2', userId: 'u1', createdAt: 0 }];
        },
      },
      adapters: new Map([['telegram', mockAdapter]]),
      log: { info() {}, warn() {}, error() {}, debug() {} },
      mediaPathResolver: () => undefined,
    });

    await hook.deliver('T2', 'Check image', undefined, [
      {
        id: 'block1',
        kind: 'media_gallery',
        v: 1,
        items: [{ url: '/avatars/opus.png', type: 'image' }],
      },
    ]);

    assert.equal(sendMediaCalls.length, 0);
  });

  it('does not send media when adapter lacks sendMedia', async () => {
    const { OutboundDeliveryHook } = await import('../dist/infrastructure/connectors/OutboundDeliveryHook.js');

    const replyCalls = [];
    const mockAdapter = {
      connectorId: 'basic',
      async sendReply(chatId, content) {
        replyCalls.push({ chatId, content });
      },
      // No sendMedia method
    };

    const hook = new OutboundDeliveryHook({
      bindingStore: {
        async getByThread() {
          return [{ connectorId: 'basic', externalChatId: 'chat3', threadId: 'T3', userId: 'u1', createdAt: 0 }];
        },
      },
      adapters: new Map([['basic', mockAdapter]]),
      log: { info() {}, warn() {}, error() {}, debug() {} },
    });

    // Should not throw even with audio blocks
    await hook.deliver('T3', 'Hello', undefined, [
      { id: 'block1', kind: 'audio', v: 1, url: '/api/tts/audio/xyz.wav', text: 'Hi' },
    ]);

    // Only text was sent, no media
    assert.equal(replyCalls.length, 1);
  });

  it('R3-P1: mediaPathResolver resolves route URL to absPath in sendMedia payload', async () => {
    const { OutboundDeliveryHook } = await import('../dist/infrastructure/connectors/OutboundDeliveryHook.js');

    const sendMediaCalls = [];
    const mockAdapter = {
      connectorId: 'telegram',
      async sendReply() {},
      async sendMedia(chatId, payload) {
        sendMediaCalls.push({ chatId, payload });
      },
    };

    const hook = new OutboundDeliveryHook({
      bindingStore: {
        async getByThread() {
          return [{ connectorId: 'telegram', externalChatId: 'chat1', threadId: 'T1', userId: 'u1', createdAt: 0 }];
        },
      },
      adapters: new Map([['telegram', mockAdapter]]),
      log: { info() {}, warn() {}, error() {}, debug() {} },
      mediaPathResolver: (url) => {
        if (url.startsWith('/api/tts/audio/')) return `/data/tts-cache/${url.slice('/api/tts/audio/'.length)}`;
        if (url.startsWith('/uploads/')) return `/home/uploads/${url.slice('/uploads/'.length)}`;
        return undefined;
      },
    });

    await hook.deliver('T1', 'Voice reply', 'opus', [
      { id: 'b1', kind: 'audio', v: 1, url: '/api/tts/audio/abc123.wav', text: '你好' },
    ]);

    assert.equal(sendMediaCalls.length, 1);
    assert.equal(sendMediaCalls[0].payload.url, '/api/tts/audio/abc123.wav');
    assert.equal(sendMediaCalls[0].payload.absPath, '/data/tts-cache/abc123.wav');
  });

  it('R3-P1: mediaPathResolver resolves image URL to absPath', async () => {
    const { OutboundDeliveryHook } = await import('../dist/infrastructure/connectors/OutboundDeliveryHook.js');

    const sendMediaCalls = [];
    const mockAdapter = {
      connectorId: 'telegram',
      async sendReply() {},
      async sendMedia(chatId, payload) {
        sendMediaCalls.push({ chatId, payload });
      },
    };

    const hook = new OutboundDeliveryHook({
      bindingStore: {
        async getByThread() {
          return [{ connectorId: 'telegram', externalChatId: 'chat1', threadId: 'T1', userId: 'u1', createdAt: 0 }];
        },
      },
      adapters: new Map([['telegram', mockAdapter]]),
      log: { info() {}, warn() {}, error() {}, debug() {} },
      mediaPathResolver: (url) => {
        if (url.startsWith('/uploads/')) return `/home/uploads/${url.slice('/uploads/'.length)}`;
        return undefined;
      },
    });

    await hook.deliver('T1', 'Check image', undefined, [
      { id: 'b1', kind: 'media_gallery', v: 1, items: [{ url: '/uploads/photo.jpg', type: 'image' }] },
    ]);

    assert.equal(sendMediaCalls.length, 1);
    assert.equal(sendMediaCalls[0].payload.absPath, '/home/uploads/photo.jpg');
  });

  it('handles multiple bindings delivering to different adapters', async () => {
    const { OutboundDeliveryHook } = await import('../dist/infrastructure/connectors/OutboundDeliveryHook.js');

    const feishuMedia = [];
    const telegramMedia = [];

    const hook = new OutboundDeliveryHook({
      bindingStore: {
        async getByThread() {
          return [
            { connectorId: 'feishu', externalChatId: 'fc1', threadId: 'T4', userId: 'u1', createdAt: 0 },
            { connectorId: 'telegram', externalChatId: 'tc1', threadId: 'T4', userId: 'u1', createdAt: 0 },
          ];
        },
      },
      adapters: new Map([
        [
          'feishu',
          {
            connectorId: 'feishu',
            async sendReply() {},
            async sendRichMessage() {},
            async sendMedia(_c, p) {
              feishuMedia.push(p);
            },
          },
        ],
        [
          'telegram',
          {
            connectorId: 'telegram',
            async sendReply() {},
            async sendRichMessage() {},
            async sendMedia(_c, p) {
              telegramMedia.push(p);
            },
          },
        ],
      ]),
      log: { info() {}, warn() {}, error() {}, debug() {} },
    });

    await hook.deliver('T4', 'Audio reply', 'opus', [
      { id: 'b1', kind: 'audio', v: 1, url: '/api/tts/audio/voice.wav', text: '早上好' },
    ]);

    assert.equal(feishuMedia.length, 1);
    assert.equal(telegramMedia.length, 1);
  });

  // --- Weixin audio outbound fix: voice blocks with text but no url ---

  it('resolves audio{text, no url} via resolveVoiceBlocks before sending media', async () => {
    const { OutboundDeliveryHook } = await import('../dist/infrastructure/connectors/OutboundDeliveryHook.js');

    const sendMediaCalls = [];
    const sendReplyCalls = [];
    // WeChat-like adapter: sendMedia but NO sendRichMessage
    const mockAdapter = {
      connectorId: 'weixin',
      async sendReply(chatId, content) {
        sendReplyCalls.push({ chatId, content });
      },
      async sendMedia(chatId, payload) {
        sendMediaCalls.push({ chatId, payload });
      },
    };

    let resolverCalled = false;
    const hook = new OutboundDeliveryHook({
      bindingStore: {
        async getByThread() {
          return [{ connectorId: 'weixin', externalChatId: 'wx-chat1', threadId: 'T1', userId: 'u1', createdAt: 0 }];
        },
      },
      adapters: new Map([['weixin', mockAdapter]]),
      log: { info() {}, warn() {}, error() {}, debug() {} },
      resolveVoiceBlocks: async (blocks, _catId) => {
        resolverCalled = true;
        return blocks.map((b) =>
          b.kind === 'audio' && 'text' in b && !('url' in b && b.url)
            ? { ...b, url: '/api/tts/audio/resolved.wav', mimeType: 'audio/wav' }
            : b,
        );
      },
    });

    await hook.deliver('T1', 'Voice reply', 'opus', [{ id: 'b1', kind: 'audio', v: 1, text: '你好世界' }]);

    assert.ok(resolverCalled, 'resolveVoiceBlocks should have been called');
    assert.equal(sendMediaCalls.length, 1, 'sendMedia should be called once for resolved audio');
    assert.equal(sendMediaCalls[0].payload.type, 'audio');
    assert.equal(sendMediaCalls[0].payload.url, '/api/tts/audio/resolved.wav');
  });

  it('degrades audio{text, no url} to text when no resolver available — no silent loss', async () => {
    const { OutboundDeliveryHook } = await import('../dist/infrastructure/connectors/OutboundDeliveryHook.js');

    const sendReplyCalls = [];
    const sendMediaCalls = [];
    const mockAdapter = {
      connectorId: 'weixin',
      async sendReply(chatId, content) {
        sendReplyCalls.push({ chatId, content });
      },
      async sendMedia(chatId, payload) {
        sendMediaCalls.push({ chatId, payload });
      },
    };

    const hook = new OutboundDeliveryHook({
      bindingStore: {
        async getByThread() {
          return [{ connectorId: 'weixin', externalChatId: 'wx-chat1', threadId: 'T1', userId: 'u1', createdAt: 0 }];
        },
      },
      adapters: new Map([['weixin', mockAdapter]]),
      log: { info() {}, warn() {}, error() {}, debug() {} },
      // NO resolveVoiceBlocks — simulates synth unavailable
    });

    await hook.deliver('T1', '', 'opus', [{ id: 'b1', kind: 'audio', v: 1, text: '这段语音应该以文本形式发出' }]);

    // Audio should not be silently dropped — text fallback must appear in sendReply
    assert.equal(sendMediaCalls.length, 0, 'no sendMedia since audio has no url');
    assert.ok(sendReplyCalls.length > 0, 'sendReply should be called with text fallback');
    const allText = sendReplyCalls.map((c) => c.content).join('\n');
    assert.ok(allText.includes('这段语音应该以文本形式发出'), 'audio text must appear in fallback');
  });

  it('degrades to text when resolveVoiceBlocks throws', async () => {
    const { OutboundDeliveryHook } = await import('../dist/infrastructure/connectors/OutboundDeliveryHook.js');

    const sendReplyCalls = [];
    const sendMediaCalls = [];
    const warnCalls = [];
    const mockAdapter = {
      connectorId: 'weixin',
      async sendReply(chatId, content) {
        sendReplyCalls.push({ chatId, content });
      },
      async sendMedia(chatId, payload) {
        sendMediaCalls.push({ chatId, payload });
      },
    };

    const hook = new OutboundDeliveryHook({
      bindingStore: {
        async getByThread() {
          return [{ connectorId: 'weixin', externalChatId: 'wx-chat1', threadId: 'T1', userId: 'u1', createdAt: 0 }];
        },
      },
      adapters: new Map([['weixin', mockAdapter]]),
      log: {
        info() {},
        warn(...args) {
          warnCalls.push(args);
        },
        error() {},
        debug() {},
      },
      resolveVoiceBlocks: async () => {
        throw new Error('TTS service unavailable');
      },
    });

    await hook.deliver('T1', '', 'opus', [{ id: 'b1', kind: 'audio', v: 1, text: '合成失败的语音' }]);

    assert.equal(sendMediaCalls.length, 0, 'no sendMedia after resolver failure');
    assert.ok(sendReplyCalls.length > 0, 'text fallback must be sent');
    const allText = sendReplyCalls.map((c) => c.content).join('\n');
    assert.ok(allText.includes('合成失败的语音'), 'audio text must survive resolver failure');
    assert.ok(warnCalls.length > 0, 'resolver failure should be logged as warning');
  });
});
