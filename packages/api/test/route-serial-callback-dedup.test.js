import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * #573: When a cat calls cat_cafe_post_message during an invocation, the callback
 * path already persists the message. The stream path must NOT also persist, or
 * the frontend sees a duplicate message.
 */

function createServiceWithPostMessage(catId) {
  return {
    async *invoke() {
      yield { type: 'text', catId, content: 'Let me post a reply.', timestamp: Date.now() };
      yield { type: 'tool_use', catId, toolName: 'cat_cafe_post_message', toolInput: '{}', timestamp: Date.now() };
      yield { type: 'tool_result', catId, content: '{"status":"ok","threadId":"thread-1"}', timestamp: Date.now() };
      yield { type: 'text', catId, content: '', timestamp: Date.now() };
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

function createMockDeps(services, appendCalls) {
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
});
