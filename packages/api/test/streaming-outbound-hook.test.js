import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

describe('StreamingOutboundHook', () => {
  let StreamingOutboundHook;

  before(async () => {
    const mod = await import('../dist/infrastructure/connectors/StreamingOutboundHook.js');
    StreamingOutboundHook = mod.StreamingOutboundHook;
  });

  function createMockAdapter() {
    return {
      connectorId: 'feishu',
      sendReply: async () => {},
      sendPlaceholder: async (_chatId, _text) => 'msg-placeholder-1',
      editMessage: async (_chatId, _msgId, _text) => {},
      deleteMessage: async (_msgId) => {},
      _calls: { sendPlaceholder: [], editMessage: [], deleteMessage: [] },
    };
  }

  function wrapAdapter(adapter) {
    const original = {
      sendPlaceholder: adapter.sendPlaceholder,
      editMessage: adapter.editMessage,
      deleteMessage: adapter.deleteMessage,
    };
    adapter.sendPlaceholder = async (chatId, text) => {
      adapter._calls.sendPlaceholder.push({ chatId, text });
      return original.sendPlaceholder(chatId, text);
    };
    adapter.editMessage = async (chatId, msgId, text) => {
      adapter._calls.editMessage.push({ chatId, msgId, text });
      return original.editMessage(chatId, msgId, text);
    };
    adapter.deleteMessage = async (msgId) => {
      adapter._calls.deleteMessage.push({ msgId });
      return original.deleteMessage(msgId);
    };
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
    const adapter = wrapAdapter(createMockAdapter());
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

  it('onStreamStart sends placeholder to bound adapters', async () => {
    const { hook, adapter } = createHook();
    await hook.onStreamStart('thread-1', 'opus');
    assert.equal(adapter._calls.sendPlaceholder.length, 1);
    assert.equal(adapter._calls.sendPlaceholder[0].chatId, 'chat1');
    assert.ok(adapter._calls.sendPlaceholder[0].text.includes('思考中'));
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

  it('onStreamEnd defers deletion for adapters with deleteMessage (Cloud-P1)', async () => {
    const { hook, adapter } = createHook();
    await hook.onStreamStart('thread-1');
    await hook.onStreamEnd('thread-1', 'Final complete response text');
    // Placeholder NOT deleted yet — deferred until cleanupPlaceholders
    assert.equal(adapter._calls.deleteMessage.length, 0);
    assert.equal(adapter._calls.editMessage.length, 0);
    // Now cleanup
    await hook.cleanupPlaceholders('thread-1');
    assert.equal(adapter._calls.deleteMessage.length, 1);
    assert.equal(adapter._calls.deleteMessage[0].msgId, 'msg-placeholder-1');
  });

  it('onStreamEnd falls back to editMessage when deleteMessage not available', async () => {
    const { hook, adapter } = createHook();
    delete adapter.deleteMessage;
    adapter._calls.deleteMessage = [];
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
    assert.equal(adapter._calls.deleteMessage.length, 1);
  });

  it('placeholder survives if cleanupPlaceholders is never called (delivery failure)', async () => {
    const { hook, adapter } = createHook();
    await hook.onStreamStart('thread-1');
    await hook.onStreamEnd('thread-1', 'Done');
    // Simulate: outbound delivery fails, cleanup never called
    assert.equal(adapter._calls.deleteMessage.length, 0);
    // Placeholder card stays visible in external chat as fallback
  });

  it('onStreamChunk appends cursor indicator', async () => {
    const { hook, adapter } = createHook({ updateIntervalMs: 0, minDeltaChars: 0 });
    await hook.onStreamStart('thread-1');
    await hook.onStreamChunk('thread-1', 'typing...');
    assert.ok(adapter._calls.editMessage[0].text.includes('▌'));
  });

  it('cross-invocation isolation: A cleanup does not affect B placeholder', async () => {
    const adapter = wrapAdapter(createMockAdapter());
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
    const adapter = wrapAdapter(createMockAdapter());
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
