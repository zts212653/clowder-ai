import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_TEMPLATE_PATH = resolve(__dirname, '..', '..', '..', 'cat-template.json');

/**
 * #573/#1332: A callback can explicitly replace the same logical final to avoid
 * duplicate bubbles. Proactive callbacks are independent by default, so a later
 * provider final remains durable instead of being discarded turn-wide.
 */

function createServiceWithPostMessage(catId, toolName = 'cat_cafe_post_message') {
  return {
    async *invoke() {
      yield { type: 'text', catId, content: 'Let me post a reply.', timestamp: Date.now() };
      yield {
        type: 'tool_use',
        catId,
        toolName,
        toolInput: { content: 'Let me post a reply.', streamDisposition: 'replace_final' },
        timestamp: Date.now(),
      };
      yield {
        type: 'tool_result',
        catId,
        content: '{"status":"ok","threadId":"thread-1","messageId":"callback-msg-1"}',
        timestamp: Date.now(),
      };
      yield { type: 'text', catId, content: '', timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createServiceWithTerminalAckReplacement(catId, messageId = 'callback-terminal-ack') {
  return {
    async *invoke() {
      yield {
        type: 'tool_use',
        catId,
        toolName: 'cat_cafe_post_message',
        toolInput: {
          content: 'Terminal coordination ACK.',
          streamDisposition: 'replace_final',
          coordination: { phase: 'terminal' },
        },
        toolUseId: 'post-terminal-ack',
        timestamp: Date.now(),
      };
      yield {
        type: 'tool_result',
        catId,
        toolUseId: 'post-terminal-ack',
        content: JSON.stringify({
          status: 'terminal_ack_recorded',
          threadId: 'thread1',
          ...(messageId ? { messageId } : {}),
        }),
        timestamp: Date.now(),
      };
      yield {
        type: 'text',
        catId,
        content: 'Provider final that should be replaced by the durable terminal ACK.',
        timestamp: Date.now(),
      };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createToolOnlyReplacementService(catId) {
  return {
    async *invoke() {
      yield {
        type: 'tool_use',
        catId,
        toolName: 'cat_cafe_post_message',
        toolInput: { content: 'Callback is the final response.', streamDisposition: 'replace_final' },
        toolUseId: 'post-tool-only',
        timestamp: Date.now(),
      };
      yield {
        type: 'tool_result',
        catId,
        toolUseId: 'post-tool-only',
        content: JSON.stringify({ status: 'ok', threadId: 'thread1', messageId: 'callback-tool-only' }),
        timestamp: Date.now(),
      };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createServiceWithMultiplePostResults(catId) {
  return {
    async *invoke() {
      yield {
        type: 'tool_use',
        catId,
        toolName: 'cat_cafe_post_message',
        toolInput: { content: 'Independent callback update.' },
        toolUseId: 'post-independent',
        timestamp: Date.now(),
      };
      yield {
        type: 'tool_use',
        catId,
        toolName: 'cat_cafe_post_message',
        toolInput: { content: 'Callback replaces the final.', streamDisposition: 'replace_final' },
        toolUseId: 'post-replacement',
        timestamp: Date.now(),
      };
      yield {
        type: 'tool_result',
        catId,
        toolUseId: 'post-independent',
        content: JSON.stringify({ status: 'ok', threadId: 'thread1', messageId: 'callback-independent' }),
        timestamp: Date.now(),
      };
      yield {
        type: 'tool_result',
        catId,
        toolUseId: 'post-replacement',
        content: JSON.stringify({ status: 'ok', threadId: 'thread1', messageId: 'callback-replacement' }),
        timestamp: Date.now(),
      };
      yield { type: 'text', catId, content: 'Provider final replaced by the second callback.', timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createServiceWithPostMessageThenDistinctFinal(catId) {
  const service = {
    callbackPersistedAt: 0,
    async *invoke() {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
      yield {
        type: 'tool_use',
        catId,
        toolName: 'cat_cafe_post_message',
        toolInput: { content: 'Short proactive callback update.' },
        timestamp: Date.now(),
      };
      service.callbackPersistedAt = Date.now();
      yield {
        type: 'tool_result',
        catId,
        content: JSON.stringify({ status: 'ok', threadId: 'thread1', messageId: 'callback-msg-distinct' }),
        timestamp: Date.now(),
      };
      yield {
        type: 'text',
        catId,
        content: 'Detailed final answer that must remain durable after the callback.',
        timestamp: Date.now(),
      };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
  return service;
}

function createServiceWithPostMessageAndStreamMetadata(catId) {
  const richBlock = {
    id: 'stream-card-1',
    kind: 'card',
    v: 1,
    title: 'Stream-only card',
    bodyMarkdown: 'persist me',
  };

  return {
    richBlock,
    async *invoke() {
      yield {
        type: 'system_info',
        catId,
        content: JSON.stringify({ type: 'invocation_created', invocationId: 'inner-inv-1' }),
        timestamp: Date.now(),
      };
      yield {
        type: 'system_info',
        catId,
        content: JSON.stringify({ type: 'thinking', text: 'stream thinking chunk' }),
        timestamp: Date.now(),
      };
      yield {
        type: 'system_info',
        catId,
        content: JSON.stringify({ type: 'rich_block', block: richBlock }),
        timestamp: Date.now(),
      };
      yield { type: 'text', catId, content: '@co-creator\nCallback body with stream metadata.', timestamp: Date.now() };
      yield {
        type: 'tool_use',
        catId,
        toolName: 'cat_cafe_post_message',
        toolInput: {
          content: '@co-creator\nCallback body with stream metadata.',
          streamDisposition: 'replace_final',
        },
        timestamp: Date.now(),
      };
      yield {
        type: 'tool_result',
        catId,
        content: JSON.stringify({ status: 'ok', threadId: 'thread1', messageId: 'callback-msg-1' }),
        timestamp: Date.now(),
      };
      yield {
        type: 'done',
        catId,
        metadata: { provider: 'mock-provider', model: 'mock-model' },
        tracing: { traceId: 'trace-1', spanId: 'span-1' },
        timestamp: Date.now(),
      };
    },
  };
}

function createServiceWithPrefixedPostMessageResult(catId) {
  return {
    async *invoke() {
      yield {
        type: 'system_info',
        catId,
        content: JSON.stringify({ type: 'invocation_created', invocationId: 'inner-inv-prefixed' }),
        timestamp: Date.now(),
      };
      yield {
        type: 'system_info',
        catId,
        content: JSON.stringify({ type: 'thinking', text: 'prefixed stream thinking' }),
        timestamp: Date.now(),
      };
      yield { type: 'text', catId, content: 'Posting via prefixed callback result.', timestamp: Date.now() };
      yield {
        type: 'tool_use',
        catId,
        toolName: 'cat_cafe_post_message',
        toolInput: { content: 'Posting via prefixed callback result.', streamDisposition: 'replace_final' },
        timestamp: Date.now(),
      };
      yield {
        type: 'tool_result',
        catId,
        content:
          'mcp:cat_cafe/cat_cafe_post_message (completed)\n' +
          JSON.stringify({ status: 'ok', threadId: 'thread1', messageId: 'callback-msg-prefixed' }),
        timestamp: Date.now(),
      };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createServiceWithoutPostMessage(catId) {
  return {
    async *invoke() {
      yield { type: 'text', catId, content: 'Normal reply without callback.', timestamp: Date.now() };
      yield { type: 'tool_use', catId, toolName: 'Read', toolInput: '{}', timestamp: Date.now() };
      yield { type: 'tool_result', catId, content: 'file contents', timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createMockDeps(services, appendCalls, augmentCalls = []) {
  let invocationSeq = 0;
  let messageSeq = 0;

  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++invocationSeq}`, callbackToken: `tok-${invocationSeq}` }),
        verify: () => null,
      },
      sessionManager: {
        getOrCreate: async () => ({}),
        get: async () => null,
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (msg) => {
        const stored = {
          id: `msg-${++messageSeq}`,
          userId: msg.userId,
          catId: msg.catId,
          content: msg.content,
          mentions: msg.mentions,
          timestamp: msg.timestamp,
          threadId: msg.threadId ?? 'default',
        };
        appendCalls.push(msg);
        return stored;
      },
      getRecent: () => [],
      getMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
      getById: () => null,
      augmentStreamMetadata: async (id, patch) => {
        augmentCalls.push({ id, patch });
        return { id, ...patch };
      },
    },
    draftStore: {
      upsert: () => {},
      touch: () => {},
      delete: () => Promise.resolve(),
      deleteByThread: () => {},
      getByThread: () => [],
    },
  };
}

describe('#573/#1332: explicit callback/final persistence semantics', () => {
  it('does not re-dispatch a callback-routed source/target through the serial mention worklist', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
    const appendCalls = [];
    let duplicateTargetInvocations = 0;
    const callbackBody = '@codex\nCallback already routed this exact source and target.';
    const callbackService = {
      async *invoke() {
        yield { type: 'text', catId: 'opus', content: callbackBody, timestamp: Date.now() };
        yield {
          type: 'tool_use',
          catId: 'opus',
          toolName: 'cat_cafe_post_message',
          toolInput: { content: callbackBody, targetCats: ['codex'], streamDisposition: 'replace_final' },
          timestamp: Date.now(),
        };
        yield {
          type: 'tool_result',
          catId: 'opus',
          content: JSON.stringify({ status: 'ok', threadId: 'thread1', messageId: 'callback-source-1' }),
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };
    const duplicateTargetService = {
      async *invoke() {
        duplicateTargetInvocations++;
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };
    const deps = createMockDeps({ opus: callbackService, codex: duplicateTargetService }, appendCalls);
    deps.messageStore.getById = async (id) =>
      id === 'callback-source-1'
        ? {
            id,
            userId: 'user1',
            catId: 'opus',
            content: callbackBody,
            mentions: ['codex'],
            timestamp: Date.now(),
            threadId: 'thread1',
            origin: 'stream',
          }
        : null;

    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig(REPO_TEMPLATE_PATH));
      for (const [id, config] of Object.entries(runtimeConfigs)) catRegistry.register(id, config);

      const yielded = [];
      for await (const msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1', {
        parentInvocationId: 'parent-inv-callback-dedup',
        invocationController: new AbortController(),
        trackA2ASlot: () => true,
        queueHasQueuedMessages: () => false,
        hasQueuedOrActiveAgentForCat: () => false,
      })) {
        yielded.push(msg);
      }

      assert.equal(
        duplicateTargetInvocations,
        0,
        'callback admission is the one carrier; route-serial must not invoke the same source/target again',
      );
      assert.equal(
        yielded.filter((msg) => msg.type === 'a2a_handoff' && msg.targetCatId === 'codex').length,
        0,
        'the stale duplicate must not acquire a serial worklist handoff or reach F167 remediation',
      );

      const failedCallbackService = {
        async *invoke() {
          yield { type: 'text', catId: 'opus', content: callbackBody, timestamp: Date.now() };
          yield {
            type: 'tool_use',
            catId: 'opus',
            toolName: 'cat_cafe_post_message',
            toolInput: { content: callbackBody, targetCats: ['codex'] },
            timestamp: Date.now(),
          };
          yield {
            type: 'tool_result',
            catId: 'opus',
            content: 'Error: callback token expired',
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        },
      };
      const failedDeps = createMockDeps({ opus: failedCallbackService, codex: duplicateTargetService }, appendCalls);
      for await (const _msg of routeSerial(failedDeps, ['opus'], 'hello', 'user1', 'thread1', {
        parentInvocationId: 'parent-inv-callback-failed',
        invocationController: new AbortController(),
        trackA2ASlot: () => true,
        queueHasQueuedMessages: () => false,
        hasQueuedOrActiveAgentForCat: () => false,
      })) {
        // drain
      }
      assert.equal(
        duplicateTargetInvocations,
        1,
        'failed callback admission must leave the line-start target eligible for the serial carrier',
      );
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) catRegistry.register(id, config);
    }
  });

  it('skips stream messageStore.append when post_message explicitly replaces the final', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps({ opus: createServiceWithPostMessage('opus') }, appendCalls);

    const yielded = [];
    for await (const msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1')) {
      yielded.push(msg);
    }

    const streamAppends = appendCalls.filter((m) => m.origin === 'stream' && m.catId === 'opus');
    assert.equal(streamAppends.length, 0, 'replace_final should keep the callback as the sole durable response');
  });

  it('treats a persisted terminal coordination ACK as a confirmed final replacement', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const persistenceContext = {};
    const deps = createMockDeps({ opus: createServiceWithTerminalAckReplacement('opus') }, appendCalls);

    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1', { persistenceContext })) {
      // drain
    }

    const streamAppends = appendCalls.filter((message) => message.origin === 'stream' && message.catId === 'opus');
    assert.equal(streamAppends.length, 0, 'the persisted terminal ACK must remain the sole durable response');
    assert.deepEqual(
      persistenceContext.persistedOutputMessageIds,
      ['callback-terminal-ack'],
      'delivery/session projections must retain the terminal ACK message id without a second final',
    );
  });

  it('keeps the provider final when terminal_ack_recorded has no durable message id', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps({ opus: createServiceWithTerminalAckReplacement('opus', '') }, appendCalls);

    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1')) {
      // drain
    }

    const streamAppends = appendCalls.filter((message) => message.origin === 'stream' && message.catId === 'opus');
    assert.equal(streamAppends.length, 1, 'an unproven terminal ACK must fail open and preserve the provider final');
  });

  it('persists a distinct final answer after a successful proactive callback by default', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const persistenceContext = {};
    const service = createServiceWithPostMessageThenDistinctFinal('opus');
    const deps = createMockDeps({ opus: service }, appendCalls);

    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1', { persistenceContext })) {
      // drain
    }

    const streamAppends = appendCalls.filter((message) => message.origin === 'stream' && message.catId === 'opus');
    assert.equal(streamAppends.length, 1, 'the callback must not suppress a later independent final answer');
    assert.equal(streamAppends[0].content, 'Detailed final answer that must remain durable after the callback.');
    assert.ok(
      streamAppends[0].timestamp >= service.callbackPersistedAt,
      'hydrated timeline order must keep the callback before the later final',
    );
    assert.deepEqual(
      persistenceContext.persistedOutputMessageIds,
      ['callback-msg-distinct', 'msg-1'],
      'delivery/session projections must retain both durable messages in callback-before-final order',
    );
  });

  it('keeps a tool-only replace_final callback as the sole durable and visible completion', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const augmentCalls = [];
    const persistenceContext = {};
    const deps = createMockDeps({ opus: createToolOnlyReplacementService('opus') }, appendCalls, augmentCalls);

    const yielded = [];
    for await (const msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1', { persistenceContext })) {
      yielded.push(msg);
    }

    const streamAppends = appendCalls.filter((message) => message.origin === 'stream' && message.catId === 'opus');
    assert.equal(streamAppends.length, 0, 'replace_final must not persist an empty tool-only stream record');
    assert.equal(
      yielded.filter((message) => message.type === 'system_info' && message.content?.includes('silent_completion'))
        .length,
      0,
      'the durable callback is the visible completion, so the route must not emit a silent_completion notice',
    );
    assert.equal(augmentCalls.length, 1, 'tool-only stream metadata should be merged into the callback message');
    assert.equal(augmentCalls[0].id, 'callback-tool-only');
    assert.equal(augmentCalls[0].patch.toolEvents.length, 2);
    assert.deepEqual(persistenceContext.persistedOutputMessageIds, ['callback-tool-only']);
  });

  it('keeps the provider final when replace_final returns duplicate without a durable message id', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const service = {
      async *invoke() {
        yield {
          type: 'text',
          catId: 'opus',
          content: 'Provider fallback must remain durable.',
          timestamp: Date.now(),
        };
        yield {
          type: 'tool_use',
          catId: 'opus',
          toolName: 'cat_cafe_post_message',
          toolInput: { content: 'Replacement claim may not have persisted.', streamDisposition: 'replace_final' },
          toolUseId: 'post-duplicate-without-message',
          timestamp: Date.now(),
        };
        yield {
          type: 'tool_result',
          catId: 'opus',
          toolUseId: 'post-duplicate-without-message',
          content: JSON.stringify({ status: 'duplicate', threadId: 'thread1' }),
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };
    const deps = createMockDeps({ opus: service }, appendCalls);

    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1')) {
      // drain
    }

    const streamAppends = appendCalls.filter((message) => message.origin === 'stream' && message.catId === 'opus');
    assert.equal(streamAppends.length, 1, 'replacement without a durable callback id must fail open to the final');
    assert.equal(streamAppends[0].content, 'Provider fallback must remain durable.');
  });

  it('keeps an error-after-callback replace_final turn on the canonical callback message', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const augmentCalls = [];
    const persistenceContext = {};
    const service = {
      async *invoke() {
        yield {
          type: 'tool_use',
          catId: 'opus',
          toolName: 'cat_cafe_post_message',
          toolInput: { content: 'Callback is already the final.', streamDisposition: 'replace_final' },
          toolUseId: 'post-before-error',
          timestamp: Date.now(),
        };
        yield {
          type: 'tool_result',
          catId: 'opus',
          toolUseId: 'post-before-error',
          content: JSON.stringify({ status: 'ok', threadId: 'thread1', messageId: 'callback-before-error' }),
          timestamp: Date.now(),
        };
        yield { type: 'error', catId: 'opus', error: 'provider failed after callback', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };
    const deps = createMockDeps({ opus: service }, appendCalls, augmentCalls);

    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1', { persistenceContext })) {
      // drain
    }

    const streamAppends = appendCalls.filter((message) => message.origin === 'stream' && message.catId === 'opus');
    assert.equal(streamAppends.length, 0, 'error finalization must not append a second empty stream record');
    assert.equal(augmentCalls.length, 1, 'error-path tool metadata should attach to the canonical callback');
    assert.equal(augmentCalls[0].id, 'callback-before-error');
    assert.equal(augmentCalls[0].patch.toolEvents.length, 2);
    assert.deepEqual(persistenceContext.persistedOutputMessageIds, ['callback-before-error']);
  });

  it('confirms replace_final from every matched post_message result in the same turn', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const augmentCalls = [];
    const persistenceContext = {};
    const deps = createMockDeps({ opus: createServiceWithMultiplePostResults('opus') }, appendCalls, augmentCalls);

    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1', { persistenceContext })) {
      // drain
    }

    const streamAppends = appendCalls.filter((message) => message.origin === 'stream' && message.catId === 'opus');
    assert.equal(streamAppends.length, 0, 'the later matched replace_final callback must suppress the provider final');
    assert.deepEqual(
      persistenceContext.persistedOutputMessageIds,
      ['callback-independent', 'callback-replacement'],
      'each confirmed callback must contribute its durable message id in result order',
    );
    assert.equal(augmentCalls.length, 1);
    assert.equal(augmentCalls[0].id, 'callback-replacement');
  });

  it('augments the callback-stored message with stream-only metadata without duplicating the stream bubble', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const augmentCalls = [];
    const service = createServiceWithPostMessageAndStreamMetadata('opus');
    const deps = createMockDeps({ opus: service }, appendCalls, augmentCalls);

    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1', {
      parentInvocationId: 'parent-inv-1',
      currentUserMessageId: 'trigger-msg-1',
    })) {
      // drain
    }

    const streamAppends = appendCalls.filter((m) => m.origin === 'stream' && m.catId === 'opus');
    assert.equal(streamAppends.length, 0, 'callback path must remain the only user-visible bubble');
    assert.equal(augmentCalls.length, 1, 'callback message should receive stream-only metadata');

    const [{ id, patch }] = augmentCalls;
    assert.equal(id, 'callback-msg-1');
    assert.equal(patch.mentionsUser, true, 'line-start co-creator mention should be preserved');
    assert.match(patch.thinking, /stream thinking chunk/);
    assert.deepEqual(patch.metadata, { provider: 'mock-provider', model: 'mock-model' });
    assert.equal(patch.toolEvents.length, 2, 'tool_use/tool_result should be retained for reload');
    assert.deepEqual(patch.extra.stream, { invocationId: 'parent-inv-1', turnInvocationId: 'inv-1' });
    assert.deepEqual(patch.extra.causal, {
      kind: 'invocation_reply',
      triggerMessageId: 'trigger-msg-1',
    });
    assert.deepEqual(patch.extra.tracing, { traceId: 'trace-1', spanId: 'span-1' });
    assert.deepEqual(patch.extra.rich.blocks, [service.richBlock]);
  });

  it('extracts messageId from Codex-style prefixed MCP tool results before metadata augment', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const { getRichBlockBuffer } = await import('../dist/domains/cats/services/agents/invocation/RichBlockBuffer.js');
    const appendCalls = [];
    const augmentCalls = [];
    const bufferedBlock = {
      id: 'prefixed-audio-1',
      kind: 'audio',
      v: 1,
      url: '/api/tts/audio/prefixed.wav',
      text: 'persist this buffered voice block',
    };
    getRichBlockBuffer().add('thread1', 'opus', bufferedBlock, 'inv-1');
    const deps = createMockDeps(
      { opus: createServiceWithPrefixedPostMessageResult('opus') },
      appendCalls,
      augmentCalls,
    );

    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1', {
      parentInvocationId: 'parent-inv-prefixed',
    })) {
      // drain
    }

    const streamAppends = appendCalls.filter((m) => m.origin === 'stream' && m.catId === 'opus');
    assert.equal(streamAppends.length, 0, 'prefixed callback success must not create a duplicate stream bubble');
    assert.equal(augmentCalls.length, 1, 'prefixed callback result should still augment callback message');

    const [{ id, patch }] = augmentCalls;
    assert.equal(id, 'callback-msg-prefixed');
    assert.match(patch.thinking, /prefixed stream thinking/);
    assert.equal(patch.toolEvents.length, 2, 'tool_use/tool_result should survive F5 reload');
    assert.deepEqual(patch.extra.stream, {
      invocationId: 'parent-inv-prefixed',
      turnInvocationId: 'inv-1',
    });
    assert.deepEqual(patch.extra.rich.blocks, [bufferedBlock]);
  });

  it('honors replace_final for namespaced cat_cafe_post_message tool names', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps(
      { opus: createServiceWithPostMessage('opus', 'mcp:cat-cafe/cat_cafe_post_message') },
      appendCalls,
    );

    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1')) {
      // drain
    }

    const streamAppends = appendCalls.filter((m) => m.origin === 'stream' && m.catId === 'opus');
    assert.equal(
      streamAppends.length,
      0,
      'namespaced cat_cafe_post_message should confirm callback persistence and skip stream append',
    );
  });

  it('still persists stream output when no cat_cafe_post_message was called', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps({ opus: createServiceWithoutPostMessage('opus') }, appendCalls);

    const yielded = [];
    for await (const msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1')) {
      yielded.push(msg);
    }

    const streamAppends = appendCalls.filter((m) => m.origin === 'stream' && m.catId === 'opus');
    assert.equal(streamAppends.length, 1, 'should persist stream output normally when no callback post');
    assert.ok(streamAppends[0].content.includes('Normal reply'), 'persisted content should match stream text');
  });

  it('still yields done event to frontend when replace_final skips the stream store', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps({ opus: createServiceWithPostMessage('opus') }, appendCalls);

    const yielded = [];
    for await (const msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1')) {
      yielded.push(msg);
    }

    const doneMsg = yielded.find((m) => m.type === 'done');
    assert.ok(doneMsg, 'done event should still be yielded to frontend');
  });

  it('preserves stream store when cat_cafe_post_message callback fails', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];

    const failedCallbackService = {
      async *invoke() {
        yield { type: 'text', catId: 'opus', content: 'Trying to post.', timestamp: Date.now() };
        yield {
          type: 'tool_use',
          catId: 'opus',
          toolName: 'cat_cafe_post_message',
          toolInput: '{}',
          timestamp: Date.now(),
        };
        yield { type: 'tool_result', catId: 'opus', content: 'Error: callback token expired', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const deps = createMockDeps({ opus: failedCallbackService }, appendCalls);
    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1')) {
      // drain
    }

    const streamAppends = appendCalls.filter((m) => m.origin === 'stream' && m.catId === 'opus');
    assert.equal(streamAppends.length, 1, 'should persist stream output when callback failed');
  });

  it('keeps waiting for cat_cafe_post_message success across unrelated tool_result events', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];

    const interleavedService = {
      async *invoke() {
        yield { type: 'text', catId: 'opus', content: 'Posting via callback.', timestamp: Date.now() };
        yield {
          type: 'tool_use',
          catId: 'opus',
          toolName: 'mcp:cat-cafe/cat_cafe_post_message',
          toolInput: { content: 'Posting via callback.', streamDisposition: 'replace_final' },
          timestamp: Date.now(),
        };
        yield {
          type: 'tool_result',
          catId: 'opus',
          content: 'command output from another tool',
          timestamp: Date.now(),
        };
        yield {
          type: 'tool_result',
          catId: 'opus',
          content: '{"status":"ok","threadId":"thread-1","messageId":"callback-interleaved"}',
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const deps = createMockDeps({ opus: interleavedService }, appendCalls);
    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1')) {
      // drain
    }

    const streamAppends = appendCalls.filter((m) => m.origin === 'stream' && m.catId === 'opus');
    assert.equal(streamAppends.length, 0, 'unrelated tool_result must not clear pending callback confirmation');
  });

  it('does not confirm callback persistence from another pending tool result with ok status', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];

    const interleavedService = {
      async *invoke() {
        yield {
          type: 'tool_use',
          catId: 'opus',
          toolName: 'mcp:example/status_probe',
          toolInput: '{}',
          timestamp: Date.now(),
        };
        yield { type: 'text', catId: 'opus', content: 'Trying callback post.', timestamp: Date.now() };
        yield {
          type: 'tool_use',
          catId: 'opus',
          toolName: 'mcp:cat-cafe/cat_cafe_post_message',
          toolInput: { content: 'Posting through callback.', streamDisposition: 'replace_final' },
          timestamp: Date.now(),
        };
        yield {
          type: 'tool_result',
          catId: 'opus',
          content: '{"status":"ok","source":"status_probe"}',
          timestamp: Date.now(),
        };
        yield {
          type: 'tool_result',
          catId: 'opus',
          content: 'Error: callback token expired',
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const deps = createMockDeps({ opus: interleavedService }, appendCalls);
    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1')) {
      // drain
    }

    const streamAppends = appendCalls.filter((m) => m.origin === 'stream' && m.catId === 'opus');
    assert.equal(streamAppends.length, 1, 'unrelated ok tool_result must not suppress stream persistence');
  });

  it('confirms an unlabeled callback result when the post tool is first pending among multiple tools', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];

    const parallelToolService = {
      async *invoke() {
        yield { type: 'text', catId: 'opus', content: 'Posting through callback.', timestamp: Date.now() };
        yield {
          type: 'tool_use',
          catId: 'opus',
          toolName: 'mcp:cat-cafe/cat_cafe_post_message',
          toolInput: { content: 'Posting through callback.', streamDisposition: 'replace_final' },
          timestamp: Date.now(),
        };
        yield {
          type: 'tool_use',
          catId: 'opus',
          toolName: 'command_execution',
          toolInput: 'echo ok',
          timestamp: Date.now(),
        };
        yield {
          type: 'tool_result',
          catId: 'opus',
          content: '{"status":"ok","threadId":"thread1","messageId":"msg-123"}',
          timestamp: Date.now(),
        };
        yield {
          type: 'tool_result',
          catId: 'opus',
          content: 'ok',
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const deps = createMockDeps({ opus: parallelToolService }, appendCalls);
    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1')) {
      // drain
    }

    const streamAppends = appendCalls.filter((m) => m.origin === 'stream' && m.catId === 'opus');
    assert.equal(streamAppends.length, 0, 'unlabeled callback result should suppress duplicate stream persistence');
  });

  it('keeps FIFO when a callback-shaped result arrives before a later pending post tool', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];

    const outOfOrderService = {
      async *invoke() {
        yield { type: 'text', catId: 'opus', content: 'Checking status then posting.', timestamp: Date.now() };
        yield {
          type: 'tool_use',
          catId: 'opus',
          toolName: 'mcp:example/status_probe',
          toolInput: '{}',
          timestamp: Date.now(),
        };
        yield {
          type: 'tool_use',
          catId: 'opus',
          toolName: 'mcp:cat-cafe/cat_cafe_post_message',
          toolInput: '{}',
          timestamp: Date.now(),
        };
        yield {
          type: 'tool_result',
          catId: 'opus',
          content: '{"status":"ok","threadId":"thread1","messageId":"status-probe-msg"}',
          timestamp: Date.now(),
        };
        yield {
          type: 'tool_result',
          catId: 'opus',
          content: 'Error: callback token expired',
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const deps = createMockDeps({ opus: outOfOrderService }, appendCalls);
    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1')) {
      // drain
    }

    const streamAppends = appendCalls.filter((m) => m.origin === 'stream' && m.catId === 'opus');
    assert.equal(
      streamAppends.length,
      1,
      'callback-shaped result from the first pending tool must not suppress stream persistence for a later failed post',
    );
  });

  it('does not consume a later pending post when cross-post returns the same message shape first', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];

    const crossPostLikeService = {
      async *invoke() {
        yield { type: 'text', catId: 'opus', content: 'Cross-posting then local callback.', timestamp: Date.now() };
        yield {
          type: 'tool_use',
          catId: 'opus',
          toolName: 'mcp:cat-cafe/cat_cafe_cross_post_message',
          toolInput: '{}',
          timestamp: Date.now(),
        };
        yield {
          type: 'tool_use',
          catId: 'opus',
          toolName: 'mcp:cat-cafe/cat_cafe_post_message',
          toolInput: '{}',
          timestamp: Date.now(),
        };
        yield {
          type: 'tool_result',
          catId: 'opus',
          content: '{"status":"ok","threadId":"thread1","messageId":"cross-post-msg"}',
          timestamp: Date.now(),
        };
        yield {
          type: 'tool_result',
          catId: 'opus',
          content: 'Error: callback token expired',
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const deps = createMockDeps({ opus: crossPostLikeService }, appendCalls);
    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1')) {
      // drain
    }

    const streamAppends = appendCalls.filter((m) => m.origin === 'stream' && m.catId === 'opus');
    assert.equal(
      streamAppends.length,
      1,
      'cross-post result with messageId+threadId must not be treated as the later pending post callback',
    );
  });

  it('does not match another tool result with messageId shape to a later pending post tool', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];

    const statusLikeService = {
      async *invoke() {
        yield { type: 'text', catId: 'opus', content: 'Checking status then posting.', timestamp: Date.now() };
        yield {
          type: 'tool_use',
          catId: 'opus',
          toolName: 'mcp:example/status_probe',
          toolInput: '{}',
          timestamp: Date.now(),
        };
        yield {
          type: 'tool_use',
          catId: 'opus',
          toolName: 'mcp:cat-cafe/cat_cafe_post_message',
          toolInput: '{}',
          timestamp: Date.now(),
        };
        yield {
          type: 'tool_result',
          catId: 'opus',
          content: '{"status":"ok","messageId":"status-probe-msg"}',
          timestamp: Date.now(),
        };
        yield {
          type: 'tool_result',
          catId: 'opus',
          content: 'Error: callback token expired',
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const deps = createMockDeps({ opus: statusLikeService }, appendCalls);
    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1')) {
      // drain
    }

    const streamAppends = appendCalls.filter((m) => m.origin === 'stream' && m.catId === 'opus');
    assert.equal(
      streamAppends.length,
      1,
      'status-like result from another tool must not suppress stream persistence for a failed post callback',
    );
  });

  it('does not confirm an ambiguous unlabeled ok result while another tool is pending', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];

    const ambiguousToolService = {
      async *invoke() {
        yield { type: 'text', catId: 'opus', content: 'Posting through callback.', timestamp: Date.now() };
        yield {
          type: 'tool_use',
          catId: 'opus',
          toolName: 'mcp:cat-cafe/cat_cafe_post_message',
          toolInput: '{}',
          timestamp: Date.now(),
        };
        yield {
          type: 'tool_use',
          catId: 'opus',
          toolName: 'mcp:example/status_probe',
          toolInput: '{}',
          timestamp: Date.now(),
        };
        yield {
          type: 'tool_result',
          catId: 'opus',
          content: '{"status":"ok","source":"status_probe"}',
          timestamp: Date.now(),
        };
        yield {
          type: 'tool_result',
          catId: 'opus',
          content: 'Error: callback token expired',
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const deps = createMockDeps({ opus: ambiguousToolService }, appendCalls);
    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1')) {
      // drain
    }

    const streamAppends = appendCalls.filter((m) => m.origin === 'stream' && m.catId === 'opus');
    assert.equal(streamAppends.length, 1, 'ambiguous ok tool_result must not suppress stream persistence');
  });

  it('does not confirm callback persistence from a duplicate labeled post result after a failed callback', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];

    const duplicatedResultService = {
      async *invoke() {
        yield { type: 'text', catId: 'opus', content: 'Trying callback post.', timestamp: Date.now() };
        yield {
          type: 'tool_use',
          catId: 'opus',
          toolName: 'mcp:cat-cafe/cat_cafe_post_message',
          toolInput: '{}',
          timestamp: Date.now(),
        };
        yield {
          type: 'tool_result',
          catId: 'opus',
          toolName: 'mcp:cat-cafe/cat_cafe_post_message',
          content: 'Error: callback token expired',
          timestamp: Date.now(),
        };
        yield {
          type: 'tool_result',
          catId: 'opus',
          toolName: 'mcp:cat-cafe/cat_cafe_post_message',
          content: '{"status":"ok","threadId":"thread-1"}',
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const deps = createMockDeps({ opus: duplicatedResultService }, appendCalls);
    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1')) {
      // drain
    }

    const streamAppends = appendCalls.filter((m) => m.origin === 'stream' && m.catId === 'opus');
    assert.equal(
      streamAppends.length,
      1,
      'duplicate labeled post result without a pending match must not suppress stream persistence',
    );
  });
});
