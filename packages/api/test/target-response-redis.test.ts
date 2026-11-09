import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RedisMessageStore } from '../src/domains/cats/services/stores/redis/RedisMessageStore.js';
import { advanceTargetResponse } from '../src/domains/messaging/target-response/state.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const fixture = ownedRedisFixture('f202-target-response');
test('target response CAS preserves terminal truth across restart, conflict and generic metadata writers', async () => {
  const redis = fixture.client('response:');
  await redis.connect();
  const store = new RedisMessageStore(redis, { ttlSeconds: 0 });
  const row = await store.append({
    threadId: 'thread',
    userId: 'system',
    from: { kind: 'system', service: 'plugin_delivery' },
    content: 'delivery',
    timestamp: 1,
    mentions: [],
    extra: {
      targetResponse: {
        v: 1,
        revision: 1,
        inputMessageId: 'input',
        targetId: 'pi_a',
        execution: { kind: 'plugin', id: 'ad_owned' },
        status: 'delivering',
        startedAt: 1,
        updatedAt: 1,
      },
    },
  });
  await advanceTargetResponse(store, row.id, { status: 'waiting' });
  const completed = await advanceTargetResponse(store, row.id, { status: 'completed', resultMessageId: 'result' });
  await advanceTargetResponse(store, row.id, { status: 'waiting' });
  assert.equal((await store.getById(row.id))?.extra?.targetResponse?.status, 'completed');
  assert.equal(
    await store.compareAndSetTargetResponse(row.id, 1, {
      ...completed.extra!.targetResponse!,
      revision: 2,
      status: 'processing',
    }),
    null,
  );
  await store.updateExtra(row.id, {
    targetResponse: row.extra!.targetResponse,
    pluginAddressedReceipt: { inputMessageId: 'input', targetId: 'pi_a', accepted: true, phase: 'accepted' },
  });
  const restored = await new RedisMessageStore(redis, { ttlSeconds: 0 }).getById(row.id);
  assert.deepEqual(restored?.extra?.targetResponse, completed.extra?.targetResponse);
  assert.equal(restored?.extra?.pluginAddressedReceipt?.accepted, true);
  const late = await advanceTargetResponse(store, row.id, { status: 'failed', resultMessageId: 'another' });
  assert.deepEqual(late.extra?.targetResponse, completed.extra?.targetResponse);
});
