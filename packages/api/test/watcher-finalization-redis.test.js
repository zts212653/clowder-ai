import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { parseWatcherSessionState } from '@cat-cafe/shared';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { CallbackAuthTurnExecutionLifecycle } from '../dist/domains/cats/services/agents/invocation/CallbackAuthTurnExecutionLifecycle.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { RedisAuthInvocationBackend } from '../dist/domains/cats/services/agents/invocation/RedisAuthInvocationBackend.js';
import { watcherSessionChainKey } from '../dist/domains/cats/services/session/session-scope.js';
import { RedisSessionChainStore } from '../dist/domains/cats/services/stores/redis/RedisSessionChainStore.js';
import { RedisTurnExecutionStore } from '../dist/domains/cats/services/stores/redis/RedisTurnExecutionStore.js';
import { MemoryConciergeConfigStore } from '../dist/domains/concierge/ConciergeConfigStore.js';
import { WatcherSupervisor } from '../dist/domains/concierge/watcher/WatcherSupervisor.js';
import { commitWatcherCheckpoint } from '../dist/domains/concierge/watcher/watcher-checkpoint.js';
import { clearAuthTestNamespace, createAuthTestNamespace } from './helpers/redis-auth-namespace.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const namespace = createAuthTestNamespace('watcher-finalization');
let redis;
before(async () => {
  assertRedisIsolationOrThrow(process.env.REDIS_URL, 'F335 watcher finalization');
  redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: namespace });
  await redis.ping();
});
after(async () => {
  if (!redis) return;
  await clearAuthTestNamespace(redis, namespace);
  await redis.quit();
});

function owners() {
  const registry = new InvocationRegistry({ backend: new RedisAuthInvocationBackend(redis) });
  const raw = new RedisTurnExecutionStore(redis);
  return {
    raw,
    registry,
    executions: new CallbackAuthTurnExecutionLifecycle(raw, registry),
    sessions: new RedisSessionChainStore(redis),
    transcript: { appendDurableEvent: async () => {} },
  };
}

// Redis owner reconstruction is necessary: an in-memory finally cannot represent these API death cuts.
for (const cut of [
  'after_prune',
  'before_auth_projection',
  'before_response_settlement',
  'settlement_rejected',
  'before_marker_clear',
]) {
  test(
    `API restart at ${cut} settles the same pruned wake without a model or an enabled member`,
    {
      skip: redisIsolationSkipReason(process.env.REDIS_URL),
    },
    async () => {
      const userId = `finalize-${cut}`;
      const threadId = `${userId}-line`;
      const first = owners();
      const sourceId = `${userId}-work`;
      await first.executions.createRunning({
        invocationId: sourceId,
        parentInvocationId: `parent-${sourceId}`,
        userId,
        threadId,
        catId: 'codex',
        executionKind: 'ordinary',
        startedAt: Date.now(),
      });
      await first.executions.transitionTerminal(sourceId, { status: 'succeeded', endedAt: Date.now() });
      const source = (
        await first.executions.markResponseSettled(sourceId, {
          kind: 'no_response',
          reason: 'tool_only',
          settledAt: Date.now(),
        })
      ).record;
      const auth = await first.registry.create(userId, 'codex', threadId, undefined, undefined, {
        mode: 'watcher',
        maxToolCalls: 6,
        allowedToolNames: ['cat_cafe_get_message'],
        allowedCallbackRoutes: [],
      });
      await first.executions.createRunning({
        invocationId: auth.invocationId,
        parentInvocationId: `watcher-source:codex:${sourceId}`,
        userId,
        threadId,
        catId: 'codex',
        executionKind: 'watcher',
        providerLifecycleTracked: true,
        causal: { watcherSourceInvocationId: sourceId },
        startedAt: Date.now(),
      });
      await first.executions.markProviderStarted(auth.invocationId, Date.now());
      const session = await first.sessions.create({
        userId,
        threadId,
        catId: 'codex',
        sessionPurpose: 'watcher',
        chainKey: watcherSessionChainKey(userId, 'codex', threadId),
        cliSessionId: `${userId}-native`,
      });
      await first.sessions.compareAndSetWatcherState(session.id, 0, {
        revision: 1,
        afterSequence: 0,
        notes: 'prior',
        wakeInvocationId: auth.invocationId,
        attempt: {
          invocationId: auth.invocationId,
          sourceInvocationId: sourceId,
          sourceSequence: source.settledSequence,
          startedAt: Date.now(),
          nativeTurnId: 'native-completed',
          phase: 'running',
          window: { frontier: 'original', offset: 0, messageIds: ['original'] },
        },
      });
      let reverted = 0;
      const client = {
        async request(method) {
          if (method === 'thread/revert') {
            reverted++;
            return {};
          }
          return {
            thread: {
              id: session.cliSessionId,
              turns: [
                {
                  id: 'native-completed',
                  status: 'completed',
                  items: [
                    {
                      type: 'agentMessage',
                      phase: 'final',
                      text: JSON.stringify({
                        v: 1,
                        notes: 'kept-notes',
                        consumedThrough: 'original:0',
                        outcome: 'remembered',
                      }),
                    },
                  ],
                },
              ],
            },
          };
        },
      };
      const state = parseWatcherSessionState((await first.sessions.get(session.id)).watcherState);
      await commitWatcherCheckpoint(first, session, state, client, {
        reportedAt: Date.now(),
        inputTokens: 31,
        outputTokens: 7,
      });
      const durable = parseWatcherSessionState((await first.sessions.get(session.id)).watcherState);
      assert.equal(durable.attempt?.phase, 'finalize_pending', 'API may die here before the caller finally');
      assert.equal(reverted, 1);
      if (cut === 'before_auth_projection' || cut === 'before_response_settlement') {
        // Exactly the canonical write before the lifecycle's auth projection, or after that projection.
        const target = cut === 'before_auth_projection' ? first.raw : first.executions;
        await target.transitionTerminal(auth.invocationId, {
          status: 'succeeded',
          endedAt: Date.now(),
          terminalReason: 'watcher_checkpoint_committed',
          providerTeardownAt: durable.attempt.prunedAt,
        });
      }
      const restored = owners(); // No caller finally, native process, configuration or original JS owner survives.
      const configs = new MemoryConciergeConfigStore();
      await configs.updateWatcherConfig(userId, 0, { enabled: false, memberCatId: 'unsupported-after-switch' });
      const reports = [];
      if (cut === 'settlement_rejected') {
        const settle = restored.executions.markResponseSettled.bind(restored.executions);
        let fail = true;
        restored.executions.markResponseSettled = async (...args) => {
          if (fail) {
            fail = false;
            return { outcome: 'not_ready', record: await restored.executions.get(args[0]) };
          }
          return settle(...args);
        };
      }
      if (cut === 'before_marker_clear') {
        const save = restored.sessions.compareAndSetWatcherState.bind(restored.sessions);
        let fail = true;
        restored.sessions.compareAndSetWatcherState = async (...args) => {
          if (fail && !args[2].attempt && !args[2].wakeInvocationId) {
            fail = false;
            throw new Error('fixture_last_session_write_failed');
          }
          return save(...args);
        };
      }
      const ordinaryId = `${userId}-still-active`;
      await restored.executions.createRunning({
        invocationId: ordinaryId,
        parentInvocationId: `parent-${ordinaryId}`,
        userId,
        threadId,
        catId: 'codex',
        executionKind: 'ordinary',
        providerLifecycleTracked: true,
        startedAt: Date.now(),
      });
      await restored.executions.markProviderStarted(ordinaryId, Date.now());
      let modelCalls = 0;
      const supervisor = new WatcherSupervisor({
        ...restored,
        configs,
        userId,
        labels: { list: async () => [] },
        service: () => {
          modelCalls++;
          throw new Error('must not create a model invocation');
        },
        capability: () => ({ supported: false }),
        report: (error) => reports.push(error),
      });
      await supervisor.start();
      try {
        if (cut === 'settlement_rejected') {
          assert.match(String(reports[0]), /watcher_response_not_finalized/);
          assert.equal((await restored.sessions.get(session.id)).watcherState.attempt.phase, 'finalize_pending');
        }
        if (cut === 'before_marker_clear') {
          assert.match(String(reports[0]), /fixture_last_session_write_failed/);
          assert.equal((await restored.executions.get(auth.invocationId)).responseSettlement.kind, 'no_response');
          assert.equal((await restored.executions.listResponsePending()).length, 0);
          assert.equal(
            (await restored.executions.listRunningByUser(userId)).filter((r) => r.executionKind === 'watcher').length,
            0,
          );
          assert.equal((await restored.sessions.listPendingWatcherSessions(userId)).length, 1);
        }
        await supervisor.poll();
        const result = await restored.executions.get(auth.invocationId);
        assert.equal(result.status, 'succeeded');
        assert.equal(result.responseSettlement.kind, 'no_response');
        assert.equal((await restored.registry.peekRecord(auth.invocationId)).state, 'completed');
        assert.equal((await restored.registry.verify(auth.invocationId, auth.callbackToken)).ok, false);
        const final = parseWatcherSessionState((await restored.sessions.get(session.id)).watcherState);
        assert.equal(final.attempt, undefined);
        assert.equal(final.wakeInvocationId, undefined);
        assert.deepEqual(await restored.sessions.listPendingWatcherSessions(userId), []);
        assert.equal(final.notes, 'kept-notes');
        assert.equal(final.afterSequence, source.settledSequence);
        const settled = (await restored.executions.listSettled({ userId, threadId, limit: 50 })).records.filter(
          (record) => record.executionKind === 'watcher',
        );
        assert.deepEqual(
          settled.map((record) => record.invocationId),
          [auth.invocationId],
        );
        assert.equal(settled[0].watcherUsage.outputTokens, 7);
        assert.equal(modelCalls, 0);
        assert.equal((await restored.executions.get(ordinaryId)).status, 'running');
        await supervisor.poll();
        assert.equal((await restored.executions.listSettled({ userId, threadId, limit: 50 })).records.length, 2);
        assert.equal(reports.length, ['settlement_rejected', 'before_marker_clear'].includes(cut) ? 1 : 0);
      } finally {
        await supervisor.stop();
      }
    },
  );
}
