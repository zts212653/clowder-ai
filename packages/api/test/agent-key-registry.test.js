import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

class FakeRedis {
  constructor() {
    this.hashes = new Map();
    this.sets = new Map();
    this.values = new Map();
  }

  async hset(key, ...fields) {
    const hash = this.hashes.get(key) ?? new Map();
    for (let i = 0; i < fields.length; i += 2) {
      hash.set(String(fields[i]), String(fields[i + 1]));
    }
    this.hashes.set(key, hash);
    return fields.length / 2;
  }

  async hgetall(key) {
    const hash = this.hashes.get(key);
    if (!hash) return {};
    return Object.fromEntries(hash.entries());
  }

  async hget(key, field) {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async sadd(key, member) {
    const set = this.sets.get(key) ?? new Set();
    const before = set.size;
    set.add(member);
    this.sets.set(key, set);
    return set.size === before ? 0 : 1;
  }

  async srem(key, member) {
    return this.sets.get(key)?.delete(member) ? 1 : 0;
  }

  async smembers(key) {
    return [...(this.sets.get(key) ?? new Set())];
  }

  async pexpireat() {
    return 1;
  }

  async exists(key) {
    return this.hashes.has(key) || this.sets.has(key) || this.values.has(key) ? 1 : 0;
  }

  async set(key, value, expiryMode, ttlMs, setMode) {
    if (expiryMode !== 'PX' || typeof ttlMs !== 'number' || setMode !== 'NX') {
      throw new Error('FakeRedis only supports SET key value PX ttl NX');
    }
    if (this.values.has(key)) return null;
    this.values.set(key, value);
    return 'OK';
  }
}

describe('AgentKeyRegistry', () => {
  test('issue() returns agentKeyId and one-time secret', async () => {
    const { AgentKeyRegistry } = await import('../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
    const registry = new AgentKeyRegistry();
    const result = await registry.issue('bengal', 'user-1');
    assert.ok(result.agentKeyId.startsWith('ak_'));
    assert.ok(typeof result.secret === 'string');
    assert.ok(result.secret.length >= 32);
  });

  test('verify() returns ok:true for valid secret', async () => {
    const { AgentKeyRegistry } = await import('../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
    const registry = new AgentKeyRegistry();
    const { secret } = await registry.issue('bengal', 'user-1');
    const result = await registry.verify(secret);
    assert.equal(result.ok, true);
    assert.equal(result.record.catId, 'bengal');
    assert.equal(result.record.userId, 'user-1');
    assert.equal(result.record.scope, 'user-bound');
  });

  test('verify() returns agent_key_unknown for bad secret', async () => {
    const { AgentKeyRegistry } = await import('../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
    const registry = new AgentKeyRegistry();
    const result = await registry.verify('bad-secret');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'agent_key_unknown');
  });

  test('verify() returns agent_key_expired after TTL', async () => {
    const { AgentKeyRegistry } = await import('../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
    const registry = new AgentKeyRegistry({ ttlMs: 1 });
    const { secret } = await registry.issue('bengal', 'user-1');
    await new Promise((r) => setTimeout(r, 10));
    const result = await registry.verify(secret);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'agent_key_expired');
  });

  test('revoke() makes verify() return agent_key_revoked', async () => {
    const { AgentKeyRegistry } = await import('../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
    const registry = new AgentKeyRegistry();
    const { agentKeyId, secret } = await registry.issue('bengal', 'user-1');
    const revoked = await registry.revoke(agentKeyId, 'test revocation');
    assert.ok(revoked);
    const result = await registry.verify(secret);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'agent_key_revoked');
  });

  test('rotate() issues new key and old key enters grace', async () => {
    const { AgentKeyRegistry } = await import('../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
    const registry = new AgentKeyRegistry();
    const old = await registry.issue('bengal', 'user-1');
    const rotated = await registry.rotate(old.agentKeyId);
    assert.ok(rotated.agentKeyId !== old.agentKeyId);
    assert.ok(rotated.agentKeyId.startsWith('ak_'));
    const oldResult = await registry.verify(old.secret);
    assert.equal(oldResult.ok, true);
    const newResult = await registry.verify(rotated.secret);
    assert.equal(newResult.ok, true);
  });

  test('rotate() old key fails after grace expires', async () => {
    const { AgentKeyRegistry } = await import('../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
    const registry = new AgentKeyRegistry({ ttlMs: 100_000, graceMs: 1 });
    const old = await registry.issue('bengal', 'user-1');
    await registry.rotate(old.agentKeyId);
    await new Promise((r) => setTimeout(r, 10));
    const oldResult = await registry.verify(old.secret);
    assert.equal(oldResult.ok, false);
    assert.equal(oldResult.reason, 'agent_key_expired');
  });

  test('list() filters by catId and userId', async () => {
    const { AgentKeyRegistry } = await import('../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
    const registry = new AgentKeyRegistry();
    await registry.issue('bengal', 'user-1');
    await registry.issue('bengal', 'user-2');
    await registry.issue('opus', 'user-1');
    const bengalUser1 = await registry.list({ catId: 'bengal', userId: 'user-1' });
    assert.equal(bengalUser1.length, 1);
    assert.equal(bengalUser1[0].catId, 'bengal');
    const allBengal = await registry.list({ catId: 'bengal' });
    assert.equal(allBengal.length, 2);
  });

  test('list() excludes revoked by default', async () => {
    const { AgentKeyRegistry } = await import('../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
    const registry = new AgentKeyRegistry();
    const { agentKeyId } = await registry.issue('bengal', 'user-1');
    await registry.issue('bengal', 'user-1');
    await registry.revoke(agentKeyId, 'test');
    const active = await registry.list({ catId: 'bengal' });
    assert.equal(active.length, 1);
    const all = await registry.list({ catId: 'bengal', includeRevoked: true });
    assert.equal(all.length, 2);
  });

  test('verify() updates lastUsedAt', async () => {
    const { AgentKeyRegistry } = await import('../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
    const registry = new AgentKeyRegistry();
    const { secret } = await registry.issue('bengal', 'user-1');
    const before = (await registry.list({}))[0].lastUsedAt;
    assert.equal(before, undefined);
    await registry.verify(secret);
    const after = (await registry.list({}))[0].lastUsedAt;
    assert.ok(typeof after === 'number');
  });

  test('secret is never stored — only hash', async () => {
    const { AgentKeyRegistry } = await import('../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
    const registry = new AgentKeyRegistry();
    const { secret } = await registry.issue('bengal', 'user-1');
    const records = await registry.list({});
    assert.equal(records.length, 1);
    assert.ok(records[0].secretHash);
    assert.ok(records[0].salt);
    assert.notEqual(records[0].secretHash, secret);
  });

  test('rotate() rejects expired key', async () => {
    const { AgentKeyRegistry } = await import('../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
    const registry = new AgentKeyRegistry({ ttlMs: 1 });
    const { agentKeyId } = await registry.issue('bengal', 'user-1');
    await new Promise((r) => setTimeout(r, 10));
    await assert.rejects(() => registry.rotate(agentKeyId), /expired/i);
  });

  test('rotated key has rotatedFrom in persisted record', async () => {
    const { AgentKeyRegistry } = await import('../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
    const registry = new AgentKeyRegistry();
    const old = await registry.issue('bengal', 'user-1');
    const rotated = await registry.rotate(old.agentKeyId);
    const newRecord = await registry.get(rotated.agentKeyId);
    assert.equal(newRecord.rotatedFrom, old.agentKeyId);
  });

  test('rotate() rejects key whose grace window already expired', async () => {
    const { AgentKeyRegistry } = await import('../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
    const registry = new AgentKeyRegistry({ ttlMs: 100_000, graceMs: 1 });
    const old = await registry.issue('bengal', 'user-1');
    await registry.rotate(old.agentKeyId);
    await new Promise((r) => setTimeout(r, 10));
    await assert.rejects(() => registry.rotate(old.agentKeyId), /expired/i);
  });

  test('rotate() rejects key already in grace window (no re-rotation)', async () => {
    const { AgentKeyRegistry } = await import('../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
    const registry = new AgentKeyRegistry({ ttlMs: 100_000, graceMs: 60_000 });
    const old = await registry.issue('bengal', 'user-1');
    await registry.rotate(old.agentKeyId);
    await assert.rejects(() => registry.rotate(old.agentKeyId), /already.*grace|cannot rotate/i);
  });

  test('get() returns a clone — mutation does not affect backend', async () => {
    const { AgentKeyRegistry } = await import('../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
    const registry = new AgentKeyRegistry();
    const { agentKeyId, secret } = await registry.issue('bengal', 'user-1');
    const record = await registry.get(agentKeyId);
    record.revokedAt = Date.now();
    record.secretHash = 'tampered';
    const result = await registry.verify(secret);
    assert.equal(result.ok, true);
    const fresh = await registry.get(agentKeyId);
    assert.equal(fresh.revokedAt, undefined);
  });
});

describe('RedisAgentKeyBackend', () => {
  const REDIS_URL = process.env.REDIS_URL;

  if (!REDIS_URL || REDIS_URL.includes(':6399')) {
    test('skipped: REDIS_URL not set or points at 圣域 6399', () => {
      assert.ok(true);
    });
  } else {
    test('a sidecar key issued by one registry verifies from another registry instance', async () => {
      const { createRedisClient } = await import('@cat-cafe/shared/utils');
      const { AgentKeyRegistry } = await import('../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
      const { RedisAgentKeyBackend } = await import(
        '../dist/domains/cats/services/agents/agent-key/RedisAgentKeyBackend.js'
      );

      const redis = createRedisClient({ url: REDIS_URL, keyPrefix: 'cat-cafe-agent-key-registry-test:' });
      try {
        const leftover = await redis.keys('cat-cafe-agent-key-registry-test:*');
        if (leftover.length > 0) {
          await redis.del(...leftover.map((k) => k.replace('cat-cafe-agent-key-registry-test:', '')));
        }

        const issuer = new AgentKeyRegistry({ backend: new RedisAgentKeyBackend(redis) });
        const verifier = new AgentKeyRegistry({ backend: new RedisAgentKeyBackend(redis) });
        const issued = await issuer.issue('antig-opus', 'default-user');

        const result = await verifier.verify(issued.secret);
        assert.equal(result.ok, true);
        if (result.ok) {
          assert.equal(result.record.agentKeyId, issued.agentKeyId);
          assert.equal(result.record.catId, 'antig-opus');
          assert.equal(result.record.userId, 'default-user');
        }
      } finally {
        const leftover = await redis.keys('cat-cafe-agent-key-registry-test:*');
        if (leftover.length > 0) {
          await redis.del(...leftover.map((k) => k.replace('cat-cafe-agent-key-registry-test:', '')));
        }
        await redis.quit();
      }
    });

    test('lazy-cleans expired index members when Redis reaps the record hash', async () => {
      const { createRedisClient } = await import('@cat-cafe/shared/utils');
      const { AgentKeyRegistry } = await import('../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
      const { RedisAgentKeyBackend } = await import(
        '../dist/domains/cats/services/agents/agent-key/RedisAgentKeyBackend.js'
      );

      const redis = createRedisClient({ url: REDIS_URL, keyPrefix: 'cat-cafe-agent-key-registry-test:' });
      try {
        const leftover = await redis.keys('cat-cafe-agent-key-registry-test:*');
        if (leftover.length > 0) {
          await redis.del(...leftover.map((k) => k.replace('cat-cafe-agent-key-registry-test:', '')));
        }

        await redis.sadd('auth:agent-key:index', 'stale-agent-key-id');
        const registry = new AgentKeyRegistry({ backend: new RedisAgentKeyBackend(redis) });

        await registry.verify('not-a-real-secret');
        await registry.list({});

        const isMember = await redis.sismember('auth:agent-key:index', 'stale-agent-key-id');
        assert.equal(isMember, 0);
      } finally {
        const leftover = await redis.keys('cat-cafe-agent-key-registry-test:*');
        if (leftover.length > 0) {
          await redis.del(...leftover.map((k) => k.replace('cat-cafe-agent-key-registry-test:', '')));
        }
        await redis.quit();
      }
    });
  }
});

describe('RedisAgentKeyBackend idempotency', () => {
  test('clientMessageId claims persist across AgentKeyRegistry instances sharing Redis', async () => {
    const { AgentKeyRegistry } = await import('../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
    const { RedisAgentKeyBackend } = await import(
      '../dist/domains/cats/services/agents/agent-key/RedisAgentKeyBackend.js'
    );

    const redis = new FakeRedis();
    const issuer = new AgentKeyRegistry({ backend: new RedisAgentKeyBackend(redis) });
    const verifier = new AgentKeyRegistry({ backend: new RedisAgentKeyBackend(redis) });
    const issued = await issuer.issue('antig-opus', 'default-user');

    assert.equal(await issuer.claimClientMessageId(issued.agentKeyId, 'callback-msg-1'), true);
    assert.equal(await verifier.claimClientMessageId(issued.agentKeyId, 'callback-msg-1'), false);
    assert.equal(await verifier.claimClientMessageId(issued.agentKeyId, 'callback-msg-2'), true);
  });
});
