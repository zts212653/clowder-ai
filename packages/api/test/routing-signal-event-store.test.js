import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

function asserted(eventId, overrides = {}) {
  return {
    v: 1,
    eventId,
    commandId: `command:${eventId}`,
    ownerId: 'owner-1',
    subjectRef: { type: 'cat', catId: 'sol' },
    reasonCode: 'quota_low',
    source: 'quota_probe',
    observedAt: 1_000,
    evidenceRef: `evidence:${eventId}`,
    eventType: 'asserted',
    state: 'scarce',
    validUntil: 20_000,
    ...overrides,
  };
}

function closeEvent(eventType, eventId, closesSignalIds, overrides = {}) {
  return {
    v: 1,
    eventId,
    commandId: `command:${eventId}`,
    ownerId: 'owner-1',
    subjectRef: { type: 'cat', catId: 'sol' },
    reasonCode: eventType === 'recovered' ? 'probe_succeeded' : 'manual_retraction',
    source: eventType === 'recovered' ? 'health_probe' : 'manual_cvo',
    observedAt: 2_000,
    evidenceRef: `evidence:${eventId}`,
    eventType,
    ...(eventType === 'recovered' ? { state: 'available' } : {}),
    closesSignalIds,
    ...overrides,
  };
}

describe('RedisRoutingSignalEventStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisRoutingSignalEventStore;
  let RoutingSignalEventKeys;
  let createRedisClient;
  let redis;
  let store;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisRoutingSignalEventStore');
    ({ RedisRoutingSignalEventStore, RoutingSignalEventKeys } = await import(
      '../dist/domains/routing-context/RedisRoutingSignalEventStore.js'
    ));
    ({ createRedisClient } = await import('@cat-cafe/shared/utils'));
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: 'f293-routing-signal-test:' });
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
    store = new RedisRoutingSignalEventStore(redis);
  });

  it('appends immutable events, lists exact owner/subject chronology, and survives a store restart', async () => {
    assert.equal(await store.getOwnerRevision('owner-1'), 0);
    const first = asserted('signal:1');
    const second = asserted('signal:2', {
      subjectRef: { type: 'provider', providerId: 'openai' },
      observedAt: 1_001,
    });
    assert.deepEqual(await store.append(first), { outcome: 'appended', event: first });
    assert.deepEqual(await store.append(second), { outcome: 'appended', event: second });

    const restarted = new RedisRoutingSignalEventStore(redis);
    assert.equal(await restarted.getOwnerRevision('owner-1'), 2);
    assert.deepEqual(await restarted.get('owner-1', 'signal:1'), first);
    assert.deepEqual(await restarted.getByCommand('owner-1', first.commandId), first);
    assert.deepEqual(await restarted.listByOwner('owner-1'), [first, second]);
    assert.deepEqual(await restarted.listBySubject('owner-1', { type: 'cat', catId: 'sol' }), [first]);
    assert.deepEqual(await restarted.listBySubject('owner-1', { type: 'provider', providerId: 'openai' }), [second]);
    assert.equal(await restarted.getByCommand('owner-1', 'command:missing'), null);
  });

  it('keeps every detail, command, chronology and closure key at TTL=-1', async () => {
    const signal = asserted('signal:ttl');
    const recovery = closeEvent('recovered', 'signal:ttl-recovery', [signal.eventId]);
    await store.append(signal);
    await store.append(recovery);

    const keys = [
      RoutingSignalEventKeys.detail(signal.ownerId, signal.eventId),
      RoutingSignalEventKeys.command(signal.ownerId, signal.commandId),
      RoutingSignalEventKeys.ownerTimeline(signal.ownerId),
      RoutingSignalEventKeys.subjectTimeline(signal.ownerId, signal.subjectRef),
      RoutingSignalEventKeys.closures(signal.ownerId),
      RoutingSignalEventKeys.ownerRevision(signal.ownerId),
    ];
    for (const key of keys) assert.equal(await redis.ttl(key), -1, `${key} must be durable`);
  });

  it('replays the exact command but rejects changed payload or event-id collisions', async () => {
    const signal = asserted('signal:replay');
    assert.equal((await store.append(signal)).outcome, 'appended');
    assert.equal(await store.getOwnerRevision('owner-1'), 1);
    assert.equal((await store.append({ ...signal })).outcome, 'replayed');
    assert.equal(await store.getOwnerRevision('owner-1'), 1);

    await assert.rejects(store.append({ ...signal, reasonCode: 'changed' }), /command conflict/);
    await assert.rejects(
      store.append({ ...signal, commandId: 'command:different', reasonCode: 'changed' }),
      /event id conflict/,
    );
    assert.equal(await store.getOwnerRevision('owner-1'), 1);
    assert.deepEqual(await store.listByOwner('owner-1'), [signal]);
  });

  it('closes every named assertion atomically or appends nothing', async () => {
    const first = asserted('signal:multi-1');
    const second = asserted('signal:multi-2');
    await store.append(first);
    await store.append(second);

    const invalid = closeEvent('recovered', 'signal:invalid-multi-close', [first.eventId, 'signal:missing']);
    await assert.rejects(store.append(invalid), /closure conflict/);
    assert.equal(await store.get('owner-1', invalid.eventId), null);
    assert.equal(await redis.hlen(RoutingSignalEventKeys.closures('owner-1')), 0);

    const valid = closeEvent('recovered', 'signal:valid-multi-close', [first.eventId, second.eventId]);
    assert.equal((await store.append(valid)).outcome, 'appended');
    assert.deepEqual(await store.listByOwner('owner-1'), [first, second, valid]);
    assert.equal(await redis.hget(RoutingSignalEventKeys.closures('owner-1'), first.eventId), valid.eventId);
    assert.equal(await redis.hget(RoutingSignalEventKeys.closures('owner-1'), second.eventId), valid.eventId);
  });

  it('allows exactly one concurrent recover/retract winner for the same assertion', async () => {
    const signal = asserted('signal:race');
    await store.append(signal);
    const competingStore = new RedisRoutingSignalEventStore(redis);
    const results = await Promise.allSettled([
      store.append(closeEvent('recovered', 'signal:race-recovered', [signal.eventId])),
      competingStore.append(closeEvent('retracted', 'signal:race-retracted', [signal.eventId])),
    ]);

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.match(results.find((result) => result.status === 'rejected').reason.message, /closure conflict/);
    assert.equal((await store.listByOwner('owner-1')).length, 2);
  });

  it('rejects cross-owner and already-closed causal ids', async () => {
    const otherOwner = asserted('signal:other-owner', { ownerId: 'owner-2' });
    await store.append(otherOwner);
    await assert.rejects(
      store.append(closeEvent('recovered', 'signal:wrong-owner-close', [otherOwner.eventId])),
      /closure conflict/,
    );

    const local = asserted('signal:already-closed');
    await store.append(local);
    await store.append(closeEvent('recovered', 'signal:first-close', [local.eventId]));
    await assert.rejects(
      store.append(closeEvent('retracted', 'signal:second-close', [local.eventId])),
      /closure conflict/,
    );
  });

  it('preflights poisoned Redis types before mutation so Lua errors cannot partially append', async () => {
    const signal = asserted('signal:poison-source');
    await store.append(signal);
    await redis.set(RoutingSignalEventKeys.closures('owner-1'), 'poison');
    const recovery = closeEvent('recovered', 'signal:poison-recovery', [signal.eventId]);

    await assert.rejects(store.append(recovery), /type conflict/);
    assert.equal(await store.get('owner-1', recovery.eventId), null);
    assert.deepEqual(await store.listByOwner('owner-1'), [signal]);
  });

  it('rejects a malformed owner revision before any event mutation', async () => {
    await redis.set(RoutingSignalEventKeys.ownerRevision('owner-1'), 'not-an-integer');
    const signal = asserted('signal:poisoned-revision');

    await assert.rejects(store.append(signal), /type conflict/);
    assert.equal(await store.get('owner-1', signal.eventId), null);
    assert.deepEqual(await store.listByOwner('owner-1'), []);
    await assert.rejects(store.getOwnerRevision('owner-1'), /malformed routing signal owner revision/);
  });

  it('treats a legacy owner timeline without a revision key as revision zero', async () => {
    const legacy = asserted('signal:legacy');
    await store.append(legacy);
    await redis.del(RoutingSignalEventKeys.ownerRevision('owner-1'));

    const restarted = new RedisRoutingSignalEventStore(redis);
    assert.equal(await restarted.getOwnerRevision('owner-1'), 0);
    assert.deepEqual(await restarted.listByOwner('owner-1'), [legacy]);

    const next = asserted('signal:post-legacy', { observedAt: 1_001 });
    await restarted.append(next);
    assert.equal(await restarted.getOwnerRevision('owner-1'), 1);
    assert.deepEqual(await restarted.listByOwner('owner-1'), [legacy, next]);
  });

  it('fails closed on malformed persisted records without deleting source truth', async () => {
    const signal = asserted('signal:malformed');
    await store.append(signal);
    const detailKey = RoutingSignalEventKeys.detail(signal.ownerId, signal.eventId);
    await redis.set(detailKey, '{not-json');

    await assert.rejects(store.get(signal.ownerId, signal.eventId), /malformed persisted routing signal/);
    await assert.rejects(store.listByOwner(signal.ownerId), /malformed persisted routing signal/);
    assert.equal(await redis.get(detailKey), '{not-json');
    assert.equal(await redis.ttl(detailKey), -1);
  });
});
