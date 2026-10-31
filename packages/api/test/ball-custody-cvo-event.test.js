/**
 * F233 PR3 — explicit operator handoff source event.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

function createMockDeps(services) {
  let invocationSeq = 0;
  let messageSeq = 0;
  const storedById = new Map();
  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++invocationSeq}`, callbackToken: `tok-${invocationSeq}` }),
        verify: () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => null,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (msg) => {
        const stored = { id: `msg-${++messageSeq}`, ...msg, threadId: msg.threadId ?? 'default' };
        storedById.set(stored.id, stored);
        return stored;
      },
      getById: async (id) => storedById.get(id) ?? null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getRecentMentionsFor: () => [],
    },
    socketManager: { broadcastToRoom: () => {} },
    draftStore: {
      delete: () => Promise.resolve(),
      touch: () => Promise.resolve(),
      upsert: () => Promise.resolve(),
    },
    voiceMode: false,
  };
}

describe('F233 PR3: explicit operator handoff event', () => {
  test('line-start @co-creator records ball.handed_cvo without natural-language intent classification', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const recorded = [];
    const deps = createMockDeps({
      opus: {
        async *invoke() {
          yield {
            type: 'system_info',
            catId: 'opus',
            content: JSON.stringify({ type: 'invocation_created', invocationId: 'inner-opus' }),
            timestamp: Date.now(),
          };
          yield { type: 'text', catId: 'opus', content: '@co-creator\n需要 operator 决策', timestamp: Date.now() };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        },
      },
    });
    deps.ballCustody = {
      async record(event) {
        recorded.push(event);
      },
    };

    for await (const _ of routeSerial(deps, ['opus'], 'start', 'user-a', 'thread-cvo-handoff', {
      currentUserMessageId: 'user-msg-cvo',
    })) {
      // drain
    }

    const cvoEvent = recorded.find((event) => event.kind === 'ball.handed_cvo');
    assert.ok(cvoEvent, 'line-start @co-creator must record ball.handed_cvo');
    assert.match(cvoEvent.sourceEventId, /^route:msg-/);
    assert.equal(cvoEvent.subjectKey, 'ball:thread:thread-cvo-handoff');
    assert.deepEqual(cvoEvent.payload, { fromCatId: 'opus', intent: 'handoff' });
  });

  test('callback-only line-start @co-creator records ball.handed_cvo from callback message id', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const recorded = [];
    const deps = createMockDeps({
      opus: {
        async *invoke() {
          yield {
            type: 'system_info',
            catId: 'opus',
            content: JSON.stringify({ type: 'invocation_created', invocationId: 'inner-opus-callback' }),
            timestamp: Date.now(),
          };
          yield {
            type: 'tool_use',
            catId: 'opus',
            toolName: 'cat_cafe_post_message',
            toolInput: JSON.stringify({ content: '@co-creator\ncallback-only escalation' }),
            timestamp: Date.now(),
          };
          yield {
            type: 'tool_result',
            catId: 'opus',
            content: JSON.stringify({ status: 'ok', threadId: 'thread-cvo-callback', messageId: 'callback-msg-cvo' }),
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        },
      },
    });
    deps.ballCustody = {
      async record(event) {
        recorded.push(event);
      },
    };

    for await (const _ of routeSerial(deps, ['opus'], 'start', 'user-a', 'thread-cvo-callback', {
      currentUserMessageId: 'user-msg-cvo-callback',
    })) {
      // drain
    }

    const cvoEvent = recorded.find((event) => event.kind === 'ball.handed_cvo');
    assert.ok(cvoEvent, 'callback-only line-start @co-creator must record ball.handed_cvo');
    assert.equal(cvoEvent.sourceEventId, 'route:callback-msg-cvo');
    assert.equal(cvoEvent.subjectKey, 'ball:thread:thread-cvo-callback');
    assert.deepEqual(cvoEvent.payload, { fromCatId: 'opus', intent: 'handoff' });
  });

  test('later callback post without line-start @co-creator does not inherit prior operator handoff', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const recorded = [];
    const deps = createMockDeps({
      opus: {
        async *invoke() {
          yield {
            type: 'system_info',
            catId: 'opus',
            content: JSON.stringify({ type: 'invocation_created', invocationId: 'inner-opus-callback-scope' }),
            timestamp: Date.now(),
          };
          yield {
            type: 'tool_use',
            catId: 'opus',
            toolName: 'cat_cafe_post_message',
            toolInput: JSON.stringify({ content: '@co-creator\nfirst callback-only escalation' }),
            timestamp: Date.now(),
          };
          yield {
            type: 'tool_result',
            catId: 'opus',
            content: JSON.stringify({
              status: 'ok',
              threadId: 'thread-cvo-callback-scope',
              messageId: 'callback-msg-cvo',
            }),
            timestamp: Date.now(),
          };
          yield {
            type: 'tool_use',
            catId: 'opus',
            toolName: 'cat_cafe_post_message',
            toolInput: JSON.stringify({ content: 'status update without operator handoff' }),
            timestamp: Date.now(),
          };
          yield {
            type: 'tool_result',
            catId: 'opus',
            content: JSON.stringify({
              status: 'ok',
              threadId: 'thread-cvo-callback-scope',
              messageId: 'callback-msg-status',
            }),
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        },
      },
    });
    deps.ballCustody = {
      async record(event) {
        recorded.push(event);
      },
    };

    for await (const _ of routeSerial(deps, ['opus'], 'start', 'user-a', 'thread-cvo-callback-scope', {
      currentUserMessageId: 'user-msg-cvo-callback-scope',
    })) {
      // drain
    }

    const cvoEvents = recorded.filter((event) => event.kind === 'ball.handed_cvo');
    assert.deepEqual(
      cvoEvents.map((event) => event.sourceEventId),
      ['route:callback-msg-cvo'],
      'only the callback that actually contained line-start @co-creator should record ball.handed_cvo',
    );
  });

  test('same-name pending callback posts use toolUseId to bind operator handoff to the actual callback', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const recorded = [];
    const deps = createMockDeps({
      opus: {
        async *invoke() {
          yield {
            type: 'system_info',
            catId: 'opus',
            content: JSON.stringify({ type: 'invocation_created', invocationId: 'inner-opus-callback-tool-id' }),
            timestamp: Date.now(),
          };
          yield {
            type: 'tool_use',
            catId: 'opus',
            toolUseId: 'post-status',
            toolName: 'cat_cafe_post_message',
            toolInput: JSON.stringify({ content: 'status update without operator handoff' }),
            timestamp: Date.now(),
          };
          yield {
            type: 'tool_use',
            catId: 'opus',
            toolUseId: 'post-cvo',
            toolName: 'cat_cafe_post_message',
            toolInput: JSON.stringify({ content: '@co-creator\ncallback-only escalation' }),
            timestamp: Date.now(),
          };
          yield {
            type: 'tool_result',
            catId: 'opus',
            toolUseId: 'post-status',
            toolName: 'cat_cafe_post_message',
            content: JSON.stringify({
              status: 'ok',
              threadId: 'thread-cvo-callback-tool-id',
              messageId: 'callback-msg-status',
            }),
            timestamp: Date.now(),
          };
          yield {
            type: 'tool_result',
            catId: 'opus',
            toolUseId: 'post-cvo',
            toolName: 'cat_cafe_post_message',
            content: JSON.stringify({
              status: 'ok',
              threadId: 'thread-cvo-callback-tool-id',
              messageId: 'callback-msg-cvo',
            }),
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        },
      },
    });
    deps.ballCustody = {
      async record(event) {
        recorded.push(event);
      },
    };

    for await (const _ of routeSerial(deps, ['opus'], 'start', 'user-a', 'thread-cvo-callback-tool-id', {
      currentUserMessageId: 'user-msg-cvo-callback-tool-id',
    })) {
      // drain
    }

    const cvoEvents = recorded.filter((event) => event.kind === 'ball.handed_cvo');
    assert.deepEqual(
      cvoEvents.map((event) => event.sourceEventId),
      ['route:callback-msg-cvo'],
      'same-name pending post_message callbacks must not consume another callback routing exit',
    );
  });

  test('cross-post callback line-start @co-creator records operator handoff on the callback target only', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const recorded = [];
    const deps = createMockDeps({
      opus: {
        async *invoke() {
          yield {
            type: 'system_info',
            catId: 'opus',
            content: JSON.stringify({ type: 'invocation_created', invocationId: 'inner-opus-cross-cvo' }),
            timestamp: Date.now(),
          };
          yield {
            type: 'tool_use',
            catId: 'opus',
            toolUseId: 'cross-cvo',
            toolName: 'cat_cafe_cross_post_message',
            toolInput: JSON.stringify({
              threadId: 'thread-cvo-cross-target',
              content: '@co-creator\ncross-thread escalation',
            }),
            timestamp: Date.now(),
          };
          yield {
            type: 'tool_result',
            catId: 'opus',
            toolUseId: 'cross-cvo',
            toolName: 'cat_cafe_cross_post_message',
            content: JSON.stringify({
              status: 'ok',
              threadId: 'thread-cvo-cross-target',
              messageId: 'callback-msg-cross-cvo',
            }),
            timestamp: Date.now(),
          };
          yield {
            type: 'text',
            catId: 'opus',
            content: 'local thread follow-up after cross-post',
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        },
      },
    });
    deps.ballCustody = {
      async record(event) {
        recorded.push(event);
      },
    };

    for await (const _ of routeSerial(deps, ['opus'], 'start', 'user-a', 'thread-cvo-cross-local', {
      currentUserMessageId: 'user-msg-cvo-cross-local',
    })) {
      // drain
    }

    const cvoEvents = recorded.filter((event) => event.kind === 'ball.handed_cvo');
    assert.deepEqual(
      cvoEvents.map((event) => [event.sourceEventId, event.subjectKey]),
      [['route:callback-msg-cross-cvo', 'ball:thread:thread-cvo-cross-target']],
      'cross-post operator handoff must bind to the callback target message/thread, not the local stream message',
    );
  });

  test('cross-post callback aliases settle without toolUseId before operator handoff', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const recorded = [];
    const deps = createMockDeps({
      opus: {
        async *invoke() {
          yield {
            type: 'system_info',
            catId: 'opus',
            content: JSON.stringify({ type: 'invocation_created', invocationId: 'inner-opus-cross-alias' }),
            timestamp: Date.now(),
          };
          yield {
            type: 'tool_use',
            catId: 'opus',
            toolName: 'cat_cafe_cross_post_message',
            toolInput: JSON.stringify({
              threadId: 'thread-cvo-cross-alias-target',
              content: '@co-creator\ncross-thread alias escalation',
            }),
            timestamp: Date.now(),
          };
          yield {
            type: 'tool_result',
            catId: 'opus',
            toolName: 'mcp:cat-cafe/cross_post_message',
            content: JSON.stringify({
              status: 'ok',
              threadId: 'thread-cvo-cross-alias-target',
              messageId: 'callback-msg-cross-alias-cvo',
            }),
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        },
      },
    });
    deps.ballCustody = {
      async record(event) {
        recorded.push(event);
      },
    };

    for await (const _ of routeSerial(deps, ['opus'], 'start', 'user-a', 'thread-cvo-cross-alias-local', {
      currentUserMessageId: 'user-msg-cvo-cross-alias-local',
    })) {
      // drain
    }

    const cvoEvents = recorded.filter((event) => event.kind === 'ball.handed_cvo');
    assert.deepEqual(
      cvoEvents.map((event) => [event.sourceEventId, event.subjectKey]),
      [['route:callback-msg-cross-alias-cvo', 'ball:thread:thread-cvo-cross-alias-target']],
      'cross-post tool-name aliases must settle the pending callback routing exit',
    );
  });
});
