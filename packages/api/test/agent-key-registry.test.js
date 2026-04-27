import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

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
