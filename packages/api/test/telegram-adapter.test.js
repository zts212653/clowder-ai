import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TelegramAdapter } from '../dist/infrastructure/connectors/adapters/TelegramAdapter.js';

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

    it('truncates messages over 4096 chars', async () => {
      const adapter = new TelegramAdapter('test-token', noopLog());
      const sendCalls = [];
      adapter._injectSendMessage(async (chatId, text, _opts) => {
        sendCalls.push({ chatId, text });
      });

      const longMsg = 'a'.repeat(5000);
      await adapter.sendReply('1001', longMsg);
      assert.equal(sendCalls.length, 1);
      assert.ok(sendCalls[0].text.length <= 4096);
      assert.ok(sendCalls[0].text.endsWith('…'));
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
});
