import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { createTypedWaitRegistration } from '../dist/domains/ball-custody/TypedWaitRegistration.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { COMMIT_QUEUE_ROW_LUA } from '../dist/domains/cats/services/agents/invocation/queue-ledger/queue-ledger-redis-scripts.js';
import { RedisQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { resolveEventBackedRoutingExit } from '../dist/domains/cats/services/agents/routing/guards/event-backed-routing-exit.js';
import { settleLifecycleResponseInputs } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { RedisTaskStore } from '../dist/domains/cats/services/stores/redis/RedisTaskStore.js';
import { TaskKeys } from '../dist/domains/cats/services/stores/redis-keys/task-keys.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';
import { createTypedWaitCustodyFixture } from './helpers/typed-wait-custody-fixture.js';

describe('typed wait Task authority stays independent of canonical Redis Queue delivery', () => {
  const owned = ownedRedisFixture('a2a-typed-queue');

  async function harness(t) {
    const redis = owned.client(`typed-queue-${randomUUID()}:`);
    await redis.ping();
    t.after(() => redis.quit());
    const messages = new RedisMessageStore(redis);
    const taskStore = new RedisTaskStore(redis);
    const ledger = new RedisQueueLedgerStore(redis);
    const h = await createTypedWaitCustodyFixture({ messageStore: messages, taskStore });
    const queue = new InvocationQueue(ledger);
    const admitted = await queue.enqueueExistingMessageDurable(messages, h.message.id, {
      threadId: h.message.threadId,
      userId: h.message.userId,
      from: h.message.from,
      content: h.message.content,
      kind: 'message_wake',
      targetCats: ['opus'],
      intent: 'execute',
      autoExecute: true,
      sourceCategory: 'scheduled',
      ownerAuthProvenance: 'strict',
    });
    assert.equal(admitted.outcome, 'enqueued');
    assert.equal((await ledger.listAll(h.message.threadId)).length, 1);
    const identity = {
      userId: h.message.userId,
      threadId: h.message.threadId,
      catId: 'opus',
      invocationId: 'child-1',
      sources: [{ sourceMessageId: h.message.id, holdTaskId: 'hold-1' }],
    };
    const resolve = (changes = {}) => resolveEventBackedRoutingExit({ taskStore, ...identity, ...changes });
    const records = new Map();
    const parentId = `parent-${randomUUID()}`;
    const errors = [];
    let calls = 0;
    let receiver;
    let exit;
    const processor = new QueueProcessor({
      queue,
      invocationTracker: new InvocationTracker(),
      messageStore: messages,
      invocationRecordStore: {
        async create(input) {
          records.set(parentId, { ...input, id: parentId, status: 'queued' });
          return { outcome: 'created', invocationId: parentId };
        },
        async get(id) {
          return records.get(id) ?? null;
        },
        async update(id, patch) {
          const current = records.get(id);
          if (!current || (patch.expectedStatus && patch.expectedStatus !== current.status)) return null;
          const { expectedStatus: _expected, ...update } = patch;
          const next = { ...current, ...update };
          records.set(id, next);
          return next;
        },
      },
      router: {
        async resolveExplicitTargets(targets) {
          return [...targets];
        },
        async resolveConversationTargetsAtAdmission(targets) {
          return [...targets];
        },
        async ackCollectedCursors() {},
        async *routeExecution(userId, _content, threadId, _messageId, targets, _intent, options) {
          calls++;
          receiver = await options.onLifecycleInvocationStarted({
            userId,
            threadId,
            catId: targets[0],
            invocationId: 'child-1',
            parentInvocationId: options.parentInvocationId,
            startedAt: Date.now(),
          });
          assert.deepEqual(await ledger.listAll(threadId), [], 'Queue target must retire before provider execution');
          exit = await resolve();
          const terminal = await messages.commitLifecycleResponseTerminal(receiver.responseMessageId, {
            invocationId: 'child-1',
            status: 'completed',
            completedAt: Date.now(),
            content: 'Controlled provider result.',
            mentions: [],
            origin: 'stream',
          });
          assert.equal(terminal.kind, 'applied');
          await settleLifecycleResponseInputs(messages, terminal.message, receiver.responseMessageId);
          yield { type: 'done', catId: targets[0], invocationId: 'child-1', isFinal: true, timestamp: Date.now() };
        },
      },
      socketManager: { emitToUser() {}, broadcastToRoom() {}, broadcastAgentMessage() {}, broadcast() {} },
      log: {
        info() {},
        warn() {},
        debug() {},
        error(...args) {
          errors.push(args);
        },
      },
      retryDeferralMs: 60000,
    });
    // Admission is explicit; no background drain or real provider is started.
    processor.requestDrain = async () => {};

    async function deliver() {
      assert.equal((await processor.processNext(identity.threadId, identity.userId)).started, true);
      const deadline = Date.now() + 3000;
      while (!['succeeded', 'failed', 'canceled'].includes(records.get(parentId)?.status)) {
        assert.ok(Date.now() < deadline, `Queue run did not settle: ${JSON.stringify(errors)}`);
        await new Promise((done) => setTimeout(done, 1));
      }
      assert.equal(records.get(parentId).status, 'succeeded', JSON.stringify(errors));
      return { receiver, exit };
    }

    async function assertDelivered() {
      const source = await messages.getById(h.message.id);
      assert.equal(source.deliveryStatus, 'delivered');
      assert.equal(source.queueCustody, undefined);
      assert.equal(source.lifecycle.dispatchRefs.length, 1);
      assert.equal(source.lifecycle.dispatchRefs[0].statusMessageId, receiver.responseMessageId);
      assert.equal(source.lifecycle.dispatchRefs[0].phase, 'settled');
      const response = await messages.getById(receiver.responseMessageId);
      assert.equal(response.lifecycle.invocationId, 'child-1');
      assert.deepEqual(response.lifecycle.inputMessageIds, [h.message.id]);
      assert.equal(response.lifecycle.status, 'completed');
      assert.deepEqual(await ledger.listAll(h.message.threadId), []);
      assert.equal((await taskStore.get(h.task.id)).status, 'todo', 'delivery must not complete the business Task');
      const cold = new InvocationQueue(new RedisQueueLedgerStore(redis));
      assert.equal(await cold.hydrateFromLedger(new RedisMessageStore(redis)), 0);
      assert.equal(await redis.ttl(TaskKeys.detail(h.task.id)), -1);
      return { source, response };
    }
    return { ...h, redis, messages, ledger, queue, processor, resolve, deliver, assertDelivered, calls: () => calls };
  }

  async function withoutDeadline(h) {
    const { expiresAt: _deadline, ...active } = h.active;
    const receipt = createTypedWaitRegistration({
      task: h.task,
      active,
      invocationId: 'child-1',
      source: h.receipt.source,
    });
    assert.ok(
      await h.taskStore.replaceAutomationStateIfGeneration(h.task.id, {
        expectedGeneration: 1,
        automationState: { await: active },
        waitRegistration: receipt,
      }),
    );
    return { ...h, active, receipt };
  }

  test('private receipt hydrates cold; settled History prevents replay without completing the business Task', async (t) => {
    const h = await harness(t);
    const cold = new RedisTaskStore(h.redis);
    assert.deepEqual((await cold.getWaitRegistration(h.task.id)).receipt, h.receipt);
    assert.equal(JSON.stringify(await cold.get(h.task.id)).includes('typedWaitRegistration'), false);
    assert.equal((await h.deliver()).exit.kind, 'bypass');
    const before = await h.assertDelivered();
    await h.taskStore.update(h.task.id, { status: 'done' });
    assert.equal((await h.resolve()).kind, 'reject');
    assert.equal((await h.processor.processNext(h.message.threadId, h.message.userId)).started, false);
    assert.equal(h.calls(), 1);
    assert.deepEqual(await h.messages.getById(h.message.id), before.source);
    assert.deepEqual(await h.ledger.listAll(h.message.threadId), []);
  });

  test('losing CAS preserves the winning exact-child receipt; delivery does not grant the old child authority', async (t) => {
    const h = await harness(t);
    const active = { ...h.active, generation: 2, ownerFence: { kind: 'containing_task', generation: 2 } };
    const receipt = createTypedWaitRegistration({
      task: h.task,
      active,
      invocationId: 'child-2',
      source: h.receipt.source,
    });
    assert.equal(
      await h.taskStore.replaceAutomationStateIfGeneration(h.task.id, {
        expectedGeneration: 0,
        automationState: { await: active },
        waitRegistration: receipt,
      }),
      null,
    );
    assert.deepEqual((await h.taskStore.getWaitRegistration(h.task.id)).receipt, h.receipt);
    assert.ok(
      await h.taskStore.replaceAutomationStateIfGeneration(h.task.id, {
        expectedGeneration: 1,
        automationState: { await: active },
        waitRegistration: receipt,
      }),
    );
    const winner = await new RedisTaskStore(h.redis).getWaitRegistration(h.task.id);
    assert.equal(winner.receipt.invocationId, 'child-2');
    assert.equal((await h.deliver()).exit.kind, 'reject');
    await h.assertDelivered();
    assert.deepEqual(await h.taskStore.getWaitRegistration(h.task.id), winner);
  });

  test('current routing read rejects an expired receipt even when delivery and Task hash are unchanged', async (t) => {
    const h = await harness(t);
    assert.equal((await h.deliver()).exit.kind, 'bypass');
    await h.assertDelivered();
    const before = await h.redis.hgetall(TaskKeys.detail(h.task.id));
    assert.equal((await h.resolve({ now: h.active.expiresAt })).kind, 'reject');
    assert.deepEqual(await h.redis.hgetall(TaskKeys.detail(h.task.id)), before);
    await h.assertDelivered();
  });

  test('persistent wait needs no deadline and remains separate from Queue retirement', async (t) => {
    const h = await withoutDeadline(await harness(t));
    assert.equal(h.receipt.expiresAt, undefined);
    assert.equal((await h.deliver()).exit.kind, 'bypass');
    await h.assertDelivered();
  });

  test('collector-only Task updates at Queue retirement preserve the registration', async (t) => {
    const h = await harness(t);
    const evaluate = h.redis.eval.bind(h.redis);
    let injected = false;
    h.redis.eval = async (script, ...args) => {
      if (script === COMMIT_QUEUE_ROW_LUA && !injected) {
        injected = true;
        await h.taskStore.patchAutomationState(h.task.id, { ci: { checkedAt: Date.now() } });
      }
      return evaluate(script, ...args);
    };
    assert.equal((await h.deliver()).exit.kind, 'bypass');
    assert.equal(injected, true);
    await h.assertDelivered();
    assert.deepEqual((await h.taskStore.getWaitRegistration(h.task.id)).receipt, h.receipt);
  });

  test('private read failure rejects routing authority without undoing persisted delivery', async (t) => {
    const h = await harness(t);
    const read = h.taskStore.getWaitRegistration.bind(h.taskStore);
    h.taskStore.getWaitRegistration = async () => {
      throw new Error('controlled private read failure');
    };
    assert.deepEqual((await h.deliver()).exit, { kind: 'reject', reason: 'query_failed' });
    h.taskStore.getWaitRegistration = read;
    await h.assertDelivered();
  });

  for (const persistent of [false, true]) {
    for (const race of ['matched', 'expired', 'superseded', 'owner', 'missing']) {
      test(`${persistent ? 'persistent' : 'bounded'}: ${race} at native Queue retirement cannot reuse old Task authority`, async (t) => {
        let h = await harness(t);
        if (persistent) h = await withoutDeadline(h);
        assert.equal((await h.resolve()).kind, 'bypass');
        const evaluate = h.redis.eval.bind(h.redis);
        let injected = false;
        let winner;
        h.redis.eval = async (script, ...args) => {
          if (script === COMMIT_QUEUE_ROW_LUA && !injected) {
            injected = true;
            if (race === 'missing') h.taskStore.getWaitRegistration = async () => null;
            else if (race === 'owner') await h.redis.hset(TaskKeys.detail(h.task.id), 'ownerCatId', 'foreign-cat');
            else {
              const active =
                race === 'superseded'
                  ? { ...h.active, generation: 2, ownerFence: { kind: 'containing_task', generation: 2 } }
                  : race === 'expired'
                    ? { ...h.active, expiresAt: Date.now() - 1 }
                    : h.active;
              assert.ok(
                await h.taskStore.replaceAutomationStateIfGeneration(h.task.id, {
                  expectedGeneration: 1,
                  automationState: {
                    await: active,
                    ...(race === 'matched' ? { waitOutcome: { generation: 1, reason: 'matched' } } : {}),
                  },
                }),
              );
            }
            winner = await h.redis.hgetall(TaskKeys.detail(h.task.id));
            const source = await h.messages.getById(h.message.id);
            assert.equal(source.lifecycle.dispatchRefs.length, 1, 'dispatchRef must precede Queue retirement');
            const response = await h.messages.getById(source.lifecycle.dispatchRefs[0].statusMessageId);
            assert.equal(response.lifecycle.status, 'processing', 'durable receiver must precede Queue retirement');
          }
          return evaluate(script, ...args);
        };
        assert.equal((await h.deliver()).exit.kind, 'reject');
        assert.equal(injected, true);
        await h.assertDelivered();
        assert.deepEqual(
          await h.redis.hgetall(TaskKeys.detail(h.task.id)),
          winner,
          'delivery cannot repair or complete Task authority',
        );
      });
    }
  }
});
