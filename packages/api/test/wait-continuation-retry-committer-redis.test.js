import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';

import { makeQueuedMessageCustody as makeCustody } from './helpers/queued-message-custody.js';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const TARGET_CAT_ID = 'codex-sol';
const USER_ID = 'user-1';
const THREAD_ID = 'thread-retry-atomic';
const TASK_ID = 'task-wait-retry-atomic';

function waitOutcome(ownerFence, overrides = {}) {
  return {
    v: 1,
    outcomeId: 'wait:pr:zts212653/cat-cafe#1:g4:matched',
    generation: 4,
    subjectRef: 'pr:zts212653/cat-cafe#1',
    ownerFence,
    reason: 'matched',
    at: 1_000,
    delivery: 'delivered',
    nextStep: 'continue exact work',
    ...overrides,
  };
}

function waitTask(ownerFence, overrides = {}) {
  return {
    id: TASK_ID,
    kind: 'pr_tracking',
    threadId: THREAD_ID,
    subjectKey: 'pr:zts212653/cat-cafe#1',
    title: 'wait',
    ownerCatId: TARGET_CAT_ID,
    status: 'done',
    why: 'test',
    createdBy: TARGET_CAT_ID,
    createdAt: 1,
    updatedAt: 2,
    userId: USER_ID,
    automationState: { waitOutcome: waitOutcome(ownerFence) },
    ...overrides,
  };
}

function failedCustody() {
  return makeCustody({
    entryId: 'entry-retry-atomic',
    allTargetCats: [TARGET_CAT_ID],
    pendingTargetCats: [TARGET_CAT_ID],
    failedByCatIds: [TARGET_CAT_ID],
    targetAttempts: [
      {
        id: `entry-retry-atomic:${TARGET_CAT_ID}:1`,
        targetCatId: TARGET_CAT_ID,
        sequence: 1,
        state: 'failed',
        createdAt: 1_000,
        updatedAt: 1_100,
        terminalReason: 'invocation_failed',
      },
    ],
    updatedAt: 1_100,
  });
}

function retryTransition(messageId, current) {
  const attempt = {
    id: `entry-retry-atomic:${TARGET_CAT_ID}:2`,
    targetCatId: TARGET_CAT_ID,
    sequence: 2,
    state: 'queued',
    createdAt: 1_200,
    updatedAt: 1_200,
  };
  return {
    messageId,
    current,
    next: {
      ...current,
      revision: current.revision + 1,
      failedByCatIds: [],
      targetAttempts: [...current.targetAttempts, attempt],
      updatedAt: 1_200,
    },
  };
}

describe('Gate 5 retry authority Redis linearization', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let messageStore;
  let taskStore;
  let leaseStore;
  let WaitContinuationRetryCommitter;
  let MessageKeys;
  let TaskKeys;
  let serializeTask;
  let canonicalizeActionTerminalPredicate;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'Gate 5 retry authority Redis linearization');
    const [
      { createRedisClient },
      messageStoreModule,
      taskStoreModule,
      messageKeysModule,
      taskKeysModule,
      taskCodecModule,
      leaseStoreModule,
      committerModule,
      predicateModule,
    ] = await Promise.all([
      import('@cat-cafe/shared/utils'),
      import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js'),
      import('../dist/domains/cats/services/stores/redis/RedisTaskStore.js'),
      import('../dist/domains/cats/services/stores/redis-keys/message-keys.js'),
      import('../dist/domains/cats/services/stores/redis-keys/task-keys.js'),
      import('../dist/domains/cats/services/stores/redis/RedisTaskCodec.js'),
      import('../dist/domains/ball-custody/RedisActionSuccessorLeaseStore.js'),
      import('../dist/domains/ball-custody/WaitContinuationRetryCommitter.js'),
      import('../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js'),
    ]);
    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
      messageStore = new messageStoreModule.RedisMessageStore(redis);
      taskStore = new taskStoreModule.RedisTaskStore(redis);
      leaseStore = new leaseStoreModule.RedisActionSuccessorLeaseStore(redis);
      WaitContinuationRetryCommitter = committerModule.WaitContinuationRetryCommitter;
      MessageKeys = messageKeysModule.MessageKeys;
      TaskKeys = taskKeysModule.TaskKeys;
      serializeTask = taskCodecModule.serializeTask;
      canonicalizeActionTerminalPredicate = predicateModule.canonicalizeActionTerminalPredicate;
    } catch {
      await redis.quit().catch(() => {});
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['msg:*', 'task:*', 'tasks:*', 'action:successor:*']);
  });

  after(async () => {
    if (!connected) return;
    await cleanupPrefixedRedisKeys(redis, ['msg:*', 'task:*', 'tasks:*', 'action:successor:*']);
    await redis.quit();
  });

  async function seedMessageAndTask(ownerFence) {
    const current = failedCustody();
    const message = await messageStore.append({
      userId: USER_ID,
      catId: 'system',
      content: 'retry this exact wait continuation',
      mentions: [TARGET_CAT_ID],
      timestamp: 1_100,
      threadId: THREAD_ID,
      deliveryStatus: 'queued',
      source: {
        connector: 'github-wait',
        label: 'GitHub wait',
        icon: 'github',
        meta: {
          waitContinuationCarrier: {
            v: 1,
            waitId: TASK_ID,
            outcomeId: 'wait:pr:zts212653/cat-cafe#1:g4:matched',
            ownerFence,
          },
        },
      },
      queueCustody: current,
    });
    await redis.hset(TaskKeys.detail(TASK_ID), serializeTask(waitTask(ownerFence)));
    return { current, message, transition: retryTransition(message.id, current) };
  }

  async function commit(fixture, beforeAtomicCommit) {
    const committer = new WaitContinuationRetryCommitter({
      messageStore,
      taskStore,
      actionSuccessorLeaseStore: leaseStore,
      redis,
      beforeAtomicCommit,
    });
    return committer.commit({
      authorityMessageId: fixture.message.id,
      requestingUserId: USER_ID,
      targetCatId: TARGET_CAT_ID,
      transitions: [fixture.transition],
    });
  }

  async function assertAttemptWasNotMinted(fixture) {
    const stored = await messageStore.getById(fixture.message.id);
    assert.equal(stored.queueCustody.revision, fixture.current.revision);
    assert.deepEqual(
      stored.queueCustody.targetAttempts.map(({ id, state }) => ({ id, state })),
      [{ id: `entry-retry-atomic:${TARGET_CAT_ID}:1`, state: 'failed' }],
    );
  }

  test('atomically verifies the containing-task witness and appends attempt 2', async () => {
    const ownerFence = { kind: 'containing_task', generation: 4 };
    const fixture = await seedMessageAndTask(ownerFence);

    assert.deepEqual(await commit(fixture), { outcome: 'committed' });
    const stored = await messageStore.getById(fixture.message.id);
    assert.equal(stored.queueCustody.revision, 2);
    assert.deepEqual(
      stored.queueCustody.targetAttempts.map(({ id, state }) => ({ id, state })),
      [
        { id: `entry-retry-atomic:${TARGET_CAT_ID}:1`, state: 'failed' },
        { id: `entry-retry-atomic:${TARGET_CAT_ID}:2`, state: 'queued' },
      ],
    );
  });

  test('preserves authenticated user retry without inventing a Task witness', async () => {
    const current = failedCustody();
    const message = await messageStore.append({
      userId: USER_ID,
      catId: null,
      content: 'retry my authored queued message',
      mentions: [TARGET_CAT_ID],
      timestamp: 1_100,
      threadId: THREAD_ID,
      deliveryStatus: 'queued',
      queueCustody: current,
    });
    const fixture = { current, message, transition: retryTransition(message.id, current) };

    assert.deepEqual(await commit(fixture), { outcome: 'committed' });
    const stored = await messageStore.getById(message.id);
    assert.equal(stored.queueCustody.revision, 2);
    assert.equal(stored.queueCustody.targetAttempts.at(-1).state, 'queued');
  });

  for (const [description, rawSource] of [
    ['legacy connector shape', JSON.stringify({ connector: 'github-wait' })],
    ['malformed connector JSON', '{'],
  ]) {
    test(`rejects a present-but-unparseable ${description} without minting attempt 2`, async () => {
      const current = failedCustody();
      const message = await messageStore.append({
        userId: USER_ID,
        catId: null,
        content: 'legacy persisted connector must not become user-authored retry authority',
        mentions: [TARGET_CAT_ID],
        timestamp: 1_100,
        threadId: THREAD_ID,
        deliveryStatus: 'queued',
        queueCustody: current,
      });
      await redis.hset(MessageKeys.detail(message.id), 'source', rawSource);
      const hydrated = await messageStore.getById(message.id);
      assert.equal(hydrated.source, undefined);
      const fixture = { current, message, transition: retryTransition(message.id, current) };

      assert.deepEqual(await commit(fixture), {
        outcome: 'authority_stale',
        reason: 'legacy_unattributed',
      });
      assert.equal(hydrated.sourceParseFailure, true);
      await assertAttemptWasNotMinted(fixture);
    });
  }

  test('rejects a source field that appears after user preflight even when its raw value is empty', async () => {
    const current = failedCustody();
    const message = await messageStore.append({
      userId: USER_ID,
      catId: null,
      content: 'source presence is part of the atomic user-authority witness',
      mentions: [TARGET_CAT_ID],
      timestamp: 1_100,
      threadId: THREAD_ID,
      deliveryStatus: 'queued',
      queueCustody: current,
    });
    const fixture = { current, message, transition: retryTransition(message.id, current) };

    const result = await commit(fixture, async () => {
      await redis.hset(MessageKeys.detail(message.id), 'source', '');
    });

    assert.deepEqual(result, { outcome: 'authority_stale', reason: 'authority_witness_changed' });
    await assertAttemptWasNotMinted(fixture);
  });

  test('rejects a containing-task replacement immediately before the custody Lua commit', async () => {
    const ownerFence = { kind: 'containing_task', generation: 4 };
    const fixture = await seedMessageAndTask(ownerFence);
    let revoked = false;

    const result = await commit(fixture, async () => {
      revoked = true;
      const replacementFence = { kind: 'containing_task', generation: 5 };
      await redis.hset(
        TaskKeys.detail(TASK_ID),
        serializeTask(
          waitTask(replacementFence, {
            automationState: { waitOutcome: waitOutcome(replacementFence, { generation: 5 }) },
          }),
        ),
      );
    });

    assert.equal(revoked, true);
    assert.deepEqual(result, { outcome: 'authority_stale', reason: 'authority_witness_changed' });
    await assertAttemptWasNotMinted(fixture);
  });

  test('rejects action-successor terminalization immediately before the custody Lua commit', async () => {
    const terminalPredicate = canonicalizeActionTerminalPredicate({
      actionFamily: 'review',
      subjectRef: 'pr:zts212653/cat-cafe#1',
      predicate: { kind: 'review_delivered', headSha: 'a'.repeat(40) },
    });
    const claimed = await leaseStore.claim({
      leaseId: 'lease-retry-atomic',
      tenantScope: USER_ID,
      subjectRef: 'pr:zts212653/cat-cafe#1',
      actionFamily: 'review',
      successorSlot: 'reviewer',
      mode: 'single',
      holderCatIds: [TARGET_CAT_ID],
      dispatchId: 'dispatch-retry-atomic',
      claimOrigin: 'structured_transfer',
      holderThreadId: THREAD_ID,
      predecessorCatId: 'codex-terra',
      predecessorThreadId: 'thread-reviewer',
      issuerStandingEvidenceRef: 'message:review-request',
      evidenceRefs: ['message:review-request'],
      terminalPredicate,
      now: 900,
    });
    assert.equal(claimed.outcome, 'claimed');
    const ownerFence = {
      kind: 'action_successor',
      leaseId: claimed.lease.leaseId,
      generation: claimed.lease.generation,
    };
    const fixture = await seedMessageAndTask(ownerFence);
    let terminalized = false;

    const result = await commit(fixture, async () => {
      terminalized = true;
      const committed = await leaseStore.commitOutcome(claimed.lease.leaseId, {
        generation: claimed.lease.generation,
        catId: TARGET_CAT_ID,
        outcome: 'failed',
        evidenceRef: 'invocation:failed-before-custody-cas',
        now: 1_150,
      });
      assert.equal(committed.outcome, 'recorded');
    });

    assert.equal(terminalized, true);
    assert.deepEqual(result, { outcome: 'authority_stale', reason: 'authority_witness_changed' });
    await assertAttemptWasNotMinted(fixture);
  });
});
