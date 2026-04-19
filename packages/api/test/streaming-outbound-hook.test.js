import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

describe('StreamingOutboundHook', () => {
  let StreamingOutboundHook;

  before(async () => {
    const mod = await import('../dist/infrastructure/connectors/StreamingOutboundHook.js');
    StreamingOutboundHook = mod.StreamingOutboundHook;
  });

  function createMockAdapter(opts = {}) {
    return {
      connectorId: 'feishu',
      sendReply: async () => {},
      sendPlaceholder: async (_chatId, _text) => 'msg-placeholder-1',
      editMessage: async (_chatId, _msgId, _text) => {},
      deleteMessage: opts.noDelete ? undefined : async (_msgId) => {},
      finalizeStreamCard: opts.noFinalize ? undefined : async (_chatId, _msgId, _catName) => {},
      _calls: { sendPlaceholder: [], editMessage: [], deleteMessage: [], finalizeStreamCard: [] },
    };
  }

  function wrapAdapter(adapter) {
    const original = {
      sendPlaceholder: adapter.sendPlaceholder,
      editMessage: adapter.editMessage,
      deleteMessage: adapter.deleteMessage,
      finalizeStreamCard: adapter.finalizeStreamCard,
    };
    adapter.sendPlaceholder = async (chatId, text) => {
      adapter._calls.sendPlaceholder.push({ chatId, text });
      return original.sendPlaceholder(chatId, text);
    };
    adapter.editMessage = async (chatId, msgId, text) => {
      adapter._calls.editMessage.push({ chatId, msgId, text });
      return original.editMessage(chatId, msgId, text);
    };
    if (adapter.deleteMessage) {
      adapter.deleteMessage = async (msgId) => {
        adapter._calls.deleteMessage.push({ msgId });
        return original.deleteMessage(msgId);
      };
    }
    if (adapter.finalizeStreamCard) {
      adapter.finalizeStreamCard = async (chatId, msgId, catName) => {
        adapter._calls.finalizeStreamCard.push({ chatId, msgId, catName });
        return original.finalizeStreamCard(chatId, msgId, catName);
      };
    }
    return adapter;
  }

  function createBindingStore(bindings) {
    return {
      getByThread: async () => bindings ?? [],
      getByExternal: async () => null,
      bind: async () => ({}),
      remove: async () => false,
      listByUser: async () => [],
    };
  }

  function createHook(opts = {}) {
    const adapter = wrapAdapter(createMockAdapter(opts));
    const adapters = new Map([['feishu', adapter]]);
    const bindingStore = createBindingStore(
      opts.bindings ?? [
        { connectorId: 'feishu', externalChatId: 'chat1', threadId: 'thread-1', userId: 'u1', createdAt: Date.now() },
      ],
    );
    const log = {
      warn: () => {},
      info: () => {},
      error: () => {},
      debug: () => {},
      fatal: () => {},
      trace: () => {},
      child: () => log,
    };
    const hook = new StreamingOutboundHook({
      bindingStore,
      adapters,
      log,
      updateIntervalMs: opts.updateIntervalMs ?? 0,
      minDeltaChars: opts.minDeltaChars ?? 0,
    });
    return { hook, adapter };
  }

  it('F157: onStreamStart sends cat-personality receipt instead of generic thinking text', async () => {
    const { hook, adapter } = createHook();
    await hook.onStreamStart('thread-1', 'opus');
    assert.equal(adapter._calls.sendPlaceholder.length, 1);
    assert.equal(adapter._calls.sendPlaceholder[0].chatId, 'chat1');
    const text = adapter._calls.sendPlaceholder[0].text;
    // Should NOT contain the old "思考中" generic text
    assert.ok(!text.includes('思考中'), `Receipt should not contain "思考中", got: ${text}`);
    // Should be a non-empty receipt line (catRegistry may not be loaded in test,
    // so we verify the text is a real receipt, not a blank/generic placeholder)
    assert.ok(text.length > 0, 'Receipt text must be non-empty');
    assert.ok(!text.includes('placeholder'), `Receipt should not be a raw placeholder, got: ${text}`);
  });

  it('F157 P1-2: Telegram adapter gets 【猫猫🐱 思考中...】 placeholder (scheme C start state)', async () => {
    const telegramAdapter = wrapAdapter({
      connectorId: 'telegram',
      sendReply: async () => {},
      sendPlaceholder: async (_chatId, _text) => 'msg-tg-1',
      editMessage: async (_chatId, _msgId, _text) => {},
      deleteMessage: async (_msgId) => {},
      _calls: { sendPlaceholder: [], editMessage: [], deleteMessage: [], finalizeStreamCard: [] },
    });
    const adapters = new Map([['telegram', telegramAdapter]]);
    const bindingStore = createBindingStore([
      {
        connectorId: 'telegram',
        externalChatId: 'tg-chat1',
        threadId: 'thread-1',
        userId: 'u1',
        createdAt: Date.now(),
      },
    ]);
    const log = {
      warn: () => {},
      info: () => {},
      error: () => {},
      debug: () => {},
      fatal: () => {},
      trace: () => {},
      child: () => log,
    };
    const hook = new StreamingOutboundHook({ bindingStore, adapters, log, updateIntervalMs: 0, minDeltaChars: 0 });
    await hook.onStreamStart('thread-1', 'opus');
    assert.equal(telegramAdapter._calls.sendPlaceholder.length, 1);
    const text = telegramAdapter._calls.sendPlaceholder[0].text;
    assert.ok(text.includes('🐱'), `Telegram placeholder must contain 🐱, got: ${text}`);
    assert.ok(text.includes('思考中'), `Telegram placeholder must contain 思考中, got: ${text}`);
    assert.ok(!text.includes('🤔'), `Telegram placeholder must not use old 🤔 format, got: ${text}`);
  });

  it('F157 P2: sender hint adds sender name to Feishu receipt prefix with 🐱', async () => {
    const { hook, adapter } = createHook();
    await hook.onStreamStart('thread-1', 'opus', undefined, { id: 'ou_abc', name: '小明' });
    assert.equal(adapter._calls.sendPlaceholder.length, 1);
    const text = adapter._calls.sendPlaceholder[0].text;
    // Sender name should appear in the prefix for group chat context
    assert.ok(text.includes('小明'), `Receipt should contain sender name, got: ${text}`);
    // AC-A2: 🐱 must always be present in prefix (R2 regression)
    assert.ok(text.includes('🐱'), `Receipt must contain 🐱 emoji per AC-A2, got: ${text}`);
  });

  it('onStreamStart is no-op when no bindings exist', async () => {
    const { hook, adapter } = createHook({ bindings: [] });
    await hook.onStreamStart('thread-1', 'opus');
    assert.equal(adapter._calls.sendPlaceholder.length, 0);
  });

  it('onStreamChunk edits message when thresholds met', async () => {
    const { hook, adapter } = createHook({ updateIntervalMs: 0, minDeltaChars: 0 });
    await hook.onStreamStart('thread-1');
    await hook.onStreamChunk('thread-1', 'Hello world this is content');
    assert.equal(adapter._calls.editMessage.length, 1);
    assert.ok(adapter._calls.editMessage[0].text.includes('Hello world'));
  });

  it('onStreamChunk respects rate limit', async () => {
    const { hook, adapter } = createHook({ updateIntervalMs: 999999, minDeltaChars: 0 });
    await hook.onStreamStart('thread-1');
    await hook.onStreamChunk('thread-1', 'chunk1');
    await hook.onStreamChunk('thread-1', 'chunk1 chunk2');
    // Rate limit prevents edits
    assert.equal(adapter._calls.editMessage.length, 0);
  });

  it('onStreamChunk respects min delta chars', async () => {
    const { hook, adapter } = createHook({ updateIntervalMs: 0, minDeltaChars: 9999 });
    await hook.onStreamStart('thread-1');
    await hook.onStreamChunk('thread-1', 'short');
    assert.equal(adapter._calls.editMessage.length, 0);
  });

  it('F157: cleanupPlaceholders prefers finalizeStreamCard over deleteMessage', async () => {
    const { hook, adapter } = createHook();
    await hook.onStreamStart('thread-1', 'opus');
    await hook.onStreamEnd('thread-1', 'Final complete response text');
    // Not cleaned up yet
    assert.equal(adapter._calls.finalizeStreamCard.length, 0);
    assert.equal(adapter._calls.deleteMessage.length, 0);
    // Now cleanup
    await hook.cleanupPlaceholders('thread-1');
    // Should finalize, NOT delete
    assert.equal(adapter._calls.finalizeStreamCard.length, 1);
    assert.equal(adapter._calls.finalizeStreamCard[0].msgId, 'msg-placeholder-1');
    assert.equal(
      adapter._calls.deleteMessage.length,
      0,
      'deleteMessage must NOT be called when finalizeStreamCard is available',
    );
  });

  it('cleanupPlaceholders falls back to deleteMessage when no finalizeStreamCard', async () => {
    const { hook, adapter } = createHook({ noFinalize: true });
    await hook.onStreamStart('thread-1');
    await hook.onStreamEnd('thread-1', 'Final text');
    await hook.cleanupPlaceholders('thread-1');
    assert.equal(adapter._calls.deleteMessage.length, 1);
    assert.equal(adapter._calls.deleteMessage[0].msgId, 'msg-placeholder-1');
  });

  it('onStreamEnd falls back to editMessage when neither deleteMessage nor finalizeStreamCard', async () => {
    const { hook, adapter } = createHook({ noDelete: true, noFinalize: true });
    await hook.onStreamStart('thread-1');
    await hook.onStreamEnd('thread-1', 'Final complete response text');
    assert.equal(adapter._calls.editMessage.length, 1);
    assert.ok(adapter._calls.editMessage[0].text.includes('Final complete response'));
    assert.ok(!adapter._calls.editMessage[0].text.includes('▌'));
  });

  it('tracks inline-final-delivery connectors until cleanup finishes', async () => {
    const telegramAdapter = wrapAdapter({
      connectorId: 'telegram',
      ownsFinalDelivery: true,
      sendReply: async () => {},
      sendPlaceholder: async (_chatId, _text) => 'msg-tg-1',
      editMessage: async (_chatId, _msgId, _text) => {},
      _calls: { sendPlaceholder: [], editMessage: [], deleteMessage: [], finalizeStreamCard: [] },
    });
    const adapters = new Map([['telegram', telegramAdapter]]);
    const bindingStore = createBindingStore([
      {
        connectorId: 'telegram',
        externalChatId: 'tg-chat1',
        threadId: 'thread-1',
        userId: 'u1',
        createdAt: Date.now(),
      },
    ]);
    const log = {
      warn: () => {},
      info: () => {},
      error: () => {},
      debug: () => {},
      fatal: () => {},
      trace: () => {},
      child: () => log,
    };
    const hook = new StreamingOutboundHook({ bindingStore, adapters, log, updateIntervalMs: 0, minDeltaChars: 0 });

    await hook.onStreamStart('thread-1', 'opus', 'inv-1');
    assert.deepEqual(hook.getDeliverySkipConnectorIds('thread-1', 'inv-1'), ['telegram']);

    await hook.onStreamEnd('thread-1', 'Final telegram text', 'inv-1');
    assert.deepEqual(hook.getDeliverySkipConnectorIds('thread-1', 'inv-1'), ['telegram']);

    await hook.cleanupPlaceholders('thread-1', 'inv-1');
    assert.deepEqual(hook.getDeliverySkipConnectorIds('thread-1', 'inv-1'), []);
  });

  it('uses explicit ownsFinalDelivery flag instead of inferring from method combinations', async () => {
    const telegramAdapter = wrapAdapter({
      connectorId: 'telegram',
      ownsFinalDelivery: true,
      sendReply: async () => {},
      sendPlaceholder: async (_chatId, _text) => 'msg-tg-1',
      editMessage: async (_chatId, _msgId, _text) => {},
      deleteMessage: async (_msgId) => {},
      _calls: { sendPlaceholder: [], editMessage: [], deleteMessage: [], finalizeStreamCard: [] },
    });
    const adapters = new Map([['telegram', telegramAdapter]]);
    const bindingStore = createBindingStore([
      {
        connectorId: 'telegram',
        externalChatId: 'tg-chat1',
        threadId: 'thread-1',
        userId: 'u1',
        createdAt: Date.now(),
      },
    ]);
    const log = {
      warn: () => {},
      info: () => {},
      error: () => {},
      debug: () => {},
      fatal: () => {},
      trace: () => {},
      child: () => log,
    };
    const hook = new StreamingOutboundHook({ bindingStore, adapters, log, updateIntervalMs: 0, minDeltaChars: 0 });

    await hook.onStreamStart('thread-1', 'opus', 'inv-explicit');
    assert.deepEqual(hook.getDeliverySkipConnectorIds('thread-1', 'inv-explicit'), ['telegram']);
  });

  it('Telegram ownsFinalDelivery+deleteMessage: editMessage writes final content before cleanup', async () => {
    // Regression test for: streaming stops updating after many edits, final content never written
    // Root cause: deleteMessage presence caused onStreamEnd to defer without writing final content
    const telegramAdapter = wrapAdapter({
      connectorId: 'telegram',
      ownsFinalDelivery: true,
      sendReply: async () => {},
      sendPlaceholder: async (_chatId, _text) => 'msg-tg-1',
      editMessage: async (_chatId, _msgId, _text) => {},
      deleteMessage: async (_msgId) => {},
      _calls: { sendPlaceholder: [], editMessage: [], deleteMessage: [], finalizeStreamCard: [] },
    });
    const adapters = new Map([['telegram', telegramAdapter]]);
    const bindingStore = createBindingStore([
      { connectorId: 'telegram', externalChatId: 'tg-chat1', threadId: 'thread-1', userId: 'u1', createdAt: Date.now() },
    ]);
    const log = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {}, fatal: () => {}, trace: () => {}, child: function() { return log; } };
    const hook = new StreamingOutboundHook({ bindingStore, adapters, log, updateIntervalMs: 0, minDeltaChars: 0 });

    await hook.onStreamStart('thread-1', 'opus', 'inv-tg');
    await hook.onStreamChunk('thread-1', 'Partial streaming content', 'inv-tg');
    await hook.onStreamEnd('thread-1', 'Final complete answer', 'inv-tg');

    // editMessage must have been called with final content (no ▌ cursor), with ✅ completion prefix
    const edits = telegramAdapter._calls.editMessage;
    assert.ok(edits.length >= 1, 'editMessage must be called at least once');
    const lastEdit = edits[edits.length - 1];
    assert.ok(lastEdit.text.includes('✅'), 'Last edit must contain ✅ completion marker');
    assert.ok(lastEdit.text.includes('Final complete answer'), 'Last edit must contain final content');
    assert.ok(!lastEdit.text.includes('▌'), 'Last edit must not contain streaming cursor');
    // deleteMessage must NOT be called yet (deferred until cleanupPlaceholders)
    assert.equal(telegramAdapter._calls.deleteMessage.length, 0, 'deleteMessage must be deferred');

    // After cleanup, placeholder is deleted
    await hook.cleanupPlaceholders('thread-1', 'inv-tg');
    assert.equal(telegramAdapter._calls.deleteMessage.length, 1);
    assert.equal(telegramAdapter._calls.deleteMessage[0].msgId, 'msg-tg-1');
  });

  it('Telegram ownsFinalDelivery: editMessage failure removes connectorId from skip list for fallback delivery', async () => {
    // Regression: if final editMessage throws (429/network), skip list must be cleared
    // so OutboundDeliveryHook can deliver as fallback — otherwise answer is silently lost
    const telegramAdapter = wrapAdapter({
      connectorId: 'telegram',
      ownsFinalDelivery: true,
      sendReply: async () => {},
      sendPlaceholder: async (_chatId, _text) => 'msg-tg-fail',
      editMessage: async (_chatId, _msgId, _text) => { throw new Error('429 Too Many Requests'); },
      deleteMessage: async (_msgId) => {},
      _calls: { sendPlaceholder: [], editMessage: [], deleteMessage: [], finalizeStreamCard: [] },
    });
    const adapters = new Map([['telegram', telegramAdapter]]);
    const bindingStore = createBindingStore([
      { connectorId: 'telegram', externalChatId: 'tg-chat1', threadId: 'thread-1', userId: 'u1', createdAt: Date.now() },
    ]);
    const log = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {}, fatal: () => {}, trace: () => {}, child: function() { return log; } };
    const hook = new StreamingOutboundHook({ bindingStore, adapters, log, updateIntervalMs: 0, minDeltaChars: 0 });

    await hook.onStreamStart('thread-1', 'opus', 'inv-fail');
    // Before onStreamEnd, telegram is in skip list
    assert.deepEqual(hook.getDeliverySkipConnectorIds('thread-1', 'inv-fail'), ['telegram']);

    // editMessage will throw — should not propagate, but must remove from skip list
    await hook.onStreamEnd('thread-1', 'Final answer', 'inv-fail');

    // Skip list must be cleared so OutboundDeliveryHook delivers as fallback
    assert.deepEqual(hook.getDeliverySkipConnectorIds('thread-1', 'inv-fail'), [],
      'skip list must be empty after editMessage failure so OutboundDeliveryHook can deliver');
    // deleteMessage must NOT be deferred (edit failed, nothing to clean up)
    await hook.cleanupPlaceholders('thread-1', 'inv-fail');
    assert.equal(telegramAdapter._calls.deleteMessage.length, 0,
      'deleteMessage must not be called when editMessage failed');
  });

  it('Telegram ownsFinalDelivery+deleteMessage: falls back to lastAccumulatedText when finalText empty', async () => {
    const telegramAdapter = wrapAdapter({
      connectorId: 'telegram',
      ownsFinalDelivery: true,
      sendReply: async () => {},
      sendPlaceholder: async (_chatId, _text) => 'msg-tg-2',
      editMessage: async (_chatId, _msgId, _text) => {},
      deleteMessage: async (_msgId) => {},
      _calls: { sendPlaceholder: [], editMessage: [], deleteMessage: [], finalizeStreamCard: [] },
    });
    const adapters = new Map([['telegram', telegramAdapter]]);
    const bindingStore = createBindingStore([
      { connectorId: 'telegram', externalChatId: 'tg-chat1', threadId: 'thread-1', userId: 'u1', createdAt: Date.now() },
    ]);
    const log = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {}, fatal: () => {}, trace: () => {}, child: function() { return log; } };
    const hook = new StreamingOutboundHook({ bindingStore, adapters, log, updateIntervalMs: 0, minDeltaChars: 0 });

    await hook.onStreamStart('thread-1', 'opus', 'inv-tg2');
    await hook.onStreamChunk('thread-1', 'Accumulated so far', 'inv-tg2');
    // finalText is empty (stream interrupted)
    await hook.onStreamEnd('thread-1', '', 'inv-tg2');

    const edits = telegramAdapter._calls.editMessage;
    const lastEdit = edits[edits.length - 1];
    // Should fall back to lastAccumulatedText, with ✅ completion prefix
    assert.ok(lastEdit.text.includes('✅'), 'Must contain ✅ completion marker');
    assert.ok(lastEdit.text.includes('Accumulated so far'), 'Must fall back to lastAccumulatedText when finalText empty');
  });

  it('uses streamed text fallback when inline-final-delivery ends without final text', async () => {
    const telegramAdapter = wrapAdapter({
      connectorId: 'telegram',
      ownsFinalDelivery: true,
      sendReply: async () => {},
      sendPlaceholder: async (_chatId, _text) => 'msg-tg-1',
      editMessage: async (_chatId, _msgId, _text) => {},
      _calls: { sendPlaceholder: [], editMessage: [], deleteMessage: [], finalizeStreamCard: [] },
    });
    const adapters = new Map([['telegram', telegramAdapter]]);
    const bindingStore = createBindingStore([
      {
        connectorId: 'telegram',
        externalChatId: 'tg-chat1',
        threadId: 'thread-1',
        userId: 'u1',
        createdAt: Date.now(),
      },
    ]);
    const log = {
      warn: () => {},
      info: () => {},
      error: () => {},
      debug: () => {},
      fatal: () => {},
      trace: () => {},
      child: () => log,
    };
    const hook = new StreamingOutboundHook({ bindingStore, adapters, log, updateIntervalMs: 0, minDeltaChars: 0 });

    await hook.onStreamStart('thread-1', 'opus', 'inv-1');
    await hook.onStreamChunk('thread-1', 'Partial answer', 'inv-1');
    await hook.onStreamEnd('thread-1', '', 'inv-1');

    assert.equal(telegramAdapter._calls.editMessage.length, 2);
    assert.ok(telegramAdapter._calls.editMessage[0].text.includes('思考中...'), 'chunk edit must have 思考中 prefix');
    assert.ok(telegramAdapter._calls.editMessage[0].text.includes('Partial answer ▌'), 'chunk edit must have content + cursor');
    assert.ok(telegramAdapter._calls.editMessage[1].text.includes('✅'), 'final edit must have ✅ completion marker');
    assert.ok(telegramAdapter._calls.editMessage[1].text.includes('Partial answer'), 'final edit must have content');
    assert.ok(!telegramAdapter._calls.editMessage[1].text.includes('▌'), 'final edit must not have cursor');
  });

  it('onStreamEnd cleans up session (second call is no-op)', async () => {
    const { hook, adapter } = createHook();
    await hook.onStreamStart('thread-1');
    await hook.onStreamEnd('thread-1', 'Done');
    await hook.onStreamEnd('thread-1', 'Done again');
    // Only one deferred cleanup
    await hook.cleanupPlaceholders('thread-1');
    assert.equal(adapter._calls.finalizeStreamCard.length, 1);
  });

  it('placeholder survives if cleanupPlaceholders is never called (delivery failure)', async () => {
    const { hook, adapter } = createHook();
    await hook.onStreamStart('thread-1');
    await hook.onStreamEnd('thread-1', 'Done');
    // Simulate: outbound delivery fails, cleanup never called
    assert.equal(adapter._calls.deleteMessage.length, 0);
    assert.equal(adapter._calls.finalizeStreamCard.length, 0);
    // Placeholder card stays visible in external chat as fallback
  });

  it('onStreamChunk appends cursor indicator', async () => {
    const { hook, adapter } = createHook({ updateIntervalMs: 0, minDeltaChars: 0 });
    await hook.onStreamStart('thread-1');
    await hook.onStreamChunk('thread-1', 'typing...');
    assert.ok(adapter._calls.editMessage[0].text.includes('▌'));
  });

  it('cross-invocation isolation: A cleanup does not affect B placeholder', async () => {
    const adapter = wrapAdapter(createMockAdapter({ noFinalize: true }));
    let placeholderCounter = 0;
    adapter.sendPlaceholder = async (_chatId, _text) => {
      placeholderCounter++;
      return `msg-placeholder-${placeholderCounter}`;
    };
    const adapters = new Map([['feishu', adapter]]);
    const bindingStore = createBindingStore([
      { connectorId: 'feishu', externalChatId: 'chat1', threadId: 'thread-1', userId: 'u1', createdAt: Date.now() },
    ]);
    const log = {
      warn: () => {},
      info: () => {},
      error: () => {},
      debug: () => {},
      fatal: () => {},
      trace: () => {},
      child: () => log,
    };
    const hook = new StreamingOutboundHook({ bindingStore, adapters, log, updateIntervalMs: 0, minDeltaChars: 0 });

    await hook.onStreamStart('thread-1', undefined, 'inv-A');
    await hook.onStreamStart('thread-1', undefined, 'inv-B');
    await hook.onStreamEnd('thread-1', 'Final A', 'inv-A');
    await hook.onStreamEnd('thread-1', 'Final B', 'inv-B');

    await hook.cleanupPlaceholders('thread-1', 'inv-A');
    assert.equal(adapter._calls.deleteMessage.length, 1);
    assert.equal(adapter._calls.deleteMessage[0].msgId, 'msg-placeholder-1');

    await hook.cleanupPlaceholders('thread-1', 'inv-B');
    assert.equal(adapter._calls.deleteMessage.length, 2);
    assert.equal(adapter._calls.deleteMessage[1].msgId, 'msg-placeholder-2');
  });

  it('cross-invocation isolation: A late-success cleanup only cleans A placeholders', async () => {
    const adapter = wrapAdapter(createMockAdapter({ noFinalize: true }));
    let placeholderCounter = 0;
    adapter.sendPlaceholder = async (_chatId, _text) => {
      placeholderCounter++;
      return `msg-placeholder-${placeholderCounter}`;
    };
    const adapters = new Map([['feishu', adapter]]);
    const bindingStore = createBindingStore([
      { connectorId: 'feishu', externalChatId: 'chat1', threadId: 'thread-1', userId: 'u1', createdAt: Date.now() },
    ]);
    const log = {
      warn: () => {},
      info: () => {},
      error: () => {},
      debug: () => {},
      fatal: () => {},
      trace: () => {},
      child: () => log,
    };
    const hook = new StreamingOutboundHook({ bindingStore, adapters, log, updateIntervalMs: 0, minDeltaChars: 0 });

    await hook.onStreamStart('thread-1', undefined, 'inv-A');
    await hook.onStreamStart('thread-1', undefined, 'inv-B');
    await hook.onStreamEnd('thread-1', 'Final A', 'inv-A');
    await hook.onStreamEnd('thread-1', 'Final B', 'inv-B');

    await hook.cleanupPlaceholders('thread-1', 'inv-A');
    assert.equal(adapter._calls.deleteMessage.length, 1);
    assert.equal(adapter._calls.deleteMessage[0].msgId, 'msg-placeholder-1');

    // B's placeholder must still be pending (not deleted by A's cleanup)
    // Calling cleanupPlaceholders for A again is a no-op
    await hook.cleanupPlaceholders('thread-1', 'inv-A');
    assert.equal(adapter._calls.deleteMessage.length, 1, 'second A cleanup must be no-op');
  });
});
