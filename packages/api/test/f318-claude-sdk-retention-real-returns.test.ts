import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcileRetentionReturn } from '../src/domains/cats/services/session/cache/cache-retention-return.js';
import type { RetentionWindow } from '../src/domains/cats/services/session/cache/cache-retention-state.js';
import { RedisTurnExecutionStore } from '../src/domains/cats/services/stores/redis/RedisTurnExecutionStore.js';
import { normalReturnFixture } from './helpers/f338-normal-return-fixture.js';
import { retentionCoordinatorFixture } from './helpers/f338-retention-coordinator-fixture.js';
import { redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

for (const gap of ['none', 'native_usage', 'fact_storage'] as const)
  test(
    `F338 real normal Host entry: first done is stable across later calls and restart (gap=${gap})`,
    { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
    async (t) => {
      const f = await retentionCoordinatorFixture(t);
      const host = await normalReturnFixture(t, f.executions);
      if (gap === 'fact_storage') {
        const persist = f.executions.cacheFacts.recordObservation.bind(f.executions.cacheFacts);
        let first = true;
        f.executions.cacheFacts.recordObservation = async (id, value) => {
          if (first) {
            first = false;
            throw new Error('fixture cache fact storage unavailable');
          }
          return persist(id, value);
        };
      }
      const frontier = await f.executions.cacheFacts.head(host.scope);
      const window: RetentionWindow = {
        id: 'real-host-window',
        revision: 1,
        ...host.scope,
        sessionId: host.record.id,
        nativeSessionId: 'native-parent',
        source: host.source,
        sourceInputSequence: frontier,
        preferenceRevision: 1,
        dueAt: Date.now(),
        retainUntil: Date.now() + 3_600_000,
        state: 'waiting',
        receipts: [
          {
            v: 1,
            invocationId: 'maintenance',
            sourceInvocationId: 'source',
            sessionId: host.record.id,
            parentNativeSessionId: 'native-parent',
            startedAt: Date.now() - 1000,
            endedAt: Date.now() - 1,
            returnAfterSequence: frontier,
            outcome: 'sample_pass',
            toolAttempts: 0,
            canonicalParentUnchanged: true,
            readRatio: 1,
            writeTokens: 1,
          },
        ],
      };
      await f.store.save(window, 0);
      const first = await host.run(0.9, gap === 'native_usage');
      const second = await host.run(0.99);
      assert.equal(host.entries(), 3, 'both real invocation entry points reached the fake SDK');
      assert.equal(second?.cacheReadTokens, 99_000);
      assert.equal(host.observations.length, gap === 'native_usage' ? 2 : 3, 'final done reaches metadata enrollment');
      if (gap !== 'native_usage') assert.ok(host.observations.includes(first!.invocationId));
      const restarted = new RedisTurnExecutionStore(f.redis);
      await reconcileRetentionReturn(window, f.store, restarted.cacheFacts);
      const saved = (await f.store.get(window.id))!;
      assert.equal(saved.state, 'stopped', 'unknown accounting also ends maintenance eligibility');
      await reconcileRetentionReturn(saved, f.store, restarted.cacheFacts);
      if (gap !== 'none') {
        assert.equal(saved.returned, undefined);
        assert.equal(saved.returnUnknown, 'first_return_unproven');
        assert.equal(await f.store.health('owner', 'opus', host.record.id), null);
      } else {
        assert.equal(saved.returned?.invocationId, first?.invocationId);
        assert.equal(saved.returned?.readRatio, 0.9);
        assert.equal((await f.store.health('owner', 'opus', host.record.id))?.consecutiveCold, 1);
      }
    },
  );
