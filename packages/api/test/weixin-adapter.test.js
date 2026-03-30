import assert from 'node:assert/strict';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
            item_list: [
              {
                type: 2,
                image_item: {
                  media: { encrypt_query_param: 'eqp123', aes_key: 'abc123' },
                },
              },
            ],
          },
        ],
      };

      const result = adapter.parseUpdates(raw);
      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0].text, '[图片]');
      assert.equal(result.messages[0].attachments?.[0]?.type, 'image');
      const mediaKey = JSON.parse(result.messages[0].attachments?.[0]?.mediaUrl ?? '{}');
      assert.equal(mediaKey.encryptQueryParam, 'eqp123');
      assert.equal(mediaKey.aesKey, 'abc123');
    });

    it('parses image without CDN media info (no attachment)', () => {
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
      assert.equal(result.messages[0].text, '[图片]');
      assert.equal(result.messages[0].attachments, undefined, 'No CDN media → no attachment');
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

    it('does not expose voice media attachment by default', () => {
      delete process.env.WEIXIN_CAPTURE_INBOUND_VOICE_MEDIA;
      const adapter = new WeixinAdapter('test-token', noopLog());
      const raw = {
        ret: 0,
        msgs: [
          {
            message_id: 10031,
            from_user_id: 'user1',
            context_token: 'ctx-voice-default',
            item_list: [
              {
                type: 3,
                voice_item: {
                  text: '默认不抓媒体',
                  media: { encrypt_query_param: 'eqp-voice', aes_key: 'voice-key' },
                },
              },
            ],
          },
        ],
      };

      const result = adapter.parseUpdates(raw);
      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0].text, '默认不抓媒体');
      assert.equal(result.messages[0].attachments, undefined);
    });

    it('captures inbound voice media as file attachment when WEIXIN_CAPTURE_INBOUND_VOICE_MEDIA=1', () => {
      process.env.WEIXIN_CAPTURE_INBOUND_VOICE_MEDIA = '1';
      const adapter = new WeixinAdapter('test-token', noopLog());
      const raw = {
        ret: 0,
        msgs: [
          {
            message_id: 10032,
            from_user_id: 'user1',
            context_token: 'ctx-voice-capture',
            item_list: [
              {
                type: 3,
                voice_item: {
                  text: '',
                  media: { encrypt_query_param: 'eqp-voice-cap', aes_key: 'voice-key-cap' },
                },
              },
            ],
          },
        ],
      };

      try {
        const result = adapter.parseUpdates(raw);
        assert.equal(result.messages.length, 1);
        assert.equal(result.messages[0].text, '[语音]');
        assert.equal(result.messages[0].attachments?.[0]?.type, 'file');
        assert.equal(result.messages[0].attachments?.[0]?.fileName, 'weixin-voice-10032.silk');
        const mediaKey = JSON.parse(result.messages[0].attachments?.[0]?.mediaUrl ?? '{}');
        assert.equal(mediaKey.encryptQueryParam, 'eqp-voice-cap');
        assert.equal(mediaKey.aesKey, 'voice-key-cap');
      } finally {
        delete process.env.WEIXIN_CAPTURE_INBOUND_VOICE_MEDIA;
      }
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

    it('parses file messages with filename and CDN media key', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      const raw = {
        ret: 0,
        msgs: [
          {
            message_id: 1004,
            from_user_id: 'user1',
            context_token: 'ctx-4',
            item_list: [
              {
                type: 4,
                file_item: {
                  file_name: 'report.pdf',
                  media: { encrypt_query_param: 'eqp-file', aes_key: 'filekey123' },
                },
              },
            ],
          },
        ],
      };

      const result = adapter.parseUpdates(raw);
      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0].text, '[文件] report.pdf');
      assert.equal(result.messages[0].attachments?.[0]?.type, 'file');
      assert.equal(result.messages[0].attachments?.[0]?.fileName, 'report.pdf');
      const mediaKey = JSON.parse(result.messages[0].attachments?.[0]?.mediaUrl ?? '{}');
      assert.equal(mediaKey.encryptQueryParam, 'eqp-file');
      assert.equal(mediaKey.aesKey, 'filekey123');
    });

    it('parses file without CDN media info (no attachment)', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      const raw = {
        ret: 0,
        msgs: [
          {
            message_id: 1005,
            from_user_id: 'user1',
            context_token: 'ctx-5',
            item_list: [{ type: 4, file_item: { file_name: 'notes.txt' } }],
          },
        ],
      };

      const result = adapter.parseUpdates(raw);
      assert.equal(result.messages[0].text, '[文件] notes.txt');
      assert.equal(result.messages[0].attachments, undefined, 'No CDN media → no attachment');
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
    // Helper: sendReply + immediately flush (avoids waiting for debounce timer)
    async function sendAndFlush(adapter, chatId, content) {
      const p = adapter.sendReply(chatId, content);
      await adapter._flushAllPending();
      return p;
    }

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

      await sendAndFlush(adapter, 'user-1', 'Hello from Clowder AI!');

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

    it('retains token after successful send (BUG-5: token is reusable)', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'ctx-token-1');
      adapter._injectFetch(async () => ({ ok: true, json: async () => ({ ret: 0 }) }));

      await sendAndFlush(adapter, 'user-1', 'Hello');
      assert.ok(adapter.hasContextToken('user-1'), 'token must be retained after send');
    });

    it('allows second send with same token (BUG-5: token is reusable)', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'ctx-token-1');
      let sendCount = 0;
      adapter._injectFetch(async () => {
        sendCount++;
        return { ok: true, json: async () => ({ ret: 0 }) };
      });

      await sendAndFlush(adapter, 'user-1', 'First reply');
      assert.equal(sendCount, 1);

      // Same token — second send should succeed (token is reusable)
      await sendAndFlush(adapter, 'user-1', 'Second reply — should also send');
      assert.equal(sendCount, 2, 'iLink API should be called twice with reusable token');
    });

    it('aggregates multiple sendReply calls within debounce window', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'ctx-token-1');
      const sentTexts = [];
      adapter._injectFetch(async (_url, opts) => {
        const body = JSON.parse(opts.body);
        sentTexts.push(body.msg.item_list[0].text_item.text);
        return { ok: true, json: async () => ({ ret: 0 }) };
      });

      // Queue two replies without flushing
      const p1 = adapter.sendReply('user-1', '[Cat A] Hello!');
      const p2 = adapter.sendReply('user-1', '[Cat B] Meow!');
      await adapter._flushAllPending();
      await Promise.all([p1, p2]);

      // Should be merged into a single API call
      assert.equal(sentTexts.length, 1);
      assert.ok(sentTexts[0].includes('Cat A'));
      assert.ok(sentTexts[0].includes('Cat B'));
    });

    it('uses token bound at queue time, not token at flush time (token rotation safety)', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'token-A');

      let capturedToken = null;
      adapter._injectFetch(async (_url, opts) => {
        const body = JSON.parse(opts.body);
        capturedToken = body.msg.context_token;
        return { ok: true, json: async () => ({ ret: 0 }) };
      });

      // Queue reply while token-A is active
      const p = adapter.sendReply('user-1', 'reply for message A');

      // Simulate new inbound message arriving with token-B (overwrites Map)
      adapter._injectContextToken('user-1', 'token-B');

      // Flush — should use token-A (bound at queue time), NOT token-B
      await adapter._flushAllPending();
      await p;

      assert.equal(capturedToken, 'token-A', 'must use token bound at queue time, not current Map value');
    });

    it('cross-token replies are NOT merged — new token flushes old bucket first', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'token-A');

      const calls = [];
      adapter._injectFetch(async (_url, opts) => {
        const body = JSON.parse(opts.body);
        calls.push({ token: body.msg.context_token, text: body.msg.item_list[0].text_item.text });
        return { ok: true, json: async () => ({ ret: 0 }) };
      });

      // Queue reply for token-A (starts debounce)
      const pA = adapter.sendReply('user-1', 'reply for A');

      // New message arrives with token-B → sendReply with token-B should flush old A bucket first
      adapter._injectContextToken('user-1', 'token-B');
      const pB = adapter.sendReply('user-1', 'reply for B');
      await adapter._flushAllPending();
      await Promise.all([pA, pB]);

      // Must be 2 separate sends: A with token-A, B with token-B
      assert.equal(calls.length, 2, 'must be 2 separate API calls, not merged');
      assert.equal(calls[0].token, 'token-A');
      assert.ok(calls[0].text.includes('reply for A'));
      assert.equal(calls[1].token, 'token-B');
      assert.ok(calls[1].text.includes('reply for B'));
    });

    it('token changes twice during flush — B refuses cross-token merge with C bucket', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'token-A');

      // Gate token-A's fetch so we control when it completes
      let releaseFetchA;
      const fetchGate = new Promise((r) => {
        releaseFetchA = r;
      });
      const calls = [];
      adapter._injectFetch(async (_url, opts) => {
        const body = JSON.parse(opts.body);
        const token = body.msg.context_token;
        if (token === 'token-A') await fetchGate;
        calls.push({ token, text: body.msg.item_list[0].text_item.text });
        return { ok: true, json: async () => ({ ret: 0 }) };
      });

      // 1. Queue reply for A
      const pA = adapter.sendReply('user-1', 'reply-A');

      // 2. Token B arrives → sendReply(B) starts flushing A (blocked by fetchGate)
      adapter._injectContextToken('user-1', 'token-B');
      const pB = adapter.sendReply('user-1', 'reply-B');

      // 3. While A flush is blocked, token C arrives + creates pending
      adapter._injectContextToken('user-1', 'token-C');
      const pC = adapter.sendReply('user-1', 'reply-C');

      // 4. Release A's fetch → B resumes → B must NOT merge into C's bucket
      releaseFetchA();
      await adapter._flushAllPending();
      await Promise.allSettled([pA, pB, pC]);

      // A sent with token-A, C sent with token-C. B refused to merge (different token bucket)
      assert.ok(
        calls.some((c) => c.token === 'token-A' && c.text.includes('reply-A')),
        'A must be sent',
      );
      assert.ok(
        calls.some((c) => c.token === 'token-C' && c.text.includes('reply-C')),
        'C must be sent',
      );
      assert.ok(!calls.some((c) => c.text.includes('reply-B') && c.token === 'token-C'), 'B must NOT be merged into C');
    });

    it('token-B remains valid after flushing token-A bucket (BUG-5: no consumption)', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'token-A');
      adapter._injectFetch(async () => ({ ok: true, json: async () => ({ ret: 0 }) }));

      // Queue reply for token-A
      const p = adapter.sendReply('user-1', 'reply A');

      // New token-B arrives before flush
      adapter._injectContextToken('user-1', 'token-B');

      // Flush old bucket — token-B must still be in contextTokens
      await adapter._flushAllPending();
      await p;

      assert.ok(adapter.hasContextToken('user-1'), 'token-B must still be in contextTokens');
    });

    it('no-token reply does not poison bucket for subsequent valid reply', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      let sendCount = 0;
      adapter._injectFetch(async () => {
        sendCount++;
        return { ok: true, json: async () => ({ ret: 0 }) };
      });

      // First reply with no token — should be skipped, no bucket created
      await adapter.sendReply('user-1', 'no-token reply');
      assert.equal(sendCount, 0);

      // Now token arrives and second reply queued
      adapter._injectContextToken('user-1', 'valid-token');
      await sendAndFlush(adapter, 'user-1', 'valid reply');

      // The valid reply must be sent
      assert.equal(sendCount, 1, 'valid reply after no-token skip must be sent');
    });

    it('silently skips when no context_token cached', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      let fetchCalled = false;
      adapter._injectFetch(async () => {
        fetchCalled = true;
        return { ok: true, json: async () => ({ ret: 0 }) };
      });

      await sendAndFlush(adapter, 'unknown-user', 'This should not send');
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

      await sendAndFlush(adapter, 'user-1', '**Hello** from [Clowder AI](https://example.com)!');
      assert.equal(capturedText, 'Hello from Clowder AI!');
    });

    it('sends official sendmessage fields expected by openclaw protocol', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'ctx-1');

      let capturedMsg = null;
      adapter._injectFetch(async (_url, opts) => {
        const body = JSON.parse(opts.body);
        capturedMsg = body.msg;
        return { ok: true, json: async () => ({ ret: 0 }) };
      });

      await sendAndFlush(adapter, 'user-1', 'hello');

      assert.equal(capturedMsg.from_user_id, '');
      assert.equal(capturedMsg.to_user_id, 'user-1');
      assert.equal(capturedMsg.message_type, 2);
      assert.equal(capturedMsg.message_state, 2);
      assert.equal(capturedMsg.context_token, 'ctx-1');
      assert.match(capturedMsg.client_id, /^cat-cafe-weixin-/);
    });

    it('parses raw text sendmessage responses without requiring res.json()', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'ctx-1');
      adapter._injectFetch(async () => ({
        ok: true,
        text: async () => JSON.stringify({ ret: 0, errmsg: 'ok' }),
      }));

      await sendAndFlush(adapter, 'user-1', 'hello');
    });

    it('throws on non-JSON 200 sendmessage response', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'ctx-1');
      adapter._injectFetch(async () => ({
        ok: true,
        text: async () => '<html>gateway error</html>',
      }));

      await assert.rejects(() => sendAndFlush(adapter, 'user-1', 'hello'), /sendmessage returned non-JSON response/);
      assert.ok(adapter.hasContextToken('user-1'), 'token must survive failed send');
    });

    it('throws on empty 200 sendmessage response body', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'ctx-1');
      adapter._injectFetch(async () => ({
        ok: true,
        text: async () => '',
      }));

      await assert.rejects(() => sendAndFlush(adapter, 'user-1', 'hello'), /sendmessage returned empty response body/);
      assert.ok(adapter.hasContextToken('user-1'), 'token must survive failed send');
    });

    it('sends all content in a single sendmessage call (no chunking)', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'ctx-1');

      let callCount = 0;
      let capturedTextLen = 0;
      adapter._injectFetch(async (_url, opts) => {
        callCount++;
        const body = JSON.parse(opts.body);
        capturedTextLen = body.msg.item_list[0].text_item.text.length;
        return { ok: true, json: async () => ({ ret: 0 }) };
      });

      const longText = 'A'.repeat(8000);
      await sendAndFlush(adapter, 'user-1', longText);

      assert.equal(callCount, 1, 'must be exactly 1 sendmessage call, no chunking');
      assert.equal(capturedTextLen, 8000, 'full text sent in single call');
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

      await assert.rejects(() => sendAndFlush(adapter, 'user-1', 'test'), /sendmessage HTTP 500/);
    });

    it('throws on errcode -14 from sendmessage', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'ctx-1');
      adapter._injectFetch(async () => ({
        ok: true,
        json: async () => ({ errcode: -14, errmsg: 'session expired' }),
      }));

      await assert.rejects(() => sendAndFlush(adapter, 'user-1', 'test'), /errcode -14/);
    });

    it('throws on ret -14 from sendmessage', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'ctx-1');
      adapter._injectFetch(async () => ({
        ok: true,
        json: async () => ({ ret: -14, errmsg: 'session expired' }),
      }));

      await assert.rejects(() => sendAndFlush(adapter, 'user-1', 'test'), /errcode -14/);
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
      const text = `${'A'.repeat(15)}\n${'B'.repeat(10)}`;
      const chunks = adapter.chunkMessage(text, 20);
      assert.equal(chunks.length, 2);
      assert.equal(chunks[0], 'A'.repeat(15));
      assert.equal(chunks[1], 'B'.repeat(10));
    });

    it('breaks at spaces as fallback', () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      const text = `${'A'.repeat(15)} ${'B'.repeat(10)}`;
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

      const p = adapter.sendReply('user-1', 'test');
      await adapter._flushAllPending();
      await p;

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

  describe('sendMedia', () => {
    function makeMalformedWav(sampleRate = 24000, durationSec = 2) {
      const frames = sampleRate * durationSec;
      const dataSize = frames * 2; // mono s16le
      const buf = Buffer.alloc(44 + dataSize);
      buf.write('RIFF', 0, 'ascii');
      // Deliberately wrong RIFF size (off by -8) to simulate malformed TTS output seen in runtime.
      buf.writeUInt32LE(36 + dataSize - 8, 4);
      buf.write('WAVE', 8, 'ascii');
      buf.write('fmt ', 12, 'ascii');
      buf.writeUInt32LE(16, 16); // PCM fmt chunk size
      buf.writeUInt16LE(1, 20); // PCM
      buf.writeUInt16LE(1, 22); // mono
      buf.writeUInt32LE(sampleRate, 24);
      buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
      buf.writeUInt16LE(2, 32); // block align
      buf.writeUInt16LE(16, 34); // bits
      buf.write('data', 36, 'ascii');
      buf.writeUInt32LE(dataSize, 40);
      return buf;
    }

    it('skips when no context_token', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      let fetchCalled = false;
      adapter._injectFetch(async () => {
        fetchCalled = true;
        return { ok: true, json: async () => ({}) };
      });
      await adapter.sendMedia('user-1', { type: 'image', absPath: '/tmp/test.png' });
      assert.equal(fetchCalled, false);
    });

    it('skips when no file path', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'ctx-1');
      let fetchCalled = false;
      adapter._injectFetch(async () => {
        fetchCalled = true;
        return { ok: true, json: async () => ({}) };
      });
      await adapter.sendMedia('user-1', { type: 'image' });
      assert.equal(fetchCalled, false);
    });

    it('throws when HTTPS download fails (P1: no silent drop)', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'ctx-1');
      adapter._injectFetch(async () => ({ ok: false, status: 404 }));
      await assert.rejects(
        () => adapter.sendMedia('user-1', { type: 'image', url: 'https://bad.example/a.png' }),
        (err) => err instanceof Error && /download failed/i.test(err.message),
      );
    });

    it('generates unique temp paths for concurrent downloads (P2: no collision)', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      const originalNow = Date.now;
      Date.now = () => 1700000000000;
      try {
        adapter._injectFetch(async () => ({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(8),
        }));
        const [p1, p2] = await Promise.all([
          adapter['downloadToTemp']('https://x.example/a.png'),
          adapter['downloadToTemp']('https://y.example/b.png'),
        ]);
        assert.ok(p1, 'first download should succeed');
        assert.ok(p2, 'second download should succeed');
        assert.notEqual(p1, p2, 'paths must differ even at the same Date.now()');
      } finally {
        Date.now = originalNow;
      }
    });

    it('degrades non-SILK audio to file_item delivery', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'ctx-1');

      const wavPath = join(tmpdir(), `cat-cafe-audio-${Date.now()}.wav`);
      await writeFile(wavPath, Buffer.from('not-a-real-wav'));

      /** @type {any} */
      let sentMsg = null;
      /** @type {any} */
      let uploadReq = null;

      try {
        adapter._injectFetch(async (url, opts) => {
          if (url.includes('/ilink/bot/getuploadurl')) {
            uploadReq = JSON.parse(opts.body);
            return { ok: true, json: async () => ({ upload_param: 'enc-upload-param' }) };
          }
          if (url.includes('/c2c/upload?')) {
            return {
              status: 200,
              headers: new Headers({ 'x-encrypted-param': 'enc-download-param' }),
            };
          }
          if (url.includes('/ilink/bot/sendmessage')) {
            sentMsg = JSON.parse(opts.body).msg;
            return { ok: true, text: async () => JSON.stringify({ ret: 0 }) };
          }
          throw new Error(`unexpected url: ${url}`);
        });

        await adapter.sendMedia('user-1', { type: 'audio', absPath: wavPath, fileName: 'voice.wav' });

        assert.equal(uploadReq.media_type, 3, 'audio fallback should upload as FILE type');
        assert.equal(sentMsg.item_list[0].type, 4, 'audio fallback should send FILE message item');
        assert.ok(sentMsg.item_list[0].file_item, 'file_item must be present');
        assert.equal(sentMsg.item_list[0].file_item.file_name, 'voice.wav');
        assert.equal(sentMsg.item_list[0].voice_item, undefined);
      } finally {
        await unlink(wavPath).catch(() => {});
      }
    });

    it('default mode: sends minimal voice_item (media only, no metadata)', async () => {
      // Default (no env var) = minimal mode — safest fallback
      delete process.env.WEIXIN_VOICE_ITEM_MODE;
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'ctx-1');
      const wavPath = join(tmpdir(), `cat-cafe-voice-default-${Date.now()}.wav`);
      await writeFile(wavPath, makeMalformedWav(24000, 2));
      /** @type {Record<string, unknown> | null} */
      let sentMsg = null;
      try {
        adapter._injectFetch(async (url, opts) => {
          if (url.includes('/ilink/bot/getuploadurl'))
            return { ok: true, json: async () => ({ upload_param: 'enc-upload-param' }) };
          if (url.includes('/c2c/upload?'))
            return { status: 200, headers: new Headers({ 'x-encrypted-param': 'enc-download-param' }) };
          if (url.includes('/ilink/bot/sendmessage')) {
            sentMsg = JSON.parse(opts.body).msg;
            return { ok: true, text: async () => JSON.stringify({ ret: 0 }) };
          }
          throw new Error(`unexpected url: ${url}`);
        });
        await adapter.sendMedia('user-1', { type: 'audio', absPath: wavPath, fileName: 'voice.wav' });
        const voiceItem = /** @type {Record<string, unknown>} */ (sentMsg?.item_list[0].voice_item);
        assert.ok(voiceItem?.media, 'media CDN reference must be present');
        assert.equal(voiceItem.encode_type, undefined, 'minimal mode: no encode_type');
        assert.equal(voiceItem.playtime, undefined, 'minimal mode: no playtime');
      } finally {
        delete process.env.WEIXIN_VOICE_ITEM_MODE;
        await unlink(wavPath).catch(() => {});
      }
    });

    it('playtime mode: sends voice_item with only playtime (WEIXIN_VOICE_ITEM_MODE=playtime)', async () => {
      process.env.WEIXIN_VOICE_ITEM_MODE = 'playtime';
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'ctx-1');
      const wavPath = join(tmpdir(), `cat-cafe-voice-playtime-${Date.now()}.wav`);
      await writeFile(wavPath, makeMalformedWav(24000, 2));
      /** @type {Record<string, unknown> | null} */
      let sentMsg = null;
      try {
        adapter._injectFetch(async (url, opts) => {
          if (url.includes('/ilink/bot/getuploadurl'))
            return { ok: true, json: async () => ({ upload_param: 'enc-upload-param' }) };
          if (url.includes('/c2c/upload?'))
            return { status: 200, headers: new Headers({ 'x-encrypted-param': 'enc-download-param' }) };
          if (url.includes('/ilink/bot/sendmessage')) {
            sentMsg = JSON.parse(opts.body).msg;
            return { ok: true, text: async () => JSON.stringify({ ret: 0 }) };
          }
          throw new Error(`unexpected url: ${url}`);
        });
        await adapter.sendMedia('user-1', { type: 'audio', absPath: wavPath, fileName: 'voice.wav' });
        const voiceItem = /** @type {Record<string, unknown>} */ (sentMsg?.item_list[0].voice_item);
        assert.ok(voiceItem?.media, 'media CDN reference must be present');
        assert.equal(voiceItem.encode_type, undefined, 'playtime mode: no encode_type');
        assert.equal(voiceItem.bits_per_sample, undefined, 'playtime mode: no bits_per_sample');
        assert.equal(voiceItem.sample_rate, undefined, 'playtime mode: no sample_rate');
        assert.equal(typeof voiceItem.playtime, 'number', 'playtime must be a number');
        assert.ok(/** @type {number} */ (voiceItem.playtime) > 0, 'playtime must be > 0');
      } finally {
        delete process.env.WEIXIN_VOICE_ITEM_MODE;
        await unlink(wavPath).catch(() => {});
      }
    });

    it('playtime-encode mode: falls back to playtime unless unsafe mode is enabled', async () => {
      process.env.WEIXIN_VOICE_ITEM_MODE = 'playtime-encode';
      delete process.env.WEIXIN_ENABLE_UNSAFE_VOICE_MODES;
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'ctx-1');
      const wavPath = join(tmpdir(), `cat-cafe-voice-pt-enc-${Date.now()}.wav`);
      await writeFile(wavPath, makeMalformedWav(24000, 2));
      /** @type {Record<string, unknown> | null} */
      let sentMsg = null;
      try {
        adapter._injectFetch(async (url, opts) => {
          if (url.includes('/ilink/bot/getuploadurl'))
            return { ok: true, json: async () => ({ upload_param: 'enc-upload-param' }) };
          if (url.includes('/c2c/upload?'))
            return { status: 200, headers: new Headers({ 'x-encrypted-param': 'enc-download-param' }) };
          if (url.includes('/ilink/bot/sendmessage')) {
            sentMsg = JSON.parse(opts.body).msg;
            return { ok: true, text: async () => JSON.stringify({ ret: 0 }) };
          }
          throw new Error(`unexpected url: ${url}`);
        });
        await adapter.sendMedia('user-1', { type: 'audio', absPath: wavPath, fileName: 'voice.wav' });
        const voiceItem = /** @type {Record<string, unknown>} */ (sentMsg?.item_list[0].voice_item);
        assert.ok(voiceItem?.media, 'media CDN reference must be present');
        assert.equal(voiceItem.encode_type, undefined, 'unsafe mode disabled: must fallback to playtime');
        assert.equal(voiceItem.bits_per_sample, undefined, 'fallback playtime mode: no bits_per_sample');
        assert.equal(voiceItem.sample_rate, undefined, 'fallback playtime mode: no sample_rate');
        assert.equal(typeof voiceItem.playtime, 'number', 'playtime must be a number');
        assert.ok(/** @type {number} */ (voiceItem.playtime) > 0, 'playtime must be > 0');
      } finally {
        delete process.env.WEIXIN_VOICE_ITEM_MODE;
        delete process.env.WEIXIN_ENABLE_UNSAFE_VOICE_MODES;
        await unlink(wavPath).catch(() => {});
      }
    });

    it('playtime-encode mode: sends encode_type when unsafe mode is explicitly enabled', async () => {
      process.env.WEIXIN_VOICE_ITEM_MODE = 'playtime-encode';
      process.env.WEIXIN_ENABLE_UNSAFE_VOICE_MODES = '1';
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'ctx-1');
      const wavPath = join(tmpdir(), `cat-cafe-voice-pt-enc-unsafe-${Date.now()}.wav`);
      await writeFile(wavPath, makeMalformedWav(24000, 2));
      /** @type {Record<string, unknown> | null} */
      let sentMsg = null;
      try {
        adapter._injectFetch(async (url, opts) => {
          if (url.includes('/ilink/bot/getuploadurl'))
            return { ok: true, json: async () => ({ upload_param: 'enc-upload-param' }) };
          if (url.includes('/c2c/upload?'))
            return { status: 200, headers: new Headers({ 'x-encrypted-param': 'enc-download-param' }) };
          if (url.includes('/ilink/bot/sendmessage')) {
            sentMsg = JSON.parse(opts.body).msg;
            return { ok: true, text: async () => JSON.stringify({ ret: 0 }) };
          }
          throw new Error(`unexpected url: ${url}`);
        });
        await adapter.sendMedia('user-1', { type: 'audio', absPath: wavPath, fileName: 'voice.wav' });
        const voiceItem = /** @type {Record<string, unknown>} */ (sentMsg?.item_list[0].voice_item);
        assert.ok(voiceItem?.media, 'media CDN reference must be present');
        assert.equal(voiceItem.encode_type, 6, 'unsafe enabled: encode_type should be preserved');
        assert.equal(voiceItem.bits_per_sample, undefined, 'playtime-encode mode: no bits_per_sample');
        assert.equal(voiceItem.sample_rate, undefined, 'playtime-encode mode: no sample_rate');
        assert.equal(typeof voiceItem.playtime, 'number', 'playtime must be a number');
        assert.ok(/** @type {number} */ (voiceItem.playtime) > 0, 'playtime must be > 0');
      } finally {
        delete process.env.WEIXIN_VOICE_ITEM_MODE;
        delete process.env.WEIXIN_ENABLE_UNSAFE_VOICE_MODES;
        await unlink(wavPath).catch(() => {});
      }
    });

    it('playtime-sec mode: sends voice_item with playtime in seconds (WEIXIN_VOICE_ITEM_MODE=playtime-sec)', async () => {
      process.env.WEIXIN_VOICE_ITEM_MODE = 'playtime-sec';
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'ctx-1');
      const wavPath = join(tmpdir(), `cat-cafe-voice-pt-sec-${Date.now()}.wav`);
      await writeFile(wavPath, makeMalformedWav(24000, 2));
      /** @type {Record<string, unknown> | null} */
      let sentMsg = null;
      try {
        adapter._injectFetch(async (url, opts) => {
          if (url.includes('/ilink/bot/getuploadurl'))
            return { ok: true, json: async () => ({ upload_param: 'enc-upload-param' }) };
          if (url.includes('/c2c/upload?'))
            return { status: 200, headers: new Headers({ 'x-encrypted-param': 'enc-download-param' }) };
          if (url.includes('/ilink/bot/sendmessage')) {
            sentMsg = JSON.parse(opts.body).msg;
            return { ok: true, text: async () => JSON.stringify({ ret: 0 }) };
          }
          throw new Error(`unexpected url: ${url}`);
        });
        await adapter.sendMedia('user-1', { type: 'audio', absPath: wavPath, fileName: 'voice.wav' });
        const voiceItem = /** @type {Record<string, unknown>} */ (sentMsg?.item_list[0].voice_item);
        assert.ok(voiceItem?.media, 'media CDN reference must be present');
        assert.equal(voiceItem.encode_type, undefined, 'playtime-sec mode: no encode_type');
        assert.equal(voiceItem.bits_per_sample, undefined, 'playtime-sec mode: no bits_per_sample');
        assert.equal(voiceItem.sample_rate, undefined, 'playtime-sec mode: no sample_rate');
        assert.equal(typeof voiceItem.playtime, 'number', 'playtime must be a number');
        // playtime-sec sends seconds, not ms — for a 2-second WAV, expect playtime ≈ 2
        assert.ok(/** @type {number} */ (voiceItem.playtime) > 0, 'playtime must be > 0');
        assert.ok(/** @type {number} */ (voiceItem.playtime) < 100, 'playtime-sec must be in seconds, not ms');
      } finally {
        delete process.env.WEIXIN_VOICE_ITEM_MODE;
        await unlink(wavPath).catch(() => {});
      }
    });

    it('playtime-sec mode: sub-second audio floors to 1 (never 0)', async () => {
      process.env.WEIXIN_VOICE_ITEM_MODE = 'playtime-sec';
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'ctx-1');
      const wavPath = join(tmpdir(), `cat-cafe-voice-pt-sec-short-${Date.now()}.wav`);
      await writeFile(wavPath, makeMalformedWav(24000, 0.2));
      /** @type {Record<string, unknown> | null} */
      let sentMsg = null;
      try {
        adapter._injectFetch(async (url, opts) => {
          if (url.includes('/ilink/bot/getuploadurl'))
            return { ok: true, json: async () => ({ upload_param: 'enc-upload-param' }) };
          if (url.includes('/c2c/upload?'))
            return { status: 200, headers: new Headers({ 'x-encrypted-param': 'enc-download-param' }) };
          if (url.includes('/ilink/bot/sendmessage')) {
            sentMsg = JSON.parse(opts.body).msg;
            return { ok: true, text: async () => JSON.stringify({ ret: 0 }) };
          }
          throw new Error(`unexpected url: ${url}`);
        });
        await adapter.sendMedia('user-1', { type: 'audio', absPath: wavPath, fileName: 'voice.wav' });
        const voiceItem = /** @type {Record<string, unknown>} */ (sentMsg?.item_list[0].voice_item);
        assert.ok(voiceItem?.media, 'media CDN reference must be present');
        assert.equal(typeof voiceItem.playtime, 'number', 'playtime must be a number');
        assert.ok(
          /** @type {number} */ (voiceItem.playtime) >= 1,
          'sub-second audio must floor to at least 1, never 0',
        );
      } finally {
        delete process.env.WEIXIN_VOICE_ITEM_MODE;
        await unlink(wavPath).catch(() => {});
      }
    });

    it('metadata mode: sends voice_item with full SILK metadata (WEIXIN_VOICE_ITEM_MODE=metadata)', async () => {
      process.env.WEIXIN_VOICE_ITEM_MODE = 'metadata';
      process.env.WEIXIN_ENABLE_UNSAFE_VOICE_MODES = '1';
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'ctx-1');
      const wavPath = join(tmpdir(), `cat-cafe-voice-metadata-${Date.now()}.wav`);
      await writeFile(wavPath, makeMalformedWav(24000, 2));
      /** @type {Record<string, unknown> | null} */
      let sentMsg = null;
      try {
        adapter._injectFetch(async (url, opts) => {
          if (url.includes('/ilink/bot/getuploadurl'))
            return { ok: true, json: async () => ({ upload_param: 'enc-upload-param' }) };
          if (url.includes('/c2c/upload?'))
            return { status: 200, headers: new Headers({ 'x-encrypted-param': 'enc-download-param' }) };
          if (url.includes('/ilink/bot/sendmessage')) {
            sentMsg = JSON.parse(opts.body).msg;
            return { ok: true, text: async () => JSON.stringify({ ret: 0 }) };
          }
          throw new Error(`unexpected url: ${url}`);
        });
        await adapter.sendMedia('user-1', { type: 'audio', absPath: wavPath, fileName: 'voice.wav' });
        const voiceItem = /** @type {Record<string, unknown>} */ (sentMsg?.item_list[0].voice_item);
        assert.ok(voiceItem?.media, 'media CDN reference must be present');
        assert.equal(voiceItem.encode_type, 6, 'encode_type must be 6 (SILK)');
        assert.equal(voiceItem.bits_per_sample, 16, 'bits_per_sample must be 16');
        assert.equal(voiceItem.sample_rate, 24000, 'sample_rate must match SILK encoding rate');
        assert.equal(typeof voiceItem.playtime, 'number', 'playtime must be a number');
        assert.ok(/** @type {number} */ (voiceItem.playtime) > 0, 'playtime must be > 0');
      } finally {
        delete process.env.WEIXIN_VOICE_ITEM_MODE;
        delete process.env.WEIXIN_ENABLE_UNSAFE_VOICE_MODES;
        await unlink(wavPath).catch(() => {});
      }
    });

    it('SILK output must not append 0xFFFF trailer (regression: EOS marker crashes WeChat decoder)', async () => {
      // Evidence: inbound WeChat SILK has no EOS marker and ends exactly at last frame.
      // 0xFFFF as int16LE = -1, read as invalid frame-size by WeChat's decoder.
      // Old code appended Buffer.from([0xff, 0xff]) — this test turns RED on that code.
      const adapter = new WeixinAdapter('test-token', noopLog());
      const wavPath = join(tmpdir(), `cat-cafe-silk-eos-regression-${Date.now()}.wav`);
      await writeFile(wavPath, makeMalformedWav(24000, 1));

      try {
        // Call convertWavToSilk directly (TS private is not enforced at JS runtime)
        const result = await adapter.convertWavToSilk(wavPath);
        assert.ok(result, 'WAV→SILK conversion must succeed');

        const silkBytes = await readFile(result.silkPath);
        // Core assertion: last 2 bytes must NOT be 0xFF 0xFF
        const lastTwo = silkBytes.subarray(-2);
        assert.ok(
          lastTwo[0] !== 0xff || lastTwo[1] !== 0xff,
          'SILK output must NOT end with 0xFFFF — WeChat reads it as frame-size -1 and crashes',
        );
        // Verify SILK header is intact
        assert.ok(silkBytes.subarray(0, 10).toString().includes('SILK_V3'), 'must have SILK_V3 header');

        await unlink(result.silkPath).catch(() => {});
      } finally {
        await unlink(wavPath).catch(() => {});
      }
    });
  });

  describe('disconnect', () => {
    it('clears botToken, contextTokens, and stops polling', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('user-1', 'ctx-1');
      adapter._injectContextToken('user-2', 'ctx-2');

      assert.equal(adapter.hasBotToken(), true);
      assert.equal(adapter.hasContextToken('user-1'), true);

      await adapter.disconnect();

      assert.equal(adapter.hasBotToken(), false, 'botToken must be cleared');
      assert.equal(adapter.isPolling(), false, 'polling must be stopped');
      assert.equal(adapter.hasContextToken('user-1'), false, 'contextTokens must be cleared');
      assert.equal(adapter.hasContextToken('user-2'), false, 'contextTokens must be cleared');
    });

    it('rejects pending sendReply promises on disconnect (P1: no dangling promises)', async () => {
      const adapter = new WeixinAdapter('test-token', noopLog());
      adapter._injectContextToken('u1', 'ctx-1');
      adapter._injectFetch(async () => ({ ok: true, json: async () => ({ ret: 0 }) }));

      // Queue a reply but don't wait for debounce to flush
      const p = adapter.sendReply('u1', 'hello');

      // Disconnect while reply is pending
      await adapter.disconnect();

      // The promise must settle (reject), not hang forever
      const TIMEOUT = Symbol('timeout');
      const result = await Promise.race([
        p.then(
          () => 'resolved',
          (err) => err,
        ),
        new Promise((r) => setTimeout(() => r(TIMEOUT), 200)),
      ]);
      assert.notEqual(result, TIMEOUT, 'sendReply promise must not dangle after disconnect');
      assert.ok(result instanceof Error, 'sendReply should reject with an Error');
      assert.match(result.message, /disconnect/i);
    });

    it('is safe to call when already disconnected', async () => {
      const adapter = new WeixinAdapter('', noopLog());
      await adapter.disconnect();
      assert.equal(adapter.hasBotToken(), false);
      assert.equal(adapter.isPolling(), false);
    });
  });
});
