import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TelegramAdapter } from '../dist/infrastructure/connectors/im-connectors/telegram/TelegramAdapter.js';

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

function recordingLog() {
  const entries = { info: [], warn: [], error: [] };
  const log = {
    info: (...args) => entries.info.push(args),
    warn: (...args) => entries.warn.push(args),
    error: (...args) => entries.error.push(args),
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => log,
  };
  return { entries, log };
}

async function flushPollingLoop() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('TelegramAdapter', () => {
  describe('parseUpdate()', () => {
    it('extracts text message from update', () => {
      const adapter = new TelegramAdapter('test-token', noopLog());
      const update = {
        update_id: 123,
        message: {
          message_id: 456,
          from: { id: 789, is_bot: false, first_name: 'Test' },
          chat: { id: 1001, type: 'private' },
          date: 1710000000,
          text: 'Hello cat!',
        },
      };
      const result = adapter.parseUpdate(update);
      assert.ok(result);
      assert.equal(result.chatId, '1001');
      assert.equal(result.text, 'Hello cat!');
      assert.equal(result.messageId, '456');
      assert.equal(result.senderId, '789');
    });

    it('returns null for unsupported message type (e.g. sticker)', () => {
      const adapter = new TelegramAdapter('test-token', noopLog());
      const update = {
        update_id: 123,
        message: {
          message_id: 456,
          from: { id: 789, is_bot: false, first_name: 'Test' },
          chat: { id: 1001, type: 'private' },
          date: 1710000000,
          sticker: { file_id: 'stk_abc', width: 512, height: 512, is_animated: false },
        },
      };
      const result = adapter.parseUpdate(update);
      assert.equal(result, null);
    });

    it('returns null for group message (MVP = DM only)', () => {
      const adapter = new TelegramAdapter('test-token', noopLog());
      const update = {
        update_id: 123,
        message: {
          message_id: 456,
          from: { id: 789, is_bot: false, first_name: 'Test' },
          chat: { id: -1001, type: 'group' },
          date: 1710000000,
          text: 'Hello from group!',
        },
      };
      const result = adapter.parseUpdate(update);
      assert.equal(result, null);
    });

    it('returns null for bot messages', () => {
      const adapter = new TelegramAdapter('test-token', noopLog());
      const update = {
        update_id: 123,
        message: {
          message_id: 456,
          from: { id: 789, is_bot: true, first_name: 'Bot' },
          chat: { id: 1001, type: 'private' },
          date: 1710000000,
          text: 'Bot echo',
        },
      };
      const result = adapter.parseUpdate(update);
      assert.equal(result, null);
    });

    it('returns null for missing message', () => {
      const adapter = new TelegramAdapter('test-token', noopLog());
      const result = adapter.parseUpdate({ update_id: 123 });
      assert.equal(result, null);
    });
  });

  describe('sendReply()', () => {
    it('calls bot.api.sendMessage with correct params', async () => {
      const adapter = new TelegramAdapter('test-token', noopLog());
      const sendCalls = [];

      // Inject mock for bot.api.sendMessage
      adapter._injectSendMessage(async (chatId, text, opts) => {
        sendCalls.push({ chatId, text, opts });
      });

      await adapter.sendReply('1001', 'Hello from cat!');
      assert.equal(sendCalls.length, 1);
      assert.equal(sendCalls[0].chatId, '1001');
      assert.equal(sendCalls[0].text, 'Hello from cat!');
    });

    it('splits messages over 4096 chars (K3: no silent truncation)', async () => {
      const adapter = new TelegramAdapter('test-token', noopLog());
      const sendCalls = [];
      adapter._injectSendMessage(async (chatId, text) => {
        sendCalls.push({ chatId, text });
      });

      const longMsg = 'a'.repeat(5000);
      await adapter.sendReply('1001', longMsg);
      assert.ok(sendCalls.length >= 2, 'must split rather than truncate');
      for (const call of sendCalls) {
        assert.ok(call.text.length <= 4096, 'each segment must be ≤4096 chars');
      }
      assert.equal(sendCalls.map((c) => c.text).join(''), longMsg, 'combined must equal original');
    });
  });

  describe('sendRichMessage()', () => {
    it('sends HTML-formatted message with parse_mode', async () => {
      const adapter = new TelegramAdapter('test-token', noopLog());
      const sendCalls = [];
      adapter._injectSendMessage(async (chatId, text, opts) => {
        sendCalls.push({ chatId, text, opts });
      });

      const blocks = [{ id: 'b1', kind: 'card', v: 1, title: 'Review', bodyMarkdown: 'LGTM' }];
      await adapter.sendRichMessage('1001', 'text', blocks, '布偶猫');

      assert.equal(sendCalls.length, 1);
      assert.equal(sendCalls[0].chatId, '1001');
      assert.deepEqual(sendCalls[0].opts, { parse_mode: 'HTML' });
      assert.ok(sendCalls[0].text.includes('<b>'));
      assert.ok(sendCalls[0].text.includes('布偶猫'));
      assert.ok(sendCalls[0].text.includes('Review'));
    });

    it('formats checklist blocks as HTML', async () => {
      const adapter = new TelegramAdapter('test-token', noopLog());
      const sendCalls = [];
      adapter._injectSendMessage(async (chatId, text, opts) => {
        sendCalls.push({ chatId, text, opts });
      });

      const blocks = [
        {
          id: 'b2',
          kind: 'checklist',
          v: 1,
          items: [
            { id: 'i1', text: 'Done', checked: true },
            { id: 'i2', text: 'Pending' },
          ],
        },
      ];
      await adapter.sendRichMessage('1001', 'text', blocks, '布偶猫');

      assert.ok(sendCalls[0].text.includes('✅ Done'));
      assert.ok(sendCalls[0].text.includes('☐ Pending'));
    });
  });

  describe('startPolling()', () => {
    it('releases the Telegram session and retries after a 409 polling conflict', async () => {
      const { entries, log } = recordingLog();
      const adapter = new TelegramAdapter('test-token', log);
      let startCalls = 0;
      let closeCalls = 0;
      const sleeps = [];

      adapter._injectPollingControls({
        start: async (options) => {
          startCalls += 1;
          if (startCalls === 1) {
            throw { error_code: 409, description: 'Conflict: terminated by other getUpdates request' };
          }
          options?.onStart?.();
        },
        close: async () => {
          closeCalls += 1;
        },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        backoffMs: [5],
        maxConflictRetries: 2,
      });

      adapter.startPolling(async () => {});
      await flushPollingLoop();

      assert.equal(startCalls, 2);
      assert.equal(closeCalls, 1);
      assert.deepEqual(sleeps, [5]);
      assert.ok(
        entries.warn.some((entry) => String(entry.at(-1)).includes('409 conflict')),
        '409 conflict should be logged as a retryable warning',
      );
      assert.equal(entries.error.length, 0);
    });

    it('logs non-409 polling startup failures without retrying', async () => {
      const { entries, log } = recordingLog();
      const adapter = new TelegramAdapter('test-token', log);
      let startCalls = 0;
      let closeCalls = 0;

      adapter._injectPollingControls({
        start: async () => {
          startCalls += 1;
          throw { error_code: 404, description: 'Not Found' };
        },
        close: async () => {
          closeCalls += 1;
        },
        sleep: async () => {
          throw new Error('non-409 errors must not sleep');
        },
      });

      adapter.startPolling(async () => {});
      await flushPollingLoop();

      assert.equal(startCalls, 1);
      assert.equal(closeCalls, 0);
      assert.ok(
        entries.error.some((entry) => String(entry.at(-1)).includes('Long polling failed')),
        'non-409 polling failures should be logged',
      );
    });
  });

  // ── Phase 5: Media message parsing ──
  describe('parseUpdate() with media types', () => {
    it('extracts photo message with file_id', () => {
      const adapter = new TelegramAdapter('test-token', noopLog());
      const update = {
        update_id: 123,
        message: {
          message_id: 456,
          from: { id: 789, is_bot: false },
          chat: { id: 1001, type: 'private' },
          date: 1710000000,
          photo: [
            { file_id: 'small_id', width: 100, height: 100, file_size: 1000 },
            { file_id: 'large_id', width: 800, height: 600, file_size: 50000 },
          ],
        },
      };
      const result = adapter.parseUpdate(update);
      assert.ok(result);
      assert.equal(result.text, '[图片]');
      // Should pick the largest photo
      assert.deepEqual(result.attachments, [{ type: 'image', telegramFileId: 'large_id' }]);
    });

    it('extracts photo with caption as text', () => {
      const adapter = new TelegramAdapter('test-token', noopLog());
      const update = {
        update_id: 123,
        message: {
          message_id: 456,
          from: { id: 789, is_bot: false },
          chat: { id: 1001, type: 'private' },
          date: 1710000000,
          photo: [{ file_id: 'photo_id', width: 800, height: 600, file_size: 50000 }],
          caption: 'Check this out!',
        },
      };
      const result = adapter.parseUpdate(update);
      assert.ok(result);
      assert.equal(result.text, 'Check this out!');
      assert.deepEqual(result.attachments, [{ type: 'image', telegramFileId: 'photo_id' }]);
    });

    it('extracts document message with file_id', () => {
      const adapter = new TelegramAdapter('test-token', noopLog());
      const update = {
        update_id: 123,
        message: {
          message_id: 456,
          from: { id: 789, is_bot: false },
          chat: { id: 1001, type: 'private' },
          date: 1710000000,
          document: { file_id: 'doc_id', file_name: 'report.pdf', file_size: 100000 },
        },
      };
      const result = adapter.parseUpdate(update);
      assert.ok(result);
      assert.equal(result.text, '[文件] report.pdf');
      assert.deepEqual(result.attachments, [{ type: 'file', telegramFileId: 'doc_id', fileName: 'report.pdf' }]);
    });

    it('extracts voice message with file_id', () => {
      const adapter = new TelegramAdapter('test-token', noopLog());
      const update = {
        update_id: 123,
        message: {
          message_id: 456,
          from: { id: 789, is_bot: false },
          chat: { id: 1001, type: 'private' },
          date: 1710000000,
          voice: { file_id: 'voice_id', duration: 5, file_size: 10000 },
        },
      };
      const result = adapter.parseUpdate(update);
      assert.ok(result);
      assert.equal(result.text, '[语音]');
      assert.deepEqual(result.attachments, [{ type: 'audio', telegramFileId: 'voice_id', duration: 5 }]);
    });
  });

  describe('connectorId', () => {
    it('is telegram', () => {
      const adapter = new TelegramAdapter('test-token', noopLog());
      assert.equal(adapter.connectorId, 'telegram');
    });
  });

  // K1: Telegram duplicate fix — placeholder chatId tracking + deleteMessage
  describe('sendPlaceholder() and deleteMessage()', () => {
    it('sendPlaceholder stores chatId mapping for later deletion', async () => {
      const adapter = new TelegramAdapter('test-token', noopLog());
      const sendCalls = [];
      const deleteCalls = [];

      adapter._injectBotApiSendMessage(async (chatId, _text) => {
        sendCalls.push(chatId);
        return { message_id: 42 };
      });
      adapter._injectBotApiDeleteMessage(async (chatId, msgId) => {
        deleteCalls.push({ chatId, msgId });
      });

      const msgId = await adapter.sendPlaceholder('1001', '猫猫思考中…');
      assert.equal(msgId, '42');
      assert.deepEqual(sendCalls, [1001]);

      await adapter.deleteMessage(msgId);
      assert.equal(deleteCalls.length, 1);
      assert.equal(deleteCalls[0].chatId, 1001);
      assert.equal(deleteCalls[0].msgId, 42);
    });

    it('deleteMessage is no-op for unknown platformMessageId', async () => {
      const adapter = new TelegramAdapter('test-token', noopLog());
      const deleteCalls = [];
      adapter._injectBotApiDeleteMessage(async (chatId, msgId) => {
        deleteCalls.push({ chatId, msgId });
      });

      await assert.doesNotReject(() => adapter.deleteMessage('9999'));
      assert.equal(deleteCalls.length, 0);
    });

    it('deleteMessage cleans up mapping after deletion (no double-delete)', async () => {
      const adapter = new TelegramAdapter('test-token', noopLog());
      const deleteCalls = [];

      adapter._injectBotApiSendMessage(async (_chatId, _text) => ({ message_id: 77 }));
      adapter._injectBotApiDeleteMessage(async (chatId, msgId) => {
        deleteCalls.push({ chatId, msgId });
      });

      const msgId = await adapter.sendPlaceholder('2002', 'placeholder');
      await adapter.deleteMessage(msgId);
      await adapter.deleteMessage(msgId); // second call must be no-op

      assert.equal(deleteCalls.length, 1, 'should only delete once');
    });

    it('deleteMessage uses explicit externalChatId over map when provided (multi-chat same message_id)', async () => {
      // Telegram message_id is only unique within a single chat.
      // When two chats produce the same message_id, the Map alone is unreliable.
      // The caller (StreamingOutboundHook) must pass externalChatId explicitly.
      const adapter = new TelegramAdapter('test-token', noopLog());
      const deleteCalls = [];
      let callCount = 0;

      adapter._injectBotApiSendMessage(async (_chatId, _text) => {
        callCount++;
        return { message_id: 42 }; // both chats return same message_id
      });
      adapter._injectBotApiDeleteMessage(async (chatId, msgId) => {
        deleteCalls.push({ chatId, msgId });
      });

      const msgId1 = await adapter.sendPlaceholder('1001', 'placeholder chat 1');
      const msgId2 = await adapter.sendPlaceholder('2002', 'placeholder chat 2');
      assert.equal(msgId1, '42');
      assert.equal(msgId2, '42');

      // Caller provides externalChatId explicitly — must delete from correct chat
      await adapter.deleteMessage(msgId1, '1001');
      assert.equal(deleteCalls.length, 1);
      assert.equal(deleteCalls[0].chatId, 1001, 'must delete from chat 1001, not 2002');

      await adapter.deleteMessage(msgId2, '2002');
      assert.equal(deleteCalls.length, 2);
      assert.equal(deleteCalls[1].chatId, 2002, 'must delete from chat 2002');
    });
  });

  // P1-2: textContent must not be discarded when both text and blocks present
  describe('sendRichMessage() text preservation', () => {
    it('includes textContent in HTML output alongside blocks', async () => {
      const adapter = new TelegramAdapter('test-token', noopLog());
      const sendCalls = [];
      adapter._injectSendMessage(async (chatId, text, opts) => {
        sendCalls.push({ chatId, text, opts });
      });

      const blocks = [{ id: 'b1', kind: 'card', v: 1, title: 'Review', bodyMarkdown: 'LGTM' }];
      await adapter.sendRichMessage('1001', 'Cat reply text here', blocks, '布偶猫');

      assert.equal(sendCalls.length, 1);
      assert.ok(sendCalls[0].text.includes('Cat reply text here'), 'textContent must appear in output');
      assert.ok(sendCalls[0].text.includes('Review'), 'block content must also appear');
    });
  });

  // K2: inline final streaming — edit placeholder instead of sending new message
  describe('registerInlinePlaceholder() + inline final (K2)', () => {
    it('sendReply edits placeholder instead of sending new message when inline pending', async () => {
      const adapter = new TelegramAdapter('test-token', noopLog());
      const sendCalls = [];
      const editCalls = [];
      adapter._injectSendMessage(async (chatId, text, opts) => sendCalls.push({ chatId, text, opts }));
      adapter.editMessage = async (chatId, msgId, text) => editCalls.push({ chatId, msgId, text });

      adapter.registerInlinePlaceholder('1001', '42');
      await adapter.sendReply('1001', 'Final answer');

      assert.equal(sendCalls.length, 0, 'must NOT send a new message when inline pending');
      assert.equal(editCalls.length, 1, 'must edit the placeholder');
      assert.equal(editCalls[0].chatId, '1001');
      assert.equal(editCalls[0].msgId, '42');
      assert.equal(editCalls[0].text, 'Final answer');
    });

    it('sendReply sends new message normally when no inline pending', async () => {
      const adapter = new TelegramAdapter('test-token', noopLog());
      const sendCalls = [];
      adapter._injectSendMessage(async (chatId, text) => sendCalls.push({ chatId, text }));

      await adapter.sendReply('1001', 'Normal reply');

      assert.equal(sendCalls.length, 1, 'must send normally when no inline pending');
      assert.equal(sendCalls[0].chatId, '1001');
    });

    it('inline placeholder is consumed after sendReply (second call sends new message)', async () => {
      const adapter = new TelegramAdapter('test-token', noopLog());
      const sendCalls = [];
      const editCalls = [];
      adapter._injectSendMessage(async (chatId, text) => sendCalls.push({ chatId, text }));
      adapter.editMessage = async (chatId, msgId, text) => editCalls.push({ chatId, msgId, text });

      adapter.registerInlinePlaceholder('1001', '42');
      await adapter.sendReply('1001', 'Final answer'); // consumes inline
      await adapter.sendReply('1001', 'Another reply'); // should send normally

      assert.equal(editCalls.length, 1, 'only first sendReply should edit');
      assert.equal(sendCalls.length, 1, 'second sendReply should send a new message');
      assert.equal(sendCalls[0].text, 'Another reply');
    });

    it('sendRichMessage edits placeholder with HTML when inline pending', async () => {
      const adapter = new TelegramAdapter('test-token', noopLog());
      const sendCalls = [];
      const editCalls = [];
      adapter._injectSendMessage(async (chatId, text, opts) => sendCalls.push({ chatId, text, opts }));
      adapter.editMessage = async (chatId, msgId, text, opts) => editCalls.push({ chatId, msgId, text, opts });

      const blocks = [{ id: 'b1', kind: 'card', v: 1, title: 'Done', bodyMarkdown: 'All good' }];
      adapter.registerInlinePlaceholder('1001', '55');
      await adapter.sendRichMessage('1001', 'Cat reply', blocks, '布偶猫');

      assert.equal(sendCalls.length, 0, 'must NOT send new message when inline pending');
      assert.equal(editCalls.length, 1, 'must edit the placeholder');
      assert.equal(editCalls[0].chatId, '1001');
      assert.equal(editCalls[0].msgId, '55');
      assert.ok(
        editCalls[0].text.includes('Done') || editCalls[0].text.includes('All good'),
        'HTML must contain block content',
      );
    });

    it('sendRichMessage sends normally when no inline pending', async () => {
      const adapter = new TelegramAdapter('test-token', noopLog());
      const sendCalls = [];
      adapter._injectSendMessage(async (chatId, text, opts) => sendCalls.push({ chatId, text, opts }));

      const blocks = [{ id: 'b1', kind: 'card', v: 1, title: 'Done', bodyMarkdown: 'OK' }];
      await adapter.sendRichMessage('1001', 'Reply', blocks, '布偶猫');

      assert.equal(sendCalls.length, 1, 'must send normally when no inline pending');
    });

    it('inline from one chatId does not affect another chatId', async () => {
      const adapter = new TelegramAdapter('test-token', noopLog());
      const sendCalls = [];
      const editCalls = [];
      adapter._injectSendMessage(async (chatId, text) => sendCalls.push({ chatId, text }));
      adapter.editMessage = async (chatId, msgId, text) => editCalls.push({ chatId, msgId, text });

      adapter.registerInlinePlaceholder('1001', '42');
      await adapter.sendReply('2002', 'Message to different chat');

      assert.equal(editCalls.length, 0, 'chatId 2002 has no inline pending — must not edit');
      assert.equal(sendCalls.length, 1, 'chatId 2002 must send normally');
      assert.equal(sendCalls[0].chatId, '2002');
    });

    // K2 P1 #2: preserve delivery when editMessage throws
    it('sendReply falls back to send when editMessage throws', async () => {
      const adapter = new TelegramAdapter('test-token', noopLog());
      const sendCalls = [];
      adapter._injectSendMessage(async (chatId, text) => sendCalls.push({ chatId, text }));
      adapter._injectBotApiDeleteMessage(async () => {});
      adapter.editMessage = async () => {
        throw new Error('Telegram edit failed');
      };

      adapter.registerInlinePlaceholder('1001', '42');
      await adapter.sendReply('1001', 'Fallback content');

      assert.equal(sendCalls.length, 1, 'must fall back to send when edit throws');
      assert.equal(sendCalls[0].chatId, '1001');
      assert.equal(sendCalls[0].text, 'Fallback content');
    });

    // K2 P1 #1: clearInlinePlaceholder cleans up stale entry
    it('clearInlinePlaceholder removes pending entry (delivery skipped)', async () => {
      const adapter = new TelegramAdapter('test-token', noopLog());
      const deleteCalls = [];
      adapter._injectBotApiDeleteMessage(async (chatId, msgId) => deleteCalls.push({ chatId, msgId }));

      adapter.registerInlinePlaceholder('1001', '42');
      await adapter.clearInlinePlaceholder('1001', '42');

      // After clear, sendReply should send normally (not edit a stale entry)
      const sendCalls = [];
      adapter._injectSendMessage(async (chatId, text) => sendCalls.push({ chatId, text }));
      await adapter.sendReply('1001', 'New reply');

      assert.equal(deleteCalls.length, 1, 'must delete stale streaming card');
      assert.equal(sendCalls.length, 1, 'must send new reply normally (no stale inline)');
    });

    it('clearInlinePlaceholder is no-op when entry was already consumed', async () => {
      const adapter = new TelegramAdapter('test-token', noopLog());
      const deleteCalls = [];
      adapter._injectBotApiDeleteMessage(async (chatId, msgId) => deleteCalls.push({ chatId, msgId }));
      adapter.editMessage = async () => {};

      adapter.registerInlinePlaceholder('1001', '42');
      await adapter.sendReply('1001', 'Content delivered'); // consumes entry
      await adapter.clearInlinePlaceholder('1001', '42'); // should be no-op

      assert.equal(deleteCalls.length, 0, 'no delete when entry already consumed by delivery');
    });
  });

  // K3: HTML parse fallback, editMessage failure fallback, long text segmentation
  describe('K3 robustness', () => {
    describe('sendRichMessage() HTML parse fallback', () => {
      it('falls back to plain text sendMessage when HTML parse fails', async () => {
        const adapter = new TelegramAdapter('test-token', noopLog());
        const sendCalls = [];
        adapter._injectSendMessage(async (chatId, text, opts) => {
          if (opts?.parse_mode === 'HTML') {
            const err = new Error("Bad Request: can't parse entities");
            err.error_code = 400;
            err.description = "Bad Request: can't parse entities: Unsupported start tag";
            throw err;
          }
          sendCalls.push({ chatId, text, opts });
        });

        const blocks = [{ id: 'b1', kind: 'card', v: 1, title: 'Test', bodyMarkdown: 'Body' }];
        await adapter.sendRichMessage('1001', 'reply text', blocks, '猫猫');

        assert.equal(sendCalls.length, 1, 'must retry with plain text after HTML parse error');
        assert.ok(!sendCalls[0].opts?.parse_mode, 'retry must not use HTML parse_mode');
      });

      it('falls back to send (not truncated edit) when inline HTML edit fails with parse error', async () => {
        const adapter = new TelegramAdapter('test-token', noopLog());
        const editCalls = [];
        const sendCalls = [];
        adapter.editMessage = async (chatId, msgId, text, opts) => {
          if (opts?.parse_mode === 'HTML') {
            const err = new Error("Bad Request: can't parse entities");
            err.error_code = 400;
            err.description = "Bad Request: can't parse entities";
            throw err;
          }
          editCalls.push({ chatId, msgId, text, opts });
        };
        adapter._injectSendMessage(async (chatId, text, opts) => sendCalls.push({ chatId, text, opts }));
        adapter._injectBotApiDeleteMessage(async () => {});

        adapter.registerInlinePlaceholder('1001', '42');
        const blocks = [{ id: 'b1', kind: 'card', v: 1, title: 'Test', bodyMarkdown: 'Body' }];
        await adapter.sendRichMessage('1001', 'reply text', blocks, '猫猫');

        assert.equal(editCalls.length, 0, 'must not retry edit as plain text — HTML errors fall through to send');
        assert.ok(sendCalls.length > 0, 'must use send path instead of truncated plain text edit');
      });
    });

    describe('editMessage() failure fallback to sendReply', () => {
      it('falls back to sendReply when editMessage fails (message deleted)', async () => {
        const adapter = new TelegramAdapter('test-token', noopLog());
        const sendCalls = [];
        adapter._injectSendMessage(async (chatId, text, opts) => sendCalls.push({ chatId, text, opts }));
        adapter._injectBotApiDeleteMessage(async () => {});

        adapter.registerInlinePlaceholder('1001', '42');
        // Simulate edit failing (message was deleted by user)
        adapter.editMessage = async () => {
          const err = new Error('Bad Request: message to edit not found');
          err.error_code = 400;
          throw err;
        };

        await adapter.sendReply('1001', 'Final answer');

        assert.equal(sendCalls.length, 1, 'must fall back to sendReply after editMessage failure');
        assert.equal(sendCalls[0].text, 'Final answer');
        assert.equal(sendCalls[0].chatId, '1001');
      });

      it('falls back to sendReply when editMessage fails for sendRichMessage', async () => {
        const adapter = new TelegramAdapter('test-token', noopLog());
        const sendCalls = [];
        adapter._injectSendMessage(async (chatId, text, opts) => sendCalls.push({ chatId, text, opts }));
        adapter._injectBotApiDeleteMessage(async () => {});

        adapter.registerInlinePlaceholder('1001', '42');
        adapter.editMessage = async () => {
          throw new Error('Bad Request: message to edit not found');
        };

        const blocks = [{ id: 'b1', kind: 'card', v: 1, title: 'Test', bodyMarkdown: 'Body' }];
        await adapter.sendRichMessage('1001', 'reply text', blocks, '猫猫');

        assert.equal(sendCalls.length, 1, 'must fall back to sendMessage after editMessage failure');
      });
    });

    // K3 P1 #1: inline final path respects 4096 char limit via splitText
    describe('inline final with long content (K3 P1 #1)', () => {
      it('sendReply edits placeholder with first 4096-char segment, sends rest as new messages', async () => {
        const adapter = new TelegramAdapter('test-token', noopLog());
        const sendCalls = [];
        const editCalls = [];
        adapter._injectSendMessage(async (chatId, text) => sendCalls.push({ chatId, text }));
        adapter.editMessage = async (chatId, msgId, text) => editCalls.push({ chatId, msgId, text });

        const longContent = 'X'.repeat(5000);
        adapter.registerInlinePlaceholder('1001', '77');
        await adapter.sendReply('1001', longContent);

        assert.equal(editCalls.length, 1, 'must edit placeholder with first segment');
        assert.equal(editCalls[0].text.length, 4096, 'first segment must be exactly 4096 chars');
        assert.equal(sendCalls.length, 1, 'remaining 904 chars must be sent as a new message');
        assert.equal(sendCalls[0].text.length, 5000 - 4096, 'second segment has the remaining chars');
        // Combined output must equal original content
        const combined = editCalls[0].text + sendCalls.map((c) => c.text).join('');
        assert.equal(combined, longContent, 'combined segments must equal original content');
      });

      it('sendReply falls back to send-all when inline edit fails for long content', async () => {
        const adapter = new TelegramAdapter('test-token', noopLog());
        const sendCalls = [];
        adapter._injectSendMessage(async (chatId, text) => sendCalls.push({ chatId, text }));
        adapter._injectBotApiDeleteMessage(async () => {});
        adapter.editMessage = async () => {
          throw new Error('Telegram edit failed');
        };

        const longContent = 'Y'.repeat(5000);
        adapter.registerInlinePlaceholder('1001', '77');
        await adapter.sendReply('1001', longContent);

        assert.ok(sendCalls.length >= 2, 'must send all segments when edit fails');
        for (const call of sendCalls) {
          assert.ok(call.text.length <= 4096, `segment must be ≤4096 chars, got ${call.text.length}`);
        }
        const combined = sendCalls.map((c) => c.text).join('');
        assert.equal(combined, longContent, 'combined fallback segments must equal original content');
      });
    });

    // K3 P1 #2: FIFO queue — two invocations in same chat use their own placeholders
    describe('FIFO queue for concurrent invocations (K3 P1 #2)', () => {
      it('two invocations registered FIFO — first delivery edits oldest placeholder', async () => {
        const adapter = new TelegramAdapter('test-token', noopLog());
        const editCalls = [];
        adapter.editMessage = async (chatId, msgId, text) => editCalls.push({ chatId, msgId, text });

        adapter.registerInlinePlaceholder('1001', 'ph-inv1');
        adapter.registerInlinePlaceholder('1001', 'ph-inv2');

        await adapter.sendReply('1001', 'Reply from inv1');

        assert.equal(editCalls.length, 1, 'only first delivery edits a placeholder');
        assert.equal(editCalls[0].msgId, 'ph-inv1', 'must edit the OLDEST (first) placeholder');
      });

      it('second delivery uses second placeholder (FIFO)', async () => {
        const adapter = new TelegramAdapter('test-token', noopLog());
        const editCalls = [];
        adapter.editMessage = async (chatId, msgId, text) => editCalls.push({ chatId, msgId, text });

        adapter.registerInlinePlaceholder('1001', 'ph-inv1');
        adapter.registerInlinePlaceholder('1001', 'ph-inv2');

        await adapter.sendReply('1001', 'Reply from inv1'); // consumes ph-inv1
        await adapter.sendReply('1001', 'Reply from inv2'); // consumes ph-inv2

        assert.equal(editCalls.length, 2);
        assert.equal(editCalls[0].msgId, 'ph-inv1', 'first delivery edits first placeholder');
        assert.equal(editCalls[1].msgId, 'ph-inv2', 'second delivery edits second placeholder');
      });

      it('clearInlinePlaceholder removes specific placeholder from FIFO queue', async () => {
        const adapter = new TelegramAdapter('test-token', noopLog());
        const editCalls = [];
        const deleteCalls = [];
        adapter.editMessage = async (chatId, msgId, text) => editCalls.push({ chatId, msgId, text });
        adapter._injectBotApiDeleteMessage(async (chatId, msgId) => deleteCalls.push({ chatId, msgId }));

        adapter.registerInlinePlaceholder('1001', 'ph-inv1');
        adapter.registerInlinePlaceholder('1001', 'ph-inv2');

        // Skip delivery for inv1 — simulate cleanup
        await adapter.clearInlinePlaceholder('1001', 'ph-inv1');

        // inv2 delivery should use ph-inv2 (not ph-inv1)
        await adapter.sendReply('1001', 'Reply from inv2');

        assert.equal(deleteCalls.length, 1, 'clearInlinePlaceholder must delete the stale streaming card');
        assert.equal(editCalls.length, 1, 'inv2 delivery must still edit its own placeholder');
        assert.equal(editCalls[0].msgId, 'ph-inv2', 'must edit ph-inv2 after ph-inv1 was cleared');
      });

      // K3 P1 (2nd review): shift() must not happen before editMessage succeeds
      it('sendReply: ID remains in FIFO queue when editMessage fails so clearInlinePlaceholder can clean up', async () => {
        const adapter = new TelegramAdapter('test-token', noopLog());
        const sendCalls = [];
        const deleteCalls = [];
        adapter._injectSendMessage(async (chatId, text) => sendCalls.push({ chatId, text }));
        adapter._injectBotApiDeleteMessage(async (chatId, msgId) => deleteCalls.push({ chatId, msgId }));
        adapter.editMessage = async () => {
          throw new Error('Telegram edit failed');
        };

        adapter.registerInlinePlaceholder('1001', 'ph-42');
        await adapter.sendReply('1001', 'Fallback content'); // edit fails, fallback sends
        await adapter.clearInlinePlaceholder('1001', 'ph-42'); // must still find ID and delete stale card

        assert.equal(sendCalls.length, 1, 'fallback send happened');
        assert.equal(deleteCalls.length, 1, 'stale streaming placeholder deleted via clearInlinePlaceholder');
      });

      // K3 P1 same issue in sendRichMessage
      it('sendRichMessage: ID remains in FIFO queue when editMessage fails so clearInlinePlaceholder can clean up', async () => {
        const adapter = new TelegramAdapter('test-token', noopLog());
        const sendCalls = [];
        const deleteCalls = [];
        adapter._injectSendMessage(async (chatId, text, opts) => sendCalls.push({ chatId, text, opts }));
        adapter._injectBotApiDeleteMessage(async (chatId, msgId) => deleteCalls.push({ chatId, msgId }));
        adapter.editMessage = async () => {
          throw new Error('edit failed');
        };

        const blocks = [{ id: 'b1', kind: 'card', v: 1, title: 'Done', bodyMarkdown: 'OK' }];
        adapter.registerInlinePlaceholder('1001', 'ph-42');
        await adapter.sendRichMessage('1001', 'text', blocks, '布偶猫'); // edit fails, fallback sends
        await adapter.clearInlinePlaceholder('1001', 'ph-42'); // must still find ID and delete

        assert.equal(sendCalls.length, 1, 'fallback send happened');
        assert.equal(deleteCalls.length, 1, 'stale streaming placeholder deleted');
      });

      // K3 P1 (3rd review): stale card must be deleted inline after fallback, not relying on cleanupPlaceholders
      it('sendReply: stale card deleted immediately after fallback without relying on cleanupPlaceholders', async () => {
        const adapter = new TelegramAdapter('test-token', noopLog());
        const sendCalls = [];
        const deleteCalls = [];
        adapter._injectSendMessage(async (chatId, text) => sendCalls.push({ chatId, text }));
        adapter._injectBotApiDeleteMessage(async (chatId, msgId) => deleteCalls.push({ chatId, msgId }));
        adapter.editMessage = async () => {
          throw new Error('edit failed');
        };

        adapter.registerInlinePlaceholder('1001', 'ph-42');
        await adapter.sendReply('1001', 'Fallback content'); // edit fails, fallback sends

        // Without calling clearInlinePlaceholder: stale card must already be gone
        assert.equal(sendCalls.length, 1, 'fallback send happened');
        assert.equal(deleteCalls.length, 1, 'stale card deleted by sendReply, no cleanupPlaceholders call needed');

        // Queue must be clean — next sendReply must not attempt inline edit
        const editCalls2 = [];
        const sendCalls2 = [];
        adapter.editMessage = async (...args) => editCalls2.push(args);
        adapter._injectSendMessage(async (chatId, text) => sendCalls2.push({ chatId, text }));
        await adapter.sendReply('1001', 'Next reply');
        assert.equal(editCalls2.length, 0, 'queue cleaned: next reply must not try inline edit');
        assert.equal(sendCalls2.length, 1, 'next reply sent normally');
      });

      // K3 P1 same: sendRichMessage stale card deleted inline after fallback
      it('sendRichMessage: stale card deleted immediately after fallback without relying on cleanupPlaceholders', async () => {
        const adapter = new TelegramAdapter('test-token', noopLog());
        const sendCalls = [];
        const deleteCalls = [];
        adapter._injectSendMessage(async (chatId, text, opts) => sendCalls.push({ chatId, text, opts }));
        adapter._injectBotApiDeleteMessage(async (chatId, msgId) => deleteCalls.push({ chatId, msgId }));
        adapter.editMessage = async () => {
          throw new Error('edit failed');
        };

        const blocks = [{ id: 'b1', kind: 'card', v: 1, title: 'Done', bodyMarkdown: 'OK' }];
        adapter.registerInlinePlaceholder('1001', 'ph-42');
        await adapter.sendRichMessage('1001', 'text', blocks, '布偶猫');

        assert.equal(sendCalls.length, 1, 'fallback send happened');
        assert.equal(deleteCalls.length, 1, 'stale card deleted inline without cleanupPlaceholders');
      });

      // K3 P2 (3rd review): HTML parse error in inline path must fall through to send (not truncated edit)
      it('sendRichMessage: HTML parse error in inline path falls through to send path (not truncated edit)', async () => {
        const adapter = new TelegramAdapter('test-token', noopLog());
        const sendCalls = [];
        const editCalls = [];
        adapter._injectBotApiDeleteMessage(async () => {});
        adapter.editMessage = async (chatId, msgId, text, opts) => {
          if (opts?.parse_mode === 'HTML') {
            const err = new Error("can't parse entities");
            err.error_code = 400;
            throw err;
          }
          editCalls.push({ chatId, msgId, text, opts });
        };
        adapter._injectSendMessage(async (chatId, text, opts) => sendCalls.push({ chatId, text, opts }));

        const blocks = [{ id: 'b1', kind: 'card', v: 1, title: 'T', bodyMarkdown: 'B' }];
        adapter.registerInlinePlaceholder('1001', 'ph-42');
        await adapter.sendRichMessage('1001', 'text', blocks, '猫猫');

        assert.equal(editCalls.length, 0, 'must not retry edit as plain text when HTML parse fails');
        assert.ok(sendCalls.length > 0, 'must fall through to send path when HTML edit fails');
      });

      // K3 P2 (2nd review): clearInlinePlaceholder must clean placeholderChats on success path
      it('clearInlinePlaceholder cleans placeholderChats after ID already consumed so stale entry cannot be misused', async () => {
        const adapter = new TelegramAdapter('test-token', noopLog());
        const editCalls = [];
        const deleteCalls = [];
        adapter.editMessage = async (chatId, msgId, text) => editCalls.push({ chatId, msgId, text });
        adapter._injectBotApiDeleteMessage(async (chatId, msgId) => deleteCalls.push({ chatId, msgId }));
        adapter._injectBotApiSendMessage(async (_chatId, _text) => ({ message_id: 42 }));

        await adapter.sendPlaceholder('1001', 'Thinking...'); // placeholderChats: {'42': '1001'}
        adapter.registerInlinePlaceholder('1001', '42');
        await adapter.sendReply('1001', 'Final content'); // edits '42' in place, ID consumed from queue

        // clearInlinePlaceholder must clean placeholderChats['42']
        await adapter.clearInlinePlaceholder('1001', '42');

        // If placeholderChats was cleaned, deleteMessage('42') without chatId finds nothing and is a no-op
        await adapter.deleteMessage('42');
        assert.equal(deleteCalls.length, 0, 'placeholderChats cleaned: no stale entry for deleteMessage to exploit');
      });
    });

    describe('long text segmentation (>4096 chars)', () => {
      it('sendReply splits content exceeding 4096 chars into multiple messages', async () => {
        const adapter = new TelegramAdapter('test-token', noopLog());
        const sendCalls = [];
        adapter._injectSendMessage(async (chatId, text) => sendCalls.push({ chatId, text }));

        const longText = 'A'.repeat(5000);
        await adapter.sendReply('1001', longText);

        assert.ok(sendCalls.length >= 2, 'must split into multiple messages');
        for (const call of sendCalls) {
          assert.ok(call.text.length <= 4096, `each segment must be ≤4096 chars, got ${call.text.length}`);
        }
        const combined = sendCalls.map((c) => c.text).join('');
        assert.equal(combined, longText, 'combined segments must equal original content');
      });

      it('sendRichMessage splits plain-text fallback exceeding 4096 chars', async () => {
        const adapter = new TelegramAdapter('test-token', noopLog());
        const sendCalls = [];
        // Always reject HTML to force plain text path
        adapter._injectSendMessage(async (chatId, text, opts) => {
          if (opts?.parse_mode === 'HTML') {
            const err = new Error("can't parse entities");
            err.error_code = 400;
            throw err;
          }
          sendCalls.push({ chatId, text });
        });

        const blocks = [{ id: 'b1', kind: 'card', v: 1, title: 'Test', bodyMarkdown: 'B'.repeat(5000) }];
        await adapter.sendRichMessage('1001', 'prefix', blocks, '猫猫');

        for (const call of sendCalls) {
          assert.ok(call.text.length <= 4096, `each segment must be ≤4096 chars, got ${call.text.length}`);
        }
      });

      // K3 P2 (3rd review): splitText must not split surrogate pairs (emoji/non-BMP chars)
      it('splitText does not split surrogate pairs at segment boundaries', async () => {
        const adapter = new TelegramAdapter('test-token', noopLog());
        const sendCalls = [];
        adapter._injectSendMessage(async (chatId, text) => sendCalls.push({ chatId, text }));

        // Build a string where an emoji lands exactly at position 4095 (high surrogate at 4095, low at 4096)
        // Emoji '😀' = 😀 (2 code units). Place it straddling the 4096 boundary.
        const prefix = 'A'.repeat(4095); // 4095 chars
        const emoji = '😀'; // 2 code units — position 4095-4096
        const suffix = 'B'.repeat(100);
        const text = prefix + emoji + suffix; // total > 4096

        await adapter.sendReply('1001', text);

        // Every segment must be valid (no unpaired surrogates)
        for (const call of sendCalls) {
          assert.doesNotThrow(
            () => encodeURIComponent(call.text),
            `segment must not contain unpaired surrogates: ${call.text.slice(-20)}`,
          );
        }
        // Combined content must equal original
        const combined = sendCalls.map((c) => c.text).join('');
        assert.equal(combined, text, 'split segments must reconstruct original content');
      });
    });

    // K3 R9/cloud-P1: mid-stream HTML parse error must fall back to plain text for remaining chunks
    describe('HTML partial delivery — graceful plain-text fallback on mid-loop parse error', () => {
      it('sendRichMessage non-inline: mid-stream HTML parse error sends remaining chunks as plain text (no throw)', async () => {
        const adapter = new TelegramAdapter('test-token', noopLog());
        const sentCalls = [];
        let callCount = 0;
        adapter._injectSendMessage(async (_chatId, text, opts) => {
          callCount++;
          if (opts?.parse_mode === 'HTML' && callCount > 1) {
            const err = Object.assign(new Error("can't parse entities: unfinished element"), { error_code: 400 });
            throw err;
          }
          sentCalls.push({ text, mode: opts?.parse_mode });
        });
        // Long content forces 2+ HTML chunks; no inline placeholder = non-inline path
        const longText = 'A'.repeat(4097);
        await adapter.sendRichMessage('1001', longText, [], '布偶猫');
        const htmlCalls = sentCalls.filter((c) => c.mode === 'HTML');
        const plainCalls = sentCalls.filter((c) => c.mode !== 'HTML');
        assert.ok(htmlCalls.length >= 1, 'first chunk(s) sent as HTML before parse error');
        assert.ok(
          plainCalls.length >= 1,
          'remaining chunk(s) sent as plain text after mid-stream parse error (no duplication of earlier chunks)',
        );
      });

      it('sendRichMessage inline-fallback: mid-stream HTML parse error sends remaining chunks as plain text (no throw)', async () => {
        const adapter = new TelegramAdapter('test-token', noopLog());
        // editMessage always fails → enters inline fallback send path
        adapter.editMessage = async () => {
          throw new Error('edit failed');
        };
        adapter._injectBotApiDeleteMessage(async () => {});
        const sentCalls = [];
        let callCount = 0;
        adapter._injectSendMessage(async (_chatId, text, opts) => {
          callCount++;
          if (opts?.parse_mode === 'HTML' && callCount > 1) {
            const err = Object.assign(new Error("can't parse entities: unfinished element"), { error_code: 400 });
            throw err;
          }
          sentCalls.push({ text, mode: opts?.parse_mode });
        });
        adapter.registerInlinePlaceholder('1001', 'ph-1');
        const longText = 'A'.repeat(4097);
        await adapter.sendRichMessage('1001', longText, [], '布偶猫');
        const htmlCalls = sentCalls.filter((c) => c.mode === 'HTML');
        const plainCalls = sentCalls.filter((c) => c.mode !== 'HTML');
        assert.ok(htmlCalls.length >= 1, 'inline-fallback: first chunk(s) sent as HTML before parse error');
        assert.ok(
          plainCalls.length >= 1,
          'inline-fallback: remaining chunk(s) sent as plain text after mid-stream parse error',
        );
      });
    });

    // K3 P1 (3rd review): queue cleanup must happen before fallback sends to survive send failures
    describe('inline fallback robustness when send also fails', () => {
      it('sendReply: queue cleaned before fallback sends so state is safe even if send throws', async () => {
        const adapter = new TelegramAdapter('test-token', noopLog());
        const deleteCalls = [];
        adapter._injectBotApiDeleteMessage(async (chatId, msgId) => deleteCalls.push({ chatId, msgId }));
        // editMessage fails
        adapter.editMessage = async () => {
          throw new Error('edit failed');
        };
        // sendMessageFn also fails (double failure)
        adapter._injectSendMessage(async () => {
          throw new Error('send also failed');
        });

        adapter.registerInlinePlaceholder('1001', 'ph-42');
        try {
          await adapter.sendReply('1001', 'content');
        } catch {
          // send failure expected to propagate
        }

        // Queue must be clean even though send failed — stale card must also be deleted
        // Verify: a subsequent call (with normal send) must NOT attempt inline edit on stale ID
        const editCalls2 = [];
        const sendCalls2 = [];
        adapter.editMessage = async (chatId, msgId, text) => editCalls2.push({ chatId, msgId, text });
        adapter._injectSendMessage(async (chatId, text) => sendCalls2.push({ chatId, text }));
        await adapter.sendReply('1001', 'Next reply');
        assert.equal(editCalls2.length, 0, 'queue cleaned before send: next reply must not attempt stale inline edit');
        assert.equal(sendCalls2.length, 1, 'next reply sent normally');
        assert.equal(deleteCalls.length, 1, 'stale streaming card deleted even though send failed');
      });
    });

    // K3 round-4 P1: concurrent sendReply calls must consume distinct queue entries
    describe('concurrent delivery — no placeholder ID collision', () => {
      it('sendReply: two concurrent calls use distinct queue placeholders', async () => {
        const adapter = new TelegramAdapter('test-token', noopLog());
        const editCalls = [];
        const resolvers = [];
        adapter.editMessage = async (_chatId, msgId, text) => {
          editCalls.push({ msgId, text });
          return new Promise((resolve) => resolvers.push(resolve));
        };
        adapter.registerInlinePlaceholder('1001', 'ph-1');
        adapter.registerInlinePlaceholder('1001', 'ph-2');
        // Start both concurrently — neither awaits until we flush microtasks
        const p1 = adapter.sendReply('1001', 'Content A');
        const p2 = adapter.sendReply('1001', 'Content B');
        // Resolve all pending edit promises
        resolvers.forEach((r) => r());
        await Promise.all([p1, p2]);
        assert.deepStrictEqual(
          editCalls.map((c) => c.msgId).sort(),
          ['ph-1', 'ph-2'],
          'each concurrent call must use a distinct placeholder, not both ph-1',
        );
      });
    });

    // K3 round-5 P1: inline path must send remaining segments when HTML exceeds 4096 chars
    describe('inline overflow segments', () => {
      it('sendRichMessage: inline edit sends first segment and remaining segments as new messages', async () => {
        const adapter = new TelegramAdapter('test-token', noopLog());
        const editCalls = [];
        const sendCalls = [];
        adapter.editMessage = async (_chatId, msgId, text, opts) => editCalls.push({ msgId, text, opts });
        adapter._injectSendMessage(async (_chatId, text, opts) => sendCalls.push({ text, opts }));
        adapter.registerInlinePlaceholder('1001', 'ph-1');

        // Use empty blocks so HTML = header(~14) + '\n\n' + textContent + '\n\n'
        // With textContent = 4097 'A' chars, total HTML ≈ 4115 chars → 2 parts from splitText
        const longText = 'A'.repeat(4097);
        await adapter.sendRichMessage('1001', longText, [], '布偶猫');

        assert.equal(editCalls.length, 1, 'editMessage called once for first segment');
        assert.ok(editCalls[0].text.length <= 4096, 'first segment fits within 4096 chars');
        assert.ok(sendCalls.length >= 1, 'remaining segment(s) sent as new message(s)');
        assert.ok(sendCalls[0].text.length > 0, 'remaining segment is non-empty');
        assert.deepEqual(sendCalls[0].opts, { parse_mode: 'HTML' }, 'remaining segment sent with HTML parse_mode');
      });

      // cloud-R11 P1: inline overflow chunks must fall back to plain text on HTML parse error
      it('sendRichMessage inline: overflow chunk HTML parse error falls back to plain text (no throw)', async () => {
        const adapter = new TelegramAdapter('test-token', noopLog());
        const editCalls = [];
        const sendCalls = [];
        let overflowCallCount = 0;
        adapter.editMessage = async (_chatId, msgId, text, opts) => editCalls.push({ msgId, text, opts });
        adapter._injectSendMessage(async (_chatId, text, opts) => {
          overflowCallCount++;
          // First overflow send with HTML → trigger HTML parse error
          if (overflowCallCount === 1 && opts?.parse_mode === 'HTML') {
            throw Object.assign(new Error("Bad Request: can't parse entities"), {
              error_code: 400,
              description: "Bad Request: can't parse entities in message text",
            });
          }
          sendCalls.push({ text, mode: opts?.parse_mode ?? 'plain' });
        });
        adapter.registerInlinePlaceholder('1001', 'ph-1');
        // Long enough to produce overflow: editMessage gets firstHtmlPart, restHtmlParts overflow
        const longText = 'A'.repeat(5000);
        await adapter.sendRichMessage('1001', longText, [], '布偶猫'); // must NOT throw
        assert.equal(editCalls.length, 1, 'editMessage called once for inline first chunk');
        const plainOverflow = sendCalls.filter((c) => c.mode === 'plain');
        assert.ok(plainOverflow.length >= 1, 'overflow chunk(s) sent as plain text after HTML parse error');
      });

      // cloud-R7 P2: overflow chunk failure must not re-send the already-edited first part
      it('sendReply: overflow chunk failure after editMessage success does not resend first part', async () => {
        const adapter = new TelegramAdapter('test-token', noopLog());
        const editCalls = [];
        const sendCalls = [];
        const deleteCalls = [];
        adapter.editMessage = async (_chatId, msgId, text) => {
          editCalls.push({ msgId, text });
        };
        // Fail only for the single-char overflow ('Z'); succeed otherwise to detect duplication
        adapter._injectSendMessage(async (_chatId, text) => {
          if (text === 'Z') throw new Error('sendMessage failed for overflow');
          sendCalls.push(text);
        });
        adapter._injectBotApiDeleteMessage(async (chatId, msgId) => {
          deleteCalls.push({ chatId, msgId });
        });

        adapter.registerInlinePlaceholder('1001', 'ph-1');
        // 4096 'A' chars + 'Z' → firstPart = 'A'.repeat(4096), overflow = 'Z'
        const longContent = 'A'.repeat(4096) + 'Z';
        try {
          await adapter.sendReply('1001', longContent);
        } catch (_) {
          // overflow failure may propagate; we care about side-effects, not throw/no-throw
        }

        assert.equal(editCalls.length, 1, 'editMessage called once for first part');
        assert.equal(sendCalls.length, 0, 'first part must NOT be re-sent after overflow failure — no duplication');
        assert.equal(
          deleteCalls.length,
          0,
          'successfully edited message must NOT be deleted after overflow chunk failure',
        );
      });
    });

    // K3 round-4 P2: HTML fallback must use plain text, not raw HTML markup
    describe('plain-text fallback content', () => {
      it('sendRichMessage: plain-text fallback sends textContent not raw HTML tags', async () => {
        const adapter = new TelegramAdapter('test-token', noopLog());
        const sendCalls = [];
        let callCount = 0;
        adapter._injectSendMessage(async (_chatId, text) => {
          callCount++;
          if (callCount === 1) {
            // Simulate Telegram HTML parse error on first (HTML) send
            throw { error_code: 400, description: "can't parse entities: unfinished element" };
          }
          sendCalls.push(text);
        });
        const blocks = [{ id: 'b1', kind: 'card', v: 1, title: 'T', bodyMarkdown: '**bold**' }];
        await adapter.sendRichMessage('1001', 'Plain fallback text', blocks, '布偶猫');
        assert.ok(sendCalls.length > 0, 'plain fallback send must have been called');
        for (const text of sendCalls) {
          assert.ok(!text.includes('<b>'), `fallback must not contain HTML tags, got: ${text.slice(0, 80)}`);
          assert.ok(!text.includes('&lt;'), `fallback must not contain HTML entities, got: ${text.slice(0, 80)}`);
          assert.ok(text.includes('Plain fallback text'), 'fallback must contain the plain textContent');
        }
      });

      // cloud-R7 P1: empty textContent must not produce empty message in HTML-parse fallback
      it('sendRichMessage: HTML-parse fallback with empty textContent delivers non-empty content', async () => {
        const adapter = new TelegramAdapter('test-token', noopLog());
        const sendCalls = [];
        adapter._injectSendMessage(async (_chatId, text, opts) => {
          if (opts?.parse_mode === 'HTML') {
            throw { error_code: 400, description: "can't parse entities: unfinished element" };
          }
          sendCalls.push(text);
        });
        const blocks = [{ id: 'b1', kind: 'card', v: 1, title: 'Important Title', bodyMarkdown: '**bold**' }];
        // textContent is empty — richBlocks-only turn
        await adapter.sendRichMessage('1001', '', blocks, '布偶猫');
        assert.ok(sendCalls.length > 0, 'must send something even when textContent is empty');
        for (const text of sendCalls) {
          assert.ok(text.trim().length > 0, `sent text must be non-empty, got: "${text}"`);
        }
      });
    });

    // K3 cloud-R6 P1 (line 404): non-inline sendRichMessage must split HTML over 4096 chars
    describe('non-inline long HTML splitting', () => {
      it('sendRichMessage: non-inline path splits HTML over 4096 chars into multiple messages', async () => {
        const adapter = new TelegramAdapter('test-token', noopLog());
        const sendCalls = [];
        adapter._injectSendMessage(async (_chatId, text, opts) => sendCalls.push({ text, opts }));
        // Empty blocks + 5000-char textContent → HTML > 4096 (header + \n\n + textContent + \n\n)
        const longText = 'X'.repeat(5000);
        await adapter.sendRichMessage('1001', longText, [], '布偶猫');
        assert.ok(sendCalls.length >= 2, `must split long HTML, got ${sendCalls.length} call(s)`);
        for (const call of sendCalls) {
          assert.ok(call.text.length <= 4096, `each segment must be <= 4096 chars, got ${call.text.length}`);
          assert.deepEqual(call.opts, { parse_mode: 'HTML' }, 'each segment must be sent with HTML parse_mode');
        }
      });

      it('sendRichMessage: inline edit-fail fallback splits long HTML into multiple messages', async () => {
        const adapter = new TelegramAdapter('test-token', noopLog());
        const sendCalls = [];
        const deleteCalls = [];
        adapter.editMessage = async () => {
          throw new Error('edit failed');
        };
        adapter._injectSendMessage(async (_chatId, text, opts) => sendCalls.push({ text, opts }));
        adapter.deleteMessage = async (msgId) => deleteCalls.push(msgId);
        adapter.registerInlinePlaceholder('1001', 'ph-1');
        const longText = 'X'.repeat(5000);
        await adapter.sendRichMessage('1001', longText, [], '布偶猫');
        assert.equal(deleteCalls.length, 1, 'stale streaming card must be deleted after edit failure');
        assert.ok(sendCalls.length >= 2, `fallback must split long HTML, got ${sendCalls.length} call(s)`);
        for (const call of sendCalls) {
          assert.ok(call.text.length <= 4096, `each fallback segment must be <= 4096 chars, got ${call.text.length}`);
        }
      });
    });

    // K3 cloud-R7 P1: plain-text fallback must prefer stripped HTML content over bare textContent
    describe('plain-text fallback content priority (K3 cloud-R7 P1)', () => {
      it('sendRichMessage: HTML parse error fallback sends stripped HTML, not just textContent', async () => {
        const adapter = new TelegramAdapter('test-token', noopLog());
        const sentTexts = [];
        adapter._injectSendMessage(async (_chatId, text, opts) => {
          if (opts?.parse_mode === 'HTML') {
            // Simulate Telegram HTML parse error on first HTML attempt
            throw Object.assign(new Error("Bad Request: can't parse entities"), {
              error_code: 400,
              description: "Bad Request: can't parse entities in message text",
            });
          }
          sentTexts.push(text);
        });
        const blocks = [{ id: 'b1', kind: 'card', v: 1, title: 'Rich Block Title', bodyMarkdown: 'detailed content' }];
        await adapter.sendRichMessage('1001', 'Short summary', blocks, '布偶猫');
        assert.ok(sentTexts.length > 0, 'must send fallback text');
        const sent = sentTexts.join(' ');
        // stripped HTML contains the rich block title; textContent alone does not
        assert.ok(
          sent.includes('Rich Block Title'),
          `plain fallback must include rich block content from HTML, got: "${sent.slice(0, 200)}"`,
        );
      });
    });

    // K3 cloud-R7 P1: HTML splitting must not cut inside an HTML entity (&amp; &lt; &gt;)
    describe('inline-path entity-safe HTML splitting (K3 cloud-R10 P1)', () => {
      it('sendRichMessage inline: overflow chunks from inline edit path use entity-safe splitting', async () => {
        // Inline path: editMessage gets firstHtmlPart, restHtmlParts sent as new messages.
        // If splitText is used (not splitHtml), a chunk may end with incomplete &amp; entity.
        const spacer = 'B'.repeat(4076);
        const textContent = spacer + '&extra content';
        const adapter = new TelegramAdapter('test-token', noopLog());
        const editCalls = [];
        const sendCalls = [];
        adapter.editMessage = async (_chatId, _msgId, text, _opts) => {
          editCalls.push(text);
        };
        adapter._injectSendMessage(async (_chatId, text, opts) => {
          if (opts?.parse_mode === 'HTML') sendCalls.push(text);
        });
        adapter.registerInlinePlaceholder('1001', '42');
        await adapter.sendRichMessage('1001', textContent, [], '布偶猫');
        // editMessage received the first chunk; sendMessage received overflow chunks
        assert.ok(editCalls.length >= 1, 'must call editMessage for inline first chunk');
        for (const chunk of [...editCalls, ...sendCalls]) {
          assert.ok(
            !/&amp$/.test(chunk) && !/&am$/.test(chunk) && !/&a$/.test(chunk) && !/&$/.test(chunk),
            `inline chunk must not end with incomplete entity, got tail: "${chunk.slice(-10)}"`,
          );
        }
      });
    });

    describe('entity-safe HTML splitting (K3 cloud-R7 P1)', () => {
      it('sendRichMessage: splitting HTML does not produce chunks ending with incomplete entities', async () => {
        // header = "<b>【布偶猫🐱】</b>" (14 JS chars) + "\n\n" (2) = 16 before esc(textContent)
        // Place an '&' at exactly the 4096-char boundary so splitText cuts inside &amp;
        // spacer: 4096 - 16 = 4080... actually 4092 to hit the entity body
        // esc(textContent) starts at position 16; we want '&' at position 4092 → spacer = 4076 B's
        const spacer = 'B'.repeat(4076);
        const textContent = spacer + '&extra content';
        // esc() turns the '&' into '&amp;' — positions 4092-4096 (straddles 4096 boundary)
        const adapter = new TelegramAdapter('test-token', noopLog());
        const sendCalls = [];
        adapter._injectSendMessage(async (_chatId, text, opts) => {
          if (opts?.parse_mode === 'HTML') sendCalls.push(text);
        });
        await adapter.sendRichMessage('1001', textContent, [], '布偶猫');
        assert.ok(sendCalls.length >= 2, `HTML must be split (${sendCalls.length} chunk(s))`);
        for (const chunk of sendCalls) {
          assert.ok(
            !/&amp$/.test(chunk) && !/&am$/.test(chunk) && !/&a$/.test(chunk) && !/&$/.test(chunk),
            `chunk must not end with incomplete entity, got tail: "${chunk.slice(-10)}"`,
          );
        }
      });
    });
  });
});
