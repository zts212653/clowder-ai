import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

function activeRevision({
  preferenceId = 'preference:reviewer',
  revisionId = `${preferenceId}:v1`,
  commandId = `command:${revisionId}`,
  version = 1,
  supersedesRevisionId,
  reviewAfter = 20_000,
  ownerId = 'owner-1',
} = {}) {
  return {
    v: 1,
    preferenceId,
    revisionId,
    commandId,
    ownerId,
    appliesWhen: {
      intent: 'review',
      requireEligible: [
        { type: 'cat', catId: 'terra' },
        { type: 'cat', catId: 'sol' },
      ],
    },
    prefer: [{ type: 'cat', catId: 'terra' }],
    over: [{ type: 'cat', catId: 'sol' }],
    rationale: 'Prefer Terra for review while both cats are eligible.',
    evidenceRefs: [`evidence:${revisionId}`],
    version,
    validFrom: 1_000 + version,
    lifecycle: 'active',
    reviewAfter,
    ...(supersedesRevisionId ? { supersedesRevisionId } : {}),
  };
}

function retiredRevision({
  preferenceId = 'preference:reviewer',
  revisionId = `${preferenceId}:v2`,
  commandId = `command:${revisionId}`,
  version = 2,
  supersedesRevisionId = `${preferenceId}:v1`,
  ownerId = 'owner-1',
} = {}) {
  const {
    lifecycle: _lifecycle,
    reviewAfter: _reviewAfter,
    ...base
  } = activeRevision({
    preferenceId,
    revisionId,
    commandId,
    version,
    supersedesRevisionId,
    ownerId,
  });
  return {
    ...base,
    lifecycle: 'retired',
    retiredAt: 10_000,
    retirementReason: 'The reviewer rotation changed.',
  };
}

describe('RedisRoutingPreferenceStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisRoutingPreferenceStore;
  let RoutingPreferenceKeys;
  let createRedisClient;
  let redis;
  let store;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisRoutingPreferenceStore');
    ({ RedisRoutingPreferenceStore, RoutingPreferenceKeys } = await import(
      '../dist/domains/routing-context/RedisRoutingPreferenceStore.js'
    ));
    ({ createRedisClient } = await import('@cat-cafe/shared/utils'));
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: 'f293-routing-preference-test:' });
    await redis.ping();
  });

  after(async () => {
    if (redis) {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  });

  beforeEach(async () => {
    await cleanupClientKeyspace(redis);
    store = new RedisRoutingPreferenceStore(redis);
  });

  it('creates, supersedes and rehydrates one immutable preference chain after restart', async () => {
    const first = activeRevision();
    const second = activeRevision({
      revisionId: 'preference:reviewer:v2',
      version: 2,
      supersedesRevisionId: first.revisionId,
    });
    assert.equal((await store.append(first)).outcome, 'appended');
    assert.equal((await store.append(second)).outcome, 'appended');

    const restarted = new RedisRoutingPreferenceStore(redis);
    assert.deepEqual(await restarted.getRevision('owner-1', first.revisionId), first);
    assert.deepEqual(await restarted.getByCommand('owner-1', first.commandId), first);
    assert.deepEqual(await restarted.getHead('owner-1', first.preferenceId), second);
    assert.deepEqual(await restarted.listChain('owner-1', first.preferenceId), [first, second]);
    assert.deepEqual(await restarted.listByOwner('owner-1'), [first, second]);
    assert.equal(await restarted.getByCommand('owner-1', 'command:missing'), null);
  });

  it('keeps detail, command, indexes and head at TTL=-1 without mutating review_due by time', async () => {
    const first = activeRevision({ reviewAfter: 2_000 });
    await store.append(first);
    assert.deepEqual(await store.getHead('owner-1', first.preferenceId), first);

    const keys = [
      RoutingPreferenceKeys.detail(first.ownerId, first.revisionId),
      RoutingPreferenceKeys.command(first.ownerId, first.commandId),
      RoutingPreferenceKeys.ownerTimeline(first.ownerId),
      RoutingPreferenceKeys.chainTimeline(first.ownerId, first.preferenceId),
      RoutingPreferenceKeys.head(first.ownerId, first.preferenceId),
    ];
    for (const key of keys) assert.equal(await redis.ttl(key), -1, `${key} must be durable`);
  });

  it('replays exact commands and rejects changed payload or revision-id collisions', async () => {
    const first = activeRevision();
    assert.equal((await store.append(first)).outcome, 'appended');
    assert.equal((await store.append({ ...first })).outcome, 'replayed');
    await assert.rejects(store.append({ ...first, rationale: 'changed' }), /command conflict/);
    await assert.rejects(
      store.append({ ...first, commandId: 'command:different', rationale: 'changed' }),
      /revision id conflict/,
    );
    assert.deepEqual(await store.listChain(first.ownerId, first.preferenceId), [first]);
  });

  it('allows exactly one concurrent writer to advance the same head', async () => {
    const first = activeRevision();
    await store.append(first);
    const competingStore = new RedisRoutingPreferenceStore(redis);
    const secondA = activeRevision({
      revisionId: 'preference:reviewer:v2-a',
      version: 2,
      supersedesRevisionId: first.revisionId,
    });
    const secondB = activeRevision({
      revisionId: 'preference:reviewer:v2-b',
      version: 2,
      supersedesRevisionId: first.revisionId,
    });
    const results = await Promise.allSettled([store.append(secondA), competingStore.append(secondB)]);

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.match(results.find((result) => result.status === 'rejected').reason.message, /head conflict/);
    assert.equal((await store.listChain(first.ownerId, first.preferenceId)).length, 2);
  });

  it('rejects version gaps, wrong predecessor ids and wrong-owner chains atomically', async () => {
    const first = activeRevision();
    await store.append(first);
    const invalid = [
      activeRevision({
        revisionId: 'preference:reviewer:v3',
        version: 3,
        supersedesRevisionId: first.revisionId,
      }),
      activeRevision({
        revisionId: 'preference:reviewer:v2',
        version: 2,
        supersedesRevisionId: 'preference:missing',
      }),
      activeRevision({
        revisionId: 'preference:reviewer:v2-owner-2',
        version: 2,
        supersedesRevisionId: first.revisionId,
        ownerId: 'owner-2',
      }),
    ];
    for (const revision of invalid) await assert.rejects(store.append(revision), /head conflict/);
    assert.deepEqual(await store.listChain(first.ownerId, first.preferenceId), [first]);
  });

  it('makes a retired head terminal and rejects every later append', async () => {
    const first = activeRevision();
    const retired = retiredRevision();
    await store.append(first);
    await store.append(retired);
    assert.deepEqual(await store.getHead(first.ownerId, first.preferenceId), retired);

    const attemptedRevival = activeRevision({
      revisionId: 'preference:reviewer:v3',
      version: 3,
      supersedesRevisionId: retired.revisionId,
    });
    await assert.rejects(store.append(attemptedRevival), /chain is retired/);
    assert.deepEqual(await store.listChain(first.ownerId, first.preferenceId), [first, retired]);
  });

  it('preflights poisoned index types before any partial append', async () => {
    const first = activeRevision();
    await redis.set(RoutingPreferenceKeys.ownerTimeline(first.ownerId), 'poison');
    await assert.rejects(store.append(first), /type conflict/);
    assert.equal(await store.getRevision(first.ownerId, first.revisionId), null);
    assert.equal(await redis.get(RoutingPreferenceKeys.command(first.ownerId, first.commandId)), null);
  });

  it('fails closed on malformed head detail without deleting or advancing truth', async () => {
    const first = activeRevision();
    await store.append(first);
    const detailKey = RoutingPreferenceKeys.detail(first.ownerId, first.revisionId);
    await redis.set(detailKey, '{not-json');

    await assert.rejects(store.getHead(first.ownerId, first.preferenceId), /malformed persisted routing preference/);
    const second = activeRevision({
      revisionId: 'preference:reviewer:v2',
      version: 2,
      supersedesRevisionId: first.revisionId,
    });
    await assert.rejects(store.append(second), /preference head is corrupt/);
    assert.equal(await redis.get(RoutingPreferenceKeys.head(first.ownerId, first.preferenceId)), first.revisionId);
    assert.equal(await redis.get(detailKey), '{not-json');
  });
});
