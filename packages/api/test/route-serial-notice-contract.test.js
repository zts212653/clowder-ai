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
          presentation: 'user_action_required',
          message: '当前 opencode适配器未返回 token 用量，自动 handoff 无法按上下文比例触发。',
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
          presentation: 'user_action_required',
          message: '当前 opencode适配器未返回 token 用量，自动 handoff 无法按上下文比例触发。',
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
  it('keeps inline-routing and unbacked-wait facts in one feedback record', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const feedbackWrites = [];
    const service = {
      async *invoke() {
        yield {
          type: 'text',
          catId: 'opus',
          content: '今天不回也没关系，我先请 @codex 补分母。',
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };
    const deps = createMockDeps({ opus: service }, [], feedbackWrites, []);
    for await (const _msg of routeSerial(deps, ['opus'], '继续', 'user1', 'thread-both')) {
    }
    assert.equal(feedbackWrites.length, 1);
    assert.deepEqual(feedbackWrites[0].payload.items.map((item) => item.reason).sort(), ['inline_action', 'void_hold']);
  });

  it('passes the canonical owned-wait fact into the next invocation navigation', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const { DeliveryCursorStore } = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    let invocationPrompt = '';
    const scopes = [];
    const service = {
      async *invoke(prompt) {
        invocationPrompt = prompt;
        yield { type: 'text', catId: 'opus', content: '处理完成。', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };
    const deps = createMockDeps({ opus: service }, [], [], []);
    deps.messageStore = new MessageStore();
    deps.deliveryCursorStore = new DeliveryCursorStore();
    const source = await deps.messageStore.append({
      from: { kind: 'user', userId: 'user1' },
      userId: 'user1',
      threadId: 'thread-nav',
      content: '继续',
      mentions: [],
      timestamp: Date.now(),
    });
    deps.taskStore = {
      listByThread: () => [
        {
          id: 'task-next',
          kind: 'work',
          title: '继续原工作',
          status: 'doing',
          ownerCatId: 'opus',
          userId: 'user1',
          threadId: 'thread-nav',
          updatedAt: Date.now(),
        },
      ],
    };
    deps.ownedWaitStatusReader = async (scope) => {
      scopes.push(scope);
      return false;
    };
    for await (const _msg of routeSerial(deps, ['opus'], '继续', 'user1', 'thread-nav', {
      currentUserMessageId: source.id,
    })) {
    }
    assert.deepEqual(scopes, [{ userId: 'user1', threadId: 'thread-nav', catId: 'opus' }]);
    assert.match(invocationPrompt, /继续原工作.*\[未挂等待\]/);
  });

  it('persists an unbacked wait as private feedback without public notices or a second invocation', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [],
      feedbackWrites = [],
      broadcasts = [];
    let invocations = 0;
    const service = {
      async *invoke() {
        invocations++;
        yield { type: 'text', catId: 'opus', content: '等 gate 跑完我再汇报。', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };
    const deps = createMockDeps({ opus: service }, appendCalls, feedbackWrites, broadcasts);
    for await (const _msg of routeSerial(deps, ['opus'], '继续处理', 'user1', 'thread-wait')) {
    }
    assert.equal(invocations, 1);
    assert.equal(appendCalls.length, 1);
    assert.equal(appendCalls[0].content, '等 gate 跑完我再汇报。');
    assert.ok(
      feedbackWrites.some(
        (write) =>
          write.threadId === 'thread-wait' &&
          write.catId === 'opus' &&
          write.payload.items.some((item) => item.reason === 'void_hold'),
      ),
    );
  });
  it('keeps an inline action @handle as text without adding a public correction bubble', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const feedbackWrites = [];
    const broadcasts = [];
    const deps = createMockDeps({ opus: createInlineMentionService('opus') }, appendCalls, feedbackWrites, broadcasts);

    for await (const _msg of routeSerial(deps, ['opus'], 'review this', 'user1', 'thread-1')) {
    }

    assert.equal(
      appendCalls.some((msg) => msg.content?.includes('Ready for @codex review')),
      true,
    );
    assert.equal(
      appendCalls.some((msg) => ['routing-syntax-hint', 'inline-mention-hint'].includes(msg.source?.connector)),
      false,
    );
    assert.equal(
      broadcasts.some(
        (entry) =>
          entry.event === 'connector_message' &&
          ['routing-syntax-hint', 'inline-mention-hint'].includes(entry.payload.message.source?.connector),
      ),
      false,
    );
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
    assert.deepEqual(warningAppend.from, { kind: 'system', service: 'system-info-warning' });
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

    assert.ok(
      appendCalls.some(
        (msg) => msg.from?.kind === 'agent' && msg.from.catId === 'opus' && msg.content === 'Here is the result.',
      ),
    );
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
        if (message.type === 'system_info' && message.content?.trim().startsWith('{'))
          yieldedPayloads.push(JSON.parse(message.content));
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
