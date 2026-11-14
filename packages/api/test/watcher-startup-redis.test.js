import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { parseWatcherSessionState } from '@cat-cafe/shared';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { CallbackAuthTurnExecutionLifecycle } from '../dist/domains/cats/services/agents/invocation/CallbackAuthTurnExecutionLifecycle.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { RedisAuthInvocationBackend } from '../dist/domains/cats/services/agents/invocation/RedisAuthInvocationBackend.js';
import { watcherSessionChainKey } from '../dist/domains/cats/services/session/session-scope.js';
import { RedisSessionChainStore } from '../dist/domains/cats/services/stores/redis/RedisSessionChainStore.js';
import { RedisTurnExecutionStore } from '../dist/domains/cats/services/stores/redis/RedisTurnExecutionStore.js';
import { saveWatcherState } from '../dist/domains/concierge/watcher/watcher-checkpoint.js';
import { reconcileWatcherRecovery } from '../dist/domains/concierge/watcher/watcher-recovery.js';
import {
  reserveWatcherRecovery,
  watcherRecoveryFinalizationDue,
} from '../dist/domains/concierge/watcher/watcher-retry.js';
import { clearAuthTestNamespace, createAuthTestNamespace } from './helpers/redis-auth-namespace.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const namespace = createAuthTestNamespace('watcher-startup');
const options = { skip: redisIsolationSkipReason(process.env.REDIS_URL) };
let redis;
before(async () => {
  assertRedisIsolationOrThrow(process.env.REDIS_URL, 'F335 watcher startup');
  redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: namespace });
  await redis.ping();
});
after(async () => {
  if (redis) {
    await clearAuthTestNamespace(redis, namespace);
    await redis.quit();
  }
});
function owners() {
  const registry = new InvocationRegistry({ backend: new RedisAuthInvocationBackend(redis) });
  return {
    registry,
    executions: new CallbackAuthTurnExecutionLifecycle(new RedisTurnExecutionStore(redis), registry),
    sessions: new RedisSessionChainStore(redis),
    recoverNative: () => assert.fail('the unbound failed CLI must never be launched again'),
  };
}

test(
  'Redis startup settles the same failed wake across a response-write cut without needing an enabled provider',
  options,
  async () => {
    const first = owners(),
      userId = 'startup-owner',
      threadId = 'startup-line';
    await first.executions.createRunning({
      invocationId: 'work',
      parentInvocationId: 'p-work',
      userId,
      threadId,
      catId: 'codex',
      executionKind: 'ordinary',
      startedAt: Date.now(),
    });
    await first.executions.transitionTerminal('work', { status: 'succeeded', endedAt: Date.now() });
    await first.executions.markResponseSettled('work', {
      kind: 'no_response',
      reason: 'tool_only',
      settledAt: Date.now(),
    });
    const source = await first.executions.get('work');
    const auth = await first.registry.create(userId, 'codex', threadId, undefined, undefined, {
      mode: 'watcher',
      maxToolCalls: 6,
      allowedToolNames: ['cat_cafe_get_message'],
      allowedCallbackRoutes: [],
    });
    await first.executions.createRunning({
      invocationId: auth.invocationId,
      parentInvocationId: 'watcher-source:codex:work',
      userId,
      threadId,
      catId: 'codex',
      executionKind: 'watcher',
      providerLifecycleTracked: true,
      causal: { watcherSourceInvocationId: 'work' },
      startedAt: Date.now(),
    });
    await first.executions.markProviderStarted(auth.invocationId, Date.now());
    await first.executions.recordProviderTeardown(auth.invocationId, Date.now());
    const session = await first.sessions.getOrCreateActive({
      userId,
      threadId,
      catId: 'codex',
      sessionPurpose: 'watcher',
      chainKey: watcherSessionChainKey(userId, 'codex', threadId),
    });
    await saveWatcherState(first.sessions, session.id, parseWatcherSessionState(undefined), {
      wakeInvocationId: auth.invocationId,
      attempt: {
        invocationId: auth.invocationId,
        sourceInvocationId: 'work',
        sourceSequence: source.settledSequence,
        startedAt: Date.now(),
        phase: 'failed',
        failure: 'reserved builtin provider',
      },
    });
    first.executions.markResponseSettled = async () => {
      throw new Error('API exits before response settlement');
    };
    const errors = [];
    await reconcileWatcherRecovery(first, userId, (error) => errors.push(error));
    assert.match(errors[0].message, /API exits/);
    assert.equal((await first.executions.get(auth.invocationId)).status, 'failed');
    assert.equal((await first.registry.verify(auth.invocationId, auth.callbackToken)).ok, false);
    assert.equal((await first.sessions.listPendingWatcherSessions(userId)).length, 1);
    const restored = owners();
    await reconcileWatcherRecovery(restored, userId, (error) => assert.fail(error));
    const record = await restored.executions.get(auth.invocationId);
    assert.equal(record.status, 'failed');
    assert.equal(record.responseSettlement.kind, 'no_response');
    assert.deepEqual(await restored.sessions.listPendingWatcherSessions(userId), []);
    assert.equal((await restored.sessions.get(session.id)).watcherState.afterSequence, 0);
    assert.equal((await restored.executions.listByParent('watcher-source:codex:work')).length, 1);
    assert.equal((await restored.executions.get('work')).status, 'succeeded');
  },
);

test(
  'Redis recovery reservations survive each owner reconstruction and admit only one stop probe per revision',
  options,
  async () => {
    let sessions = new RedisSessionChainStore(redis);
    const session = await sessions.getOrCreateActive({
      userId: 'retry-owner',
      threadId: 'retry-line',
      catId: 'codex',
      sessionPurpose: 'watcher',
      chainKey: watcherSessionChainKey('retry-owner', 'codex', 'retry-line'),
    });
    await saveWatcherState(sessions, session.id, parseWatcherSessionState(undefined), {
      attempt: {
        invocationId: 'retry-wake',
        sourceInvocationId: 'retry-work',
        sourceSequence: 1,
        startedAt: 1,
        phase: 'failed',
      },
    });
    const reserve = async (at, controlKey) => {
      sessions = new RedisSessionChainStore(redis);
      const current = await sessions.get(session.id);
      return reserveWatcherRecovery(
        { sessions },
        current,
        parseWatcherSessionState(current.watcherState),
        at,
        controlKey,
      );
    };
    assert.equal(await reserve(100), true);
    assert.equal(await reserve(200), false);
    assert.equal(await reserve(5100), true);
    assert.equal(await reserve(25100), true);
    assert.equal(await reserve(999999), false);
    const capped = parseWatcherSessionState((await new RedisSessionChainStore(redis).get(session.id)).watcherState);
    assert.equal(watcherRecoveryFinalizationDue(capped, 25101), false, 'the last backoff still applies');
    assert.equal(
      watcherRecoveryFinalizationDue(capped, 999999),
      true,
      'a capped model budget still owes native settlement',
    );
    const restarted = await promisify(execFile)(
      process.execPath,
      ['test/helpers/watcher-retry-process.mjs', namespace, session.id, '999999'],
      { timeout: 15000 },
    );
    const observation = restarted.stdout.split('\n').find((line) => line.startsWith('WATCHER_RETRY_PROCESS:'));
    assert.deepEqual(JSON.parse(observation.slice('WATCHER_RETRY_PROCESS:'.length)), { admitted: false, attempts: 3 });
    assert.equal(await reserve(999999, '1:0'), true);
    assert.equal(await reserve(999999, '1:0'), false);
    assert.equal(await reserve(999999, '1:1'), true);
    assert.equal((await sessions.get(session.id)).watcherState.attempt.recoveryAttempts, 3);
  },
);
