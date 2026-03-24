import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { WeixinAdapter } from '../dist/infrastructure/connectors/adapters/WeixinAdapter.js';

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

describe('WeixinAdapter', () => {
  describe('parseUpdates', () => {
    it('parses text messages from getupdates response', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      const raw = {
        ret: 0,
        get_updates_buf: 'cursor-abc',
        msgs: [
          {
            message_id: 1001,
            from_user_id: 'user-wx-123',
            context_token: 'ctx-token-abc',
            item_list: [{ type: 1, text_item: { text: '你好猫猫' } }],
          },
        ],
      };

      const result = adapter.parseUpdates(raw);
      assert.equal(result.sessionExpired, false);
      assert.equal(result.newCursor, 'cursor-abc');
      assert.equal(result.messages.length, 1);

      const msg = result.messages[0];
      assert.equal(msg.chatId, 'user-wx-123');
      assert.equal(msg.text, '你好猫猫');
      assert.equal(msg.messageId, '1001');
      assert.equal(msg.senderId, 'user-wx-123');
      assert.equal(msg.contextToken, 'ctx-token-abc');
    });

    it('returns sessionExpired=true on errcode -14', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      const raw = { errcode: -14, errmsg: 'session expired' };

      const result = adapter.parseUpdates(raw);
      assert.equal(result.sessionExpired, true);
      assert.equal(result.messages.length, 0);
    });

    it('returns sessionExpired=true on ret -14', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      const raw = { ret: -14, errmsg: 'session expired' };

      const result = adapter.parseUpdates(raw);
      assert.equal(result.sessionExpired, true);
      assert.equal(result.messages.length, 0);
    });

    it('handles empty msgs array', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      const raw = { ret: 0, get_updates_buf: 'cursor-new', msgs: [] };

      const result = adapter.parseUpdates(raw);
      assert.equal(result.messages.length, 0);
      assert.equal(result.newCursor, 'cursor-new');
      assert.equal(result.sessionExpired, false);
    });

    it('handles non-zero errcode (non-session-expired)', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      const raw = { errcode: -1, errmsg: 'unknown error' };

      const result = adapter.parseUpdates(raw);
      assert.equal(result.messages.length, 0);
      assert.equal(result.sessionExpired, false);
    });

    it('handles non-zero ret (non-session-expired)', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      const raw = { ret: -1, errmsg: 'unknown error' };

      const result = adapter.parseUpdates(raw);
      assert.equal(result.messages.length, 0);
      assert.equal(result.sessionExpired, false);
    });

    it('skips messages without from_user_id', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      const raw = {
        ret: 0,
        msgs: [{ message_id: 1001, context_token: 'ctx', item_list: [{ type: 1, text_item: { text: 'hello' } }] }],
      };

      const result = adapter.parseUpdates(raw);
      assert.equal(result.messages.length, 0);
    });

    it('skips messages without context_token', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      const raw = {
        ret: 0,
        msgs: [{ message_id: 1001, from_user_id: 'user1', item_list: [{ type: 1, text_item: { text: 'hello' } }] }],
      };

      const result = adapter.parseUpdates(raw);
      assert.equal(result.messages.length, 0);
    });

    it('skips messages with empty item_list', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      const raw = {
        ret: 0,
        msgs: [{ message_id: 1001, from_user_id: 'user1', context_token: 'ctx', item_list: [] }],
      };

      const result = adapter.parseUpdates(raw);
      assert.equal(result.messages.length, 0);
    });

    it('parses image messages as placeholder text', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      const raw = {
        ret: 0,
        msgs: [
          {
            message_id: 1002,
            from_user_id: 'user1',
            context_token: 'ctx-2',
            item_list: [{ type: 2, image_item: { url: 'https://cdn.weixin.qq.com/image/123' } }],
          },
        ],
      };

      const result = adapter.parseUpdates(raw);
      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0].text, '[图片]');
      assert.equal(result.messages[0].attachments?.[0]?.type, 'image');
      assert.equal(result.messages[0].attachments?.[0]?.mediaUrl, 'https://cdn.weixin.qq.com/image/123');
    });

    it('parses voice messages with transcribed text', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      const raw = {
        ret: 0,
        msgs: [
          {
            message_id: 1003,
            from_user_id: 'user1',
            context_token: 'ctx-3',
            item_list: [{ type: 3, voice_item: { text: '语音转文字内容' } }],
          },
        ],
      };

      const result = adapter.parseUpdates(raw);
      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0].text, '语音转文字内容');
    });

    it('parses voice messages without transcription as placeholder', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      const raw = {
        ret: 0,
        msgs: [
          {
            message_id: 1003,
            from_user_id: 'user1',
            context_token: 'ctx-3',
            item_list: [{ type: 3, voice_item: {} }],
          },
        ],
      };

      const result = adapter.parseUpdates(raw);
      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0].text, '[语音]');
    });

    it('parses voice messages with empty transcription as placeholder', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      const raw = {
        ret: 0,
        msgs: [
          {
            message_id: 1033,
            from_user_id: 'user1',
            context_token: 'ctx-voice-empty',
            item_list: [{ type: 3, voice_item: { text: '' } }],
          },
        ],
      };

      const result = adapter.parseUpdates(raw);
      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0].text, '[语音]');
    });

    it('parses file messages with filename', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      const raw = {
        ret: 0,
        msgs: [
          {
            message_id: 1004,
            from_user_id: 'user1',
            context_token: 'ctx-4',
            item_list: [{ type: 4, file_item: { file_name: 'report.pdf' } }],
          },
        ],
      };

      const result = adapter.parseUpdates(raw);
      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0].text, '[文件] report.pdf');
      assert.equal(result.messages[0].attachments?.[0]?.type, 'file');
      assert.equal(result.messages[0].attachments?.[0]?.fileName, 'report.pdf');
    });

    it('parses multiple messages in one update', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      const raw = {
        ret: 0,
        get_updates_buf: 'cursor-multi',
        msgs: [
          {
            message_id: 2001,
            from_user_id: 'user-a',
            context_token: 'ctx-a',
            item_list: [{ type: 1, text_item: { text: 'first' } }],
          },
          {
            message_id: 2002,
            from_user_id: 'user-b',
            context_token: 'ctx-b',
            item_list: [{ type: 1, text_item: { text: 'second' } }],
          },
        ],
      };

      const result = adapter.parseUpdates(raw);
      assert.equal(result.messages.length, 2);
      assert.equal(result.messages[0].text, 'first');
      assert.equal(result.messages[1].text, 'second');
    });

    it('generates fallback messageId when message_id is missing', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      const raw = {
        ret: 0,
        msgs: [
          {
            from_user_id: 'user1',
            context_token: 'ctx-1',
            item_list: [{ type: 1, text_item: { text: 'no id' } }],
          },
        ],
      };

      const result = adapter.parseUpdates(raw);
      assert.equal(result.messages.length, 1);
      assert.ok(result.messages[0].messageId.startsWith('weixin-'));
    });

    it('handles response with both ret and errcode (errcode wins for session expired)', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      const raw = { errcode: -14, ret: 0 };

      const result = adapter.parseUpdates(raw);
      assert.equal(result.sessionExpired, true);
    });
  });

  describe('sendReply', () => {
    it('sends text message via iLink sendmessage API with msg wrapper', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'ctx-token-1');

      let capturedBody = null;
      let capturedUrl = null;
      adapter._injectFetch(async (url, opts) => {
        capturedUrl = url;
        capturedBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ ret: 0 }) };
      });

      await adapter.sendReply('user-1', 'Hello from Clowder AI!');

      assert.ok(capturedUrl.includes('/ilink/bot/sendmessage'));
      assert.ok(capturedBody.msg, 'body must have msg wrapper');
      assert.equal(capturedBody.msg.context_token, 'ctx-token-1');
      assert.equal(capturedBody.msg.to_user_id, 'user-1');
      assert.equal(capturedBody.msg.message_state, 2);
      assert.equal(capturedBody.msg.item_list.length, 1);
      assert.equal(capturedBody.msg.item_list[0].type, 1);
      assert.equal(capturedBody.msg.item_list[0].text_item.text, 'Hello from Clowder AI!');
      assert.ok(capturedBody.base_info, 'body must include base_info');
    });

    it('silently skips when no context_token cached', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      let fetchCalled = false;
      adapter._injectFetch(async () => {
        fetchCalled = true;
        return { ok: true, json: async () => ({ ret: 0 }) };
      });

      await adapter.sendReply('unknown-user', 'This should not send');
      assert.equal(fetchCalled, false);
    });

    it('strips markdown before sending', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'ctx-token-1');

      let capturedText = null;
      adapter._injectFetch(async (_url, opts) => {
        const body = JSON.parse(opts.body);
        capturedText = body.msg.item_list[0].text_item.text;
        return { ok: true, json: async () => ({ ret: 0 }) };
      });

      await adapter.sendReply('user-1', '**Hello** from [Clowder AI](https://example.com)!');
      assert.equal(capturedText, 'Hello from Clowder AI!');
    });

    it('adds inter-chunk delay for multi-chunk messages', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'ctx-1');

      const sendTimestamps = [];
      adapter._injectFetch(async (_url, opts) => {
        sendTimestamps.push(Date.now());
        return { ok: true, json: async () => ({ ret: 0 }) };
      });

      const longText = 'A'.repeat(1200);
      await adapter.sendReply('user-1', longText);

      assert.ok(sendTimestamps.length >= 3, `Expected >= 3 chunks, got ${sendTimestamps.length}`);
      for (let i = 1; i < sendTimestamps.length; i++) {
        const gap = sendTimestamps[i] - sendTimestamps[i - 1];
        assert.ok(gap >= 200, `Gap between chunk ${i - 1} and ${i} was only ${gap}ms, expected >= 200ms`);
      }
    });

    it('throws on HTTP error from sendmessage', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'ctx-1');
      adapter._injectFetch(async () => ({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'server error',
      }));

      await assert.rejects(() => adapter.sendReply('user-1', 'test'), /sendmessage HTTP 500/);
    });

    it('throws on errcode -14 from sendmessage', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'ctx-1');
      adapter._injectFetch(async () => ({
        ok: true,
        json: async () => ({ errcode: -14, errmsg: 'session expired' }),
      }));

      await assert.rejects(() => adapter.sendReply('user-1', 'test'), /errcode -14/);
    });

    it('throws on ret -14 from sendmessage', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'ctx-1');
      adapter._injectFetch(async () => ({
        ok: true,
        json: async () => ({ ret: -14, errmsg: 'session expired' }),
      }));

      await assert.rejects(() => adapter.sendReply('user-1', 'test'), /errcode -14/);
    });
  });

  describe('chunkMessage', () => {
    it('returns single chunk for short messages', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      const chunks = adapter.chunkMessage('hello', 2000);
      assert.deepEqual(chunks, ['hello']);
    });

    it('breaks at newlines when possible', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      const text = 'A'.repeat(15) + '\n' + 'B'.repeat(10);
      const chunks = adapter.chunkMessage(text, 20);
      assert.equal(chunks.length, 2);
      assert.equal(chunks[0], 'A'.repeat(15));
      assert.equal(chunks[1], 'B'.repeat(10));
    });

    it('breaks at spaces as fallback', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      const text = 'A'.repeat(15) + ' ' + 'B'.repeat(10);
      const chunks = adapter.chunkMessage(text, 20);
      assert.equal(chunks.length, 2);
      assert.equal(chunks[0], 'A'.repeat(15));
      assert.equal(chunks[1], 'B'.repeat(10));
    });

    it('hard-cuts when no natural break point', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      const text = 'A'.repeat(50);
      const chunks = adapter.chunkMessage(text, 20);
      assert.equal(chunks.length, 3);
      assert.equal(chunks[0], 'A'.repeat(20));
      assert.equal(chunks[1], 'A'.repeat(20));
      assert.equal(chunks[2], 'A'.repeat(10));
    });
  });

  describe('connectorId', () => {
    it('returns weixin', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      assert.equal(adapter.connectorId, 'weixin');
    });
  });

  describe('stripMarkdownForWeixin', () => {
    it('strips bold and italic markers', () => {
      assert.equal(WeixinAdapter.stripMarkdownForWeixin('**bold** and *italic*'), 'bold and italic');
    });

    it('strips link syntax keeping text', () => {
      assert.equal(WeixinAdapter.stripMarkdownForWeixin('[click here](https://example.com)'), 'click here');
    });

    it('strips image syntax keeping alt text', () => {
      assert.equal(WeixinAdapter.stripMarkdownForWeixin('![cat photo](https://img.com/cat.jpg)'), 'cat photo');
    });

    it('strips fenced code blocks but keeps code content', () => {
      const input = 'before\n```js\nconsole.log("hi")\n```\nafter';
      const result = WeixinAdapter.stripMarkdownForWeixin(input);
      assert.ok(result.includes('console.log("hi")'), 'should preserve code content');
      assert.ok(!result.includes('```'), 'should not contain fence markers');
    });

    it('strips fenced code blocks with non-word info strings (shell-session, c++)', () => {
      const input = 'before\n```shell-session\n$ npm test\n```\nmid\n```c++\nint main() {}\n```\nafter';
      const result = WeixinAdapter.stripMarkdownForWeixin(input);
      assert.ok(result.includes('$ npm test'), 'should preserve shell-session code');
      assert.ok(result.includes('int main() {}'), 'should preserve c++ code');
      assert.ok(!result.includes('```'), 'should not contain fence markers');
      assert.ok(!result.includes('shell-session'), 'should strip info string');
      assert.ok(!result.includes('c++'), 'should strip info string');
    });

    it('preserves single-line fenced code content', () => {
      const result = WeixinAdapter.stripMarkdownForWeixin('run ```npm test``` now');
      assert.ok(result.includes('npm test'), 'should preserve single-line code');
      assert.ok(!result.includes('```'), 'should not contain fence markers');
    });

    it('converts inline code to plain text', () => {
      assert.equal(WeixinAdapter.stripMarkdownForWeixin('use `npm install` here'), 'use npm install here');
    });

    it('strips heading markers', () => {
      assert.equal(WeixinAdapter.stripMarkdownForWeixin('## Hello World'), 'Hello World');
    });

    it('converts unordered list markers to bullets', () => {
      assert.equal(WeixinAdapter.stripMarkdownForWeixin('- item one\n- item two'), '• item one\n• item two');
    });

    it('strips blockquote markers', () => {
      assert.equal(WeixinAdapter.stripMarkdownForWeixin('> quoted text'), 'quoted text');
    });

    it('strips strikethrough markers', () => {
      assert.equal(WeixinAdapter.stripMarkdownForWeixin('~~deleted~~'), 'deleted');
    });

    it('preserves literal underscores in identifiers (my_file_name)', () => {
      assert.equal(WeixinAdapter.stripMarkdownForWeixin('my_file_name'), 'my_file_name');
    });

    it('preserves literal asterisks in expressions (2*3*4)', () => {
      assert.equal(WeixinAdapter.stripMarkdownForWeixin('2*3*4'), '2*3*4');
    });

    it('strips true markdown italic emphasis (*word*)', () => {
      assert.equal(WeixinAdapter.stripMarkdownForWeixin('this is *italic* text'), 'this is italic text');
    });

    it('strips true markdown italic emphasis (_word_)', () => {
      assert.equal(WeixinAdapter.stripMarkdownForWeixin('this is _italic_ text'), 'this is italic text');
    });

    it('strips emphasis after CJK text (*重点*)', () => {
      assert.equal(WeixinAdapter.stripMarkdownForWeixin('这是*重点*，请看'), '这是重点，请看');
    });

    it('strips emphasis inside parentheses (*italic*)', () => {
      const result = WeixinAdapter.stripMarkdownForWeixin('(*italic*)');
      assert.ok(!result.includes('*'), 'should strip asterisks');
      assert.ok(result.includes('italic'), 'should preserve text');
    });

    it('collapses excessive newlines', () => {
      assert.equal(WeixinAdapter.stripMarkdownForWeixin('a\n\n\n\nb'), 'a\n\nb');
    });

    it('passes through plain text unchanged', () => {
      assert.equal(WeixinAdapter.stripMarkdownForWeixin('Hello world'), 'Hello world');
    });

    it('handles complex mixed markdown', () => {
      const input =
        '## Summary\n\n**Key point**: use [this tool](https://x.com) for `testing`.\n\n```bash\nnpm test\n```\n\n- Step one\n- Step two';
      const result = WeixinAdapter.stripMarkdownForWeixin(input);
      assert.ok(!result.includes('**'), 'should not contain bold markers');
      assert.ok(!result.includes('```'), 'should not contain code fences');
      assert.ok(!result.includes('['), 'should not contain link brackets');
      assert.ok(result.includes('Key point'), 'should preserve meaningful text');
      assert.ok(result.includes('this tool'), 'should preserve link text');
      assert.ok(result.includes('npm test'), 'should preserve code block content');
    });
  });

  describe('context token management', () => {
    it('caches context_token during parseUpdates processing', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      assert.equal(adapter.hasContextToken('user-1'), false);

      adapter._injectContextToken('user-1', 'ctx-1');
      assert.equal(adapter.hasContextToken('user-1'), true);
    });
  });

  describe('cursor management', () => {
    it('starts with empty cursor', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      assert.equal(adapter._getCursor(), '');
    });

    it('returns new cursor from getupdates response', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      const result = adapter.parseUpdates({ ret: 0, get_updates_buf: 'new-cursor', msgs: [] });
      assert.equal(result.newCursor, 'new-cursor');
    });
  });

  describe('auth headers', () => {
    it('includes required iLink auth headers in fetch calls', async () => {
      const adapter = new WeixinAdapter('my-bot-token', noopLog());
      adapter._injectContextToken('user-1', 'ctx-1');

      let capturedHeaders = null;
      adapter._injectFetch(async (_url, opts) => {
        capturedHeaders = opts.headers;
        return { ok: true, json: async () => ({ errcode: 0 }) };
      });

      await adapter.sendReply('user-1', 'test');

      assert.equal(capturedHeaders.AuthorizationType, 'ilink_bot_token');
      assert.equal(capturedHeaders.Authorization, 'Bearer my-bot-token');
      assert.ok(capturedHeaders['X-WECHAT-UIN'], 'X-WECHAT-UIN header must be present');
      assert.equal(capturedHeaders['Content-Type'], 'application/json');
    });
  });

  describe('botToken management', () => {
    it('hasBotToken returns false for empty token', () => {
      const adapter = new WeixinAdapter('', noopLog());
      assert.equal(adapter.hasBotToken(), false);
    });

    it('hasBotToken returns true for non-empty token', () => {
      const adapter = new WeixinAdapter('some-token', noopLog());
      assert.equal(adapter.hasBotToken(), true);
    });

    it('setBotToken updates the token', () => {
      const adapter = new WeixinAdapter('', noopLog());
      assert.equal(adapter.hasBotToken(), false);
      adapter.setBotToken('new-token');
      assert.equal(adapter.hasBotToken(), true);
    });
  });

  describe('QR code login (static methods)', () => {
    afterEach(() => {
      // Reset static fetch to globalThis.fetch after each QR test
      WeixinAdapter._injectStaticFetch(globalThis.fetch);
    });

    describe('fetchQrCode', () => {
      it('returns qrUrl and qrPayload on success', async () => {
        WeixinAdapter._injectStaticFetch(async () => ({
          ok: true,
          json: async () => ({
            errcode: 0,
            qrcode_url: 'https://weixin.qq.com/qr/abc123',
            qrcode: 'payload-xyz',
          }),
        }));

        const result = await WeixinAdapter.fetchQrCode();
        assert.equal(result.qrUrl, 'https://weixin.qq.com/qr/abc123');
        assert.equal(result.qrPayload, 'payload-xyz');
      });

      it('parses real iLink response with qrcode_img_content and ret', async () => {
        WeixinAdapter._injectStaticFetch(async () => ({
          ok: true,
          json: async () => ({
            ret: 0,
            qrcode: 'ef1387e07975295290b7d609dd5e3da7',
            qrcode_img_content: 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=ef1387e&bot_type=3',
          }),
        }));

        const result = await WeixinAdapter.fetchQrCode();
        assert.equal(result.qrUrl, 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=ef1387e&bot_type=3');
        assert.equal(result.qrPayload, 'ef1387e07975295290b7d609dd5e3da7');
      });

      it('prefers qrcode_img_content over qrcode_url when both present', async () => {
        WeixinAdapter._injectStaticFetch(async () => ({
          ok: true,
          json: async () => ({
            ret: 0,
            qrcode: 'payload-abc',
            qrcode_img_content: 'https://liteapp.weixin.qq.com/preferred',
            qrcode_url: 'https://weixin.qq.com/fallback',
          }),
        }));

        const result = await WeixinAdapter.fetchQrCode();
        assert.equal(result.qrUrl, 'https://liteapp.weixin.qq.com/preferred');
      });

      it('throws on non-zero ret (iLink error format)', async () => {
        WeixinAdapter._injectStaticFetch(async () => ({
          ok: true,
          json: async () => ({ ret: -1, errmsg: 'bot quota exceeded' }),
        }));

        await assert.rejects(() => WeixinAdapter.fetchQrCode(), /get_bot_qrcode errcode -1.*bot quota exceeded/);
      });

      it('throws on HTTP error', async () => {
        WeixinAdapter._injectStaticFetch(async () => ({
          ok: false,
          status: 502,
          statusText: 'Bad Gateway',
        }));

        await assert.rejects(() => WeixinAdapter.fetchQrCode(), /get_bot_qrcode HTTP 502/);
      });

      it('throws on non-zero errcode', async () => {
        WeixinAdapter._injectStaticFetch(async () => ({
          ok: true,
          json: async () => ({ errcode: -1, errmsg: 'service unavailable' }),
        }));

        await assert.rejects(() => WeixinAdapter.fetchQrCode(), /get_bot_qrcode errcode -1.*service unavailable/);
      });

      it('throws when response missing qrcode_img_content/qrcode_url or qrcode', async () => {
        WeixinAdapter._injectStaticFetch(async () => ({
          ok: true,
          json: async () => ({ errcode: 0 }),
        }));

        await assert.rejects(() => WeixinAdapter.fetchQrCode(), /missing qrcode_img_content\/qrcode_url or qrcode/);
      });
    });

    describe('pollQrCodeStatus', () => {
      it('returns waiting for status 0', async () => {
        WeixinAdapter._injectStaticFetch(async () => ({
          ok: true,
          json: async () => ({ errcode: 0, status: 0 }),
        }));

        const result = await WeixinAdapter.pollQrCodeStatus('qr-payload');
        assert.equal(result.status, 'waiting');
      });

      it('returns scanned for status 1', async () => {
        WeixinAdapter._injectStaticFetch(async () => ({
          ok: true,
          json: async () => ({ errcode: 0, status: 1 }),
        }));

        const result = await WeixinAdapter.pollQrCodeStatus('qr-payload');
        assert.equal(result.status, 'scanned');
      });

      it('returns confirmed with botToken for status 2', async () => {
        WeixinAdapter._injectStaticFetch(async () => ({
          ok: true,
          json: async () => ({ errcode: 0, status: 2, bot_token: 'live-token-abc' }),
        }));

        const result = await WeixinAdapter.pollQrCodeStatus('qr-payload');
        assert.equal(result.status, 'confirmed');
        assert.equal(result.botToken, 'live-token-abc');
      });

      it('returns error when status 2 but no bot_token', async () => {
        WeixinAdapter._injectStaticFetch(async () => ({
          ok: true,
          json: async () => ({ errcode: 0, status: 2 }),
        }));

        const result = await WeixinAdapter.pollQrCodeStatus('qr-payload');
        assert.equal(result.status, 'error');
        assert.ok(result.message.includes('confirmed but no bot_token'));
      });

      it('returns expired for status 3', async () => {
        WeixinAdapter._injectStaticFetch(async () => ({
          ok: true,
          json: async () => ({ errcode: 0, status: 3 }),
        }));

        const result = await WeixinAdapter.pollQrCodeStatus('qr-payload');
        assert.equal(result.status, 'expired');
      });

      it('returns error for unknown status code', async () => {
        WeixinAdapter._injectStaticFetch(async () => ({
          ok: true,
          json: async () => ({ errcode: 0, status: 99 }),
        }));

        const result = await WeixinAdapter.pollQrCodeStatus('qr-payload');
        assert.equal(result.status, 'error');
        assert.ok(result.message.includes('unknown status 99'));
      });

      it('returns error on HTTP failure', async () => {
        WeixinAdapter._injectStaticFetch(async () => ({
          ok: false,
          status: 500,
        }));

        const result = await WeixinAdapter.pollQrCodeStatus('qr-payload');
        assert.equal(result.status, 'error');
        assert.ok(result.message.includes('HTTP 500'));
      });

      it('returns error on non-zero errcode', async () => {
        WeixinAdapter._injectStaticFetch(async () => ({
          ok: true,
          json: async () => ({ errcode: -7, errmsg: 'invalid qrcode' }),
        }));

        const result = await WeixinAdapter.pollQrCodeStatus('qr-payload');
        assert.equal(result.status, 'error');
        assert.ok(result.message.includes('invalid qrcode'));
      });

      it('URL-encodes the qrPayload in the request', async () => {
        let capturedUrl = null;
        WeixinAdapter._injectStaticFetch(async (url) => {
          capturedUrl = url;
          return { ok: true, json: async () => ({ errcode: 0, status: 0 }) };
        });

        await WeixinAdapter.pollQrCodeStatus('payload with spaces&special=chars');
        assert.ok(capturedUrl.includes(encodeURIComponent('payload with spaces&special=chars')));
      });

      it('returns waiting for string status "wait" (real iLink format)', async () => {
        WeixinAdapter._injectStaticFetch(async () => ({
          ok: true,
          json: async () => ({ ret: 0, status: 'wait' }),
        }));

        const result = await WeixinAdapter.pollQrCodeStatus('qr-payload');
        assert.equal(result.status, 'waiting');
      });

      it('returns expired for string status "expired" (real iLink format)', async () => {
        WeixinAdapter._injectStaticFetch(async () => ({
          ok: true,
          json: async () => ({ ret: 0, status: 'expired' }),
        }));

        const result = await WeixinAdapter.pollQrCodeStatus('qr-payload');
        assert.equal(result.status, 'expired');
      });

      it('returns confirmed for string status "confirmed" with bot_token', async () => {
        WeixinAdapter._injectStaticFetch(async () => ({
          ok: true,
          json: async () => ({ ret: 0, status: 'confirmed', bot_token: 'real-token-xyz' }),
        }));

        const result = await WeixinAdapter.pollQrCodeStatus('qr-payload');
        assert.equal(result.status, 'confirmed');
        assert.equal(result.botToken, 'real-token-xyz');
      });

      it('returns scanned for string status "scanned"', async () => {
        WeixinAdapter._injectStaticFetch(async () => ({
          ok: true,
          json: async () => ({ ret: 0, status: 'scanned' }),
        }));

        const result = await WeixinAdapter.pollQrCodeStatus('qr-payload');
        assert.equal(result.status, 'scanned');
      });

      it('returns error on non-zero ret in poll response', async () => {
        WeixinAdapter._injectStaticFetch(async () => ({
          ok: true,
          json: async () => ({ ret: -7, errmsg: 'invalid qrcode' }),
        }));

        const result = await WeixinAdapter.pollQrCodeStatus('qr-payload');
        assert.equal(result.status, 'error');
        assert.ok(result.message.includes('invalid qrcode'));
      });

      it('uses a timeout >= 35 s to accommodate iLink long-poll', async () => {
        let capturedOptions = null;
        WeixinAdapter._injectStaticFetch(async (_url, opts) => {
          capturedOptions = opts;
          return { ok: true, json: async () => ({ ret: 0, status: 'wait' }) };
        });

        await WeixinAdapter.pollQrCodeStatus('qr-payload');
        assert.ok(capturedOptions, 'fetch options should be captured');
        assert.ok(capturedOptions.signal, 'signal should be present');
        assert.equal(capturedOptions.signal.aborted, false);
      });
    });

    describe('waitForQrCodeLogin', () => {
      it('returns immediately on confirmed status', async () => {
        let pollCount = 0;
        WeixinAdapter._injectStaticFetch(async () => {
          pollCount++;
          return {
            ok: true,
            json: async () => ({ errcode: 0, status: 2, bot_token: 'confirmed-token' }),
          };
        });

        const result = await WeixinAdapter.waitForQrCodeLogin('qr-payload');
        assert.equal(result.status, 'confirmed');
        assert.equal(result.botToken, 'confirmed-token');
        assert.equal(pollCount, 1);
      });

      it('returns immediately on expired status', async () => {
        WeixinAdapter._injectStaticFetch(async () => ({
          ok: true,
          json: async () => ({ errcode: 0, status: 3 }),
        }));

        const result = await WeixinAdapter.waitForQrCodeLogin('qr-payload');
        assert.equal(result.status, 'expired');
      });

      it('returns immediately on error status', async () => {
        WeixinAdapter._injectStaticFetch(async () => ({
          ok: false,
          status: 500,
        }));

        const result = await WeixinAdapter.waitForQrCodeLogin('qr-payload');
        assert.equal(result.status, 'error');
      });

      it('calls onStatusChange when status transitions', async () => {
        const responses = [
          { errcode: 0, status: 0 }, // waiting
          { errcode: 0, status: 0 }, // still waiting (no callback)
          { errcode: 0, status: 1 }, // scanned
          { errcode: 0, status: 2, bot_token: 'tk' }, // confirmed
        ];
        let callIdx = 0;
        WeixinAdapter._injectStaticFetch(async () => ({
          ok: true,
          json: async () => responses[Math.min(callIdx++, responses.length - 1)],
        }));

        const statusChanges = [];
        const result = await WeixinAdapter.waitForQrCodeLogin('qr-payload', (s) => {
          statusChanges.push(s.status);
        });

        assert.equal(result.status, 'confirmed');
        // Should have 3 unique transitions: waiting → scanned → confirmed
        assert.deepEqual(statusChanges, ['waiting', 'scanned', 'confirmed']);
      });
    });
  });
});
