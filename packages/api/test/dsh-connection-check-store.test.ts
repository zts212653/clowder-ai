import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { RedisDshMemberConnectionCheckStore } from '../src/domains/cats/services/stores/redis/RedisDshMemberConnectionCheckStore.js';

test('started facts survive restart and replay cannot begin the same billable attempt again', async () => {
  const values = new Map<string, string>();
  const redis = {
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string, mode?: string) => {
      if (mode === 'NX' && values.has(key)) return null;
      values.set(key, value);
      return 'OK';
    },
  } as unknown as RedisClient;
  const first = new RedisDshMemberConnectionCheckStore(redis);
  const fact = {
    catId: 'fixture',
    attemptId: 'first',
    effectiveFingerprint: 'config-v1',
    toolManifestHash: 'tools-v1',
    phase: 'started' as const,
    startedAt: 1,
  };
  assert.equal(await first.start('owner-project', fact), true);
  const restarted = new RedisDshMemberConnectionCheckStore(redis);
  assert.deepEqual(await restarted.latest('owner-project'), fact);
  assert.equal(await restarted.start('owner-project', fact), false);
  const next = { ...fact, attemptId: 'second', effectiveFingerprint: 'config-v2' };
  assert.equal(await restarted.start('owner-project', next), true);
  await first.finish('owner-project', { ...fact, phase: 'terminal', outcome: 'failed' });
  assert.deepEqual(
    await restarted.latest('owner-project'),
    next,
    'late old replies cannot replace the current attempt',
  );
  assert.equal(await restarted.latest('different-owner'), null);
  assert.equal((await restarted.attempt('owner-project', 'first'))?.outcome, 'failed');
});
