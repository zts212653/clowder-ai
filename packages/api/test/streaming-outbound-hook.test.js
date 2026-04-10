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

  it('F157 P1-2: non-Feishu adapter gets generic "思考中" placeholder, not receipt text', async () => {
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
    assert.ok(text.includes('思考中'), `Non-Feishu adapter should get generic text, got: ${text}`);
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
