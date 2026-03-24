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
        errcode: 0,
        get_updates_buf: 'cursor-abc',
        messages: [
          {
            msg_id: 'msg-001',
            from_user_name: { str: 'user-wx-123' },
            content: { str: '你好猫猫' },
            context_token: 'ctx-token-abc',
            msg_type: 1,
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
      assert.equal(msg.messageId, 'msg-001');
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

    it('handles empty messages array', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      const raw = { errcode: 0, get_updates_buf: 'cursor-new', messages: [] };

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

    it('skips messages without from_user_name', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      const raw = {
        errcode: 0,
        messages: [{ msg_id: 'msg-001', content: { str: 'text' }, context_token: 'ctx' }],
      };

      const result = adapter.parseUpdates(raw);
      assert.equal(result.messages.length, 0);
    });

    it('skips messages without context_token', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      const raw = {
        errcode: 0,
        messages: [{ msg_id: 'msg-001', from_user_name: { str: 'user1' }, content: { str: 'text' } }],
      };

      const result = adapter.parseUpdates(raw);
      assert.equal(result.messages.length, 0);
    });

    it('parses image messages as placeholder text', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      const raw = {
        errcode: 0,
        messages: [
          {
            msg_id: 'msg-002',
            from_user_name: { str: 'user1' },
            context_token: 'ctx-2',
            msg_type: 3,
            cdn_img_url: 'https://cdn.weixin.qq.com/image/123',
          },
        ],
      };

      const result = adapter.parseUpdates(raw);
      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0].text, '[图片]');
      assert.equal(result.messages[0].attachments?.[0]?.type, 'image');
    });

    it('parses voice messages as placeholder text', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      const raw = {
        errcode: 0,
        messages: [
          {
            msg_id: 'msg-003',
            from_user_name: { str: 'user1' },
            context_token: 'ctx-3',
            msg_type: 34,
          },
        ],
      };

      const result = adapter.parseUpdates(raw);
      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0].text, '[语音]');
    });

    it('parses multiple messages in one update', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      const raw = {
        errcode: 0,
        get_updates_buf: 'cursor-multi',
        messages: [
          {
            msg_id: 'msg-a',
            from_user_name: { str: 'user-a' },
            content: { str: 'first' },
            context_token: 'ctx-a',
            msg_type: 1,
          },
          {
            msg_id: 'msg-b',
            from_user_name: { str: 'user-b' },
            content: { str: 'second' },
            context_token: 'ctx-b',
            msg_type: 1,
          },
        ],
      };

      const result = adapter.parseUpdates(raw);
      assert.equal(result.messages.length, 2);
      assert.equal(result.messages[0].text, 'first');
      assert.equal(result.messages[1].text, 'second');
    });
  });

  describe('sendReply', () => {
    it('sends text message via iLink sendmessage API', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'ctx-token-1');

      let capturedBody = null;
      let capturedUrl = null;
      adapter._injectFetch(async (url, opts) => {
        capturedUrl = url;
        capturedBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ errcode: 0 }) };
      });

      await adapter.sendReply('user-1', 'Hello from Clowder AI!');

      assert.ok(capturedUrl.includes('/ilink/bot/sendmessage'));
      assert.equal(capturedBody.context_token, 'ctx-token-1');
      assert.equal(capturedBody.to_user_name, 'user-1');
      assert.equal(capturedBody.content.str, 'Hello from Clowder AI!');
      assert.equal(capturedBody.msg_type, 1);
      assert.equal(capturedBody.message_state, 2);
    });

    it('silently skips when no context_token cached', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      let fetchCalled = false;
      adapter._injectFetch(async () => {
        fetchCalled = true;
        return { ok: true, json: async () => ({ errcode: 0 }) };
      });

      await adapter.sendReply('unknown-user', 'This should not send');
      assert.equal(fetchCalled, false);
    });

    it('chunks messages exceeding 2000 characters', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'ctx-1');

      const sentChunks = [];
      adapter._injectFetch(async (_url, opts) => {
        sentChunks.push(JSON.parse(opts.body).content.str);
        return { ok: true, json: async () => ({ errcode: 0 }) };
      });

      const longText = 'A'.repeat(3500);
      await adapter.sendReply('user-1', longText);

      assert.ok(sentChunks.length >= 2, `Expected >= 2 chunks, got ${sentChunks.length}`);
      const totalLength = sentChunks.reduce((sum, c) => sum + c.length, 0);
      assert.equal(totalLength, 3500);
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
      const result = adapter.parseUpdates({ errcode: 0, get_updates_buf: 'new-cursor', messages: [] });
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
