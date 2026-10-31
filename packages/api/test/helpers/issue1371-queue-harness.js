import assert from 'node:assert/strict';
import { mock } from 'node:test';
import Fastify from 'fastify';
import { InvocationQueue } from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import {
  commitLifecycleResponseFromAppendInput,
  MessageStore,
} from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { queueRoutes } from '../../dist/routes/queue.js';
import { canonicalTestMessageInput, canonicalTestQueueInput } from './message-from-fixtures.js';

export async function waitFor(predicate) {
  const until = Date.now() + 2_000;
  while (!(await predicate())) {
    if (Date.now() > until) throw new Error('Queue did not converge');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export async function harness({ guide = false } = {}) {
  const queue = new InvocationQueue();
  const tracker = new InvocationTracker();
  const store = new MessageStore();
  let releaseCreate;
  const createGate = new Promise((resolve) => {
    releaseCreate = resolve;
  });
  let created = 0;
  const recordMap = new Map();
  const records = {
    create: mock.fn(async (input) => {
      const invocationId = `inv-${++created}`;
      if (created === 1) await createGate;
      const record = {
        id: invocationId,
        ...input,
        userMessageId: null,
        status: 'queued',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      recordMap.set(invocationId, record);
      return { outcome: 'created', invocationId };
    }),
    get: async (id) => recordMap.get(id) ?? null,
    update: async (id, patch) => {
      const current = recordMap.get(id);
      if (!current) return null;
      if (patch.expectedStatus && current.status !== patch.expectedStatus) return null;
      const { expectedStatus: _expectedStatus, ...changes } = patch;
      const next = { ...current, ...changes, updatedAt: Date.now() };
      recordMap.set(id, next);
      return next;
    },
    listRunningByThread: async () => [],
  };
  const socketManager = { emitToUser: mock.fn(), broadcastToRoom() {}, broadcastAgentMessage() {} };
  const routeExecution = mock.fn(async function* (userId, _content, threadId, messageId, targets, _intent, options) {
    for (const catId of targets) {
      const childId = `child-${created}-${catId}`;
      const lifecycleAdmission = await options.onLifecycleInvocationStarted({
        threadId,
        userId,
        catId,
        invocationId: childId,
        parentInvocationId: options.parentInvocationId,
        startedAt: Date.now(),
      });
      await options.onPromptMessagesExposed({
        threadId,
        userId,
        catId,
        invocationId: childId,
        messageIds: [messageId],
        seenAt: Date.now(),
      });
      await commitLifecycleResponseFromAppendInput(
        store,
        lifecycleAdmission.responseMessageId,
        childId,
        { status: 'completed', completedAt: Date.now() },
        {
          from: { kind: 'agent', catId },
          userId,
          threadId,
          content: 'handled exact source',
          mentions: [],
          timestamp: Date.now(),
          replyTo: messageId,
          extra: {
            causal: { kind: 'invocation_reply', triggerMessageId: messageId },
            stream: { invocationId: `inv-${created}`, turnInvocationId: childId },
          },
        },
      );
      yield { type: 'done', catId, invocationId: childId, isFinal: true, timestamp: Date.now() };
    }
  });
  const processor = new QueueProcessor({
    queue,
    invocationTracker: tracker,
    messageStore: store,
    invocationRecordStore: records,
    socketManager,
    router: {
      resolveConversationTargetsAtAdmission: async (targets) => [...targets],
      resolveExplicitTargets: async (targets) => [...targets],
      routeExecution,
      ackCollectedCursors: async () => {},
    },
    log: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
  });
  const queueInput = canonicalTestQueueInput({
    threadId: 'thread-1',
    userId: 'user-1',
    kind: 'conversation_input',
    sourceId: 'issue1371-prestart-source',
    ...(guide ? { ownerAuthProvenance: 'strict', autoExecute: true } : {}),
    content: 'independent targets',
    targetCats: ['opus', 'codex'],
    intent: 'execute',
  });
  const admitted = await queue.send(
    store,
    canonicalTestMessageInput({
      threadId: queueInput.threadId,
      userId: queueInput.userId,
      from: queueInput.from,
      catId: null,
      mentions: queueInput.targetCats,
      content: queueInput.content,
      timestamp: Date.now(),
      deliveryStatus: 'queued',
    }),
    queueInput,
  );
  const source = admitted.message;
  const entry = admitted.entry;
  const app = Fastify();
  await app.register(queueRoutes, {
    resolveCarrierCapability: () => ({
      provider: 'openai_codex',
      carrier: 'codex_app_server',
      activeInvocationGuidance: 'supported',
      deliverySemantics: 'exact_active_turn',
    }),
    threadStore: { get: async () => ({ id: 'thread-1', createdBy: 'user-1', participants: ['opus', 'codex'] }) },
    invocationQueue: queue,
    invocationTracker: tracker,
    queueProcessor: processor,
    messageStore: store,
    invocationRecordStore: records,
    socketManager,
  });
  return {
    queue,
    tracker,
    store,
    processor,
    records,
    source,
    entry,
    routeExecution,
    releaseCreate,
    app,
  };
}

export function bindAppendRun(h, catId) {
  const parent = `parent-${catId}`,
    invocationId = `turn-${catId}`,
    startedAt = Date.now();
  const controller = h.tracker.start('thread-1', catId, 'user-1', [catId], parent);
  const response = h.store.append({
    from: { kind: 'agent', catId },
    userId: 'user-1',
    threadId: 'thread-1',
    content: '',
    mentions: [],
    origin: 'stream',
    timestamp: startedAt,
    lifecycle: {
      kind: 'response',
      orderKey: `${startedAt}:${invocationId}`,
      invocationId,
      targetId: catId,
      inputEntryIds: [],
      inputMessageIds: [],
      status: 'processing',
      startedAt,
    },
  });
  assert.ok(
    h.tracker.bindLifecycleActiveRun(
      {
        threadId: 'thread-1',
        targetId: catId,
        invocationId,
        responseMessageId: response.id,
        inputEntryIds: [],
        inputMessageIds: [],
        privateInputEntryIds: [],
        startedAt,
      },
      parent,
    ),
  );
  return { invocationId, responseId: response.id, controller };
}
