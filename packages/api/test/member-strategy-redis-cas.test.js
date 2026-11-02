import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Redis } from 'ioredis';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const redisUrl = process.env.REDIS_URL;
const skip = redisIsolationSkipReason(redisUrl) || undefined;

test('two independent strategy owners cannot both commit the same Redis revision', { skip }, async (t) => {
  assertRedisIsolationOrThrow(redisUrl, t.name);
  const keyPrefix = `member-strategy-cas:${randomUUID()}:`;
  const clients = [new Redis(redisUrl, { keyPrefix }), new Redis(redisUrl, { keyPrefix })];
  t.after(() => Promise.all(clients.map((client) => client.quit())));
  const [one, two] = await Promise.all(
    ['one', 'two'].map(
      (owner) => import(`../dist/config/session-strategy-overrides.js?owner=${owner}-${randomUUID()}`),
    ),
  );
  await one.initRuntimeOverrides(clients[0]);
  const before = await one.setRuntimeOverride('member', { strategy: 'compress' }, 'none');
  await two.initRuntimeOverrides(clients[1]);
  const writes = await Promise.allSettled([
    one.setRuntimeOverride('member', { strategy: 'handoff' }, before.revision),
    two.setRuntimeOverride('member', { strategy: 'hybrid' }, before.revision),
  ]);
  assert.equal(writes.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = writes.find((result) => result.status === 'rejected');
  assert.equal(rejected?.reason.statusCode, 409);
  const stored = JSON.parse(await clients[0].get('session-strategy:override:member'));
  const accepted = writes.find((result) => result.status === 'fulfilled');
  assert.equal(stored.revision, accepted.value.revision);
  console.log(`Retained isolated strategy evidence: ${keyPrefix}`);
});

test('a Redis edit after GET but before the Lua commit cannot be overwritten', { skip }, async (t) => {
  assertRedisIsolationOrThrow(redisUrl, t.name);
  const keyPrefix = `member-strategy-cas-race:${randomUUID()}:`;
  const client = new Redis(redisUrl, { keyPrefix });
  const other = new Redis(redisUrl, { keyPrefix });
  t.after(() => Promise.all([client.quit(), other.quit()]));
  const owner = await import(`../dist/config/session-strategy-overrides.js?owner=race-${randomUUID()}`);
  await owner.initRuntimeOverrides(client);
  const before = await owner.setRuntimeOverride('member', { strategy: 'compress' }, 'none');
  const realEval = client.eval.bind(client);
  const concurrent = { config: { strategy: 'hybrid' }, revision: randomUUID(), changedAt: Date.now() };
  client.eval = async (...args) => {
    await other.set('session-strategy:override:member', JSON.stringify(concurrent));
    return realEval(...args);
  };
  await assert.rejects(owner.setRuntimeOverride('member', { strategy: 'handoff' }, before.revision), {
    statusCode: 409,
  });
  assert.deepEqual(JSON.parse(await other.get('session-strategy:override:member')), concurrent);
  console.log(`Retained isolated strategy evidence: ${keyPrefix}`);
});
