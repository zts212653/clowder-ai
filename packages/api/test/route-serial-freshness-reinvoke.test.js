/**
 * F254 B3/B4 — route-serial freshness re-invoke routing wiring tests.
 *
 * Validates that route-serial consumes `doneMsg.metadata.freshnessReinvoke`
 * and enqueues a re-invoke (or skips with logging) based on the decision
 * from FreshnessReinvokeDecider.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');

// --- Helpers ---

/**
 * Create a mock cat service that yields text + done, with optional
 * freshnessReinvoke decision attached to done metadata.
 */
function createFreshnessService(catId, freshnessDecision) {
  return {
    async *invoke() {
      yield {
        type: 'text',
        catId,
        content: '收到，处理完毕。',
        timestamp: Date.now(),
      };
      yield {
        type: 'done',
        catId,
        timestamp: Date.now(),
        metadata: freshnessDecision ? { freshnessReinvoke: freshnessDecision } : undefined,
      };
    },
  };
}

function createMockDeps(services) {
  let invocationSeq = 0;
  let messageSeq = 0;
  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({
          invocationId: `inv-${++invocationSeq}`,
          callbackToken: `tok-${invocationSeq}`,
        }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => null,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: {
        async getParticipantsWithActivity() {
          return [];
        },
        async get(threadId) {
          return {
            id: threadId,
            title: 'Test Thread',
            createdBy: 'user1',
            participants: [],
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            projectPath: 'default',
          };
        },
        async consumeMentionRoutingFeedback() {
          return null;
        },
        async setMentionRoutingFeedback() {},
        async getVotingState() {
          return null;
        },
        async updateVotingState() {},
        async updateParticipantActivity() {},
      },
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (msg) => ({
        id: `msg-${++messageSeq}`,
        userId: msg.userId,
        catId: msg.catId,
        content: msg.content,
        mentions: msg.mentions,
        timestamp: msg.timestamp,
        threadId: msg.threadId ?? 'default',
      }),
      getRecent: () => [],
      getMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
  };
}

/** Drain all messages from routeSerial */
async function drain(generator) {
  const messages = [];
  for await (const msg of generator) {
    messages.push(msg);
  }
  return messages;
}

// --- Tests ---

describe('F254 B3/B4 — route-serial freshness re-invoke wiring', () => {
  it('enqueues freshness re-invoke when shouldReinvoke=true', async () => {
    const enqueued = [];
    const decision = {
      shouldReinvoke: true,
      reason: 'trigger:high_priority_unseen',
      noticeIds: ['notice-1'],
      senders: ['user'],
      reinvokePrompt: '你上一轮 turn 中有来自 user 的 1 条未读消息，请调 list_recent 查看并回应。',
    };

    const deps = createMockDeps({
      opus: createFreshnessService('opus', decision),
    });

    await drain(
      routeSerial(deps, ['opus'], '你好', 'user1', 'thread-1', {
        freshnessReinvokeEnqueue: (entry) => enqueued.push(entry),
      }),
    );

    assert.equal(enqueued.length, 1, 'should enqueue exactly one re-invoke');
    const entry = enqueued[0];
    assert.equal(entry.threadId, 'thread-1');
    assert.equal(entry.userId, 'user1');
    assert.deepEqual(entry.targetCats, ['opus']);
    assert.equal(entry.source, 'agent');
    assert.equal(entry.sourceCategory, 'freshness');
    assert.equal(entry.autoExecute, true);
    assert.equal(entry.priority, 'normal');
    // P1-2 fix: content must carry spec-defined prompt, NOT empty string
    assert.ok(entry.content.length > 0, 'content must not be empty');
    assert.ok(entry.content.includes('user'), 'content should mention sender');
    assert.ok(entry.content.includes('list_recent'), 'content should instruct cat to call list_recent');
  });

  it('does NOT enqueue when shouldReinvoke=false', async () => {
    const enqueued = [];
    const decision = {
      shouldReinvoke: false,
      reason: 'skip:cursor_caught_up',
      skipReason: 'cursor_caught_up',
      noticeIds: [],
      senders: [],
    };

    const deps = createMockDeps({
      opus: createFreshnessService('opus', decision),
    });

    await drain(
      routeSerial(deps, ['opus'], '你好', 'user1', 'thread-1', {
        freshnessReinvokeEnqueue: (entry) => enqueued.push(entry),
      }),
    );

    assert.equal(enqueued.length, 0, 'should not enqueue for skip decision');
  });

  it('does NOT enqueue when no freshnessReinvoke metadata', async () => {
    const enqueued = [];

    const deps = createMockDeps({
      opus: createFreshnessService('opus', null),
    });

    await drain(
      routeSerial(deps, ['opus'], '你好', 'user1', 'thread-1', {
        freshnessReinvokeEnqueue: (entry) => enqueued.push(entry),
      }),
    );

    assert.equal(enqueued.length, 0, 'should not enqueue without metadata');
  });

  it('does NOT enqueue when freshnessReinvokeEnqueue option is not provided', async () => {
    // No crash, just silently skip
    const decision = {
      shouldReinvoke: true,
      reason: 'trigger:high_priority_unseen',
      noticeIds: ['notice-1'],
      senders: ['user'],
    };

    const deps = createMockDeps({
      opus: createFreshnessService('opus', decision),
    });

    // No freshnessReinvokeEnqueue option — should not crash
    const messages = await drain(routeSerial(deps, ['opus'], '你好', 'user1', 'thread-1'));

    // Should still complete normally with a done message
    const doneMsg = messages.find((m) => m.type === 'done');
    assert.ok(doneMsg, 'should still yield done message');
  });

  it('passes sourceNoticeIds from decision to enqueued entry', async () => {
    const enqueued = [];
    const decision = {
      shouldReinvoke: true,
      reason: 'trigger:high_priority_unseen',
      noticeIds: ['notice-a', 'notice-b'],
      senders: ['user', 'connector-slack'],
    };

    const deps = createMockDeps({
      opus: createFreshnessService('opus', decision),
    });

    await drain(
      routeSerial(deps, ['opus'], '你好', 'user1', 'thread-1', {
        freshnessReinvokeEnqueue: (entry) => enqueued.push(entry),
      }),
    );

    assert.equal(enqueued.length, 1);
    assert.deepEqual(enqueued[0].freshnessContext.sourceNoticeIds, ['notice-a', 'notice-b']);
    assert.deepEqual(enqueued[0].freshnessContext.senders, ['user', 'connector-slack']);
  });

  it('P1-2: builds fallback prompt when reinvokePrompt not in decision', async () => {
    const enqueued = [];
    const decision = {
      shouldReinvoke: true,
      reason: 'trigger:high_priority_unseen',
      noticeIds: ['notice-1', 'notice-2'],
      senders: ['user', 'connector-slack'],
      // No reinvokePrompt — route-serial should build fallback
    };

    const deps = createMockDeps({
      opus: createFreshnessService('opus', decision),
    });

    await drain(
      routeSerial(deps, ['opus'], '你好', 'user1', 'thread-1', {
        freshnessReinvokeEnqueue: (entry) => enqueued.push(entry),
      }),
    );

    assert.equal(enqueued.length, 1);
    const entry = enqueued[0];
    assert.ok(entry.content.length > 0, 'fallback content must not be empty');
    assert.ok(entry.content.includes('user'), 'fallback should mention sender');
    assert.ok(entry.content.includes('connector-slack'), 'fallback should mention all senders');
    assert.ok(entry.content.includes('2'), 'fallback should mention notice count');
    assert.ok(entry.content.includes('list_recent'), 'fallback should instruct list_recent');
  });

  it('does NOT enqueue when invocation had an error', async () => {
    const enqueued = [];
    const decision = {
      shouldReinvoke: true,
      reason: 'trigger:high_priority_unseen',
      noticeIds: ['notice-1'],
      senders: ['user'],
    };

    // Service that yields error then done with freshnessReinvoke
    const errorService = {
      async *invoke() {
        yield { type: 'error', catId: 'opus', error: 'provider failure', timestamp: Date.now() };
        yield {
          type: 'done',
          catId: 'opus',
          timestamp: Date.now(),
          metadata: { freshnessReinvoke: decision },
        };
      },
    };

    const deps = createMockDeps({ opus: errorService });

    await drain(
      routeSerial(deps, ['opus'], '你好', 'user1', 'thread-1', {
        freshnessReinvokeEnqueue: (entry) => enqueued.push(entry),
      }),
    );

    assert.equal(enqueued.length, 0, 'should not enqueue freshness re-invoke after provider error');
  });
});
