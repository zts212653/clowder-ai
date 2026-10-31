import assert from 'node:assert/strict';
import { test } from 'node:test';
import Redis from 'ioredis';
import { RedisSessionChainStore } from '../src/domains/cats/services/stores/redis/RedisSessionChainStore.js';
import { RedisThreadStore } from '../src/domains/cats/services/stores/redis/RedisThreadStore.js';
import { assertRedisIsolationOrThrow } from './helpers/redis-test-helpers.js';

test('Redis title provenance survives reload and a concurrent user rename wins', async () => {
  assertRedisIsolationOrThrow(process.env.REDIS_URL, 'F322 title/import');
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('An isolated Redis URL is required');
  const redis = new Redis(redisUrl);
  try {
    const store = new RedisThreadStore(redis);
    const t = await store.create('f322-test');
    await store.setAutomaticTitle(t.id, '临时名', 'temporary');
    await store.updateTitle(t.id, '临时名');
    assert.equal(await new RedisThreadStore(redis).setAutomaticTitle(t.id, '猫起名', 'cat', 'sonnet'), false);
    assert.equal((await store.get(t.id))?.titleSource, 'user');
    const fresh = await store.create('f322-test');
    const claims = await Promise.all([
      store.setAutomaticTitle(fresh.id, '猫甲', 'cat', 'sonnet'),
      store.setAutomaticTitle(fresh.id, '猫乙', 'cat', 'codex61-sol'),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal((await new RedisThreadStore(redis).get(fresh.id))?.titleSource, 'cat');
    const sessions = new RedisSessionChainStore(redis);
    const session = await sessions.getOrCreateActive({ threadId: fresh.id, catId: 'codex61-sol', userId: 'f322-test' });
    const externalImport = {
      cliSessionId: 'f322-native',
      clientId: 'openai' as const,
      projectPath: '/project',
      firstPrompt: 'first',
      lastActivityAt: 123,
      importedAt: 456,
    };
    await sessions.update(session.id, { externalImport });
    await sessions.bindCliSessionId(session.id, 'f322-native');
    const coordinate = { sessionId: session.id, catId: 'codex61-sol' };
    await store.setSessionImport(fresh.id, coordinate);
    assert.deepEqual((await new RedisThreadStore(redis).get(fresh.id))?.sessionImport, coordinate);
    assert.deepEqual(
      (await new RedisSessionChainStore(redis).getByCliSessionId('f322-native'))?.externalImport,
      externalImport,
    );
    const indexedClaims = await new RedisSessionChainStore(redis).getCliSessionBindings([
      'f322-native',
      'missing',
      'f322-native',
    ]);
    assert.equal(indexedClaims.size, 1);
    assert.equal(indexedClaims.get('f322-native')?.threadId, fresh.id);
    assert.equal(indexedClaims.get('f322-native')?.catId, 'codex61-sol');
    assert.equal(indexedClaims.get('f322-native')?.isExternalImport, true);
    assert.equal(await redis.ttl(`thread:${fresh.id}`), -1);
  } finally {
    await redis.quit();
  }
});
