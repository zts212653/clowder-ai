import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function createTextWithWarningService(catId) {
  return {
    async *invoke() {
      yield { type: 'text', catId, content: 'Parallel result.', timestamp: Date.now() };
      yield {
        type: 'system_info',
        catId,
        content: JSON.stringify({
          type: 'warning',
          message: '当前 opencode/CodeAgent 适配器未返回 token 用量，自动 handoff 无法按上下文比例触发。',
        }),
        timestamp: Date.now(),
      };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createWarningOnlyService(catId) {
  return {
    async *invoke() {
      yield {
        type: 'system_info',
        catId,
        content: JSON.stringify({
          type: 'warning',
          message: '当前 opencode/CodeAgent 适配器未返回 token 用量，自动 handoff 无法按上下文比例触发。',
        }),
        timestamp: Date.now(),
      };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createMockDeps(services, append) {
  let invocationSeq = 0;
  return {
    services,
    toolEventLog: { append: async () => {}, updateSummary: async () => {} },
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inner-inv-${++invocationSeq}`, callbackToken: `tok-${invocationSeq}` }),
        verify: () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => null,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: {
        get: async () => null,
        getParticipantsWithActivity: async () => [],
        updateParticipantActivity: async () => {},
      },
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append,
      getRecent: () => [],
      getMentionsFor: () => [],
      getRecentMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
    draftStore: { delete: () => Promise.resolve(), touch: () => Promise.resolve(), upsert: () => Promise.resolve() },
    socketManager: { broadcastToRoom: () => {} },
  };
}

describe('route-parallel warning persistence (issue #1208 P2)', () => {
  it('persists user-facing warning system_info without textual output', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const appendCalls = [];
    const deps = createMockDeps({ opus: createWarningOnlyService('opus') }, async (msg) => {
      appendCalls.push(msg);
      return { id: `msg-${appendCalls.length}`, ...msg, threadId: msg.threadId ?? 'default' };
    });

    for await (const _msg of routeParallel(deps, ['opus'], 'do something', 'user1', 'thread-parallel-warning-only')) {
      // consume
    }

    assert.ok(
      appendCalls.some((msg) => msg.source?.connector === 'system-warning'),
      'warning-only turns must survive refresh in parallel mode',
    );
    assert.equal(
      appendCalls.some((msg) => msg.catId === 'opus' && msg.content === ''),
      false,
      'warning-only turns must not create an empty assistant message',
    );
  });

  it('persists user-facing warning system_info alongside text without re-broadcasting', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const appendCalls = [];
    const broadcasts = [];
    const deps = {
      ...createMockDeps({ opus: createTextWithWarningService('opus') }, async (msg) => {
        appendCalls.push(msg);
        return { id: `msg-${appendCalls.length}`, ...msg, threadId: msg.threadId ?? 'default' };
      }),
      socketManager: {
        broadcastToRoom: (room, event, payload) => broadcasts.push({ room, event, payload }),
      },
    };

    const yieldedTypes = [];
    for await (const msg of routeParallel(deps, ['opus'], 'do something', 'user1', 'thread-parallel-warning')) {
      yieldedTypes.push(msg.type);
    }

    assert.ok(yieldedTypes.includes('text'), 'text must reach the live stream');
    assert.ok(yieldedTypes.includes('system_info'), 'warning must reach the live stream');
    assert.ok(appendCalls.some((msg) => msg.catId === 'opus' && msg.content === 'Parallel result.'));

    const warningAppend = appendCalls.find((msg) => msg.source?.connector === 'system-warning');
    assert.ok(warningAppend, 'warning must survive refresh in parallel mode');
    assert.equal(warningAppend.userId, 'system');
    assert.equal(warningAppend.catId, null);
    assert.match(warningAppend.content, /未返回 token 用量/);
    assert.equal(warningAppend.source.meta.presentation, 'system_notice');
    assert.equal(warningAppend.source.meta.noticeTone, 'warning');
    assert.equal(
      broadcasts.some(
        (entry) => entry.event === 'connector_message' && entry.payload.message.source?.connector === 'system-warning',
      ),
      false,
      'warning persistence must not duplicate the live stream',
    );
  });

  it('reports warning persistence failure via persistenceContext', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const appendCalls = [];
    const deps = createMockDeps({ opus: createTextWithWarningService('opus') }, async (msg) => {
      if (msg.source?.connector === 'system-warning') throw new Error('parallel store unavailable');
      appendCalls.push(msg);
      return { id: `msg-${appendCalls.length}`, ...msg, threadId: msg.threadId ?? 'default' };
    });
    const persistenceContext = { failed: false, errors: [] };

    for await (const _msg of routeParallel(deps, ['opus'], 'do something', 'user1', 'thread-parallel-warning-fail', {
      persistenceContext,
    })) {
      // consume
    }

    assert.equal(persistenceContext.failed, true);
    assert.equal(persistenceContext.errors.length, 1);
    assert.equal(persistenceContext.errors[0].catId, 'opus');
    assert.match(persistenceContext.errors[0].error, /parallel store unavailable/);
  });
});
