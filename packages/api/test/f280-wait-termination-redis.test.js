import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { buildHumanDispositionLedgerReceipt } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { RedisWaitTerminationStore } from '../dist/domains/ball-custody/RedisWaitTerminationStore.js';
import { WaitTerminationService } from '../dist/domains/ball-custody/WaitTerminationService.js';
import { WaitTerminationKeys } from '../dist/domains/ball-custody/wait-termination-keys.js';
import { HumanDispositionLedger } from '../dist/domains/human-disposition/HumanDispositionLedger.js';
import { buildWaitCancellationDispositionLedgerEntry } from '../dist/domains/human-disposition/human-disposition-adapters.js';
import { HumanDispositionKeys } from '../dist/domains/human-disposition/human-disposition-keys.js';
import { registerHumanDispositionFeedbackRoutes } from '../dist/routes/human-disposition-feedback-routes.js';
import { registerWaitTerminationRoutes } from '../dist/routes/wait-termination-routes.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const KEY_PREFIX = 'cat-cafe-f280-wait-termination-test:';

function record(feedback = { reasonCode: 'wrong' }) {
  const event = {
    v: 1,
    eventId: 'wait-termination:hold_ball:hold-ball-redis:user_cancel',
    kind: 'wait.terminated',
    waitId: 'hold-ball-redis',
    waitKind: 'hold_ball',
    generation: 1,
    subjectRef: 'wait:hold_ball:hold-ball-redis',
    threadId: 'thread-redis',
    ownerUserId: 'owner-redis',
    ownerCatId: 'codex-sol',
    reason: 'user_cancel',
    actor: { kind: 'user', userId: 'owner-redis' },
    at: 456,
  };
  return {
    event,
    entry: buildWaitCancellationDispositionLedgerEntry({ event, feedback }),
  };
}

describe('F280 RedisWaitTerminationStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let connected = false;
  let store;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F280 RedisWaitTerminationStore');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: KEY_PREFIX });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
    }
  });

  after(async () => {
    if (!connected) return;
    await cleanupClientKeyspace(redis);
    await redis.quit().catch(() => {});
  });

  beforeEach(async () => {
    if (!connected) return;
    await cleanupClientKeyspace(redis);
    store = new RedisWaitTerminationStore(redis);
  });

  test('atomically persists F280 event, producer entry, and content-free F281 receipt without TTL', async () => {
    const canonical = record({ reasonCode: 'other', detail: 'private cancel reason' });
    assert.equal(await store.commit(canonical), 'applied');
    assert.deepEqual(await store.getByWaitId(canonical.event.waitId), canonical);

    const receipt = buildHumanDispositionLedgerReceipt(canonical.entry);
    assert.deepEqual(await store.loadEntry({ ownerUserId: 'owner-redis', receipt }), canonical.entry);
    const ledger = new HumanDispositionLedger(redis, store);
    assert.deepEqual(await ledger.get('owner-redis', canonical.event.eventId), canonical.entry);
    const keys = [
      WaitTerminationKeys.records(),
      WaitTerminationKeys.sources(),
      HumanDispositionKeys.receipts('owner-redis'),
      HumanDispositionKeys.episodes('owner-redis'),
      HumanDispositionKeys.subject('owner-redis', canonical.event.subjectRef),
    ];
    assert.deepEqual(await Promise.all(keys.map((key) => redis.ttl(key))), [-1, -1, -1, -1, -1]);
    const receipts = await redis.hgetall(HumanDispositionKeys.receipts('owner-redis'));
    assert.equal(JSON.stringify(receipts).includes('private cancel reason'), false);
  });

  test('replays exact input and rejects changed feedback without mutating canonical truth', async () => {
    const canonical = record({ reasonCode: 'wrong' });
    assert.equal(await store.commit(canonical), 'applied');
    assert.equal(await store.commit(canonical), 'replay');
    assert.equal(await store.commit(record({ reasonCode: 'not_now' })), 'conflict');
    assert.deepEqual(await store.getByWaitId(canonical.event.waitId), canonical);
  });

  test('does not hydrate another owner from a source receipt', async () => {
    const canonical = record();
    await store.commit(canonical);
    const receipt = buildHumanDispositionLedgerReceipt(canonical.entry);
    assert.equal(await store.loadEntry({ ownerUserId: 'intruder', receipt }), null);
  });

  test('fails atomically on a poisoned key type', async () => {
    const canonical = record();
    await redis.set(WaitTerminationKeys.sources(), 'poison');

    await assert.rejects(store.commit(canonical), /TYPE_CONFLICT/);
    assert.equal(await redis.hlen(WaitTerminationKeys.records()), 0);
    assert.equal(await redis.hlen(HumanDispositionKeys.receipts('owner-redis')), 0);
  });

  test('dogfoods owner cancel through HTTP and reads the hydrated why through the F281 query', async () => {
    const tasks = new Map([
      [
        'hold-ball-dogfood',
        {
          id: 'hold-ball-dogfood',
          templateId: 'reminder',
          trigger: { type: 'once', fireAt: Date.now() + 60_000 },
          params: { targetCatId: 'codex-sol' },
          display: { label: 'wait', category: 'system', description: 'wait' },
          deliveryThreadId: 'thread-dogfood',
          enabled: true,
          createdBy: 'hold-ball:codex-sol',
          createdAt: new Date().toISOString(),
        },
      ],
    ]);
    const service = new WaitTerminationService({
      store,
      dynamicTaskStore: {
        getById: (id) => tasks.get(id) ?? null,
        remove: (id) => tasks.delete(id),
      },
      taskRunner: {
        reserveOnceCancellation: () => ({ outcome: 'reserved', token: 1 }),
        releaseOnceCancellation: () => true,
        unregister() {},
      },
      managedWakeCancellation: {
        reserve: () => ({ outcome: 'not_found' }),
        commit: () => false,
        release: () => false,
        cancelIfTaskMatches: () => false,
      },
      threadStore: { get: () => ({ createdBy: 'owner-redis' }) },
      now: () => 789,
    });
    const app = Fastify();
    registerWaitTerminationRoutes(app, { service });
    registerHumanDispositionFeedbackRoutes(app, {
      ledger: new HumanDispositionLedger(redis, store),
    });

    const cancelled = await app.inject({
      method: 'POST',
      url: '/api/waits/hold-ball/hold-ball-dogfood/cancel',
      headers: { 'x-cat-cafe-user': 'owner-redis' },
      payload: { feedback: { reasonCode: 'bad_evidence' } },
    });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().event.reason, 'user_cancel');
    assert.equal(Object.hasOwn(cancelled.json().event, 'feedback'), false);

    const episodes = await app.inject({
      method: 'GET',
      url: '/api/human-disposition-feedback/episodes?interactionKind=wait_cancel&subjectRef=wait%3Ahold_ball%3Ahold-ball-dogfood',
      headers: { 'x-cat-cafe-user': 'owner-redis' },
    });
    assert.equal(episodes.statusCode, 200);
    assert.deepEqual(episodes.json().entries[0].envelope.feedback, { reasonCode: 'bad_evidence' });
    assert.equal(tasks.has('hold-ball-dogfood'), false);
  });
});
