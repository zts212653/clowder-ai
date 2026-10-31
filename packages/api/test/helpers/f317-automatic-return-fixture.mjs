import './setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catRegistry, createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { saveMessageDispositionPreference } from '../../src/config/user-preferences-store.ts';
import { InvocationQueue } from '../../src/domains/cats/services/agents/invocation/InvocationQueue.ts';
import { InvocationRegistry } from '../../src/domains/cats/services/agents/invocation/InvocationRegistry.ts';
import { InvocationTracker } from '../../src/domains/cats/services/agents/invocation/InvocationTracker.ts';
import { QueueProcessor } from '../../src/domains/cats/services/agents/invocation/QueueProcessor.ts';
import { InMemoryTurnExecutionStore } from '../../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.ts';
import { DeliveryCursorStore } from '../../src/domains/cats/services/stores/ports/DeliveryCursorStore.ts';
import { InvocationRecordStore } from '../../src/domains/cats/services/stores/ports/InvocationRecordStore.ts';
import { settleLifecycleResponseInputs } from '../../src/domains/cats/services/stores/ports/MessageStore.ts';
import { MessageLiveInboxSource } from '../../src/domains/concierge/live/inbox/MessageLiveInboxSource.ts';
import { LiveCarrierOperationGate } from '../../src/domains/concierge/live/LiveCarrierOperationGate.ts';
import { callbacksRoutes } from '../../src/routes/callbacks.ts';
import { appendTestLifecycleResponseSource } from './message-from-fixtures.js';

export async function eventually(predicate, message) {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(typeof message === 'function' ? message() : message);
}

/** Formal callback admission and automatic QueueProcessor; only partner inference/native rendering are test ports. */
export async function automaticReturnFixture(t, f, provider) {
  if (!catRegistry.has('codex-astra'))
    catRegistry.register('codex-astra', {
      ...catRegistry.getOrThrow('codex').config,
      id: createCatId('codex-astra'),
      displayName: '小星星·砚砚',
      defaultModel: 'gpt-6-astra',
    });
  const projectRoot = await mkdtemp(join(tmpdir(), 'f317-guide-policy-'));
  saveMessageDispositionPreference(projectRoot, { scope: 'global', disposition: 'continue_current' });
  const tracker = new InvocationTracker();
  const queue = new InvocationQueue(undefined, {
    projectRoot,
    invocationTracker: tracker,
    resolveCarrierCapability: () => ({
      provider: 'openai_codex',
      carrier: 'codex_app_server',
      deliverySemantics: 'exact_active_turn',
      activeInvocationGuidance: 'supported',
    }),
    onAdmitted: ({ threadId }) => void processor.requestDrain(threadId),
  });
  const registry = new InvocationRegistry();
  const records = new InvocationRecordStore();
  const turns = new InMemoryTurnExecutionStore();
  const cursors = new DeliveryCursorStore();
  const app = Fastify();
  const gate = new LiveCarrierOperationGate();
  const starts = [],
    appends = [],
    errors = [];
  let closed = false;
  const socketManager = { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} };
  const router = {
    resolveExplicitTargets(targets) {
      return targets;
    },
    async resolveConversationTargetsAtAdmission(targets) {
      return targets;
    },
    async *routeExecution(userId, content, threadId, messageId, targets, _intent, options) {
      const catId = targets[0];
      assert.equal(catId, 'codex-sol', 'the active Live cat must not be launched as an ordinary successor');
      const parentInvocationId = options.parentInvocationId;
      const auth = await registry.create(userId, catId, threadId, parentInvocationId, messageId);
      const invocationId = auth.invocationId;
      const startedAt = Date.now();
      turns.createRunning({
        invocationId,
        parentInvocationId,
        threadId,
        userId,
        catId,
        startedAt,
        executionKind: 'ordinary',
        causal: { triggerMessageId: messageId, coveredMessageIds: options.persistedPromptMessageIds },
      });
      const lifecycle = await options.onLifecycleInvocationStarted({
        threadId,
        userId,
        catId,
        invocationId,
        parentInvocationId,
        startedAt,
      });
      assert.ok(lifecycle);
      yield {
        lifecycleResponseMessageId: lifecycle.responseMessageId,
        lifecyclePriorFrontierMessageId: lifecycle.priorFrontierMessageId,
        type: 'system_info',
        catId,
        turnInvocationId: invocationId,
        turnExecutionStartedAt: startedAt,
        timestamp: startedAt,
        extra: { turnExecution: { executionKind: 'ordinary', invocationId, parentInvocationId } },
      };
      await options.onPromptMessagesExposed({
        threadId,
        userId,
        catId,
        invocationId,
        messageIds: options.persistedPromptMessageIds,
        seenAt: Date.now(),
      });
      starts.push({ content, messageId, invocationId });
      try {
        await provider({ auth, content, post, read });
        turns.transitionTerminal(invocationId, { status: 'succeeded', endedAt: Date.now() });
        const settled = await f.messages.commitLifecycleResponseTerminal(lifecycle.responseMessageId, {
          invocationId,
          status: 'completed',
          completedAt: Date.now(),
          content: '',
          mentions: [],
          origin: 'stream',
        });
        assert.ok(settled.kind === 'applied' || settled.kind === 'replayed');
        await settleLifecycleResponseInputs(f.messages, settled.message, lifecycle.responseMessageId);
        yield { type: 'done', catId, invocationId, timestamp: Date.now() };
      } catch (error) {
        errors.push(error);
        turns.transitionTerminal(invocationId, {
          status: 'failed',
          terminalReason: 'fixture_provider_error',
          endedAt: Date.now(),
        });
        yield { type: 'done', catId, invocationId, isError: true, timestamp: Date.now() };
      }
    },
    async ackCollectedCursors() {},
  };
  const processor = new QueueProcessor({
    queue,
    invocationTracker: tracker,
    invocationRecordStore: records,
    turnExecutionStore: turns,
    messageStore: f.messages,
    router,
    socketManager,
    log: {
      info() {},
      warn() {},
      error(context) {
        errors.push(context);
      },
    },
  });
  await app.register(callbacksRoutes, {
    registry,
    messageStore: f.messages,
    threadStore: f.threads,
    taskStore: f.tasks,
    invocationQueue: queue,
    invocationTracker: tracker,
    invocationRecordStore: records,
    turnExecutionStore: turns,
    deliveryCursorStore: cursors,
    withLiveCarrierOperation: (query, consume) => gate.runForCarrier(query, consume),
    queueProcessor: processor,
    router,
    socketManager,
  });
  async function post(auth, content, targetCats) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: { content, targetCats },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.notEqual(body.isError, true, response.body);
    assert.deepEqual(body.routed, targetCats, 'every explicitly requested target must be durably routed');
    return body;
  }
  async function read(auth) {
    const response = await app.inject({
      url: '/api/callbacks/thread-context?readIntent=unread&responseMode=full',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  }
  const live = await registry.create('owner', 'codex-astra', f.thread.id, 'live-parent');
  turns.createRunning({
    invocationId: live.invocationId,
    parentInvocationId: 'live-parent',
    threadId: f.thread.id,
    userId: 'owner',
    catId: 'codex-astra',
    startedAt: Date.now(),
    executionKind: 'ordinary',
    queueCompletionPolicy: 'explicit_source',
  });
  tracker.start(f.thread.id, 'codex-astra', 'owner', ['codex-astra'], 'live-parent');
  const liveResponse = appendTestLifecycleResponseSource(f.messages, {
    userId: 'owner',
    threadId: f.thread.id,
    catId: 'codex-astra',
    invocationId: live.invocationId,
    timestamp: Date.now(),
  });
  assert.equal(
    tracker.bindLifecycleActiveRun(
      {
        threadId: f.thread.id,
        targetId: 'codex-astra',
        invocationId: live.invocationId,
        responseMessageId: liveResponse.id,
        inputEntryIds: [],
        inputMessageIds: [],
        privateInputEntryIds: [],
        startedAt: Date.now(),
      },
      'live-parent',
    ),
    true,
  );
  const scope = {
    userId: 'owner',
    threadId: f.thread.id,
    catId: 'codex-astra',
    invocationId: live.invocationId,
    parentInvocationId: 'live-parent',
    callId: 'automatic-return-call',
    generation: 1,
  };
  const source = new MessageLiveInboxSource({ store: f.messages, queue, authorize: async () => !closed });
  const releaseDispatcher = tracker.bindAgentClientActiveRunDispatcher(
    scope.threadId,
    scope.catId,
    {
      invocationId: live.invocationId,
      capabilities: { append: true, steer: true, inputReadReceipt: true },
      handle: { provider: 'openai', carrier: 'codex_app_server', threadId: 'native-live', turnId: 'active-live-turn' },
      dispatch: async (input) => {
        appends.push(input);
        return { accepted: true, inputReadAt: Date.now() };
      },
    },
    'live-parent',
  );
  assert.ok(releaseDispatcher, 'normal Queue append has an exact active Live target');
  t.after(async () => {
    closed = true;
    releaseDispatcher();
    gate.close();
    await gate.drain();
    await app.close();
  });
  return { live, scope, source, queue, tracker, records, turns, starts, appends, errors, post, read };
}
