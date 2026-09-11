import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('RFC #1356 Redis Queue ledger', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let store;
  let messageStore;
  let InvocationQueue;
  let queueEntryId;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RFC #1356 Redis Queue ledger');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    const module = await import(
      '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js'
    );
    ({ queueEntryId } = await import('../dist/domains/cats/services/agents/invocation/queue-ledger/QueueLedger.js'));
    ({ InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js'));
    const { RedisMessageStore } = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
    redis = createRedisClient({ url: REDIS_URL });
    await redis.ping();
    store = new module.RedisQueueLedgerStore(redis);
    messageStore = new RedisMessageStore(redis);
  });

  after(async () => {
    if (!redis) return;
    await cleanupPrefixedRedisKeys(redis, ['queue:*', 'msg:*']);
    await redis.quit();
  });

  beforeEach(async () => {
    await cleanupPrefixedRedisKeys(redis, ['queue:*', 'msg:*']);
  });

  function row(sourceRecordId, targets, overrides = {}) {
    return {
      version: 2,
      id: queueEntryId(sourceRecordId),
      threadId: 'thread-redis',
      owner: { kind: 'user', userId: 'owner-1' },
      kind: 'conversation_input',
      from: { kind: 'user', userId: 'owner-1' },
      targets,
      payload: { sourceRecordId: sourceRecordId, content: sourceRecordId, messageId: sourceRecordId },
      execution: { intent: 'execute', ownerAuthProvenance: 'strict', autoExecute: false },
      delivery: {},
      status: 'queued',
      enqueuedAt: 100,
      priority: 'normal',
      ...overrides,
    };
  }

  it('stores one source row with every pending target and rejects a conflicting replay', async () => {
    const entry = row('m1', ['opus', 'codex']);
    assert.equal((await store.enqueue([entry], 5)).outcome, 'enqueued');
    assert.equal((await store.enqueue([entry], 5)).outcome, 'replayed');
    assert.equal((await store.enqueue([{ ...entry, targets: ['opus'] }], 5)).outcome, 'conflict');
    assert.deepEqual(await store.list('thread-redis'), [entry]);
    assert.deepEqual((await store.getByMessageIds('thread-redis', ['m1', 'missing'])).get('m1'), [entry]);
  });

  it('atomically migrates v1 scalar rows without resurrecting admitted targets', async () => {
    const threadId = 'thread-legacy-v1';
    const rowsKey = `queue:{${threadId}}:entries`;
    const orderKey = `queue:{${threadId}}:order`;
    const messagesKey = `queue:{${threadId}}:messages`;
    const sourceId = 'legacy-source';
    const legacy = (id, targetCatId, status, authorIntent) => ({
      version: 1,
      id,
      threadId,
      owner: { kind: 'user', userId: 'owner-1' },
      kind: 'conversation_input',
      from: { kind: 'user', userId: 'owner-1' },
      target: { kind: 'cat', catId: targetCatId },
      payload: { sourceId, content: 'legacy body', messageId: sourceId },
      execution: { intent: 'execute', ownerAuthProvenance: 'strict', autoExecute: false },
      delivery: authorIntent ? { authorIntent } : {},
      status,
      enqueuedAt: 100,
      priority: 'normal',
      ...(status === 'claimed' ? { claimId: 'crashed-claim', claimedAt: 110 } : {}),
      ...(status === 'processing' ? { processingStartedAt: 120 } : {}),
      ...(status === 'terminal' ? { terminalAt: 130 } : {}),
    });
    const oldRows = [
      legacy('legacy-opus', 'opus', 'queued', { requested: 'next_work', requestedAt: 1 }),
      legacy('legacy-codex', 'codex', 'claimed', { requested: 'continue_current', requestedAt: 2 }),
      legacy('legacy-sonnet', 'sonnet', 'processing'),
      legacy('legacy-kimi', 'kimi', 'terminal'),
    ];
    await redis.hset(
      rowsKey,
      Object.fromEntries(oldRows.map((candidate) => [candidate.id, JSON.stringify(candidate)])),
    );
    await redis.rpush(orderKey, ...oldRows.slice(0, 3).map((candidate) => candidate.id));
    await redis.hset(messagesKey, sourceId, JSON.stringify(oldRows.map((candidate) => candidate.id)));

    const [migrated] = await store.list(threadId);
    assert.equal(await redis.get(`queue:{${threadId}}:schema`), '2');
    assert.equal(migrated.version, 2);
    assert.equal(migrated.id, queueEntryId(sourceId));
    assert.equal(migrated.payload.sourceRecordId, sourceId);
    assert.equal(Object.hasOwn(migrated.payload, 'sourceId'), false);
    assert.equal(migrated.status, 'queued', 'a crashed short claim is restored as pending');
    assert.deepEqual(migrated.targets, ['opus', 'codex']);
    assert.deepEqual(migrated.delivery.authorIntentByTarget, {
      opus: { requested: 'next_work', requestedAt: 1 },
      codex: { requested: 'continue_current', requestedAt: 2 },
    });
    assert.deepEqual(await redis.lrange(orderKey, 0, -1), [migrated.id]);
    assert.deepEqual(JSON.parse(await redis.hget(messagesKey, sourceId)), [migrated.id]);
    assert.equal(await redis.hlen(rowsKey), 1, 'processing and terminal v1 rows are not requeued');
  });

  it('claims one exact target and restores the original row and order', async () => {
    const first = row('m1', ['opus', 'codex']);
    const second = row('m2', ['opus'], { enqueuedAt: 101 });
    await store.enqueue([first]);
    await store.enqueue([second]);
    const claimed = await store.claim('thread-redis', first.id, 'claim-1', 200, 'codex');
    assert.equal(claimed.outcome, 'claimed');
    assert.deepEqual(claimed.entries[0].claimedTargetIds, ['codex']);
    assert.equal((await store.restore('thread-redis', first.id, 'stale')).outcome, 'state_changed');
    assert.equal((await store.restore('thread-redis', first.id, 'claim-1')).outcome, 'updated');
    assert.deepEqual(
      (await store.list('thread-redis')).map((entry) => [entry.id, entry.targets]),
      [
        [first.id, ['opus', 'codex']],
        [second.id, ['opus']],
      ],
    );
  });

  it('binds and restores a targetless row inside the same atomic claim', async () => {
    const targetless = row('m1', []);
    await store.enqueue([targetless]);
    const claimed = await store.claim('thread-redis', targetless.id, 'claim-targetless', 200, 'codex', 199);
    assert.equal(claimed.outcome, 'claimed');
    assert.deepEqual(claimed.entries[0].targets, ['codex']);
    assert.deepEqual(claimed.entries[0].claimedTargetIds, ['codex']);
    assert.equal(claimed.entries[0].delivery.steerRequestedAt, 199);
    const restored = await store.restore('thread-redis', targetless.id, 'claim-targetless');
    assert.equal(restored.outcome, 'updated');
    assert.deepEqual(restored.entry.targets, []);
    assert.equal(restored.entry.delivery.steerRequestedAt, undefined);
  });

  it('claims a prefix all-or-nothing without inventing terminal tombstones', async () => {
    const first = row('m1', ['opus']);
    const second = row('m2', ['opus'], { enqueuedAt: 101 });
    await store.enqueue([first]);
    await store.enqueue([second]);
    const claimed = await store.claimPrefix('thread-redis', [first.id, second.id], 'batch-1', 200, undefined, 199);
    assert.equal(claimed.outcome, 'claimed');
    assert.ok(claimed.entries.every((entry) => entry.delivery.steerRequestedAt === 199));
    assert.equal((await store.commit('thread-redis', first.id, 'batch-1', 'processing', 201)).outcome, 'updated');
    assert.equal(await store.get('thread-redis', first.id), null);
    assert.equal((await store.commit('thread-redis', first.id, '', 'terminal', 300)).outcome, 'not_found');
    assert.deepEqual(
      (await store.listAll('thread-redis')).map((entry) => [entry.id, entry.status]),
      [[second.id, 'claimed']],
    );
  });

  it('removes only the committed target and deletes the row after the final target', async () => {
    const entry = row('m-partial', ['opus', 'codex'], {
      delivery: {
        authorIntentByTarget: {
          opus: { requested: 'continue_current', requestedAt: 1 },
          codex: { requested: 'next_work', requestedAt: 1 },
        },
      },
    });
    await store.enqueue([entry]);
    await store.claim('thread-redis', entry.id, 'claim-opus', 200, 'opus');
    const first = await store.commit('thread-redis', entry.id, 'claim-opus', 'processing', 201);
    assert.equal(first.outcome, 'updated');
    assert.deepEqual(first.entry.targets, ['opus']);
    assert.equal(first.entry.status, 'processing');
    const remaining = await store.get('thread-redis', entry.id);
    assert.deepEqual(remaining.targets, ['codex']);
    assert.deepEqual(Object.keys(remaining.delivery.authorIntentByTarget), ['codex']);

    await store.claim('thread-redis', entry.id, 'claim-codex', 202, 'codex');
    const second = await store.commit('thread-redis', entry.id, 'claim-codex', 'processing', 203);
    assert.equal(second.outcome, 'updated');
    assert.deepEqual(second.entry.targets, ['codex']);
    assert.equal(await store.get('thread-redis', entry.id), null);
    assert.deepEqual(await store.listAll('thread-redis'), []);
    assert.equal((await store.getByMessageIds('thread-redis', ['m-partial'])).has('m-partial'), false);
  });

  it('atomically reconciles only the explicit Steer target delta', async () => {
    const entry = row('m-reconcile', ['opus', 'codex', 'sonnet'], {
      delivery: {
        authorIntentByTarget: {
          opus: { requested: 'next_work', requestedAt: 1 },
          codex: { requested: 'next_work', requestedAt: 1 },
          sonnet: { requested: 'next_work', requestedAt: 1 },
        },
      },
    });
    await store.enqueue([entry]);

    const result = await store.reconcileTargets('thread-redis', entry.id, ['kimi'], ['codex'], {
      opus: { requested: 'continue_current', requestedAt: 2 },
      kimi: { requested: 'next_work', requestedAt: 2 },
    });

    assert.equal(result.outcome, 'updated');
    assert.deepEqual(result.entry.targets, ['opus', 'sonnet', 'kimi']);
    assert.deepEqual(Object.keys(result.entry.delivery.authorIntentByTarget).sort(), ['kimi', 'opus', 'sonnet']);
    assert.equal(result.entry.delivery.authorIntentByTarget.opus.requested, 'continue_current');
    assert.equal(result.entry.delivery.authorIntentByTarget.sonnet.requested, 'next_work');
    assert.deepEqual(
      (await store.list('thread-redis')).map((candidate) => candidate.id),
      [entry.id],
    );
  });

  it('atomically deletes the source row and message index after removing its final target', async () => {
    const entry = row('m-reconcile-empty', ['opus']);
    await store.enqueue([entry]);
    const result = await store.reconcileTargets('thread-redis', entry.id, [], ['opus'], {});
    assert.deepEqual(result, { outcome: 'updated', entry: null });
    assert.equal(await store.get('thread-redis', entry.id), null);
    assert.equal((await store.getByMessageIds('thread-redis', ['m-reconcile-empty'])).size, 0);
  });

  it('keeps post-admission execution evidence process-local rather than in Queue storage', async () => {
    const queue = new InvocationQueue(store);
    const entry = row('m-processing-evidence', ['opus']);
    await store.enqueue([entry]);
    await queue.hydrateFromLedger();
    assert.ok(
      await queue.markProcessingDurable('thread-redis', 'owner-1', {
        entryId: entry.id,
        targetCats: ['opus'],
      }),
    );
    assert.equal(await queue.commitClaimedProcessing('thread-redis', [entry.id], 200), true);
    assert.equal(await store.get('thread-redis', entry.id), null);

    assert.equal(
      await queue.markProcessingAwakened('thread-redis', 'owner-1', entry.id, 'opus', 'inv-processing-evidence', 210),
      true,
    );
    assert.deepEqual(
      await queue.markProcessingSeen('thread-redis', 'owner-1', entry.id, 'opus', 'inv-processing-evidence', 220),
      { changed: true, newlySeen: true },
    );
    const admitted = queue.findProcessingByCat('thread-redis', 'opus');
    assert.equal('awakenedInvocationId' in admitted.delivery, false);
    assert.equal('seenInvocationId' in admitted.delivery, false);
    assert.deepEqual(await store.listAll('thread-redis'), []);
  });

  it('retires one unread-adopted target while preserving the remaining target on the same row', async () => {
    const queue = new InvocationQueue(store);
    const admitted = await queue.appendAndEnqueueDurable(
      messageStore,
      {
        from: { kind: 'user', userId: 'owner-1' },
        userId: 'owner-1',
        content: 'shared input',
        mentions: ['opus', 'codex'],
        timestamp: 100,
        threadId: 'thread-redis',
        idempotencyKey: 'shared-input',
        deliveryStatus: 'queued',
      },
      {
        from: { kind: 'user', userId: 'owner-1' },
        threadId: 'thread-redis',
        userId: 'owner-1',
        kind: 'conversation_input',
        ownerAuthProvenance: 'strict',
        idempotencyKey: 'shared-input',
        content: 'shared input',
        targetCats: ['opus', 'codex'],
        intent: 'execute',
      },
    );
    assert.equal(admitted.outcome, 'enqueued');
    assert.equal(admitted.entries.length, 1);
    assert.deepEqual(admitted.entry.targets, ['opus', 'codex']);

    const claimed = await queue.claimExactExposureDurable(
      'thread-redis',
      'owner-1',
      admitted.entry.id,
      'opus',
      admitted.message.id,
    );
    assert.equal(claimed?.id, admitted.entry.id);
    const committed = await queue.commitClaimedAdoptionDurable(
      'thread-redis',
      'owner-1',
      admitted.entry.id,
      'opus',
      'turn-read',
      200,
    );
    assert.equal(committed?.newlySeen, true);
    assert.deepEqual((await store.get('thread-redis', admitted.entry.id)).targets, ['codex']);
    assert.deepEqual((await store.getByMessageIds('thread-redis', [admitted.message.id])).get(admitted.message.id), [
      await store.get('thread-redis', admitted.entry.id),
    ]);
  });

  it('atomically stores hidden user source + one Queue row and rejects capacity overflow without a ghost', async () => {
    const queue = new InvocationQueue(store);
    const input = (idempotencyKey) => ({
      from: { kind: 'user', userId: 'owner-1' },
      threadId: 'thread-redis',
      userId: 'owner-1',
      kind: 'conversation_input',
      ownerAuthProvenance: 'strict',
      idempotencyKey,
      content: idempotencyKey,
      targetCats: ['opus', 'codex'],
      intent: 'execute',
    });
    const message = (idempotencyKey) => ({
      from: { kind: 'user', userId: 'owner-1' },
      userId: 'owner-1',
      content: idempotencyKey,
      mentions: ['opus', 'codex'],
      timestamp: 100,
      threadId: 'thread-redis',
      idempotencyKey,
      deliveryStatus: 'queued',
    });

    for (let index = 0; index < 5; index += 1) {
      const id = `request-${index}`;
      const admitted = await queue.appendAndEnqueueDurable(messageStore, message(id), input(id));
      assert.equal(admitted.outcome, 'enqueued');
      assert.equal(admitted.entries.length, 1);
      assert.deepEqual(admitted.entry.targets, ['opus', 'codex']);
      assert.equal(admitted.message.timelinePublishedAtAppend, undefined);
    }
    assert.equal((await store.list('thread-redis')).length, 5);
    assert.deepEqual(await messageStore.getByThreadAfter('thread-redis', undefined, undefined, 'owner-1'), []);

    const replay = await queue.appendAndEnqueueDurable(messageStore, message('request-0'), input('request-0'));
    assert.equal(replay.deduped, true);
    assert.equal((await store.list('thread-redis')).length, 5);

    const rejected = await queue.appendAndEnqueueDurable(
      messageStore,
      message('over-capacity'),
      input('over-capacity'),
    );
    assert.deepEqual(rejected, { outcome: 'full' });
    assert.equal(await messageStore.getByIdempotencyKey('owner-1', 'thread-redis', 'over-capacity'), null);

    const hidden = await messageStore.getByIdempotencyKey('owner-1', 'thread-redis', 'request-0');
    const delivered = await messageStore.markDelivered(hidden.id, 500);
    assert.equal(delivered.deliveryTransitioned, true);
    assert.equal(delivered.timelineOrderAt, 500);
    assert.equal(await redis.zscore('msg:thread:thread-redis', hidden.id), '500');
  });

  it('adds Queue custody to published Agent speech without hiding the History source', async () => {
    const queue = new InvocationQueue(store);
    const source = await messageStore.append({
      from: { kind: 'agent', catId: 'opus' },
      userId: 'owner-1',
      content: '@codex inspect this result',
      mentions: ['codex'],
      timestamp: 100,
      threadId: 'thread-redis',
      idempotencyKey: 'published-agent-source',
    });

    const admitted = await queue.enqueueExistingMessageDurable(messageStore, source.id, {
      from: { kind: 'agent', catId: 'opus' },
      threadId: 'thread-redis',
      userId: 'owner-1',
      kind: 'message_wake',
      ownerAuthProvenance: 'strict',
      content: source.content,
      messageId: source.id,
      sourceId: source.id,
      sourceCategory: 'a2a',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
    });

    assert.equal(admitted.outcome, 'enqueued');
    assert.equal(admitted.message.deliveryStatus, undefined);
    assert.equal(admitted.message.lifecycle.kind, 'input');
    assert.deepEqual(admitted.message.lifecycle.dispatchRefs, []);
    assert.deepEqual(admitted.entry.targets, ['codex']);
    const stored = await messageStore.getById(source.id);
    assert.equal(stored.deliveryStatus, undefined);
    assert.equal(stored.lifecycle.kind, 'input');
    assert.deepEqual(
      (await messageStore.getByThreadAfter('thread-redis', undefined, undefined, 'owner-1')).map(
        (message) => message.id,
      ),
      [source.id],
    );
  });

  it('admits one fresh external source once and rejects the same target after History records dispatch', async () => {
    const queue = new InvocationQueue(store);
    const source = await messageStore.append({
      from: { kind: 'external', connectorId: 'github' },
      userId: 'owner-1',
      content: 'fresh connector event',
      mentions: ['opus'],
      timestamp: 100,
      threadId: 'thread-redis',
      idempotencyKey: 'fresh-external-source',
    });
    const input = {
      from: source.from,
      threadId: source.threadId,
      userId: source.userId,
      kind: 'conversation_input',
      ownerAuthProvenance: 'strict',
      content: source.content,
      messageId: source.id,
      sourceId: source.id,
      targetCats: ['opus'],
      intent: 'execute',
      autoExecute: true,
    };

    const admitted = await queue.enqueueExistingMessageDurable(messageStore, source.id, input);
    assert.equal(admitted.outcome, 'enqueued');
    assert.equal(admitted.message.deliveryStatus, 'queued');
    assert.deepEqual(admitted.message.lifecycle.dispatchRefs, []);

    const claimed = await queue.markProcessingDurable(source.threadId, source.userId, {
      entryId: admitted.entry.id,
      targetCats: ['opus'],
    });
    assert.equal(claimed.status, 'claimed');
    assert.equal(await queue.commitClaimedProcessing(source.threadId, [admitted.entry.id], 200), true);
    const dispatched = await messageStore.advanceLifecycleInputDispatch(source.id, {
      orderKey: admitted.message.lifecycle.orderKey,
      ...(admitted.message.lifecycle.producerInvocationId
        ? { producerInvocationId: admitted.message.lifecycle.producerInvocationId }
        : {}),
      targetId: 'opus',
      phase: 'dispatched',
      statusMessageId: 'external-response',
      dispatchedAt: 200,
    });
    assert.equal(dispatched.kind, 'applied');

    await assert.rejects(
      queue.enqueueExistingMessageDurable(messageStore, source.id, input),
      /cannot replay an already dispatched source target/,
    );
    assert.equal(await store.get(source.threadId, admitted.entry.id), null);
  });

  it('expands a targetless source on the same row and preserves FIFO metadata', async () => {
    const queue = new InvocationQueue(store);
    const admitted = await queue.appendAndEnqueueDurable(
      messageStore,
      {
        from: { kind: 'user', userId: 'owner-1' },
        userId: 'owner-1',
        content: 'targetless fan-out',
        mentions: [],
        timestamp: 100,
        threadId: 'thread-redis',
        idempotencyKey: 'targetless-fan-out',
        deliveryStatus: 'queued',
      },
      {
        from: { kind: 'user', userId: 'owner-1' },
        threadId: 'thread-redis',
        userId: 'owner-1',
        kind: 'conversation_input',
        ownerAuthProvenance: 'strict',
        idempotencyKey: 'targetless-fan-out',
        content: 'targetless fan-out',
        targetCats: [],
        intent: 'execute',
      },
    );
    assert.deepEqual(admitted.entry.targets, []);
    assert.equal(await queue.setPositionDurable('thread-redis', 'owner-1', admitted.entry.id, 2), true);

    const expansionInput = {
      from: { kind: 'user', userId: 'owner-1' },
      threadId: 'thread-redis',
      userId: 'owner-1',
      kind: 'conversation_input',
      ownerAuthProvenance: 'strict',
      content: 'targetless fan-out',
      messageId: admitted.message.id,
      sourceId: admitted.message.id,
      targetCats: ['codex'],
      intent: 'execute',
    };
    const expanded = await queue.mapQueuedMessageTargetsDurable(
      messageStore,
      admitted.message.id,
      admitted.entry.id,
      'opus',
      [],
      expansionInput,
    );
    assert.equal(expanded.outcome, 'expanded');
    assert.equal(expanded.entries.length, 1);
    assert.deepEqual(expanded.entries[0].targets, ['opus', 'codex']);
    assert.equal(expanded.entries[0].position, 2);
    assert.equal(expanded.entries[0].enqueuedAt, admitted.entry.enqueuedAt);

    const replay = await queue.mapQueuedMessageTargetsDurable(
      messageStore,
      admitted.message.id,
      admitted.entry.id,
      'opus',
      [],
      expansionInput,
    );
    assert.equal(replay.outcome, 'replayed');
    assert.equal((await store.list('thread-redis')).length, 1);
  });

  it('terminalizes one response bubble while Queue stores one source row with pending targets and no assigned refs', async () => {
    const queue = new InvocationQueue(store);
    const response = (
      await messageStore.appendAndObservePriorFrontier({
        from: { kind: 'agent', catId: 'opus' },
        userId: 'owner-1',
        content: '',
        mentions: [],
        timestamp: 100,
        threadId: 'thread-redis',
        lifecycle: {
          kind: 'response',
          orderKey: '0000000000100:response-atomic',
          invocationId: 'invocation-atomic',
          targetId: 'opus',
          inputEntryIds: ['entry-input'],
          inputMessageIds: ['message-input'],
          status: 'processing',
          startedAt: 100,
        },
      })
    ).message;
    const input = {
      from: { kind: 'agent', catId: 'opus' },
      threadId: 'thread-redis',
      userId: 'owner-1',
      kind: 'message_wake',
      ownerAuthProvenance: 'strict',
      content: '@codex @sonnet review',
      messageId: response.id,
      sourceId: response.id,
      sourceCategory: 'a2a',
      targetCats: ['codex', 'sonnet'],
      intent: 'execute',
      autoExecute: true,
    };
    const patch = {
      invocationId: 'invocation-atomic',
      status: 'completed',
      completedAt: 200,
      content: input.content,
      mentions: ['codex', 'sonnet'],
      origin: 'stream',
    };

    const applied = await queue.terminalizeResponseAndEnqueueDurable(messageStore, response.id, patch, input);
    assert.equal(applied.outcome, 'enqueued');
    assert.equal(applied.message.lifecycle.status, 'completed');
    assert.deepEqual(applied.message.lifecycle.dispatchRefs ?? [], []);
    assert.equal(applied.entries.length, 1);
    assert.deepEqual(applied.entry.targets, ['codex', 'sonnet']);

    const replay = await queue.terminalizeResponseAndEnqueueDurable(messageStore, response.id, patch, input);
    assert.equal(replay.deduped, true);
    assert.equal((await store.list('thread-redis')).length, 1);

    assert.ok(await queue.terminalizeEntryDurable('thread-redis', 'owner-1', applied.entry.id));
    assert.equal(
      (
        await messageStore.advanceLifecycleInputDispatch(response.id, {
          orderKey: applied.message.lifecycle.orderKey,
          producerInvocationId: applied.message.lifecycle.producerInvocationId,
          targetId: 'codex',
          phase: 'dispatched',
          statusMessageId: 'response-codex',
          dispatchedAt: 210,
        })
      ).kind,
      'applied',
    );
    const afterDispatchReplay = await queue.terminalizeResponseAndEnqueueDurable(
      messageStore,
      response.id,
      patch,
      input,
    );
    assert.equal(afterDispatchReplay.deduped, false);
    assert.deepEqual(afterDispatchReplay.entry.targets, ['sonnet']);
    assert.deepEqual(
      (await store.list('thread-redis')).map((entry) => entry.targets),
      [['sonnet']],
    );
  });

  it('leaves a processing response unchanged when its one outbound Queue identity conflicts', async () => {
    const queue = new InvocationQueue(store);
    const response = await messageStore.append({
      from: { kind: 'agent', catId: 'opus' },
      userId: 'owner-1',
      content: '',
      mentions: [],
      timestamp: 100,
      threadId: 'thread-redis',
      lifecycle: {
        kind: 'response',
        orderKey: '0000000000100:response-conflict',
        invocationId: 'invocation-conflict',
        targetId: 'opus',
        inputEntryIds: ['entry-input'],
        inputMessageIds: ['message-input'],
        status: 'processing',
        startedAt: 100,
      },
    });
    const conflicting = row(response.id, ['codex'], { priority: 'urgent' });
    await store.enqueue([conflicting]);

    await assert.rejects(
      queue.terminalizeResponseAndEnqueueDurable(
        messageStore,
        response.id,
        {
          invocationId: 'invocation-conflict',
          status: 'completed',
          completedAt: 200,
          content: '@codex review',
          mentions: ['codex'],
        },
        {
          from: { kind: 'agent', catId: 'opus' },
          threadId: 'thread-redis',
          userId: 'owner-1',
          kind: 'message_wake',
          ownerAuthProvenance: 'strict',
          content: '@codex review',
          messageId: response.id,
          targetCats: ['codex'],
          intent: 'execute',
          autoExecute: true,
          sourceCategory: 'a2a',
        },
      ),
      /Queue admission conflict/,
    );
    assert.equal((await messageStore.getById(response.id)).lifecycle.status, 'processing');
    assert.deepEqual(await store.get('thread-redis', conflicting.id), conflicting);
  });
});
