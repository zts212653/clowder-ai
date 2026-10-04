import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import {
  createInitialQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { resolveRestartTargets } from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyRestartTargets.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

async function fixture(explicit = true, detached = false, status = 'succeeded') {
  const messages = new MessageStore();
  const queue = new InvocationQueue();
  const executions = new InMemoryTurnExecutionStore();
  const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: messages });
  const scope = {
    threadId: 'live-thread',
    userId: 'owner',
    catId: 'codex',
    invocationId: 'live-child',
    parentInvocationId: 'live-parent',
  };
  const input = {
    ...scope,
    executionKind: 'ordinary',
    startedAt: 1,
    ...(explicit ? { queueCompletionPolicy: 'explicit_source' } : {}),
  };
  executions.createRunning(input);
  const source = messages.append({
    userId: scope.userId,
    threadId: scope.threadId,
    catId: 'opus',
    content: 'Please inspect this exact request',
    mentions: ['codex'],
    timestamp: 2,
    deliveryStatus: 'queued',
  });
  const admitted = queue.enqueue({
    threadId: scope.threadId,
    userId: scope.userId,
    content: source.content,
    messageId: source.id,
    source: 'agent',
    targetCats: ['codex'],
    intent: 'execute',
    ownerAuthProvenance: 'strict',
  });
  assert.equal(admitted.outcome, 'enqueued');
  const entry = admitted.entry;
  messages.initializeQueueCustody(source.id, createInitialQueuedMessageCustody(entry));
  queue.markQueuedSeen(scope.threadId, scope.userId, entry.id, scope.catId, scope.invocationId, Date.now());
  await coordinator.persistEntry(queue.getEntrySnapshot(scope.threadId, scope.userId, entry.id));
  if (detached)
    assert.equal(
      queue.removeEntrySnapshotIfUnchanged(queue.getEntrySnapshot(scope.threadId, scope.userId, entry.id)),
      true,
    );
  executions.transitionTerminal(scope.invocationId, {
    status,
    endedAt: Date.now(),
    ...(status === 'succeeded' ? {} : { terminalReason: status }),
  });
  const processor = new QueueProcessor({
    queue,
    invocationTracker: new InvocationTracker(),
    messageStore: messages,
    queueCustodyCoordinator: coordinator,
    turnExecutionStore: executions,
    socketManager: { emitToUser() {}, broadcastAgentMessage() {}, broadcastToRoom() {} },
    log: { info() {}, warn() {}, error() {} },
    router: {
      routeExecution() {
        assert.fail('No replacement execution may start during receipt settlement');
      },
      async ackCollectedCursors() {},
    },
  });
  return { ...scope, input, messages, queue, executions, coordinator, processor, source, entry };
}

for (const detached of [false, true]) {
  test(`Live clean stop keeps read-but-undispositioned ${detached ? 'detached' : 'queued'} source unhandled`, async () => {
    const h = await fixture(true, detached);
    await h.processor.onInvocationComplete(
      h.threadId,
      h.catId,
      'succeeded',
      h.parentInvocationId,
      [h.catId],
      false,
      { [h.catId]: h.invocationId },
      [],
      {},
      true,
    );
    const custody = h.messages.getById(h.source.id).queueCustody;
    assert.deepEqual(custody.handledByCatIds, [], 'voice session success is not a dispatch completion');
    assert.ok(custody.pendingTargetCats.includes(h.catId));
    assert.equal(custody.bodyExposures.length, 1);
    if (!detached) assert.ok(h.queue.getEntrySnapshot(h.threadId, h.userId, h.entry.id));
  });
}

test('restart cannot use a succeeded Live child as source completion, while ordinary child success still settles', async () => {
  for (const explicit of [true, false]) {
    const h = await fixture(explicit);
    const source = h.messages.getById(h.source.id);
    const next = await resolveRestartTargets(
      source,
      source.queueCustody,
      h.messages,
      { get: () => null },
      h.executions,
      new Set(),
      Date.now(),
    );
    assert.equal(next.handled.has(h.catId), !explicit);
    assert.equal(next.pending.has(h.catId), explicit);
    assert.equal(next.failed.has(h.catId), explicit);
  }
});

test('Live completion policy is durable immutable child identity, including after coverage binding and terminal transition', async () => {
  const h = await fixture();
  assert.equal(h.executions.get(h.invocationId).queueCompletionPolicy, 'explicit_source');
  h.executions.bindCoveredMessageIds(h.invocationId, [h.source.id]);
  assert.equal(h.executions.get(h.invocationId).queueCompletionPolicy, 'explicit_source');
  const { queueCompletionPolicy: _policy, ...ordinary } = h.input;
  assert.equal(h.executions.createRunning(ordinary).outcome, 'conflict');
});

test('ordinary runtime success still settles its exact exposed Queue source', async () => {
  const h = await fixture(false);
  await h.processor.onInvocationComplete(
    h.threadId,
    h.catId,
    'succeeded',
    h.parentInvocationId,
    [h.catId],
    false,
    { [h.catId]: h.invocationId },
    [],
    {},
    true,
  );
  assert.deepEqual(h.messages.getById(h.source.id).queueCustody.handledByCatIds, [h.catId]);
});

for (const status of ['failed', 'canceled']) {
  test(`Live ${status} keeps the source recoverable without a completion receipt`, async () => {
    const h = await fixture(true, false, status);
    await h.processor.onInvocationComplete(
      h.threadId,
      h.catId,
      status,
      h.parentInvocationId,
      [h.catId],
      false,
      { [h.catId]: h.invocationId },
      [],
      {},
      true,
    );
    const custody = h.messages.getById(h.source.id).queueCustody;
    assert.deepEqual(custody.handledByCatIds, []);
    assert.ok(custody.pendingTargetCats.includes(h.catId));
    assert.ok(custody.failedByCatIds.includes(h.catId));
    assert.ok(h.queue.getEntrySnapshot(h.threadId, h.userId, h.entry.id));
  });
}

test('a Live reply to the source cannot substitute for explicit dispatch disposition at runtime or restart', async () => {
  for (const detached of [false, true]) {
    const h = await fixture(true, detached);
    h.messages.append({
      userId: h.userId,
      threadId: h.threadId,
      catId: h.catId,
      content: 'I have read it; still checking.',
      mentions: [],
      timestamp: Date.now(),
      replyTo: h.source.id,
      extra: { stream: { invocationId: h.invocationId, turnInvocationId: h.invocationId } },
    });
    const source = h.messages.getById(h.source.id);
    const projection = await resolveRestartTargets(
      source,
      source.queueCustody,
      h.messages,
      { get: () => null },
      h.executions,
      new Set(),
      Date.now(),
    );
    assert.equal(projection.handled.has(h.catId), false);
    await h.processor.onInvocationComplete(
      h.threadId,
      h.catId,
      'succeeded',
      h.parentInvocationId,
      [h.catId],
      false,
      { [h.catId]: h.invocationId },
      [],
      {},
      true,
    );
    assert.deepEqual(h.messages.getById(h.source.id).queueCustody.handledByCatIds, []);
  }
});

test(
  'Redis restart preserves the Live completion policy and rejects downgrading the same child',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'F317 Live completion policy');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    const { RedisTurnExecutionStore } = await import(
      '../dist/domains/cats/services/stores/redis/RedisTurnExecutionStore.js'
    );
    const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `f317-policy:${randomUUID()}:` });
    const h = await fixture();
    try {
      const store = new RedisTurnExecutionStore(redis);
      await store.createRunning(h.input);
      await store.bindCoveredMessageIds(h.invocationId, [h.source.id]);
      await store.transitionTerminal(h.invocationId, { status: 'succeeded', endedAt: Date.now() });
      const restarted = new RedisTurnExecutionStore(redis);
      assert.equal((await restarted.get(h.invocationId)).queueCompletionPolicy, 'explicit_source');
      assert.equal(await redis.ttl(`turnexec:record:${h.invocationId}`), -1);
      const { queueCompletionPolicy: _policy, ...ordinary } = h.input;
      assert.equal((await restarted.createRunning(ordinary)).outcome, 'conflict');
      const source = h.messages.getById(h.source.id);
      const projection = await resolveRestartTargets(
        source,
        source.queueCustody,
        h.messages,
        { get: () => null },
        restarted,
        new Set(),
        Date.now(),
      );
      assert.equal(projection.handled.has(h.catId), false);
      assert.equal(projection.pending.has(h.catId), true);
    } finally {
      await redis.del(
        `turnexec:record:${h.invocationId}`,
        `turnexec:parent:${h.parentInvocationId}`,
        'turnexec:running',
      );
      await redis.quit();
    }
  },
);
