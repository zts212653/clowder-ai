import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('createRuntimeSessionStore', () => {
  test('returns in-memory store without Redis', async () => {
    const { createRuntimeSessionStore } = await import(
      '../dist/domains/cats/services/runtime-session/RuntimeSessionStoreFactory.js'
    );
    const { RuntimeSessionStore } = await import(
      '../dist/domains/cats/services/runtime-session/RuntimeSessionStore.js'
    );

    assert.ok(createRuntimeSessionStore() instanceof RuntimeSessionStore);
  });

  test('returns Redis store when Redis client is provided', async () => {
    const { createRuntimeSessionStore } = await import(
      '../dist/domains/cats/services/runtime-session/RuntimeSessionStoreFactory.js'
    );
    const { RedisRuntimeSessionStore } = await import(
      '../dist/domains/cats/services/runtime-session/RedisRuntimeSessionStore.js'
    );

    const fakeRedis = { options: {} };
    assert.ok(createRuntimeSessionStore(fakeRedis) instanceof RedisRuntimeSessionStore);
  });
});
