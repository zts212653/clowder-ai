import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import type { ITurnExecutionStore } from '../src/domains/cats/services/stores/ports/TurnExecutionStore.js';
import { base, retentionCoordinatorFixture } from './helpers/f338-retention-coordinator-fixture.js';
import { redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

for (const backend of ['memory', 'redis'] as const)
  test(
    `F338 ${backend}: input ordering excludes observers, deduplicates entry and preserves a missing first fact`,
    { skip: backend === 'redis' && redisIsolationSkipReason(process.env.REDIS_URL) },
    async (t) => {
      const fixture = backend === 'redis' ? await retentionCoordinatorFixture(t) : null;
      const store: ITurnExecutionStore = fixture ? fixture.executions : new InMemoryTurnExecutionStore();
      const facts = store.cacheFacts!;
      const scope = { userId: 'owner', threadId: 'order', catId: 'opus55' };
      for (const kind of ['watcher', 'cache_retention', 'ordinary'] as const) {
        await store.createRunning({
          ...scope,
          invocationId: kind,
          parentInvocationId: kind,
          executionKind: kind,
          providerLifecycleTracked: true,
          startedAt: base,
        });
        assert.equal(await store.markProviderStarted(kind, base), true);
        assert.equal(await store.markProviderStarted(kind, base + 1), true);
      }
      assert.equal(await facts.head(scope), 1, 'only ordinary input advances the boundary, once');
      assert.equal(await facts.sequenceOf(scope, 'ordinary'), 1);
      assert.equal(await facts.sequenceOf({ ...scope, userId: 'other' }, 'ordinary'), undefined);
      assert.equal(await facts.sequenceOf(scope, 'watcher'), undefined);
      assert.equal((await facts.firstAfter(scope, 0)).status, 'pending');
      await store.transitionTerminal('ordinary', { status: 'failed', endedAt: base + 1, terminalReason: 'fixture' });
      await store.createRunning({
        ...scope,
        invocationId: 'second',
        parentInvocationId: 'second',
        executionKind: 'ordinary',
        providerLifecycleTracked: true,
        startedAt: base + 2,
      });
      await store.markProviderStarted('second', base + 2);
      const value = {
        sessionId: 'parent',
        observation: {
          invocationId: 'second',
          nativeSessionId: 'private-native',
          runtime: 'anthropic:sdk',
          model: 'claude-opus-5-5',
          requestStartedAt: base,
          observedAt: base + 1,
          contextTokens: 100_000,
          compressionCount: 0,
          timeSource: 'invocation_start_lower_bound' as const,
          confirmedWarmGapsMs: [],
          cacheReadTokens: 99_000,
        },
      };
      assert.equal(await facts.recordObservation('second', value), true);
      assert.equal(await facts.recordObservation('second', value), true);
      assert.equal(await facts.recordObservation('second', { ...value, sessionId: 'changed' }), false);
      assert.deepEqual(await facts.firstAfter(scope, 0), { status: 'unknown', invocationId: 'ordinary' });
      assert.equal((await facts.firstAfter(scope, 1)).status, 'observed');
      assert.equal((await facts.firstAfter({ ...scope, userId: 'other' }, 0)).status, 'none');
      assert.equal(
        JSON.stringify(await store.get('second')).includes('private-native'),
        false,
        'public execution projections do not expose native cache identity',
      );
    },
  );
