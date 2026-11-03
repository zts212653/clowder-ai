import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { InvocationRecordStore } from '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import {
  MessageStore,
  settleLifecycleResponseInputs,
} from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { messagesRoutes } from '../dist/routes/messages.js';

const cancelled = { type: 'done', catId: 'codex', errorCode: 'INVOCATION_CANCELLED' };
const cases = [
  ['Host stop with error and done', [{ ...cancelled, type: 'error', error: 'Host stopped' }, cancelled], 'canceled'],
  ['Host stop with done only', [cancelled], 'canceled'],
  ['real failure before Host stop', [{ type: 'error', catId: 'codex', error: 'real failure' }, cancelled], 'failed'],
  ['real failure after Host stop', [cancelled, { type: 'error', catId: 'codex', error: 'real failure' }], 'failed'],
  ['successful peer survives Host stop', [cancelled, { type: 'done', catId: 'opus' }], 'succeeded'],
];

function fixture(events, expected) {
  const records = new InvocationRecordStore();
  const tracker = new InvocationTracker();
  const queue = new InvocationQueue();
  const messages = new MessageStore();
  const turns = new InMemoryTurnExecutionStore();
  const parentIds = [];
  const completions = [];
  const targetCats = [...new Set(events.map((event) => event.catId))];
  const router = {
    previewTargets: async () => ({ targetCats: [], reason: { kind: 'default_cat' } }),
    resolveTargetsAndIntent: async () => ({ targetCats, intent: { intent: 'execute' } }),
    resolveExplicitTargets: async (targets) => [...targets],
    resolveConversationTargetsAtAdmission: async (targets) => (targets.length ? [...targets] : targetCats),
    async *routeExecution(userId, _content, threadId, _messageId, targets, _intent, options) {
      const responses = new Map();
      for (const catId of targets) {
        const input = {
          threadId,
          userId,
          catId,
          invocationId: `child-${catId}`,
          parentInvocationId: options.parentInvocationId,
          startedAt: Date.now(),
        };
        turns.createRunning({
          ...input,
          executionKind: 'ordinary',
          ...(catId === 'codex' ? { queueCompletionPolicy: 'explicit_source' } : {}),
        });
        responses.set(catId, await options.onLifecycleInvocationStarted(input));
      }
      // Controlled provider outcome is persisted through the actual History/turn owners.
      // Queue must derive the parent and successful receivers without replacing a canceled Live child.
      for (const event of events) yield { ...event, turnInvocationId: `child-${event.catId}`, timestamp: Date.now() };
      for (const catId of targets) {
        const status = catId === 'opus' ? 'succeeded' : expected === 'succeeded' ? 'canceled' : expected;
        turns.transitionTerminal(`child-${catId}`, {
          status,
          endedAt: Date.now(),
          terminalReason: 'controlled_native_outcome',
        });
        const responseId = responses.get(catId).responseMessageId;
        const result = messages.commitLifecycleResponseTerminal(responseId, {
          invocationId: `child-${catId}`,
          status: status === 'succeeded' ? 'completed' : status,
          completedAt: Date.now(),
          content: '',
          mentions: [],
          origin: 'stream',
        });
        assert.equal(result.kind, 'applied');
        await settleLifecycleResponseInputs(messages, result.message, responseId);
      }
    },
    ackCollectedCursors: async () => {},
  };
  const deps = {
    registry: new InvocationRegistry(),
    messageStore: messages,
    turnExecutionStore: turns,
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
    router,
    invocationTracker: tracker,
    invocationQueue: queue,
    queue,
    invocationRecordStore: {
      async create(input) {
        const result = records.create(input);
        parentIds.push(result.invocationId);
        return result;
      },
      update: (id, input) => records.update(id, input),
      get: (id) => records.get(id),
    },
    threadStore: { get: async () => ({ id: 'home', createdBy: 'owner', title: 'Home' }) },
    log: { info() {}, warn() {}, error() {} },
  };
  const processor = new QueueProcessor(deps);
  const complete = processor.onInvocationComplete.bind(processor);
  processor.onInvocationComplete = async (...args) => {
    completions.push(args);
    return complete(...args);
  };
  return {
    records,
    tracker,
    queue,
    messages,
    processor,
    parentIds,
    completions,
    targetCats,
    deps: { ...deps, queueProcessor: processor },
  };
}

for (const [label, events, expected] of cases)
  for (const ingress of ['messages', 'queue']) {
    test(`${ingress} preserves each exact receiver through ${label}`, async (t) => {
      const h = fixture(events, expected);
      const app = Fastify();
      t.after(() => app.close());
      await app.register(messagesRoutes, h.deps);
      let sourceId;
      if (ingress === 'messages') {
        const response = await app.inject({
          method: 'POST',
          url: '/api/messages',
          headers: { 'x-cat-cafe-user': 'owner' },
          payload: { content: '@codex Host Live bootstrap', threadId: 'home', mentions: h.targetCats },
        });
        assert.equal(response.statusCode, 202, response.body);
        sourceId = response.json().userMessageId;
      } else {
        const from = { kind: 'user', userId: 'owner' };
        const admitted = await h.queue.send(
          h.messages,
          {
            from,
            userId: 'owner',
            threadId: 'home',
            content: 'Host Live bootstrap',
            mentions: h.targetCats,
            timestamp: Date.now(),
            deliveryStatus: 'queued',
          },
          {
            kind: 'conversation_input',
            from,
            userId: 'owner',
            threadId: 'home',
            content: 'Host Live bootstrap',
            targetCats: h.targetCats,
            intent: 'execute',
            ownerAuthProvenance: 'strict',
          },
        );
        assert.ok(admitted.message);
        sourceId = admitted.message.id;
      }
      await h.processor.requestDrain('home');
      const deadline = Date.now() + 2000;
      while (h.completions.length < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(h.completions.length, 1);
      assert.equal(h.completions[0][2], expected);
      assert.equal(h.records.get(h.parentIds[0]).status, expected);
      assert.deepEqual(h.records.get(h.parentIds[0]).successfulCatIds ?? [], expected === 'succeeded' ? ['opus'] : []);
      const source = h.messages.getById(sourceId);
      assert.equal(source.lifecycle.dispatchRefs.length, h.targetCats.length);
      for (const catId of h.targetCats) {
        const ref = source.lifecycle.dispatchRefs.find((ref) => ref.targetId === catId);
        assert.ok(ref, 'each started receiver remains tied to its own original response');
        assert.equal(ref.phase, 'settled');
        const targetStatus = catId === 'opus' ? 'completed' : expected === 'succeeded' ? 'canceled' : expected;
        assert.equal(
          h.messages.getById(ref.statusMessageId).lifecycle.status,
          targetStatus === 'succeeded' ? 'completed' : targetStatus,
        );
        assert.equal(h.messages.getById(ref.statusMessageId).lifecycle.invocationId, `child-${catId}`);
      }
      assert.equal(h.queue.list('home', 'owner').length, 0);
    });
  }
