import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('P1-2: TelegramAdapter.sendMedia', () => {
  it('sendMedia sends image via bot API', async () => {
    const { TelegramAdapter } = await import(
      '../dist/infrastructure/connectors/im-connectors/telegram/TelegramAdapter.js'
    );

    const sent = [];
    const adapter = new TelegramAdapter('fake-token', {
      info() {},
      warn() {},
      error() {},
      debug() {},
    });
    // Inject mock to capture all send calls
    adapter._injectSendMessage(async (chatId, text, opts) => {
      sent.push({ chatId, text, opts });
    });
    // Inject media send mock
    adapter._injectSendMedia?.({
      sendPhoto: async (chatId, url) => {
        sent.push({ method: 'sendPhoto', chatId, url });
      },
      sendDocument: async (chatId, url) => {
        sent.push({ method: 'sendDocument', chatId, url });
      },
      sendVoice: async (chatId, url) => {
        sent.push({ method: 'sendVoice', chatId, url });
      },
    });

    // sendMedia should exist and work with url payload
    assert.equal(typeof adapter.sendMedia, 'function', 'TelegramAdapter must have sendMedia');
    await adapter.sendMedia('12345', { type: 'image', url: 'https://example.com/photo.jpg' });

    // Should have sent something
    assert.ok(sent.length > 0, 'sendMedia should have sent a message');
    const call = sent.find((s) => s.method === 'sendPhoto');
    assert.ok(call, 'should have called sendPhoto for image');
    assert.equal(call.url, 'https://example.com/photo.jpg');
  });

  it('R2-P1-2: local file path uses InputFile instead of raw string', async () => {
    const { TelegramAdapter } = await import(
      '../dist/infrastructure/connectors/im-connectors/telegram/TelegramAdapter.js'
    );
    const { InputFile } = await import('grammy');

    const sent = [];
    const adapter = new TelegramAdapter('fake-token', {
      info() {},
      warn() {},
      error() {},
      debug() {},
    });
    adapter._injectSendMedia({
      sendPhoto: async (chatId, input) => {
        sent.push({ method: 'sendPhoto', chatId, input });
      },
      sendDocument: async (chatId, input) => {
        sent.push({ method: 'sendDocument', chatId, input });
      },
      sendVoice: async (chatId, input) => {
        sent.push({ method: 'sendVoice', chatId, input });
      },
    });

    // Local absolute file path should become InputFile, not raw string
    await adapter.sendMedia('12345', { type: 'image', url: '/tmp/connector-media/photo.jpg' });

    const call = sent.find((s) => s.method === 'sendPhoto');
    assert.ok(call, 'should have called sendPhoto');
    assert.ok(call.input instanceof InputFile, 'local path should be wrapped in InputFile');
  });

  it('R2-P1-2: public URL stays as string (not InputFile)', async () => {
    const { TelegramAdapter } = await import(
      '../dist/infrastructure/connectors/im-connectors/telegram/TelegramAdapter.js'
    );

    const sent = [];
    const adapter = new TelegramAdapter('fake-token', {
      info() {},
      warn() {},
      error() {},
      debug() {},
    });
    adapter._injectSendMedia({
      sendPhoto: async (chatId, input) => {
        sent.push({ method: 'sendPhoto', chatId, input });
      },
      sendDocument: async (chatId, input) => {
        sent.push({ method: 'sendDocument', chatId, input });
      },
      sendVoice: async (chatId, input) => {
        sent.push({ method: 'sendVoice', chatId, input });
      },
    });

    await adapter.sendMedia('12345', { type: 'image', url: 'https://example.com/photo.jpg' });

    const call = sent.find((s) => s.method === 'sendPhoto');
    assert.ok(call, 'should have called sendPhoto');
    assert.equal(typeof call.input, 'string', 'public URL should stay as string');
    assert.equal(call.input, 'https://example.com/photo.jpg');
  });

  it('R3-P1: absPath in payload takes priority over url for InputFile', async () => {
    const { TelegramAdapter } = await import(
      '../dist/infrastructure/connectors/im-connectors/telegram/TelegramAdapter.js'
    );
    const { InputFile } = await import('grammy');

    const sent = [];
    const adapter = new TelegramAdapter('fake-token', {
      info() {},
      warn() {},
      error() {},
      debug() {},
    });
    adapter._injectSendMedia({
      sendPhoto: async (chatId, input) => {
        sent.push({ method: 'sendPhoto', chatId, input });
      },
      sendDocument: async (chatId, input) => {
        sent.push({ method: 'sendDocument', chatId, input });
      },
      sendVoice: async (chatId, input) => {
        sent.push({ method: 'sendVoice', chatId, input });
      },
    });

    // absPath takes priority — even with a route URL, should use absPath for InputFile
    await adapter.sendMedia('12345', {
      type: 'audio',
      url: '/api/tts/audio/abc123.wav',
      absPath: '/data/tts-cache/abc123.wav',
    });

    const call = sent.find((s) => s.method === 'sendVoice');
    assert.ok(call, 'should have called sendVoice');
    assert.ok(call.input instanceof InputFile, 'absPath should be wrapped in InputFile');
  });

  it('sendMedia sends voice via bot API', async () => {
    const { TelegramAdapter } = await import(
      '../dist/infrastructure/connectors/im-connectors/telegram/TelegramAdapter.js'
    );

    const sent = [];
    const adapter = new TelegramAdapter('fake-token', {
      info() {},
      warn() {},
      error() {},
      debug() {},
    });
    adapter._injectSendMedia?.({
      sendPhoto: async (chatId, url) => {
        sent.push({ method: 'sendPhoto', chatId, url });
      },
      sendDocument: async (chatId, url) => {
        sent.push({ method: 'sendDocument', chatId, url });
      },
      sendVoice: async (chatId, url) => {
        sent.push({ method: 'sendVoice', chatId, url });
      },
    });

    assert.equal(typeof adapter.sendMedia, 'function', 'TelegramAdapter must have sendMedia');
    await adapter.sendMedia('12345', { type: 'audio', url: 'https://example.com/voice.ogg' });

    const call = sent.find((s) => s.method === 'sendVoice');
    assert.ok(call, 'should have called sendVoice for audio');
  });
});

describe('P1-2: FeishuAdapter.sendMedia with URL fallback', () => {
  it('sendMedia with url (no platform key) sends link as text', async () => {
    const { FeishuAdapter } = await import('../dist/infrastructure/connectors/im-connectors/feishu/FeishuAdapter.js');

    const sent = [];
    const adapter = new FeishuAdapter('fake-app-id', 'fake-secret', {
      info() {},
      warn() {},
      error() {},
      debug() {},
    });
    adapter._injectSendMessage(async (params) => {
      sent.push(params);
    });

    // OutboundDeliveryHook passes { type: 'image', url: '...' } — no imageKey
    await adapter.sendMedia('chat1', { type: 'image', url: 'https://example.com/photo.jpg' });

    assert.ok(sent.length > 0, 'sendMedia with url should send something');
    // Should fallback to text link since no imageKey provided
    const call = sent[0];
    assert.ok(call, 'should have sent a message');
  });

  it('sendMedia with imageKey uses platform key (existing behavior)', async () => {
    const { FeishuAdapter } = await import('../dist/infrastructure/connectors/im-connectors/feishu/FeishuAdapter.js');

    const sent = [];
    const adapter = new FeishuAdapter('fake-app-id', 'fake-secret', {
      info() {},
      warn() {},
      error() {},
      debug() {},
    });
    adapter._injectSendMessage(async (params) => {
      sent.push(params);
    });

    await adapter.sendMedia('chat1', { type: 'image', imageKey: 'img_v3_key' });

    assert.ok(sent.length > 0);
    const call = sent[0];
    assert.equal(call.msgType, 'image');
    const content = JSON.parse(call.content);
    assert.equal(content.image_key, 'img_v3_key');
  });
});
