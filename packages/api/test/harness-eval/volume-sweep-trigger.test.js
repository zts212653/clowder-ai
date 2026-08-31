/**
 * F257: generation-fenced volume SemanticSweep trigger.
 *
 * Exercises production dist exports with an atomic Redis emulator. The cases
 * target cross-generation overlap, durable due recovery, completion fencing,
 * final-batch retry, and the real submit handler boundary.
 *
 * [砚砚/gpt-5.6-sol🐾]
 */

import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';
import {
  advanceVolumeSweepDrain,
  bindVolumeSweepInvoke,
  bootstrapTraceStore,
  checkAndTriggerVolumeSweep,
  drainDueVolumeSweepRetries,
  SWEEP_BATCH_SIZE,
  SWEEP_FAILURE_RETRY_SECONDS,
  SWEEP_LEASE_SECONDS,
  SWEEP_MAX_DRAIN_ROUNDS,
  SWEEP_RETRY_DUE_KEY,
  SWEEP_STATE_KEY_PREFIX,
  SWEEP_VOLUME_THRESHOLD,
} from '../../dist/domains/prompt-hooks/trace-bootstrap.js';
import { handleSubmitSemanticSweep } from '../../dist/infrastructure/harness-eval/trace-annotation/submit-semantic-sweep.js';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from '../helpers/redis-test-helpers.js';

const UNCLASSIFIED_KEY_PREFIX = 'trace-unclassified-episode:';
// Keep completion-path calls to production Date.now() inside the seven-day
// evaluation window. A fixed calendar timestamp makes this suite expire.
const BASE_TIME = Date.now();

function createFakeRedis() {
  const store = new Map();
  const zsets = new Map();
  const ttls = new Map();

  const zset = (key) => {
    if (!zsets.has(key)) zsets.set(key, []);
    return zsets.get(key);
  };
  const writeState = (key, state) => store.set(key, JSON.stringify(state));

  const evalBeginAttempt = async (keys, argv, state, raw) => {
    const [owner, now, leaseUntil, attemptId, maxRounds] = argv;
    if (state && (typeof state.leaseUntil !== 'number' || state.leaseUntil > Number(now))) return [0, raw];
    if (state && state.completedRounds >= Number(maxRounds)) return [-1, raw];
    const next = {
      version: 1,
      generation: state ? state.generation + 1 : 1,
      attemptId,
      phase: 'dispatching',
      completedRounds: state?.completedRounds ?? 0,
      startedAt: state?.startedAt ?? Number(now),
      leaseUntil: Number(leaseUntil),
      ...(typeof state?.jobId === 'string' ? { jobId: state.jobId } : {}),
    };
    writeState(keys[0], next);
    await redis.zadd(keys[1], leaseUntil, owner);
    return [1, JSON.stringify(next)];
  };

  const evalAttachJob = async (keys, argv, state) => {
    const [owner, generation, attemptId, jobId, leaseUntil] = argv;
    if (!state || state.generation !== Number(generation) || state.attemptId !== attemptId) return 0;
    writeState(keys[0], { ...state, phase: 'in_flight', jobId, leaseUntil: Number(leaseUntil) });
    await redis.zadd(keys[1], leaseUntil, owner);
    return 1;
  };

  const evalFailAttempt = async (keys, argv, state) => {
    const [owner, generation, attemptId, retryAt] = argv;
    if (!state || state.generation !== Number(generation) || state.attemptId !== attemptId) return 0;
    writeState(keys[0], { ...state, phase: 'retry_wait', leaseUntil: Number(retryAt) });
    await redis.zadd(keys[1], retryAt, owner);
    return 1;
  };

  const evalCompleteJob = async (keys, argv, state) => {
    const [owner, completedJobId, attemptId, now] = argv;
    if (!state || typeof state.jobId !== 'string' || state.jobId !== completedJobId) return 0;
    const { jobId: _jobId, ...withoutJob } = state;
    writeState(keys[0], {
      ...withoutJob,
      generation: state.generation + 1,
      attemptId,
      phase: 'ready',
      completedRounds: state.completedRounds + 1,
      leaseUntil: Number(now),
    });
    await redis.zadd(keys[1], now, owner);
    return 1;
  };

  const evalClearState = async (keys, argv, state) => {
    const [owner, generation, attemptId] = argv;
    if (state && (state.generation !== Number(generation) || state.attemptId !== attemptId)) return 0;
    store.delete(keys[0]);
    await redis.zrem(keys[1], owner);
    return 1;
  };

  const evalClearOrphanDue = async (keys, argv, state) => {
    if (state) return 0;
    await redis.zrem(keys[1], argv[0]);
    return 1;
  };

  const luaHandlers = [
    ['volume-sweep:begin-attempt', evalBeginAttempt],
    ['volume-sweep:attach-job', evalAttachJob],
    ['volume-sweep:fail-attempt', evalFailAttempt],
    ['volume-sweep:complete-job', evalCompleteJob],
    ['volume-sweep:clear-state', evalClearState],
    ['volume-sweep:clear-orphan-due', evalClearOrphanDue],
  ];

  const redis = {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value, ...args) => {
      if (args.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      const exIndex = args.indexOf('EX');
      if (exIndex >= 0) ttls.set(key, Number(args[exIndex + 1]));
      return 'OK';
    },
    del: async (key) => {
      const existed = store.delete(key);
      ttls.delete(key);
      return existed ? 1 : 0;
    },
    zcard: async (key) => zset(key).length,
    zcount: async (key, min, max) => {
      const lower = min === '-inf' ? -Infinity : Number(min);
      const upper = max === '+inf' ? Infinity : Number(max);
      return zset(key).filter(({ score }) => score >= lower && score <= upper).length;
    },
    zadd: async (key, score, member) => {
      const entries = zset(key);
      const existing = entries.find(({ member: candidate }) => candidate === member);
      if (existing) existing.score = Number(score);
      else entries.push({ score: Number(score), member });
      return existing ? 0 : 1;
    },
    zrangebyscore: async (key, min, max, ...args) => {
      const lower = min === '-inf' ? -Infinity : Number(min);
      const upper = max === '+inf' ? Infinity : Number(max);
      let entries = zset(key)
        .filter(({ score }) => score >= lower && score <= upper)
        .sort((a, b) => a.score - b.score);
      const limitIndex = args.indexOf('LIMIT');
      if (limitIndex >= 0) {
        const offset = Number(args[limitIndex + 1]);
        entries = entries.slice(offset, offset + Number(args[limitIndex + 2]));
      }
      return entries.map(({ member }) => member);
    },
    zrem: async (key, member) => {
      const entries = zset(key);
      const before = entries.length;
      zsets.set(
        key,
        entries.filter(({ member: candidate }) => candidate !== member),
      );
      return before === zsets.get(key).length ? 0 : 1;
    },
    smembers: async () => [],
    sadd: async () => 1,
    expire: async () => 1,
    eval: async (script, numKeys, ...args) => {
      const keys = args.slice(0, numKeys);
      const argv = args.slice(numKeys);
      const raw = store.get(keys[0]);
      const state = raw ? JSON.parse(raw) : null;
      const handler = luaHandlers.find(([marker]) => script.includes(marker))?.[1];
      if (!handler) throw new Error('unexpected_lua_script');
      return handler(keys, argv, state, raw);
    },
    _store: store,
    _zsets: zsets,
    _ttls: ttls,
  };
  return redis;
}

async function populateEpisodes(redis, ownerUserId, count, timestamp = BASE_TIME) {
  const key = `${UNCLASSIFIED_KEY_PREFIX}${ownerUserId}`;
  for (let index = 0; index < count; index++) {
    await redis.zadd(key, timestamp - index * 1_000, `inv-${ownerUserId}-${timestamp}-${index}`);
  }
}

async function populateStaleEpisodes(redis, ownerUserId, count) {
  await populateEpisodes(redis, ownerUserId, count, BASE_TIME - 30 * 24 * 60 * 60 * 1_000);
}

function setup(redis, invoke) {
  bootstrapTraceStore(redis);
  bindVolumeSweepInvoke(invoke);
}

function createJobInvoke() {
  let sequence = 0;
  return mock.fn(async () => ({ dispatched: true, jobId: `job-${++sequence}` }));
}

function readState(redis, ownerUserId = 'user_A') {
  const raw = redis._store.get(`${SWEEP_STATE_KEY_PREFIX}${ownerUserId}`);
  return raw ? JSON.parse(raw) : null;
}

function removeEpisodes(redis, ownerUserId, count) {
  const entries = redis._zsets.get(`${UNCLASSIFIED_KEY_PREFIX}${ownerUserId}`) ?? [];
  entries.splice(0, count);
}

describe('F257: generation-fenced volume sweep trigger', () => {
  describe('threshold and owner isolation', () => {
    it('does not trigger below 200 and triggers at 200', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 199);
      await checkAndTriggerVolumeSweep('user_A', BASE_TIME);
      assert.equal(invoke.mock.callCount(), 0);
      await redis.zadd(`${UNCLASSIFIED_KEY_PREFIX}user_A`, BASE_TIME, 'inv-200');
      await checkAndTriggerVolumeSweep('user_A', BASE_TIME);
      assert.equal(invoke.mock.callCount(), 1);
      assert.equal(readState(redis).jobId, 'job-1');
    });

    it('dispatches a newly-ready Unit below the Semantic Sweep threshold without opening a sweep drain', async () => {
      const redis = createFakeRedis();
      const invoke = mock.fn(async () => ({ dispatched: true, unitEvaluationJobIds: ['unit-job-1'] }));
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 1);

      await checkAndTriggerVolumeSweep('user_A', BASE_TIME, true);

      assert.equal(invoke.mock.callCount(), 1);
      assert.equal(readState(redis), null);
    });

    it('isolates owner state and atomically deduplicates same-owner callers', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);
      await populateEpisodes(redis, 'user_B', 200);
      await Promise.all([
        checkAndTriggerVolumeSweep('user_A', BASE_TIME),
        checkAndTriggerVolumeSweep('user_A', BASE_TIME),
        checkAndTriggerVolumeSweep('user_B', BASE_TIME),
      ]);
      assert.equal(invoke.mock.callCount(), 2);
      assert.equal(readState(redis, 'user_A').jobId, 'job-1');
      assert.equal(readState(redis, 'user_B').jobId, 'job-2');
    });

    it('counts only the current seven-day window', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await populateStaleEpisodes(redis, 'user_A', 300);
      await populateEpisodes(redis, 'user_A', 50);
      await checkAndTriggerVolumeSweep('user_A', BASE_TIME);
      assert.equal(invoke.mock.callCount(), 0);
    });
  });

  describe('durable retry state', () => {
    it('removes an orphan due entry only after confirming no state exists', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await redis.zadd(SWEEP_RETRY_DUE_KEY, BASE_TIME, 'user_A');
      assert.equal(await drainDueVolumeSweepRetries(BASE_TIME), 1);
      assert.deepEqual(await redis.zrangebyscore(SWEEP_RETRY_DUE_KEY, '-inf', '+inf'), []);
      assert.equal(invoke.mock.callCount(), 0);
    });

    it('persists failed dispatch and retries it from the due index', async () => {
      const redis = createFakeRedis();
      let calls = 0;
      const invoke = mock.fn(async () =>
        ++calls === 1 ? { dispatched: false } : { dispatched: true, jobId: 'job-retry' },
      );
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);

      await checkAndTriggerVolumeSweep('user_A', BASE_TIME);
      const failed = readState(redis);
      assert.equal(failed.phase, 'retry_wait');
      assert.equal(failed.leaseUntil, BASE_TIME + SWEEP_FAILURE_RETRY_SECONDS * 1_000);
      assert.equal(redis._ttls.has(`${SWEEP_STATE_KEY_PREFIX}user_A`), false, 'state must not expire');

      assert.equal(await drainDueVolumeSweepRetries(failed.leaseUntil - 1), 0);
      assert.equal(await drainDueVolumeSweepRetries(failed.leaseUntil), 1);
      assert.equal(invoke.mock.callCount(), 2);
      assert.equal(readState(redis).jobId, 'job-retry');
    });

    it('treats a runtime dispatched-without-jobId result as durable retry_wait', async () => {
      const redis = createFakeRedis();
      const invoke = mock.fn(async () => ({ dispatched: true }));
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);
      await checkAndTriggerVolumeSweep('user_A', BASE_TIME);
      assert.equal(readState(redis).phase, 'retry_wait');
      assert.equal(invoke.mock.callCount(), 1);
      await checkAndTriggerVolumeSweep('user_A', BASE_TIME);
      assert.equal(invoke.mock.callCount(), 1, 'retry lease prevents immediate duplicate dispatch');
    });

    it('recovers a final batch after its completion never arrives', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);
      await checkAndTriggerVolumeSweep('user_A', BASE_TIME);

      removeEpisodes(redis, 'user_A', 190);
      await advanceVolumeSweepDrain('user_A', 'job-1');
      assert.equal(invoke.mock.callCount(), 2, 'final 10 episodes dispatched');
      const finalBatch = readState(redis);
      assert.equal(finalBatch.jobId, 'job-2');
      assert.equal(redis._ttls.has(`${SWEEP_STATE_KEY_PREFIX}user_A`), false, 'final state is persistent');

      assert.equal(await drainDueVolumeSweepRetries(finalBatch.leaseUntil + 1), 1);
      assert.equal(invoke.mock.callCount(), 3, 'due worker retries without a new trace or completion');
      assert.equal(readState(redis).jobId, 'job-3');
    });
  });

  describe('generation and completion fencing', () => {
    it('allows only one duplicate completion to advance', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);
      await checkAndTriggerVolumeSweep('user_A', BASE_TIME);
      removeEpisodes(redis, 'user_A', SWEEP_BATCH_SIZE);
      await Promise.all([advanceVolumeSweepDrain('user_A', 'job-1'), advanceVolumeSweepDrain('user_A', 'job-1')]);
      assert.equal(invoke.mock.callCount(), 2);
      assert.equal(readState(redis).jobId, 'job-2');
    });

    it('fails closed for unrelated or missing active jobId', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);
      await checkAndTriggerVolumeSweep('user_A', BASE_TIME);
      await advanceVolumeSweepDrain('user_A', 'unrelated');
      assert.equal(invoke.mock.callCount(), 1);

      const state = readState(redis);
      delete state.jobId;
      redis._store.set(`${SWEEP_STATE_KEY_PREFIX}user_A`, JSON.stringify(state));
      await advanceVolumeSweepDrain('user_A', 'job-1');
      assert.equal(invoke.mock.callCount(), 1);
      assert.equal(readState(redis).generation, 1);
    });

    it('prevents an expired-lease retry result from overwriting the next generation', async () => {
      const redis = createFakeRedis();
      let releaseRetry;
      const retryGate = new Promise((resolve) => {
        releaseRetry = resolve;
      });
      let callCount = 0;
      const invoke = mock.fn(async () => {
        callCount += 1;
        if (callCount === 2) {
          await retryGate;
          return { dispatched: true, jobId: 'job-1' };
        }
        return { dispatched: true, jobId: callCount === 1 ? 'job-1' : `job-${callCount}` };
      });
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);
      await checkAndTriggerVolumeSweep('user_A', BASE_TIME);

      const retry = checkAndTriggerVolumeSweep('user_A', readState(redis).leaseUntil + 1);
      while (invoke.mock.callCount() < 2) await new Promise((resolve) => setImmediate(resolve));

      removeEpisodes(redis, 'user_A', SWEEP_BATCH_SIZE);
      await advanceVolumeSweepDrain('user_A', 'job-1');
      releaseRetry();
      await retry;

      const state = readState(redis);
      assert.equal(invoke.mock.callCount(), 3);
      assert.equal(state.jobId, 'job-3');
      assert.equal(state.generation, 4, 'late generation-2 attach cannot replace generation 4');
    });
  });

  describe('completion lifecycle', () => {
    it('dispatches the next batch immediately after matching completion', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);
      await checkAndTriggerVolumeSweep('user_A', BASE_TIME);
      removeEpisodes(redis, 'user_A', SWEEP_BATCH_SIZE);
      await advanceVolumeSweepDrain('user_A', 'job-1');
      assert.equal(invoke.mock.callCount(), 2);
      assert.equal(readState(redis).completedRounds, 1);
      assert.equal(readState(redis).jobId, 'job-2');
    });

    it('clears state and the due index only after completion observes zero', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);
      await checkAndTriggerVolumeSweep('user_A', BASE_TIME);
      redis._zsets.set(`${UNCLASSIFIED_KEY_PREFIX}user_A`, []);
      await advanceVolumeSweepDrain('user_A', 'job-1');
      assert.equal(readState(redis), null);
      assert.deepEqual(await redis.zrangebyscore(SWEEP_RETRY_DUE_KEY, '-inf', '+inf'), []);
      assert.equal(invoke.mock.callCount(), 1);
    });

    it('wakes a newly ready Unit after the final semantic batch clears its sweep state', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);
      await checkAndTriggerVolumeSweep('user_A', BASE_TIME);
      redis._zsets.set(`${UNCLASSIFIED_KEY_PREFIX}user_A`, []);

      await advanceVolumeSweepDrain('user_A', 'job-1', true);

      assert.equal(readState(redis), null);
      assert.equal(invoke.mock.callCount(), 2, 'the Unit job is dispatched after the sweep reaches zero');
    });

    it('clears a state that reaches the safety cap', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 10);
      const state = {
        version: 1,
        generation: 50,
        attemptId: 'capped',
        phase: 'ready',
        completedRounds: SWEEP_MAX_DRAIN_ROUNDS,
        startedAt: BASE_TIME,
        leaseUntil: BASE_TIME,
      };
      redis._store.set(`${SWEEP_STATE_KEY_PREFIX}user_A`, JSON.stringify(state));
      await redis.zadd(SWEEP_RETRY_DUE_KEY, BASE_TIME, 'user_A');
      await checkAndTriggerVolumeSweep('user_A', BASE_TIME);
      assert.equal(readState(redis), null);
      assert.equal(invoke.mock.callCount(), 0);
    });

    it('chains through the real handleSubmitSemanticSweep boundary', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);
      await checkAndTriggerVolumeSweep('user_A', BASE_TIME);
      removeEpisodes(redis, 'user_A', SWEEP_BATCH_SIZE);
      const coordinator = { submit: mock.fn(async () => ({ classified: 1, alreadyCompleted: false })) };

      const response = await handleSubmitSemanticSweep(
        coordinator,
        { userId: 'user_A', catId: 'eval-cat' },
        {
          jobId: 'job-1',
          decisions: [{ invocationId: 'inv-1', status: 'irrelevant', matches: [] }],
        },
      );

      assert.equal(response.status, 200);
      assert.equal(coordinator.submit.mock.callCount(), 1);
      assert.equal(invoke.mock.callCount(), 2, 'real submit handler advances and dispatches');
      assert.equal(readState(redis).jobId, 'job-2');
    });

    it('propagates fresh Unit readiness through the semantic submit handler without a sweep drain', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      const coordinator = {
        submit: mock.fn(async () => ({
          selected: 1,
          classified: 1,
          annotations: 1,
          unitEvaluationReady: true,
          alreadyCompleted: false,
        })),
      };

      const response = await handleSubmitSemanticSweep(
        coordinator,
        { userId: 'user_A', catId: 'eval-cat' },
        {
          jobId: 'manual-job',
          decisions: [{ invocationId: 'inv-1', status: 'irrelevant', matches: [] }],
        },
      );

      assert.equal(response.status, 200);
      assert.equal(invoke.mock.callCount(), 1, 'new Unit readiness wakes evaluation without volume state');
      assert.equal(readState(redis), null);
    });

    it('does not redispatch Unit readiness from an idempotent semantic submission replay', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      const coordinator = {
        submit: mock.fn(async () => ({
          selected: 1,
          classified: 1,
          annotations: 1,
          unitEvaluationReady: true,
          alreadyCompleted: true,
        })),
      };

      const response = await handleSubmitSemanticSweep(
        coordinator,
        { userId: 'user_A', catId: 'eval-cat' },
        {
          jobId: 'completed-job',
          decisions: [{ invocationId: 'inv-1', status: 'irrelevant', matches: [] }],
        },
      );

      assert.equal(response.status, 200);
      assert.equal(invoke.mock.callCount(), 0, 'cached readiness is not a fresh dispatch signal');
    });
  });

  describe('exported contract', () => {
    it('uses the expected volume and batch bounds', () => {
      assert.equal(SWEEP_VOLUME_THRESHOLD, 200);
      assert.equal(SWEEP_BATCH_SIZE, 10);
      assert.equal(SWEEP_MAX_DRAIN_ROUNDS, 25);
      assert.equal(SWEEP_LEASE_SECONDS, 600);
      assert.equal(SWEEP_FAILURE_RETRY_SECONDS, 30);
    });
  });
});

const REDIS_URL = process.env.REDIS_URL;

describe('F257: generation fencing with real Redis Lua', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  const ownerUserId = 'volume-sweep-real-redis-user';
  const cleanupPatterns = [
    `${UNCLASSIFIED_KEY_PREFIX}${ownerUserId}`,
    `${SWEEP_STATE_KEY_PREFIX}${ownerUserId}`,
    SWEEP_RETRY_DUE_KEY,
  ];
  let redis;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F257 volume sweep generation fencing');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient({ url: REDIS_URL });
    await redis.ping();
    await cleanupPrefixedRedisKeys(redis, cleanupPatterns);
  });

  after(async () => {
    if (!redis) return;
    await cleanupPrefixedRedisKeys(redis, cleanupPatterns);
    await redis.quit();
  });

  it('executes the generation CAS scripts without late retry overwrite', async () => {
    const now = Date.now();
    let releaseRetry;
    const retryGate = new Promise((resolve) => {
      releaseRetry = resolve;
    });
    let callCount = 0;
    const invoke = mock.fn(async () => {
      callCount += 1;
      if (callCount === 2) {
        await retryGate;
        return { dispatched: true, jobId: 'job-1' };
      }
      return { dispatched: true, jobId: callCount === 1 ? 'job-1' : `job-${callCount}` };
    });
    bootstrapTraceStore(redis);
    bindVolumeSweepInvoke(invoke);
    await populateEpisodes(redis, ownerUserId, SWEEP_VOLUME_THRESHOLD, now);
    await checkAndTriggerVolumeSweep(ownerUserId, now);

    const initial = JSON.parse(await redis.get(`${SWEEP_STATE_KEY_PREFIX}${ownerUserId}`));
    const retry = checkAndTriggerVolumeSweep(ownerUserId, initial.leaseUntil + 1);
    while (invoke.mock.callCount() < 2) await new Promise((resolve) => setImmediate(resolve));

    const classified = await redis.zrange(`${UNCLASSIFIED_KEY_PREFIX}${ownerUserId}`, 0, SWEEP_BATCH_SIZE - 1);
    await redis.zrem(`${UNCLASSIFIED_KEY_PREFIX}${ownerUserId}`, ...classified);
    await advanceVolumeSweepDrain(ownerUserId, 'job-1');
    releaseRetry();
    await retry;

    const finalState = JSON.parse(await redis.get(`${SWEEP_STATE_KEY_PREFIX}${ownerUserId}`));
    assert.equal(invoke.mock.callCount(), 3);
    assert.equal(finalState.jobId, 'job-3');
    assert.equal(finalState.generation, 4);
  });
});
