import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { BallCustodyProbeScheduler } from '../dist/domains/ball-custody/BallCustodyProbeScheduler.js';
import { RedisBallCustodyProjectionStore } from '../dist/domains/ball-custody/BallCustodyProjectionStore.js';
import { createInitialProjection } from '../dist/domains/ball-custody/ball-custody-projection-reducer.js';
import { BallProbeRecoveryCensusPending } from '../dist/domains/ball-custody/ball-probe-recovery-backend.js';
import { RecoveryDeadlineExceeded, withinRecoveryDeadline } from '../dist/infrastructure/recovery/recovery-deadline.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';
import { auditRecoveryRedis } from './helpers/recovery-store-audit.js';

const fixture = ownedRedisFixture('1843-ball-probe-census');
const completeKey = 'ballcustody:recovery:census:v1';

async function legacyProjections(redis, count) {
  // This journey restarts the API owner while its exclusively owned Redis stays alive.
  await redis.config('SET', 'appendfsync', 'everysec');
  const batch = redis.pipeline();
  for (let n = 0; n < count; n++) {
    const subject = `ball:task:legacy-${n}`;
    batch.set(
      `ballcustody:projection:${subject}`,
      JSON.stringify({ ...createInitialProjection(subject, 1), state: 'resolved' }),
    );
    batch.sadd('ballcustody:projections:index', subject);
  }
  const subject = 'ball:task:healthy';
  batch.set(
    `ballcustody:projection:${subject}`,
    JSON.stringify({
      ...createInitialProjection(subject, 1),
      state: 'blocked',
      blockedSinceAt: 1,
      resolveMode: 'bounces_back',
    }),
  );
  batch.sadd('ballcustody:projections:index', subject);
  for (const [error] of await batch.exec()) assert.ifError(error);
}

function scheduler(store, evaluate) {
  return new BallCustodyProbeScheduler({
    projectionStore: store,
    now: () => 1000,
    taskStore: {
      get: async (id) => ({
        id,
        status: 'blocked',
        probe: { kind: 'redis_exists', key: 'condition' },
        resolveMode: 'bounces_back',
        userId: 'user',
        threadId: 'home',
        ownerCatId: 'codex61-sol',
      }),
    },
    probeEvaluator: { evaluate },
    ballCustody: { record: async () => assert.fail('census and ordinary waiting do not emit events') },
    wakeSender: { send: async () => assert.fail('census and ordinary waiting do not send wakes') },
  });
}

test('cold periodic census is bounded, reports incomplete readiness and resumes across store reconstruction', async () => {
  const redis = fixture.client(`bounded-census-${randomUUID()}:`);
  await legacyProjections(redis, 1200);
  let probes = 0;
  const evaluate = async () => {
    probes++;
    return { satisfied: false };
  };
  const first = await scheduler(new RedisBallCustodyProjectionStore(redis), evaluate).tick();
  assert.equal(first.initializing, true, 'incomplete census is visible instead of masquerading as an empty due queue');
  assert.equal(first.failed, 0, 'bounded census work is deferral, not a bad business record');
  assert.equal(probes, 0, 'business probes wait for complete owner discovery');
  const firstProgress = await redis.get(completeKey);
  assert.ok(firstProgress && firstProgress !== '1', 'the original owner persists exact census progress');
  for (let round = 0; round < 30 && (await redis.get(completeKey)) !== '1'; round++)
    await scheduler(new RedisBallCustodyProjectionStore(redis), evaluate).tick();
  assert.equal(
    await redis.get(completeKey),
    '1',
    'reconstruction continues the original census rather than restarting it',
  );
  await scheduler(new RedisBallCustodyProjectionStore(redis), evaluate).tick();
  assert.ok(probes > 0, 'the healthy pending subject becomes reachable');
  assert.equal(await redis.scard('ballcustody:projections:index'), 1201, 'original history is retained');
  const audit = await auditRecoveryRedis(redis);
  try {
    await scheduler(new RedisBallCustodyProjectionStore(redis), evaluate).tick();
    await audit.flush();
    audit.assertIndexed();
    assert.equal(
      audit.reads.filter((read) => ['scan', 'sscan', 'smembers'].includes(read.command)).length,
      0,
      'completed census never re-enumerates historical records',
    );
  } finally {
    audit.stop();
  }
});

test('a delayed earlier-generation census cannot mark a fresh rebuild complete', async () => {
  const redis = fixture.client(`census-generation-${randomUUID()}:`);
  await legacyProjections(redis, 5);
  let releaseOld,
    releaseNew,
    oldAtCompletion = false,
    freshPaused = false;
  let oldReached, newReached;
  const oldReady = new Promise((resolve) => {
    oldReached = resolve;
  });
  const newReady = new Promise((resolve) => {
    newReached = resolve;
  });
  const oldGate = new Promise((resolve) => {
    releaseOld = resolve;
  });
  const newGate = new Promise((resolve) => {
    releaseNew = resolve;
  });
  const wrap = (before) =>
    new Proxy(redis, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (property === 'eval')
          return async (...args) => {
            await before(args);
            return value.apply(target, args);
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  const oldStore = new RedisBallCustodyProjectionStore(
    wrap(async (args) => {
      if (args[0].includes('ARGV[2]') && args.at(-1) === '1') {
        oldAtCompletion = true;
        oldReached();
        await oldGate;
      }
    }),
  );
  const old = (async () => {
    for (;;) {
      try {
        await oldStore.listProbeRecoveryCandidates(1, 1000);
        return;
      } catch (error) {
        if (oldAtCompletion || !(error instanceof BallProbeRecoveryCensusPending)) throw error;
      }
    }
  })().then(
    () => null,
    (error) => error,
  );
  let fresh;
  try {
    await oldReady;
    const freshStore = new RedisBallCustodyProjectionStore(
      wrap(async (args) => {
        if (args[0].includes('invalid_ball_recovery_index') && !args[0].includes('for i=2,#KEYS') && !freshPaused) {
          freshPaused = true;
          newReached();
          await newGate;
        }
      }),
    );
    fresh = freshStore.initializeRecovery(true);
    await newReady;
    const original = await redis.get(completeKey);
    assert.notEqual(original, '1', 'the new census is demonstrably incomplete');
    releaseOld();
    assert.ok((await old) instanceof BallProbeRecoveryCensusPending, 'the old exact checkpoint loses its CAS');
    assert.equal(await redis.get(completeKey), original, 'a delayed completion cannot overwrite the new generation');
    releaseNew();
    await fresh;
    assert.equal(await redis.get(completeKey), '1');
    assert.equal(await redis.scard('ballcustody:projections:index'), 6);
  } finally {
    releaseOld();
    releaseNew();
    await Promise.allSettled([old, fresh]);
  }
});

test('expired partial census preserves progress and eventually admits a healthy probe without charging its budget', async () => {
  const redis = fixture.client(`interrupted-census-${randomUUID()}:`);
  await legacyProjections(redis, 35);
  const replies = [];
  const delayed = new Proxy(redis, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (property === 'eval')
        return (...args) => {
          const reply = (async () => {
            const result = await value.apply(target, args);
            if (args[0].includes('invalid_ball_recovery_index')) await setTimeout(15);
            return result;
          })();
          replies.push(reply);
          return reply;
        };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  let probes = 0,
    expired = 0;
  for (let round = 0; round < 60 && (await redis.get(completeKey)) !== '1'; round++) {
    try {
      await withinRecoveryDeadline(Date.now() + 100, Date.now, () =>
        new RedisBallCustodyProjectionStore(delayed).initializeRecovery(),
      );
    } catch (error) {
      assert.ok(error instanceof RecoveryDeadlineExceeded);
      expired++;
    }
    await Promise.allSettled(replies.splice(0));
  }
  assert.ok(expired > 0, 'the regression exercises actual recovery deadline interruption');
  assert.equal(
    await redis.get(completeKey),
    '1',
    'interruption cannot permanently strand the migration at the first page',
  );
  await scheduler(new RedisBallCustodyProjectionStore(redis), async () => {
    probes++;
    return { satisfied: false };
  }).tick();
  assert.ok(probes > 0, 'a healthy neighbor is eventually processed');
  const facts = await new RedisBallCustodyProjectionStore(redis).getRecoveryFacts('ball:task:healthy');
  assert.equal(facts.probe.failures, 0, 'discovery interruption never charges an unentered business probe');
});
