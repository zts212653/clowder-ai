import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { AgentKeyRegistry } from '../src/domains/cats/services/agents/agent-key/AgentKeyRegistry.js';
import { RedisAgentKeyBackend } from '../src/domains/cats/services/agents/agent-key/RedisAgentKeyBackend.js';

class IsolatedRedis {
  readonly hashes = new Map<string, Record<string, string>>();
  readonly sets = new Map<string, Set<string>>();
  readonly expiries = new Map<string, number>();
  async hset(key: string, ...values: Array<string | number>) {
    const hash = this.hashes.get(key) ?? {};
    for (let i = 0; i < values.length; i += 2) hash[String(values[i])] = String(values[i + 1]);
    this.hashes.set(key, hash);
    return values.length / 2;
  }
  async hgetall(key: string) {
    if ((this.expiries.get(key) ?? Infinity) <= Date.now()) this.hashes.delete(key);
    return { ...this.hashes.get(key) };
  }
  async sadd(key: string, value: string) {
    const set = this.sets.get(key) ?? new Set<string>();
    set.add(value);
    this.sets.set(key, set);
    return 1;
  }
  async smembers(key: string) {
    return [...(this.sets.get(key) ?? [])];
  }
  async srem(key: string, value: string) {
    return this.sets.get(key)?.delete(value) ? 1 : 0;
  }
  async exists(key: string) {
    return this.hashes.has(key) ? 1 : 0;
  }
  async pexpireat(key: string, value: number) {
    this.expiries.set(key, value);
    return 1;
  }
  async set() {
    return 'OK';
  }
}

test('explicit persistent keys survive Redis rehydration; rotation grace and revocation still fence them', async () => {
  let now = Date.now();
  const clock = mock.method(Date, 'now', () => now);
  try {
    const redis = new IsolatedRedis();
    const registry = new AgentKeyRegistry({ backend: new RedisAgentKeyBackend(redis as unknown as RedisClient) });
    const issued = await registry.issue(createCatId('gpt-dot'), 'owner', { expiresAt: null });
    const key = `auth:agent-key:${issued.agentKeyId}`;
    assert.equal(redis.expiries.has(key), false, 'persistent service keys have no Redis reaper TTL');
    assert.equal((await registry.get(issued.agentKeyId))?.expiresAt, null);
    const defaultKey = await registry.issue(createCatId('gpt-pro'), 'owner');
    assert.equal(redis.expiries.has(`auth:agent-key:${defaultKey.agentKeyId}`), true);
    now += 46 * 24 * 60 * 60_000;
    const freshReader = new AgentKeyRegistry({ backend: new RedisAgentKeyBackend(redis as unknown as RedisClient) });
    assert.equal((await freshReader.verify(issued.secret)).ok, true);
    assert.equal((await freshReader.verify(defaultKey.secret)).ok, false);
    const rotated = await freshReader.rotate(issued.agentKeyId);
    assert.equal((await freshReader.get(rotated.agentKeyId))?.expiresAt, null);
    assert.equal(redis.expiries.has(key), true, 'the old permanent key enters an expiring rotation grace');
    now += 25 * 60 * 60_000;
    assert.equal((await freshReader.verify(issued.secret)).ok, false);
    assert.equal((await freshReader.verify(rotated.secret)).ok, true);
    await freshReader.revoke(rotated.agentKeyId, 'owner_disconnect');
    assert.equal(redis.expiries.has(`auth:agent-key:${rotated.agentKeyId}`), true, 'retired credentials are reaped');
    assert.equal((await freshReader.verify(rotated.secret)).ok, false);
    now += 61_000;
    assert.equal(await freshReader.get(rotated.agentKeyId), null);
    await freshReader.list({ includeRevoked: true });
    assert.equal(redis.sets.get('auth:agent-key:index')?.has(rotated.agentKeyId), false);
  } finally {
    clock.mock.restore();
  }
});
