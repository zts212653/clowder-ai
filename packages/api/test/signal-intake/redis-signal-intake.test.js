import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  RedisMeetingIntakeStore,
  RedisSignalRouteStore,
  RedisSourceAccessLeaseStore,
  SignalIntakeKeys,
  SourceAccessLeaseService,
  SourceResolverRegistry,
  signalSettlementKey,
} from '../../dist/domains/signal-intake/index.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from '../helpers/redis-test-helpers.js';
import { admissionHarness, publishInput, SIGNAL_TYPE } from './helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const KEY_PREFIX = 'cat-cafe-f292-signal-intake-test:';

describe('F292 Redis signal intake', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F292 Redis signal intake');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: KEY_PREFIX });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
    }
  });

  beforeEach(async (context) => {
    if (!connected) return context.skip('Redis not connected');
    await cleanupClientKeyspace(redis);
  });

  after(async () => {
    if (!connected) return;
    await cleanupClientKeyspace(redis);
    await redis.quit().catch(() => {});
  });

  it('admits concurrent redelivery once and persists every truth key without TTL', async () => {
    const intakes = new RedisMeetingIntakeStore(redis);
    const { binding, service } = await admissionHarness({ intakes });
    const [left, right] = await Promise.all([
      service.publish(binding, publishInput()),
      service.publish(binding, publishInput()),
    ]);
    assert.deepEqual(new Set([left.disposition, right.disposition]), new Set(['accepted', 'duplicate']));
    assert.equal(left.publicationId, right.publicationId);
    assert.equal((await intakes.list()).length, 1);
    assert.deepEqual(await intakes.lookupSettlement(signalSettlementKey(binding.pluginInstanceId, publishInput())), {
      canonicalDigest: (await intakes.list())[0].ingress.canonicalDigest,
      intakeId: 'intake-1',
      publicationId: left.publicationId,
    });

    const keys = await redis.keys(`${KEY_PREFIX}signal-intake:v1:*`);
    assert.equal(keys.length, 4);
    const unprefixed = keys.map((key) => key.slice(KEY_PREFIX.length));
    assert.deepEqual(await Promise.all(unprefixed.map((key) => redis.ttl(key))), [-1, -1, -1, -1]);
  });

  it('creates Host route truth atomically without expiry or later bootstrap overwrite', async () => {
    const routes = new RedisSignalRouteStore(redis);
    const route = {
      routeId: 'route-redis',
      ownerId: 'owner-1',
      pluginId: 'official.example-meeting',
      signalType: SIGNAL_TYPE,
      generation: 4,
      state: 'active',
      workflowKind: 'meeting-intake',
      initialUnresolved: ['destination'],
      updatedAt: 12_000,
    };
    assert.equal(await routes.putIfAbsent(route), true);
    assert.equal(
      await routes.putIfAbsent({
        ...route,
        routeId: 'startup-overwrite',
        ownerId: 'new-default-user',
        generation: 1,
        state: 'active',
        updatedAt: 99_000,
      }),
      false,
    );
    assert.deepEqual(await routes.get(route.pluginId, route.signalType), route);
    const keys = await redis.keys(`${KEY_PREFIX}${SignalIntakeKeys.route('*')}`);
    assert.equal(keys.length, 1);
    assert.equal(await redis.ttl(keys[0].slice(KEY_PREFIX.length)), -1);
  });

  it('claims a short-lived source grant atomically without storing the raw token', async () => {
    const admission = await admissionHarness();
    await admission.service.publish(admission.binding, publishInput());
    const calls = [];
    const resolvers = new SourceResolverRegistry();
    resolvers.register({
      adapterId: 'example',
      supports: () => true,
      resolve: async (access) => {
        calls.push(access);
        return { contentType: 'text/plain', text: 'source text' };
      },
    });
    const service = new SourceAccessLeaseService({
      intakes: admission.intakes,
      leases: new RedisSourceAccessLeaseStore(redis),
      resolvers,
      now: () => 20_000,
      ttlMs: 1_000,
      createGrant: () => 'raw-secret-grant',
    });
    const issued = await service.issue({ intakeId: 'intake-1', principalId: 'cat-sol', purpose: 'transcript' });
    const request = { ...issued, intakeId: 'intake-1', principalId: 'cat-sol', purpose: 'transcript' };
    const results = await Promise.allSettled([
      service.resolve(request, new AbortController().signal),
      service.resolve(request, new AbortController().signal),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(calls.length, 1);
    const keys = await redis.keys(`${KEY_PREFIX}signal-intake:v1:source-grant:*`);
    assert.equal(keys.length, 1);
    const raw = await redis.get(keys[0].slice(KEY_PREFIX.length));
    assert.equal(raw.includes('raw-secret-grant'), false);
    assert.ok((await redis.pttl(keys[0].slice(KEY_PREFIX.length))) > 0);
  });
});
