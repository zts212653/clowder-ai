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

function createWarningSystemInfoService(catId) {
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

function createTextWithWarningService(catId) {
  return {
    async *invoke() {
      yield { type: 'text', catId, content: 'Here is the result.', timestamp: Date.now() };
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

const cloudBridgeStatusCases = [
  {
    name: 'sent',
    bridgeStatus: 'sent',
    receiptStatus: 'sent',
    reason: undefined,
    transport: 'host',
    hostMessageId: 'host-message-1',
    disposition: 'fresh',
    message: '已发送给 @opus，等待它从 ChatGPT 云端会话回写。',
    contentPattern: /已发送/,
    tone: 'info',
  },
  {
    name: 'failed',
    bridgeStatus: 'unavailable',
    receiptStatus: 'failed',
    reason: 'no-adapter',
    transport: 'none',
    hostMessageId: undefined,
    disposition: 'not_attempted',
    message: '未发送给 @opus：还没有可用的后台 Host Adapter。',
    contentPattern: /未发送/,
    tone: 'warning',
  },
  {
    name: 'unknown',
    bridgeStatus: 'unavailable',
    receiptStatus: 'unknown',
    reason: 'host-append-failed',
    transport: 'host',
    hostMessageId: 'host-message-1',
    disposition: 'unknown',
    message: '投递给 @opus 的结果未知：Host Adapter 返回了不可确认的结果。',
    contentPattern: /结果未知/,
    tone: 'warning',
  },
];

function createCloudBridgeStatusService(catId, testCase) {
  const sourceMessageId = `source-cloud-${testCase.name}`;
  const payload = JSON.stringify({
    type: 'cloud_bridge_status',
    catId,
    status: testCase.bridgeStatus,
    reason: testCase.reason,
    outboundReceipt: {
      v: 1,
      sourceMessageId,
      sourceSender: { kind: 'cat', id: 'codex-sol', invocationId: 'inv-source-1' },
      dispatchInvocationId: 'inv-1',
      targetCatId: catId,
      status: testCase.receiptStatus,
      transport: testCase.transport,
      hostMessageId: testCase.hostMessageId,
      idempotency: {
        keyKind: 'source_message_id',
        disposition: testCase.disposition,
      },
      conversationId: 'conversation-7',
      pairingSecret: 'pairing-secret',
      cookie: 'Cookie: secret',
      payload: 'full repeated payload',
      cloudReturnBinding: 'cbr1.private.capability',
    },
    message: testCase.message,
  });
  return {
    async *invoke() {
      yield {
        type: 'system_info',
        catId,
        content: payload,
        timestamp: Date.now(),
      };
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
      getById: async (messageId) => {
        const match = /^source-cloud-(sent|failed|unknown)$/.exec(messageId);
        if (!match) return null;
        return {
          id: messageId,
          userId: 'user1',
          catId: 'codex-sol',
          threadId: `thread-cloud-${match[1]}`,
          content: `exact ${match[1]} source`,
          mentions: ['opus'],
          timestamp: 1,
          extra: { stream: { invocationId: 'inv-source-1', turnInvocationId: 'inv-source-1' } },
        };
      },
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

  it('issue #1208 P2: persists user-facing warning system_info to messageStore', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const feedbackWrites = [];
    const broadcasts = [];
    const deps = createMockDeps(
      { opus: createWarningSystemInfoService('opus') },
      appendCalls,
      feedbackWrites,
      broadcasts,
    );

    const yieldedTypes = [];
    for await (const msg of routeSerial(deps, ['opus'], 'do something', 'user1', 'thread-warning-persist')) {
      yieldedTypes.push(msg.type);
    }

    // The warning must reach the live stream.
    assert.ok(yieldedTypes.includes('system_info'), 'warning system_info must be yielded to live stream');

    // It must also be persisted as a system_notice connector message so it survives refresh.
    const warningAppend = appendCalls.find((msg) => msg.source?.connector === 'system-warning');
    assert.ok(warningAppend, 'warning system_info must be persisted to messageStore');
    assert.equal(warningAppend.userId, 'system');
    assert.equal(warningAppend.catId, null);
    assert.ok(
      warningAppend.content.includes('未返回 token 用量'),
      'persisted warning content should include the original warning message',
    );
    assert.equal(warningAppend.source.meta.presentation, 'system_notice');
    assert.equal(warningAppend.source.meta.noticeTone, 'warning');

    // It must NOT be broadcast again — the live stream already delivered the system_info event;
    // broadcasting a duplicate connector_message would cause double rendering.
    const warningBroadcast = broadcasts.find(
      (entry) => entry.event === 'connector_message' && entry.payload.message.source?.connector === 'system-warning',
    );
    assert.equal(warningBroadcast, undefined, 'warning persistence must not re-broadcast to live clients');
  });

  it('issue #1208 P2: persists warning system_info even when the cat produced text', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const feedbackWrites = [];
    const broadcasts = [];
    const deps = createMockDeps(
      { opus: createTextWithWarningService('opus') },
      appendCalls,
      feedbackWrites,
      broadcasts,
    );

    for await (const _msg of routeSerial(deps, ['opus'], 'do something', 'user1', 'thread-warning-with-text')) {
      // consume
    }

    assert.ok(appendCalls.some((msg) => msg.catId === 'opus' && msg.content === 'Here is the result.'));
    assert.ok(
      appendCalls.some((msg) => msg.source?.connector === 'system-warning'),
      'warning must survive refresh when the same turn also produced text',
    );
    assert.equal(
      broadcasts.some(
        (entry) => entry.event === 'connector_message' && entry.payload.message.source?.connector === 'system-warning',
      ),
      false,
    );
  });

  for (const testCase of cloudBridgeStatusCases) {
    it(`F247 persists one readable cloud bridge ${testCase.name} notice without a silent completion duplicate`, async () => {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      const appendCalls = [];
      const deps = createMockDeps({ opus: createCloudBridgeStatusService('opus', testCase) }, appendCalls, [], []);
      const yieldedPayloads = [];
      for await (const message of routeSerial(
        deps,
        ['opus'],
        'deliver this',
        'user1',
        `thread-cloud-${testCase.name}`,
        { currentUserMessageId: `source-cloud-${testCase.name}` },
      )) {
        if (message.type === 'system_info' && message.content) yieldedPayloads.push(JSON.parse(message.content));
      }

      assert.equal(yieldedPayloads.filter((payload) => payload.type === 'cloud_bridge_status').length, 1);
      assert.equal(
        yieldedPayloads.some((payload) => payload.type === 'silent_completion'),
        false,
      );
      const persisted = appendCalls.filter((message) => message.source?.label === '云端猫投递');
      assert.equal(persisted.length, 1);
      assert.equal(persisted[0].source.connector, 'cloud-bridge-status');
      assert.match(persisted[0].content, testCase.contentPattern);
      assert.equal(persisted[0].source.meta.noticeTone, testCase.tone);
      assert.equal(persisted[0].replyTo, `source-cloud-${testCase.name}`);
      assert.equal(
        persisted[0].source.meta.cloudBridgeOutboundReceipt.sourceMessageId,
        `source-cloud-${testCase.name}`,
      );
      assert.equal(persisted[0].source.meta.cloudBridgeOutboundReceipt.status, testCase.receiptStatus);
      const durableAudit = JSON.stringify(persisted[0]);
      for (const forbidden of [
        'conversation-7',
        'pairing-secret',
        'Cookie:',
        'full repeated payload',
        'cbr1.private.capability',
      ]) {
        assert.equal(durableAudit.includes(forbidden), false, `durable audit leaked ${forbidden}`);
      }
    });
  }

  it('issue #1208 P2: reports warning persistence failure via persistenceContext', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const feedbackWrites = [];
    const broadcasts = [];
    const deps = createMockDeps(
      { opus: createWarningSystemInfoService('opus') },
      appendCalls,
      feedbackWrites,
      broadcasts,
    );
    deps.messageStore.append = async (msg) => {
      if (msg.source?.connector === 'system-warning') {
        throw new Error('store unavailable');
      }
      appendCalls.push(msg);
      return { id: 'msg-ok', ...msg, threadId: msg.threadId ?? 'default' };
    };

    const persistenceContext = { failed: false, errors: [] };
    for await (const _msg of routeSerial(deps, ['opus'], 'do something', 'user1', 'thread-warning-fail', {
      persistenceContext,
    })) {
      // consume
    }

    assert.equal(persistenceContext.failed, true, 'warning persistence failure must mark context failed');
    assert.equal(persistenceContext.errors.length, 1, 'warning persistence failure must record one error');
    assert.equal(persistenceContext.errors[0].catId, 'opus');
    assert.match(persistenceContext.errors[0].error, /store unavailable/);
  });
});
