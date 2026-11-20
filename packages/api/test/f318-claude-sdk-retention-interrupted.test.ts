import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentSessionMutex } from '../src/domains/cats/services/agents/invocation/AgentSessionMutex.js';
import { retentionProbeAttemptRef } from '../src/domains/cats/services/session/cache/cache-retention-receipt.js';
import { recoverRetentionReceipt } from '../src/domains/cats/services/session/cache/cache-retention-return.js';
import type { RetentionWindow } from '../src/domains/cats/services/session/cache/cache-retention-state.js';
import {
  retentionCoordinatorFixture as fixture,
  settledRetentionTick,
} from './helpers/f338-retention-coordinator-fixture.js';
import { retentionProbeFixture } from './helpers/f338-retention-probe-fixture.js';
import { redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const opts = { skip: redisIsolationSkipReason(process.env.REDIS_URL) };

for (const conflict of ['none', 'late_completion', 'close', 'stop_conflict', 'stop_unconfirmed'] as const)
  test(`F338: orphan recovery stops before reading a durable result (${conflict})`, opts, async (t) => {
    const f = await fixture(t);
    await f.enable();
    const settle = f.store.settleReceipt.bind(f.store),
      save = f.store.save.bind(f.store);
    let atReceipt!: () => void,
      release!: () => void,
      block = true,
      raced = false,
      rejectStop = conflict === 'stop_unconfirmed',
      rawReads = 0;
    const arrived = new Promise<void>((resolve) => {
      atReceipt = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.mock.method(f.store, 'settleReceipt', async (...args: Parameters<typeof settle>) => {
      if (block) {
        block = false;
        atReceipt();
        await gate;
      }
      return settle(...args);
    });
    try {
      await f.coordinator.tick();
      await arrived;
      const [claim] = await f.store.recent();
      assert.ok(claim && claim.state === 'retaining' && !claim.attempt?.completed);
      assert.ok(await f.redis.get(`fixture:maintenance-receipt:${claim.attempt.id}`), 'raw result is durable');
      const read = f.redis.get.bind(f.redis);
      t.mock.method(f.redis, 'get', async (...args: Parameters<typeof read>) => {
        if (args[0] === `fixture:maintenance-receipt:${claim.attempt!.id}`) {
          rawReads++;
          assert.equal((await f.store.get(claim.id))?.state, 'stopped', 'stop must commit before raw recovery');
        }
        return read(...args);
      });
      if (conflict === 'close') {
        await f.settings.set('owner', 'opus55', false);
        await f.coordinator.preferenceChanged('owner', 'opus55');
      }
      t.mock.method(f.store, 'save', async (...args: Parameters<typeof save>) => {
        if (rejectStop && args[0].reason === 'interrupted_attempt_cost_unknown') return false;
        if (!raced && args[0].reason === 'interrupted_attempt_cost_unknown') {
          raced = true;
          if (conflict === 'late_completion') {
            release();
            await f.coordinator.settleActive();
          } else if (conflict === 'stop_conflict') return false;
        }
        return save(...args);
      });
      const restarted = f.restart();
      f.time(60);
      await settledRetentionTick(restarted);
      if (rejectStop) {
        assert.equal(rawReads, 0, 'a refused stop cannot be bypassed with a raw receipt');
        assert.equal((await f.store.get(claim.id))?.attempt?.completed, false);
        assert.equal(f.queries(), 1);
        assert.notEqual(await f.redis.zscore('cache-retention:reconciliation', claim.id), null);
        rejectStop = false;
        await settledRetentionTick(restarted);
      }
      const recovered = await f.store.get(claim.id);
      assert.equal(recovered?.state, 'stopped', 'raw usage cannot grant permission to resume an orphan');
      assert.equal(recovered.reason, conflict === 'close' ? 'preference_changed' : 'interrupted_attempt_cost_unknown');
      assert.equal(recovered.attempt?.completed, true, 'the same input can still be accounted');
      assert.equal(recovered.receipts.length, 1);
      assert.notEqual(await f.redis.zscore('cache-retention:reconciliation', claim.id), null);
      release();
      await f.coordinator.settleActive();
      f.time(100);
      await settledRetentionTick(restarted);
      assert.equal(f.queries(), 1, 'T100 cannot create another input after interrupted ownership');
      await f.returnUsage('after-orphan', 90_000, 101);
      f.time(101);
      await settledRetentionTick(f.restart());
      await settledRetentionTick(restarted);
      assert.equal((await f.store.get(claim.id))?.returned?.maintenanceInvocationId, 'maintenance-1');
      assert.equal((await f.store.health('owner', 'opus55', 'parent'))?.consecutiveCold, 1);
      assert.equal(f.queries(), 1);
    } finally {
      release();
      await f.coordinator.settleActive();
    }
  });

test('F338: a real durable Probe result with unconfirmed teardown is accounting evidence only', opts, async (t) => {
  const f = await fixture(t, { admitSource: false });
  const p = await retentionProbeFixture(t);
  const scope = {
    userId: 'owner',
    catId: 'haiku55',
    threadId: 'thread',
    sessionId: 'session',
    nativeSessionId: 'native-parent',
    sourceInvocationId: 'source',
    attemptId: 'teardown-incomplete',
  };
  // Only this isolated fixture's in-process locks survive the simulated abrupt cleanup failure.
  t.after(() => agentSessionMutex.forceReleaseByScope(scope));
  t.mock.method(p.executions, 'recordProviderTeardown', async () => {
    throw new Error('teardown-not-persisted');
  });
  await assert.rejects(
    p.run({ attemptId: scope.attemptId, captureReturnBoundary: async () => 1 }),
    /teardown-not-persisted/,
  );
  const [execution] = await p.executions.listByParent(retentionProbeAttemptRef(scope));
  assert.ok(execution && execution.status === 'running' && execution.providerTeardownAt === undefined);
  const window: RetentionWindow = {
    ...scope,
    id: 'unconfirmed-native-cleanup',
    revision: 1,
    source: p.record.lastUsage!.cacheObservation!,
    sourceInputSequence: 1,
    preferenceRevision: 1,
    dueAt: Date.now(),
    retainUntil: Date.now() + 2 * 3_600_000,
    state: 'retaining',
    attempt: { id: scope.attemptId, startedAt: Date.now(), completed: false },
    receipts: [],
  };
  assert.equal(await f.store.save(window, 0), true);
  const recovered = await recoverRetentionReceipt(window, f.store, p.restart());
  assert.equal(recovered.state, 'stopped');
  assert.equal(recovered.reason, 'interrupted_attempt_cost_unknown');
  assert.equal(recovered.receipts[0]?.outcome, 'sample_pass');
  assert.equal(recovered.attempt?.completed, true, 'window accounting can settle independently of teardown truth');
  assert.deepEqual(
    await p.executions.get(execution.invocationId),
    execution,
    'recovery cannot invent terminal/teardown facts',
  );
  assert.equal((await f.store.due(Date.now() + 100 * 60_000)).length, 0);
  assert.equal(p.counters.modelRequests, 1);
});
