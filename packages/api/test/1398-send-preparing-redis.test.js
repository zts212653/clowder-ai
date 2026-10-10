import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { RedisQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { queueRoutes } from '../dist/routes/queue.js';
import { canonicalTestMessageInput, canonicalTestQueueInput } from './helpers/message-from-fixtures.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const owned = ownedRedisFixture('f117-send-preparing');

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for the delivery boundary');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function recordStore() {
  const records = new Map();
  return {
    async create(input) {
      const invocationId = `record-${records.size + 1}`;
      records.set(invocationId, { id: invocationId, ...input, userMessageId: null, status: 'queued' });
      return { outcome: 'created', invocationId };
    },
    async get(id) {
      return records.get(id) ?? null;
    },
    async update(id, patch) {
      const old = records.get(id);
      if (!old || (patch.expectedStatus && old.status !== patch.expectedStatus)) return null;
      const { expectedStatus: _expectedStatus, ...changes } = patch;
      const next = { ...old, ...changes };
      records.set(id, next);
      return next;
    },
  };
}

for (const useSteer of [false, true]) {
  test(`Redis send -> drain -> delayed readiness${useSteer ? ' with HTTP Steer' : ''} appends once`, async () => {
    const redis = owned.client(`${useSteer ? 'steer' : 'automatic'}:`);
    const messageStore = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const invocationTracker = new InvocationTracker();
    const preparation = deferred();
    const running = deferred();
    const dispatch = mock.fn(async () => ({ accepted: true, handle: {} }));
    const errors = [];
    let started = false;
    let processor;
    const queue = new InvocationQueue(new RedisQueueLedgerStore(redis), {
      resolveTargets: async (targets) => (targets.length ? targets : ['opus']),
      onAdmitted: ({ threadId }) => {
        void processor.requestDrain(threadId).catch((error) => errors.push(error));
      },
    });
    const router = {
      resolveExplicitTargets: async (targets) => targets,
      resolveConversationTargetsAtAdmission: async (targets) => (targets.length ? targets : ['opus']),
      ackCollectedCursors: async () => {},
      routeExecution: mock.fn(async function* (userId, _content, threadId, _images, targets, _mode, options) {
        await options.onLifecycleInvocationStarted({
          threadId,
          userId,
          catId: targets[0],
          invocationId: 'preparing-child',
          parentInvocationId: options.parentInvocationId,
          startedAt: Date.now(),
        });
        started = true;
        await preparation.promise;
        const release = options.onAgentClientActiveRunReady({
          catId: targets[0],
          dispatcher: {
            invocationId: 'preparing-child',
            capabilities: { append: true, steer: true },
            handle: { provider: 'openai_codex', carrier: 'codex_app_server', threadId: 'native', turnId: 'turn' },
            dispatch,
          },
        });
        try {
          await running.promise;
        } finally {
          release();
        }
        yield { type: 'done', catId: targets[0], isFinal: true, timestamp: Date.now() };
      }),
    };
    const socketManager = { broadcastAgentMessage: mock.fn(), broadcastToRoom: mock.fn(), emitToUser: mock.fn() };
    processor = new QueueProcessor({
      queue,
      invocationTracker,
      invocationRecordStore: recordStore(),
      router,
      socketManager,
      messageStore,
      log: { info: mock.fn(), warn: mock.fn(), error: (...args) => errors.push(args) },
    });
    let sequence = 0;
    async function send(authorIntentByCatId) {
      const input = canonicalTestQueueInput({
        threadId: 'thread',
        userId: 'owner',
        kind: 'conversation_input',
        ownerAuthProvenance: 'strict',
        sourceId: `source-${++sequence}`,
        content: `input-${sequence}`,
        targetCats: [],
        intent: 'execute',
        ...(authorIntentByCatId ? { authorIntentByCatId } : {}),
      });
      const result = await queue.send(
        messageStore,
        canonicalTestMessageInput({
          threadId: input.threadId,
          userId: input.userId,
          catId: null,
          from: input.from,
          content: input.content,
          mentions: [],
          timestamp: Date.now(),
          deliveryStatus: 'queued',
        }),
        input,
      );
      assert.equal(result.outcome, 'enqueued');
      return result;
    }
    const app = Fastify();
    try {
      await send();
      await waitFor(() => started);
      const guidance = await send({
        opus: {
          requested: 'continue_current',
          boundParentInvocationId: invocationTracker.getExecutionId('thread', 'opus'),
        },
      });
      await processor.requestDrain('thread');
      assert.equal(
        queue.getEntrySnapshot('thread', 'owner', guidance.entry.id).delivery.authorIntentByTarget.opus.fallbackAt,
        undefined,
      );
      if (useSteer) {
        await app.register(queueRoutes, {
          threadStore: { get: async () => ({ id: 'thread', createdBy: 'owner', participants: ['opus'] }) },
          invocationQueue: queue,
          queueProcessor: processor,
          invocationTracker,
          messageStore,
          socketManager,
          resolveCarrierCapability: () => ({
            provider: 'openai_codex',
            carrier: 'codex_app_server',
            activeInvocationGuidance: 'supported',
            deliverySemantics: 'exact_active_turn',
          }),
          isCatAvailable: () => true,
        });
        const response = await app.inject({
          method: 'POST',
          url: `/api/threads/thread/queue/${guidance.entry.id}/continue`,
          headers: { 'x-cat-cafe-user': 'owner' },
          payload: { targetCatId: 'opus' },
        });
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().effective, 'continue_current');
      }
      preparation.resolve();
      await waitFor(() => dispatch.mock.calls.length === 1);
      assert.equal(queue.getEntrySnapshot('thread', 'owner', guidance.entry.id), null);
      assert.equal(router.routeExecution.mock.calls.length, 1, 'guidance must not start another turn');
      await processor.requestDrain('thread');
      assert.equal(dispatch.mock.calls.length, 1, 'repeated drain must not append again');
      assert.deepEqual(errors, []);
    } finally {
      preparation.resolve();
      running.resolve();
      await app.close();
    }
  });
}
