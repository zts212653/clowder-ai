import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function createInlineMentionService(catId) {
  return {
    async *invoke() {
      yield { type: 'text', catId, content: 'Done. Ready for @codex review', timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createMockDeps(services, appendCalls, feedbackWrites, broadcasts) {
  let invocationSeq = 0;
  let messageSeq = 0;
  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++invocationSeq}`, callbackToken: `tok-${invocationSeq}` }),
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
        async setMentionRoutingFeedback(threadId, catId, payload) {
          feedbackWrites.push({ threadId, catId, payload });
        },
        async getVotingState() {
          return null;
        },
        async updateVotingState() {},
        async updateParticipantActivity() {},
      },
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (msg) => {
        appendCalls.push(msg);
        return {
          id: `msg-${++messageSeq}`,
          userId: msg.userId,
          catId: msg.catId,
          content: msg.content,
          mentions: msg.mentions,
          timestamp: msg.timestamp,
          threadId: msg.threadId ?? 'default',
          source: msg.source,
          extra: msg.extra,
        };
      },
      getRecent: () => [],
      getMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
    socketManager: {
      broadcastToRoom(room, event, payload) {
        broadcasts.push({ room, event, payload });
      },
    },
  };
}

describe('route-serial notice contract', () => {
  it('emits routing-syntax-hint with explicit system_notice presentation metadata', async () => {
    // F167 Phase H AC-H5 (2026-04-24): Phase H `routing-syntax-hint` is now the
    // primary emission for slot-internal inline @handles. It suppresses the
    // legacy `inline-mention-hint` (#417) on the same turn. The legacy
    // setMentionRoutingFeedback path remains — cats get next-turn correction.
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const feedbackWrites = [];
    const broadcasts = [];
    const deps = createMockDeps({ opus: createInlineMentionService('opus') }, appendCalls, feedbackWrites, broadcasts);

    for await (const _msg of routeSerial(deps, ['opus'], 'review this', 'user1', 'thread-1')) {
    }

    assert.equal(feedbackWrites.length, 1, 'should still write routing feedback (next-turn correction preserved)');

    const hintAppend = appendCalls.find((msg) => msg.source?.connector === 'routing-syntax-hint');
    assert.ok(hintAppend, 'should append a routing-syntax-hint (Phase H primary)');
    assert.equal(hintAppend.userId, 'system');
    assert.equal(hintAppend.catId, null);
    assert.equal(hintAppend.source.meta.presentation, 'system_notice');
    assert.equal(hintAppend.source.meta.noticeTone, 'warning');

    // AC-H5: legacy inline-mention-hint is suppressed when Phase H hits
    const legacyHint = appendCalls.find((msg) => msg.source?.connector === 'inline-mention-hint');
    assert.equal(legacyHint, undefined, 'AC-H5: legacy inline-mention-hint must be suppressed when Phase H hits');

    const hintBroadcast = broadcasts.find(
      (entry) =>
        entry.event === 'connector_message' && entry.payload.message.source?.connector === 'routing-syntax-hint',
    );
    assert.ok(hintBroadcast, 'should broadcast the routing-syntax-hint in real-time');
    assert.equal(hintBroadcast.payload.message.source.meta.presentation, 'system_notice');
    assert.equal(hintBroadcast.payload.message.source.meta.noticeTone, 'warning');
  });
});
