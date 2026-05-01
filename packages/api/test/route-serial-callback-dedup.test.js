import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * #573: When a cat calls cat_cafe_post_message during an invocation, the callback
 * path already persists the message. The stream path must NOT also persist, or
 * the frontend sees a duplicate message.
 */

function createServiceWithPostMessage(catId, toolName = 'cat_cafe_post_message') {
  return {
    async *invoke() {
      yield { type: 'text', catId, content: 'Let me post a reply.', timestamp: Date.now() };
      yield { type: 'tool_use', catId, toolName, toolInput: '{}', timestamp: Date.now() };
      yield { type: 'tool_result', catId, content: '{"status":"ok","threadId":"thread-1"}', timestamp: Date.now() };
      yield { type: 'text', catId, content: '', timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
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
      yield { type: 'text', catId, content: '@铲屎官\nCallback body with stream metadata.', timestamp: Date.now() };
      yield { type: 'tool_use', catId, toolName: 'cat_cafe_post_message', toolInput: '{}', timestamp: Date.now() };
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
      yield { type: 'tool_use', catId, toolName: 'cat_cafe_post_message', toolInput: '{}', timestamp: Date.now() };
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

describe('#573: stream store dedup when cat_cafe_post_message used', () => {
  it('skips stream messageStore.append when cat_cafe_post_message was called', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps({ opus: createServiceWithPostMessage('opus') }, appendCalls);

    const yielded = [];
    for await (const msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1')) {
      yielded.push(msg);
    }

    const streamAppends = appendCalls.filter((m) => m.origin === 'stream' && m.catId === 'opus');
    assert.equal(streamAppends.length, 0, 'should NOT persist stream output when cat_cafe_post_message was used');
  });

  it('augments the callback-stored message with stream-only metadata without duplicating the stream bubble', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const augmentCalls = [];
    const service = createServiceWithPostMessageAndStreamMetadata('opus');
    const deps = createMockDeps({ opus: service }, appendCalls, augmentCalls);

    for await (const msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1', {
      parentInvocationId: 'parent-inv-1',
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
    assert.deepEqual(patch.extra.stream, { invocationId: 'parent-inv-1' });
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

    for await (const msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1', {
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
    assert.deepEqual(patch.extra.stream, { invocationId: 'parent-inv-prefixed' });
    assert.deepEqual(patch.extra.rich.blocks, [bufferedBlock]);
  });

  it('skips stream append for namespaced cat_cafe_post_message tool names', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps(
      { opus: createServiceWithPostMessage('opus', 'mcp:cat-cafe/cat_cafe_post_message') },
      appendCalls,
    );

    for await (const msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1')) {
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

  it('still yields done event to frontend even when stream store is skipped', async () => {
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
    for await (const msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1')) {
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
          toolInput: '{}',
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
          content: '{"status":"ok","threadId":"thread-1"}',
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const deps = createMockDeps({ opus: interleavedService }, appendCalls);
    for await (const msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1')) {
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

    const deps = createMockDeps({ opus: interleavedService }, appendCalls);
    for await (const msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1')) {
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
          toolInput: '{}',
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
    for await (const msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1')) {
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
    for await (const msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1')) {
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
    for await (const msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1')) {
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
    for await (const msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1')) {
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
    for await (const msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1')) {
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
    for await (const msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1')) {
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
