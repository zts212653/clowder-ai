import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

function preference(version, supersedesRevisionId) {
  return {
    v: 1,
    preferenceId: 'preference:reviewer',
    revisionId: `preference:reviewer:v${version}`,
    commandId: `command:preference:reviewer:v${version}`,
    ownerId: 'owner-1',
    appliesWhen: { intent: 'review' },
    prefer: [{ type: 'cat', catId: 'sol' }],
    over: [{ type: 'cat', catId: 'terra' }],
    rationale: `Reviewer preference v${version}.`,
    evidenceRefs: [`evidence:reviewer:v${version}`],
    version,
    ...(supersedesRevisionId ? { supersedesRevisionId } : {}),
    validFrom: 1_000 + version,
    lifecycle: 'active',
  };
}

describe('routing preflight process-hot decision state', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisRoutingPreferenceStore;
  let RedisRoutingSignalEventStore;
  let RoutingContextResolver;
  let RoutingPreflightService;
  let createRedisClient;
  let redis;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'routing preflight process-hot decision state');
    ({ RedisRoutingPreferenceStore } = await import('../dist/domains/routing-context/RedisRoutingPreferenceStore.js'));
    ({ RedisRoutingSignalEventStore } = await import(
      '../dist/domains/routing-context/RedisRoutingSignalEventStore.js'
    ));
    ({ RoutingContextResolver } = await import('../dist/domains/routing-context/RoutingContextResolver.js'));
    ({ RoutingPreflightService } = await import('../dist/domains/routing-context/RoutingPreflightService.js'));
    ({ createRedisClient } = await import('@cat-cafe/shared/utils'));
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: 'f293-routing-hot-state-test:' });
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
  });

  it('keeps actual-send preflight off Redis after load and same-process appends', async () => {
    const signalStore = new RedisRoutingSignalEventStore(redis);
    const preferenceStore = new RedisRoutingPreferenceStore(redis);
    const failure = {
      v: 1,
      eventId: 'signal:provider-failure',
      commandId: 'command:provider-failure',
      ownerId: 'owner-1',
      subjectRef: { type: 'cat', catId: 'sol' },
      reasonCode: 'provider_unreachable',
      source: 'provider_error',
      observedAt: 1_000,
      evidenceRef: 'turn:failed',
      eventType: 'asserted',
      state: 'unavailable',
      validUntil: 30_000,
    };
    const firstPreference = preference(1);
    await signalStore.append(failure);
    await preferenceStore.append(firstPreference);

    const resolver = new RoutingContextResolver({
      signalStore,
      preferenceStore,
      profileRevisionSource: {
        load: async () => ({ status: 'fresh', profiles: [], absentCatIds: ['sol', 'terra'] }),
      },
    });
    const preflight = new RoutingPreflightService({ resolver, readBudgetMs: 120 });
    const candidates = [
      { v: 1, catId: 'sol', providerId: 'openai', provenQuotaPools: [] },
      { v: 1, catId: 'terra', providerId: 'openai', provenQuotaPools: [] },
    ];
    const input = (observedAt) => ({
      ownerId: 'owner-1',
      observedAt,
      catalogRevision: 'catalog:v1',
      intent: 'review',
      candidates,
      targetCatIds: ['sol'],
    });

    const cold = await preflight.preflight(input(1_500));
    assert.equal(cold.resolverState, 'fresh');
    assert.equal(cold.targets[0].disposition, 'rejected');

    await signalStore.append({
      v: 1,
      eventId: 'signal:dispatch-success',
      commandId: 'command:dispatch-success',
      ownerId: 'owner-1',
      subjectRef: { type: 'cat', catId: 'sol' },
      reasonCode: 'dispatch_success_probe',
      source: 'dispatch_success',
      observedAt: 2_000,
      evidenceRef: 'turn:succeeded',
      eventType: 'recovered',
      state: 'available',
      closesSignalIds: [],
      probeStartedAt: 1_500,
    });
    let previousPreference = firstPreference;
    for (let version = 2; version <= 128; version += 1) {
      const nextPreference = preference(version, previousPreference.revisionId);
      await preferenceStore.append(nextPreference);
      previousPreference = nextPreference;
    }

    const originalSendCommand = redis.sendCommand;
    let redisCommands = 0;
    redis.sendCommand = function (...args) {
      redisCommands += 1;
      return originalSendCommand.apply(this, args);
    };
    try {
      const decisions = await Promise.all(
        Array.from({ length: 100 }, (_, index) => preflight.preflight(input(3_000 + index))),
      );
      assert.ok(decisions.every((decision) => decision.resolverState === 'fresh'));
      assert.ok(decisions.every((decision) => decision.targets[0].disposition === 'allowed'));
      assert.equal(redisCommands, 0, 'warm preflight must not yield through shared Redis');
    } finally {
      redis.sendCommand = originalSendCommand;
    }
  });
});
