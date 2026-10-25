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
  let routingSignalDecisionClosureMap;
  let createRedisClient;
  let redis;
  let store;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisRoutingSignalEventStore');
    ({ RedisRoutingSignalEventStore, RoutingSignalEventKeys } = await import(
      '../dist/domains/routing-context/RedisRoutingSignalEventStore.js'
    ));
    ({ routingSignalDecisionClosureMap } = await import(
      '../dist/domains/routing-context/preflight/RoutingSignalDecisionProjection.js'
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

  it('reuses a durable decision projection after restart and advances it from the append sequence', async () => {
    const failure = asserted('signal:projection-failure', {
      source: 'provider_error',
      state: 'unavailable',
      reasonCode: 'provider_unreachable',
    });
    const success = closeEvent('recovered', 'signal:projection-success', [], {
      source: 'dispatch_success',
      probeStartedAt: 1_500,
    });
    await store.append(failure);
    await store.append(success);

    const built = await store.readDecisionProjection('owner-1');
    assert.equal(built.revision, 2);
    assert.equal(built.assertions.length, 1);
    assert.equal(routingSignalDecisionClosureMap(built).get(failure.eventId)?.eventId, success.eventId);

    const restarted = new RedisRoutingSignalEventStore(redis);
    let fullLedgerReads = 0;
    restarted.listByOwner = async () => {
      fullLedgerReads += 1;
      throw new Error('durable projection must survive restart without a full-ledger read');
    };
    assert.deepEqual(await restarted.readDecisionProjection('owner-1'), built);

    const next = asserted('signal:projection-next', {
      observedAt: 3_000,
      validUntil: 30_000,
    });
    await restarted.append(next);
    const advanced = await restarted.readDecisionProjection('owner-1');
    assert.equal(advanced.revision, 3);
    assert.deepEqual(
      advanced.assertions.map((event) => event.eventId),
      [failure.eventId, next.eventId],
    );
    assert.equal(fullLedgerReads, 0);
  });

  it('rebuilds a late assertion against canonical success history instead of the latest frontier', async () => {
    const firstSuccess = closeEvent('recovered', 'signal:late-first-success', [], {
      source: 'dispatch_success',
      observedAt: 2_000,
      probeStartedAt: 1_500,
    });
    const laterSuccess = closeEvent('recovered', 'signal:late-later-success', [], {
      source: 'dispatch_success',
      observedAt: 10_001,
      probeStartedAt: 9_500,
    });
    await store.append(firstSuccess);
    await store.append(laterSuccess);
    await store.readDecisionProjection('owner-1');

    const lateFailure = asserted('signal:late-after-successes', {
      source: 'provider_error',
      state: 'unavailable',
      reasonCode: 'provider_unreachable',
      observedAt: 1_000,
    });
    await store.append(lateFailure);

    const restarted = new RedisRoutingSignalEventStore(redis);
    let rebuildReads = 0;
    const originalList = restarted.listByOwner.bind(restarted);
    restarted.listByOwner = async (...args) => {
      rebuildReads += 1;
      return originalList(...args);
    };
    const projection = await restarted.readDecisionProjection('owner-1');

    assert.equal(rebuildReads, 1);
    assert.equal(routingSignalDecisionClosureMap(projection).get(lateFailure.eventId)?.eventId, firstSuccess.eventId);
  });

  it('keeps every detail, command, chronology and closure key at TTL=-1', async () => {
    const signal = asserted('signal:ttl');
    const recovery = closeEvent('recovered', 'signal:ttl-recovery', [signal.eventId]);
    await store.append(signal);
    await store.append(recovery);
    await store.readDecisionProjection(signal.ownerId);

    const keys = [
      RoutingSignalEventKeys.detail(signal.ownerId, signal.eventId),
      RoutingSignalEventKeys.command(signal.ownerId, signal.commandId),
      RoutingSignalEventKeys.ownerTimeline(signal.ownerId),
      RoutingSignalEventKeys.subjectTimeline(signal.ownerId, signal.subjectRef),
      RoutingSignalEventKeys.closures(signal.ownerId),
      RoutingSignalEventKeys.ownerRevision(signal.ownerId),
      RoutingSignalEventKeys.ownerAppendSequence(signal.ownerId),
      RoutingSignalEventKeys.decisionProjection(signal.ownerId),
    ];
    for (const key of keys) assert.equal(await redis.ttl(key), -1, `${key} must be durable`);
  });

  it('rebuilds a malformed or sequence-gapped derived projection without changing source truth', async () => {
    const first = asserted('signal:projection-rebuild-1');
    await store.append(first);
    await store.readDecisionProjection('owner-1');

    await redis.set(RoutingSignalEventKeys.decisionProjection('owner-1'), '{malformed');
    const afterMalformed = await store.readDecisionProjection('owner-1');
    assert.deepEqual(
      afterMalformed.assertions.map((event) => event.eventId),
      [first.eventId],
    );

    const second = asserted('signal:projection-rebuild-2', { observedAt: 1_001 });
    await store.append(second);
    await redis.zrem(RoutingSignalEventKeys.ownerAppendSequence('owner-1'), second.eventId);
    const restarted = new RedisRoutingSignalEventStore(redis);
    let rebuildReads = 0;
    const originalList = restarted.listByOwner.bind(restarted);
    restarted.listByOwner = async (...args) => {
      rebuildReads += 1;
      return originalList(...args);
    };
    const rebuilt = await restarted.readDecisionProjection('owner-1');

    assert.equal(rebuildReads, 1);
    assert.deepEqual(
      rebuilt.assertions.map((event) => event.eventId),
      [first.eventId, second.eventId],
    );
    assert.deepEqual(await restarted.listByOwner('owner-1'), [first, second]);
  });

  it('rejects a semantically truncated projection with a stale content hash and rebuilds it', async () => {
    const failure = asserted('signal:projection-truncated-failure', {
      source: 'provider_error',
      state: 'unavailable',
    });
    const success = closeEvent('recovered', 'signal:projection-truncated-success', [], {
      source: 'dispatch_success',
      probeStartedAt: 1_500,
    });
    await store.append(failure);
    await store.append(success);
    await store.readDecisionProjection('owner-1');

    const key = RoutingSignalEventKeys.decisionProjection('owner-1');
    const truncated = JSON.parse(await redis.get(key));
    truncated.assertions = [];
    truncated.closures = [];
    await redis.set(key, JSON.stringify(truncated));

    const rebuilt = await new RedisRoutingSignalEventStore(redis).readDecisionProjection('owner-1');
    assert.deepEqual(
      rebuilt.assertions.map((event) => event.eventId),
      [failure.eventId],
    );
    assert.equal(routingSignalDecisionClosureMap(rebuilt).get(failure.eventId)?.eventId, success.eventId);
  });

  it('rebuilds the prior split-closure checkpoint shape during a rolling upgrade', async () => {
    const failure = asserted('signal:projection-prior-shape-failure', {
      source: 'provider_error',
      state: 'unavailable',
    });
    const success = closeEvent('recovered', 'signal:projection-prior-shape-success', [], {
      source: 'dispatch_success',
      probeStartedAt: 1_500,
    });
    await store.append(failure);
    await store.append(success);
    await store.readDecisionProjection('owner-1');

    const key = RoutingSignalEventKeys.decisionProjection('owner-1');
    const priorShape = JSON.parse(await redis.get(key));
    priorShape.explicitClosures = [];
    delete priorShape.closures;
    await redis.set(key, JSON.stringify(priorShape));

    const rebuilt = await new RedisRoutingSignalEventStore(redis).readDecisionProjection('owner-1');
    assert.equal(routingSignalDecisionClosureMap(rebuilt).get(failure.eventId)?.eventId, success.eventId);
    assert.equal(Array.isArray(rebuilt.closures), true);
  });

  it('self-heals wrong Redis types in disposable projection keys without blocking canonical append', async () => {
    const first = asserted('signal:derived-type-1');
    await store.append(first);
    await store.readDecisionProjection('owner-1');
    await redis.del(RoutingSignalEventKeys.ownerAppendSequence('owner-1'));
    await redis.set(RoutingSignalEventKeys.ownerAppendSequence('owner-1'), 'poison');
    await redis.del(RoutingSignalEventKeys.decisionProjection('owner-1'));
    await redis.hset(RoutingSignalEventKeys.decisionProjection('owner-1'), 'poison', 'value');

    const second = asserted('signal:derived-type-2', { observedAt: 1_001 });
    assert.equal((await store.append(second)).outcome, 'appended');
    const rebuilt = await store.readDecisionProjection('owner-1');

    assert.deepEqual(
      rebuilt.assertions.map((event) => event.eventId),
      [first.eventId, second.eventId],
    );
    assert.deepEqual(await store.listByOwner('owner-1'), [first, second]);
  });

  it('persists an atomic success window before a late failure, survives restart and replays once', async () => {
    const { routingSignalClosures } = await import('@cat-cafe/shared');
    const probe = closeEvent('recovered', 'probe:1', [], { source: 'dispatch_success', probeStartedAt: 1_500 });
    await store.append(probe);
    await store.append(asserted('late:1', { source: 'provider_error', observedAt: 1_100 }));
    const restarted = new RedisRoutingSignalEventStore(redis);
    assert.equal((await restarted.append(probe)).outcome, 'replayed');
    assert.equal(await restarted.getOwnerRevision('owner-1'), 2);
    const history = await restarted.listByOwner('owner-1');
    assert.equal(routingSignalClosures(history).get('late:1')?.eventId, 'probe:1');
    assert.equal(await redis.ttl(RoutingSignalEventKeys.detail('owner-1', 'probe:1')), -1);
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

  it('projects a legacy owner timeline without revision or append-sequence keys and then advances it', async () => {
    const legacy = asserted('signal:legacy');
    await store.append(legacy);
    await redis.del(RoutingSignalEventKeys.ownerRevision('owner-1'));
    await redis.del(RoutingSignalEventKeys.ownerAppendSequence('owner-1'));

    const restarted = new RedisRoutingSignalEventStore(redis);
    assert.equal(await restarted.getOwnerRevision('owner-1'), 0);
    assert.deepEqual(await restarted.listByOwner('owner-1'), [legacy]);
    const migrated = await restarted.readDecisionProjection('owner-1');
    assert.equal(migrated.revision, 0);
    assert.deepEqual(migrated.assertions, [legacy]);

    const next = asserted('signal:post-legacy', { observedAt: 1_001 });
    await restarted.append(next);
    assert.equal(await restarted.getOwnerRevision('owner-1'), 1);
    assert.deepEqual(await restarted.listByOwner('owner-1'), [legacy, next]);
    const advanced = await restarted.readDecisionProjection('owner-1');
    assert.equal(advanced.revision, 1);
    assert.deepEqual(advanced.assertions, [legacy, next]);
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
