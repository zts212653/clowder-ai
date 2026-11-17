import assert from 'node:assert/strict';
import { test } from 'node:test';
import Redis from 'ioredis';
import { RedisMessageStore } from '../src/domains/cats/services/stores/redis/RedisMessageStore.js';
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

test('Redis progress and user-requested titles survive fresh detail and list readers without TTL', async (t) => {
  assertRedisIsolationOrThrow(process.env.REDIS_URL, 'Issue #2006 title updates');
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('An isolated Redis URL is required');
  const redis = new Redis(redisUrl);
  t.after(() => redis.quit());
  const store = new RedisThreadStore(redis);
  const thread = await store.create('issue2006-test');
  assert.equal(await store.setAutomaticTitle(thread.id, '排查', 'cat', 'sonnet'), true);
  assert.equal(await store.setAutomaticTitle(thread.id, '修复中', 'cat', 'codex', 'update'), true);
  const fresh = new RedisThreadStore(redis);
  assert.equal((await fresh.get(thread.id))?.title, '修复中');
  assert.equal((await fresh.get(thread.id))?.titleSource, 'cat');
  assert.equal((await fresh.list('issue2006-test')).find((item) => item.id === thread.id)?.title, '修复中');
  assert.equal(await fresh.setUserRequestedTitle(thread.id, '用户要求替换猫标题', 0), 'applied');
  assert.equal((await new RedisThreadStore(redis).get(thread.id))?.titleCatId, undefined);
  await store.updateTitle(thread.id, '用户手工标题');
  assert.equal(await fresh.setAutomaticTitle(thread.id, '自动覆盖', 'cat', 'codex', 'update'), false);
  assert.equal(await fresh.setUserRequestedTitle(thread.id, 'issue#2006 用户指定标题', 2), 'applied');
  const reloaded = new RedisThreadStore(redis);
  assert.equal((await reloaded.get(thread.id))?.title, 'issue#2006 用户指定标题');
  assert.equal((await reloaded.get(thread.id))?.titleSource, 'user');
  assert.equal((await reloaded.get(thread.id))?.titleCatId, undefined);
  assert.equal(
    (await reloaded.list('issue2006-test')).find((item) => item.id === thread.id)?.title,
    'issue#2006 用户指定标题',
  );
  assert.equal(await reloaded.setAutomaticTitle(thread.id, '后续自动覆盖', 'cat', 'codex', 'update'), false);
  assert.equal(await redis.ttl(`thread:${thread.id}`), -1);
});

test('Redis atomically fences same-name and restored menu decisions and concurrent requested titles', async (t) => {
  assertRedisIsolationOrThrow(process.env.REDIS_URL, 'Issue #2006 protected title revision');
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('An isolated Redis URL is required');
  const redis = new Redis(redisUrl);
  t.after(() => redis.quit());
  const store = new RedisThreadStore(redis);
  const thread = await store.create('issue2006-fence', '原名');
  const messages = new RedisMessageStore(redis);
  const request = {
    from: { kind: 'user' as const, userId: 'issue2006-fence' },
    userId: 'issue2006-fence',
    threadId: thread.id,
    content: '请改名',
    mentions: [],
    timestamp: Date.now(),
    idempotencyKey: 'title-request',
    extra: { userTitleRevisionAtRequest: 0 },
  };
  const source = await messages.append(request);
  assert.equal((await store.get(thread.id))?.userTitleRevision, 0);
  await store.updateTitle(thread.id, '原名');
  assert.equal((await new RedisMessageStore(redis).getById(source.id))?.extra?.userTitleRevisionAtRequest, 0);
  const replay = await messages.append({ ...request, extra: { userTitleRevisionAtRequest: 1 } });
  assert.equal(replay.id, source.id);
  assert.equal(replay.extra?.userTitleRevisionAtRequest, 0);
  assert.equal(await store.setUserRequestedTitle(thread.id, '旧请求', 0), 'revision_conflict');
  await store.updateTitle(thread.id, '其他名字');
  await store.updateTitle(thread.id, '原名');
  assert.equal(await store.setUserRequestedTitle(thread.id, '旧请求', 0), 'revision_conflict');
  const outcomes = await Promise.all([
    store.setUserRequestedTitle(thread.id, '甲', 3),
    store.setUserRequestedTitle(thread.id, '乙', 3),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome === 'applied').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome === 'revision_conflict').length, 1);
  const fresh = new RedisThreadStore(redis);
  assert.equal((await fresh.get(thread.id))?.userTitleRevision, 4);
  assert.equal((await fresh.list('issue2006-fence')).find((item) => item.id === thread.id)?.userTitleRevision, 4);
  assert.equal(await redis.ttl(`thread:${thread.id}`), -1);
  assert.equal(await store.setUserRequestedTitle('missing-issue2006-thread', '新名', 0), 'not_found');
  await redis.hset(`thread:${thread.id}`, 'deletedAt', String(Date.now()));
  assert.equal(await store.setUserRequestedTitle(thread.id, '新名', 4), 'deleted');
});
