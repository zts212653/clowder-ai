import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_TEMPLATE_PATH = resolve(__dirname, '..', '..', '..', 'cat-template.json');

/**
 * #573/#1332: a cat_cafe_post_message callback is always its own durable message.
 * It never suppresses, replaces or absorbs the provider's final stream output, so
 * the final is persisted as usual. The route only tracks whether each post was
 * confirmed by its matching tool_result; a confirmed post's message id is recorded
 * in persistedOutputMessageIds ahead of the final's id.
 */

function createServiceWithPostMessage(catId, toolName = 'cat_cafe_post_message') {
  return {
    async *invoke() {
      yield { type: 'text', catId, content: 'Let me post a reply.', timestamp: Date.now() };
      yield {
        type: 'tool_use',
        catId,
        toolName,
        toolInput: { content: 'Let me post a reply.' },
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

function createServiceWithTerminalAck(catId, messageId = 'callback-terminal-ack') {
  return {
    async *invoke() {
      yield {
        type: 'tool_use',
        catId,
        toolName: 'cat_cafe_post_message',
        toolInput: {
          content: 'Terminal coordination ACK.',
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
        content: 'Provider final that stays durable next to the terminal ACK.',
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
        toolInput: { content: 'First callback update.' },
        toolUseId: 'post-first',
        timestamp: Date.now(),
      };
      yield {
        type: 'tool_use',
        catId,
        toolName: 'cat_cafe_post_message',
        toolInput: { content: 'Second callback update.' },
        toolUseId: 'post-second',
        timestamp: Date.now(),
      };
      yield {
        type: 'tool_result',
        catId,
        toolUseId: 'post-first',
        content: JSON.stringify({ status: 'ok', threadId: 'thread1', messageId: 'callback-first' }),
        timestamp: Date.now(),
      };
      yield {
        type: 'tool_result',
        catId,
        toolUseId: 'post-second',
        content: JSON.stringify({ status: 'ok', threadId: 'thread1', messageId: 'callback-second' }),
        timestamp: Date.now(),
      };
      yield {
        type: 'text',
        catId,
        content: 'Provider final stays durable after both callbacks.',
        timestamp: Date.now(),
      };
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

function createServiceWithPrefixedPostMessageResult(catId) {
  return {
    async *invoke() {
      yield { type: 'text', catId, content: 'Posting via prefixed callback result.', timestamp: Date.now() };
      yield {
        type: 'tool_use',
        catId,
        toolName: 'cat_cafe_post_message',
        toolInput: { content: 'Posting via prefixed callback result.' },
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
      getById: () => null,
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
  beforeEach(async () => {
    const { getRichBlockBuffer } = await import('../dist/domains/cats/services/agents/invocation/RichBlockBuffer.js');
    getRichBlockBuffer().destroy();
  });

  // A confirmed callback and a final response are independent durable sources, even
  // when addressed to the same target or carrying identical text. Only callback
  // confirmations refer to the callback source; they must not replay into the final.
  for (const scenario of [
    {
      name: 'earlier scope notification then a distinct final handoff',
      final: '@codex\nExact commit is ready for review.',
    },
    { name: 'identical text with independent callback and response identities', final: '@codex\nScope notification.' },
    {
      name: 'structured callback target then a final handoff',
      final: '@codex\nReview the completed work.',
      callback: 'Scope notification.',
    },
    {
      name: 'duplicate callback confirmation then a final handoff',
      final: '@codex\nNew final handoff.',
      duplicate: true,
    },
    { name: 'failed callback then a final handoff', final: '@codex\nFallback handoff.', failed: true },
    {
      name: 'callback-only handoff is not replayed into plain final text',
      final: 'Final summary without a new handoff.',
    },
    {
      name: 'duplicate callback confirmation is not replayed into plain final text',
      final: 'Final summary.',
      duplicate: true,
    },
    { name: 'failed callback target is not invented for plain final text', final: 'Final summary.', failed: true },
    { name: 'callback-only tool output creates no second handoff', final: '' },
  ]) {
    it(`source-scoped routing: ${scenario.name}`, async () => {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
      const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
      const { commitCompletedResponseAndEnqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
      const { appendTestLifecycleResponseSource } = await import('./helpers/message-from-fixtures.js');
      const messages = new MessageStore();
      const queue = new InvocationQueue();
      let callbackId;
      let responseId;
      const callbackBody = scenario.callback ?? '@codex\nScope notification.';
      const commits = [];
      const service = {
        async *invoke() {
          yield {
            type: 'tool_use',
            catId: 'opus',
            toolName: 'cat_cafe_post_message',
            toolUseId: 'scope-post',
            toolInput: { content: callbackBody, targetCats: ['codex'] },
            timestamp: Date.now(),
          };
          if (!scenario.failed) {
            const admitted = await queue.send(
              messages,
              {
                from: { kind: 'agent', catId: 'opus' },
                userId: 'user1',
                threadId: 'thread1',
                content: callbackBody,
                mentions: ['codex'],
                timestamp: Date.now(),
                origin: 'callback',
              },
              {
                from: { kind: 'agent', catId: 'opus' },
                kind: 'conversation_input',
                userId: 'user1',
                threadId: 'thread1',
                content: callbackBody,
                targetCats: ['codex'],
                intent: 'execute',
                ownerAuthProvenance: 'unknown',
              },
            );
            assert.equal(admitted.outcome, 'enqueued');
            callbackId = admitted.message.id;
          }
          const result = {
            type: 'tool_result',
            catId: 'opus',
            toolUseId: 'scope-post',
            timestamp: Date.now(),
            content: scenario.failed
              ? 'Error: callback token expired'
              : JSON.stringify({ status: 'ok', threadId: 'thread1', messageId: callbackId, routed: ['codex'] }),
          };
          yield result;
          if (scenario.duplicate)
            yield {
              ...result,
              content: JSON.stringify({ status: 'duplicate', threadId: 'thread1', messageId: callbackId }),
            };
          if (scenario.final) yield { type: 'text', catId: 'opus', content: scenario.final, timestamp: Date.now() };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        },
      };
      const deps = createMockDeps({ opus: service }, []);
      deps.messageStore = messages;
      const persistenceContext = { errors: [], failed: false };
      for await (const _ of routeSerial(deps, ['opus'], 'work', 'user1', 'thread1', {
        parentInvocationId: 'source-routing-parent',
        persistenceContext,
        onLifecycleInvocationStarted: async (input) => {
          const response = await appendTestLifecycleResponseSource(messages, {
            invocationId: input.invocationId,
            catId: input.catId,
            threadId: input.threadId,
            userId: input.userId,
            timestamp: input.startedAt,
          });
          responseId = response.id;
          return {
            responseMessageId: response.id,
            priorFrontierMessageId: null,
            activeRun: {
              threadId: 'thread1',
              targetId: 'opus',
              invocationId: input.invocationId,
              responseMessageId: response.id,
              inputEntryIds: [],
              inputMessageIds: [],
              privateInputEntryIds: [],
              startedAt: input.startedAt,
            },
          };
        },
        commitCompletedA2AWake: async (input) => {
          commits.push(input);
          return commitCompletedResponseAndEnqueueA2ATargets(
            {
              messageStore: messages,
              invocationQueue: queue,
              queueProcessor: { async requestDrain() {} },
              socketManager: { emitToUser() {}, broadcastAgentMessage() {} },
              log: { info() {}, warn() {}, error() {} },
            },
            input,
          );
        },
      })) {
        /* consume */
      }
      assert.deepEqual(persistenceContext.errors, [], 'route persistence must succeed');
      const final = await messages.getById(responseId);
      const wantsFinalHandoff = scenario.final.startsWith('@codex');
      assert.deepEqual(final.mentions, wantsFinalHandoff ? ['codex'] : [], 'final owns only its own targets');
      assert.equal(commits.length, wantsFinalHandoff ? 1 : 0);
      if (wantsFinalHandoff) {
        assert.equal(commits[0].responseMessageId, responseId);
        assert.notEqual(responseId, callbackId);
        assert.equal(final.lifecycle.status, 'completed');
        const queued = queue.list('thread1', 'user1').find((entry) => entry.payload.sourceRecordId === responseId);
        assert.ok(queued, 'final must enter the real queue under its own source id');
        assert.deepEqual(queued.targets, ['codex']);
      }
      const entries = queue.list('thread1', 'user1');
      assert.equal(entries.length, (scenario.failed ? 0 : 1) + (wantsFinalHandoff ? 1 : 0));
      if (!scenario.failed) {
        assert.equal(
          entries.filter((entry) => entry.payload.sourceRecordId === callbackId).length,
          1,
          'callback source is not replayed',
        );
        assert.equal(persistenceContext.persistedOutputMessageIds.filter((id) => id === callbackId).length, 1);
      }
    });
  }

  it('does not replay a callback carrier through recursive serial execution', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
    const appendCalls = [];
    let duplicateTargetInvocations = 0;
    const callbackBody = '@codex\nCallback already routed this exact source and target.';
    const callbackService = {
      async *invoke() {
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
          content: JSON.stringify({ status: 'ok', threadId: 'thread1', messageId: 'callback-source-1' }),
          timestamp: Date.now(),
        };
        yield { type: 'text', catId: 'opus', content: 'Callback handoff sent; final summary.', timestamp: Date.now() };
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
        0,
        'failed callback admission must not resurrect the removed recursive serial carrier',
      );
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) catRegistry.register(id, config);
    }
  });

  it('treats a persisted terminal coordination ACK as a confirmed post', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const persistenceContext = {};
    const deps = createMockDeps({ opus: createServiceWithTerminalAck('opus') }, appendCalls);

    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1', { persistenceContext })) {
      // drain
    }

    // F117: AppendMessageInput carries the sender as MessageFrom (`from`), not a
    // top-level `catId` projection — ef94412a5 "make MessageFrom the sender truth".
    const streamAppends = appendCalls.filter(
      (message) => message.origin === 'stream' && message.from?.kind === 'agent' && message.from.catId === 'opus',
    );
    assert.equal(streamAppends.length, 1, 'the terminal ACK must not suppress the provider final');
    assert.equal(streamAppends[0].content, 'Provider final that stays durable next to the terminal ACK.');
    assert.deepEqual(
      persistenceContext.persistedOutputMessageIds,
      ['callback-terminal-ack', 'msg-1'],
      'the confirmed terminal ACK id must be recorded before the final id',
    );
  });

  it('does not confirm terminal_ack_recorded without a durable message id', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const persistenceContext = {};
    const deps = createMockDeps({ opus: createServiceWithTerminalAck('opus', '') }, appendCalls);

    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1', { persistenceContext })) {
      // drain
    }

    // F117: AppendMessageInput carries the sender as MessageFrom (`from`), not a
    // top-level `catId` projection — ef94412a5 "make MessageFrom the sender truth".
    const streamAppends = appendCalls.filter(
      (message) => message.origin === 'stream' && message.from?.kind === 'agent' && message.from.catId === 'opus',
    );
    assert.equal(streamAppends.length, 1, 'the provider final must be persisted exactly once');
    assert.deepEqual(
      persistenceContext.persistedOutputMessageIds,
      ['msg-1'],
      'an unproven terminal ACK must not record a callback output id',
    );
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

    // F117: AppendMessageInput carries the sender as MessageFrom (`from`), not a
    // top-level `catId` projection — ef94412a5 "make MessageFrom the sender truth".
    const streamAppends = appendCalls.filter(
      (message) => message.origin === 'stream' && message.from?.kind === 'agent' && message.from.catId === 'opus',
    );
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

  it('records no callback id when a duplicate post result has no durable message id', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const persistenceContext = {};
    const service = {
      async *invoke() {
        yield {
          type: 'text',
          catId: 'opus',
          content: 'Provider final must remain durable.',
          timestamp: Date.now(),
        };
        yield {
          type: 'tool_use',
          catId: 'opus',
          toolName: 'cat_cafe_post_message',
          toolInput: { content: 'Callback may not have a durable message.' },
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

    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1', { persistenceContext })) {
      // drain
    }

    // F117: AppendMessageInput carries the sender as MessageFrom (`from`), not a
    // top-level `catId` projection — ef94412a5 "make MessageFrom the sender truth".
    const streamAppends = appendCalls.filter(
      (message) => message.origin === 'stream' && message.from?.kind === 'agent' && message.from.catId === 'opus',
    );
    assert.equal(streamAppends.length, 1, 'the provider final must be persisted exactly once');
    assert.equal(streamAppends[0].content, 'Provider final must remain durable.');
    assert.deepEqual(
      persistenceContext.persistedOutputMessageIds,
      ['msg-1'],
      'a duplicate post without a durable message id must not record a callback output id',
    );
  });

  it('records every matched confirmed post in result order and still stores the final', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const persistenceContext = {};
    const deps = createMockDeps({ opus: createServiceWithMultiplePostResults('opus') }, appendCalls);

    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1', { persistenceContext })) {
      // drain
    }

    // F117: AppendMessageInput carries the sender as MessageFrom (`from`), not a
    // top-level `catId` projection — ef94412a5 "make MessageFrom the sender truth".
    const streamAppends = appendCalls.filter(
      (message) => message.origin === 'stream' && message.from?.kind === 'agent' && message.from.catId === 'opus',
    );
    assert.equal(streamAppends.length, 1, 'confirmed callbacks must not suppress the provider final');
    assert.equal(streamAppends[0].content, 'Provider final stays durable after both callbacks.');
    assert.deepEqual(
      persistenceContext.persistedOutputMessageIds,
      ['callback-first', 'callback-second', 'msg-1'],
      'each confirmed callback must contribute its durable message id in result order, before the final',
    );
  });

  it('extracts messageId from Codex-style prefixed MCP tool results to confirm the post', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const persistenceContext = {};
    const deps = createMockDeps({ opus: createServiceWithPrefixedPostMessageResult('opus') }, appendCalls);

    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1', { persistenceContext })) {
      // drain
    }

    const streamAppends = appendCalls.filter(
      (m) => m.origin === 'stream' && m.from?.kind === 'agent' && m.from.catId === 'opus',
    );
    assert.equal(streamAppends.length, 1, 'the provider final must be persisted exactly once');
    assert.deepEqual(
      persistenceContext.persistedOutputMessageIds,
      ['callback-msg-prefixed', 'msg-1'],
      'a prefixed callback result must confirm the post and record its id before the final',
    );
  });

  it('persists blocks created after an interim callback when the serial route appends its final', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const { getRichBlockBuffer } = await import('../dist/domains/cats/services/agents/invocation/RichBlockBuffer.js');
    const buffer = getRichBlockBuffer();
    const first = { id: 'interim-card', kind: 'card', v: 1, title: 'Interim' };
    const later = { id: 'final-card', kind: 'card', v: 1, title: 'Final' };
    const service = {
      async *invoke() {
        yield {
          type: 'system_info',
          catId: 'opus',
          content: JSON.stringify({ type: 'invocation_created', invocationId: 'inv-1' }),
          timestamp: Date.now(),
        };
        assert.equal(buffer.add('thread1', 'opus', first, 'inv-1'), 'added');
        assert.deepEqual(buffer.consume('thread1', 'opus', 'inv-1', { final: false }), [first]);
        assert.equal(buffer.add('thread1', 'opus', later, 'inv-1'), 'added');
        yield { type: 'text', catId: 'opus', content: 'Final answer', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };
    const appendCalls = [];
    const deps = createMockDeps({ opus: service }, appendCalls);

    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1')) {
      // drain
    }

    const final = appendCalls.find(
      (message) => message.origin === 'stream' && message.from?.kind === 'agent' && message.from.catId === 'opus',
    );
    assert.deepEqual(final?.extra?.rich?.blocks, [later]);
    assert.equal(
      buffer.add('thread1', 'opus', { id: 'too-late', kind: 'card', v: 1, title: 'Late' }, 'inv-1'),
      'rejected',
    );
  });

  it('confirms namespaced cat_cafe_post_message tool names', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const persistenceContext = {};
    const deps = createMockDeps(
      { opus: createServiceWithPostMessage('opus', 'mcp:cat-cafe/cat_cafe_post_message') },
      appendCalls,
    );

    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1', { persistenceContext })) {
      // drain
    }

    const streamAppends = appendCalls.filter(
      (m) => m.origin === 'stream' && m.from?.kind === 'agent' && m.from.catId === 'opus',
    );
    assert.equal(streamAppends.length, 1, 'the provider final must be persisted exactly once');
    assert.deepEqual(
      persistenceContext.persistedOutputMessageIds,
      ['callback-msg-1', 'msg-1'],
      'namespaced cat_cafe_post_message should confirm the post and record its id before the final',
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

    const streamAppends = appendCalls.filter(
      (m) => m.origin === 'stream' && m.from?.kind === 'agent' && m.from.catId === 'opus',
    );
    assert.equal(streamAppends.length, 1, 'should persist stream output normally when no callback post');
    assert.ok(streamAppends[0].content.includes('Normal reply'), 'persisted content should match stream text');
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

    const streamAppends = appendCalls.filter(
      (m) => m.origin === 'stream' && m.from?.kind === 'agent' && m.from.catId === 'opus',
    );
    assert.equal(streamAppends.length, 1, 'should persist stream output when callback failed');
  });

  it('keeps waiting for cat_cafe_post_message success across unrelated tool_result events', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const persistenceContext = {};

    const interleavedService = {
      async *invoke() {
        yield { type: 'text', catId: 'opus', content: 'Posting via callback.', timestamp: Date.now() };
        yield {
          type: 'tool_use',
          catId: 'opus',
          toolName: 'mcp:cat-cafe/cat_cafe_post_message',
          toolInput: { content: 'Posting via callback.' },
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
    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1', { persistenceContext })) {
      // drain
    }

    const streamAppends = appendCalls.filter(
      (m) => m.origin === 'stream' && m.from?.kind === 'agent' && m.from.catId === 'opus',
    );
    assert.equal(streamAppends.length, 1, 'the provider final must be persisted exactly once');
    assert.deepEqual(
      persistenceContext.persistedOutputMessageIds,
      ['callback-interleaved', 'msg-1'],
      'unrelated tool_result must not clear pending callback confirmation',
    );
  });

  it('does not confirm callback persistence from another pending tool result with ok status', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const persistenceContext = {};

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
          toolInput: { content: 'Posting through callback.' },
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
    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1', { persistenceContext })) {
      // drain
    }

    const streamAppends = appendCalls.filter(
      (m) => m.origin === 'stream' && m.from?.kind === 'agent' && m.from.catId === 'opus',
    );
    assert.equal(streamAppends.length, 1, 'the provider final must be persisted exactly once');
    assert.deepEqual(
      persistenceContext.persistedOutputMessageIds,
      ['msg-1'],
      'an ok result from another pending tool must not confirm the failed post',
    );
  });

  it('confirms an unlabeled callback result when the post tool is first pending among multiple tools', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const persistenceContext = {};

    const parallelToolService = {
      async *invoke() {
        yield { type: 'text', catId: 'opus', content: 'Posting through callback.', timestamp: Date.now() };
        yield {
          type: 'tool_use',
          catId: 'opus',
          toolName: 'mcp:cat-cafe/cat_cafe_post_message',
          toolInput: { content: 'Posting through callback.' },
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
    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1', { persistenceContext })) {
      // drain
    }

    const streamAppends = appendCalls.filter(
      (m) => m.origin === 'stream' && m.from?.kind === 'agent' && m.from.catId === 'opus',
    );
    assert.equal(streamAppends.length, 1, 'the provider final must be persisted exactly once');
    assert.deepEqual(
      persistenceContext.persistedOutputMessageIds,
      ['msg-123', 'msg-1'],
      'an unlabeled callback result should confirm the first pending post before the final',
    );
  });

  it('keeps FIFO when a callback-shaped result arrives before a later pending post tool', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const persistenceContext = {};

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
    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1', { persistenceContext })) {
      // drain
    }

    const streamAppends = appendCalls.filter(
      (m) => m.origin === 'stream' && m.from?.kind === 'agent' && m.from.catId === 'opus',
    );
    assert.equal(streamAppends.length, 1, 'the provider final must be persisted exactly once');
    assert.deepEqual(
      persistenceContext.persistedOutputMessageIds,
      ['msg-1'],
      'callback-shaped result from the first pending tool must not confirm the later failed post',
    );
  });

  it('does not consume a later pending post when cross-post returns the same message shape first', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const persistenceContext = {};

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
    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1', { persistenceContext })) {
      // drain
    }

    const streamAppends = appendCalls.filter(
      (m) => m.origin === 'stream' && m.from?.kind === 'agent' && m.from.catId === 'opus',
    );
    assert.equal(streamAppends.length, 1, 'the provider final must be persisted exactly once');
    assert.deepEqual(
      persistenceContext.persistedOutputMessageIds,
      ['msg-1'],
      'cross-post result with messageId+threadId must not confirm the later pending post',
    );
  });

  it('does not match another tool result with messageId shape to a later pending post tool', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const persistenceContext = {};

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
    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1', { persistenceContext })) {
      // drain
    }

    const streamAppends = appendCalls.filter(
      (m) => m.origin === 'stream' && m.from?.kind === 'agent' && m.from.catId === 'opus',
    );
    assert.equal(streamAppends.length, 1, 'the provider final must be persisted exactly once');
    assert.deepEqual(
      persistenceContext.persistedOutputMessageIds,
      ['msg-1'],
      'status-like result from another tool must not confirm the failed post callback',
    );
  });

  it('does not confirm an ambiguous unlabeled ok result while another tool is pending', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const persistenceContext = {};

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
    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1', { persistenceContext })) {
      // drain
    }

    const streamAppends = appendCalls.filter(
      (m) => m.origin === 'stream' && m.from?.kind === 'agent' && m.from.catId === 'opus',
    );
    assert.equal(streamAppends.length, 1, 'the provider final must be persisted exactly once');
    assert.deepEqual(
      persistenceContext.persistedOutputMessageIds,
      ['msg-1'],
      'ambiguous ok tool_result must not confirm the pending post',
    );
  });

  it('does not confirm callback persistence from a duplicate labeled post result after a failed callback', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const persistenceContext = {};

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
    for await (const _msg of routeSerial(deps, ['opus'], 'hello', 'user1', 'thread1', { persistenceContext })) {
      // drain
    }

    const streamAppends = appendCalls.filter(
      (m) => m.origin === 'stream' && m.from?.kind === 'agent' && m.from.catId === 'opus',
    );
    assert.equal(streamAppends.length, 1, 'the provider final must be persisted exactly once');
    assert.deepEqual(
      persistenceContext.persistedOutputMessageIds,
      ['msg-1'],
      'duplicate labeled post result without a pending match must not confirm the post',
    );
  });
});
