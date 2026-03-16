/**
 * InvocationRegistry Tests
 * 测试 MCP 回传鉴权的 invocation 注册和验证
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('InvocationRegistry', () => {
  test('create() returns invocationId and callbackToken', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    const result = registry.create('user-1', 'opus');

    assert.ok(typeof result.invocationId === 'string');
    assert.ok(typeof result.callbackToken === 'string');
    assert.ok(result.invocationId.length > 0);
    assert.ok(result.callbackToken.length > 0);
  });

  test('verify() returns record for valid credentials', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    const record = registry.verify(invocationId, callbackToken);
    assert.ok(record !== null);
    assert.equal(record.userId, 'user-1');
    assert.equal(record.catId, 'opus');
    assert.equal(record.invocationId, invocationId);
    assert.equal(record.callbackToken, callbackToken);
  });

  test('verify() returns null for wrong token', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    const { invocationId } = registry.create('user-1', 'opus');

    const record = registry.verify(invocationId, 'wrong-token');
    assert.equal(record, null);
  });

  test('verify() returns null for unknown invocationId', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    registry.create('user-1', 'opus');

    const record = registry.verify('unknown-id', 'any-token');
    assert.equal(record, null);
  });

  test('verify() returns null for expired invocation', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    // Use very short TTL
    const registry = new InvocationRegistry({ ttlMs: 1 });
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    // Wait for expiry
    await new Promise((resolve) => setTimeout(resolve, 10));

    const record = registry.verify(invocationId, callbackToken);
    assert.equal(record, null);
  });

  test('LRU eviction removes oldest unused when at capacity', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry({ maxRecords: 3 });

    const first = registry.create('user-1', 'opus');
    registry.create('user-2', 'codex');
    registry.create('user-3', 'gemini');

    // Adding a 4th should evict first (oldest, never verified/refreshed)
    registry.create('user-4', 'opus');
    assert.equal(registry.verify(first.invocationId, first.callbackToken), null);
  });

  test('verify() refreshes recency (true LRU)', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry({ maxRecords: 3 });

    const first = registry.create('user-1', 'opus');
    const second = registry.create('user-2', 'codex');
    const _third = registry.create('user-3', 'gemini');

    // Access first — refreshes its recency, making second the oldest
    assert.ok(registry.verify(first.invocationId, first.callbackToken) !== null);

    // Adding a 4th should evict second (oldest unused), not first (recently verified)
    registry.create('user-4', 'opus');
    assert.ok(
      registry.verify(first.invocationId, first.callbackToken) !== null,
      'first should survive (recently used)',
    );
    assert.equal(
      registry.verify(second.invocationId, second.callbackToken),
      null,
      'second should be evicted (oldest unused)',
    );
  });

  test('multiple creates produce unique IDs', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    const r1 = registry.create('user-1', 'opus');
    const r2 = registry.create('user-1', 'opus');

    assert.notEqual(r1.invocationId, r2.invocationId);
    assert.notEqual(r1.callbackToken, r2.callbackToken);
  });

  test('claimClientMessageId() deduplicates per invocation', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    const { invocationId } = registry.create('user-1', 'opus');

    assert.equal(registry.claimClientMessageId(invocationId, 'msg-1'), true);
    assert.equal(registry.claimClientMessageId(invocationId, 'msg-1'), false);
    assert.equal(registry.claimClientMessageId(invocationId, 'msg-2'), true);
  });

  test('claimClientMessageId() scopes ids to each invocation', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    const first = registry.create('user-1', 'opus');
    const second = registry.create('user-1', 'opus');

    assert.equal(registry.claimClientMessageId(first.invocationId, 'same-id'), true);
    assert.equal(registry.claimClientMessageId(second.invocationId, 'same-id'), true);
  });

  // --- isLatest() freshness guard (cloud Codex P1 + 缅因猫 R3) ---

  test('isLatest() returns true for the most recent invocation per thread+cat', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    const { invocationId } = registry.create('user-1', 'opus', 'thread-1');
    assert.equal(registry.isLatest(invocationId), true);
  });

  test('isLatest() returns false for a superseded invocation (same thread+cat)', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    const { invocationId: oldId } = registry.create('user-1', 'opus', 'thread-1');
    const { invocationId: newId } = registry.create('user-1', 'opus', 'thread-1');

    assert.equal(registry.isLatest(oldId), false, 'old invocation should be stale');
    assert.equal(registry.isLatest(newId), true, 'new invocation should be latest');
  });

  test('isLatest() tracks different cats independently on same thread', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    const { invocationId: opusId } = registry.create('user-1', 'opus', 'thread-1');
    const { invocationId: codexId } = registry.create('user-1', 'codex', 'thread-1');

    assert.equal(registry.isLatest(opusId), true, 'opus should be latest');
    assert.equal(registry.isLatest(codexId), true, 'codex should be latest');

    // Supersede opus only
    const { invocationId: opusId2 } = registry.create('user-1', 'opus', 'thread-1');
    assert.equal(registry.isLatest(opusId), false, 'old opus should be stale');
    assert.equal(registry.isLatest(opusId2), true, 'new opus should be latest');
    assert.equal(registry.isLatest(codexId), true, 'codex should be unaffected');
  });

  test('isLatest() tracks different threads independently for same cat', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    const { invocationId: t1Id } = registry.create('user-1', 'opus', 'thread-1');
    const { invocationId: t2Id } = registry.create('user-1', 'opus', 'thread-2');

    assert.equal(registry.isLatest(t1Id), true);
    assert.equal(registry.isLatest(t2Id), true);
  });

  test('isLatest() returns false for unknown invocationId', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    assert.equal(registry.isLatest('nonexistent-id'), false);
  });

  // --- latestByThreadCat cleanup (缅因猫 P2) ---

  test('latestByThreadCat cleans up on TTL expiry', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry({ ttlMs: 1 });
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', 'thread-1');
    assert.equal(registry.isLatest(invocationId), true);

    // Wait for TTL expiry
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Trigger TTL cleanup via verify() with correct token (reaches TTL check)
    const result = registry.verify(invocationId, callbackToken);
    assert.equal(result, null, 'expired record should fail verify');

    // isLatest should now return false (record gone + pointer cleaned)
    assert.equal(registry.isLatest(invocationId), false);
  });

  test('latestByThreadCat cleans up on LRU eviction', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry({ maxRecords: 2 });
    const { invocationId: firstId } = registry.create('user-1', 'opus', 'thread-1');
    registry.create('user-2', 'codex', 'thread-2');

    assert.equal(registry.isLatest(firstId), true);

    // Adding a 3rd evicts the oldest (firstId)
    registry.create('user-3', 'gemini', 'thread-3');

    // firstId should no longer be latest (evicted)
    assert.equal(registry.isLatest(firstId), false);
  });

  test('latestByThreadCat cleanup does not remove superseded pointer', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry({ maxRecords: 3 });

    // Create old opus invocation, then new opus invocation (supersedes old)
    const { invocationId: oldId } = registry.create('user-1', 'opus', 'thread-1');
    const { invocationId: newId } = registry.create('user-1', 'opus', 'thread-1');

    assert.equal(registry.isLatest(oldId), false);
    assert.equal(registry.isLatest(newId), true);

    // Fill capacity to evict oldId (it's the oldest)
    registry.create('user-2', 'codex', 'thread-2');
    registry.create('user-3', 'gemini', 'thread-3');

    // newId's latest pointer should NOT have been cleaned up by oldId's eviction
    assert.equal(
      registry.isLatest(newId),
      true,
      'latest pointer must survive when evicted record was already superseded',
    );
  });

  // --- Sliding window TTL renewal (F-Ground-1 pre: TTL 止血) ---

  test('verify() extends expiresAt (sliding window)', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    // 50ms TTL — short enough to test, long enough to not flake
    const registry = new InvocationRegistry({ ttlMs: 50 });
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    // Wait 30ms (past 60% of TTL), then verify to renew
    await new Promise((resolve) => setTimeout(resolve, 30));
    const record = registry.verify(invocationId, callbackToken);
    assert.ok(record !== null, 'should still be valid at 30ms');

    // Wait another 30ms (60ms total from create, but only 30ms since renewal)
    await new Promise((resolve) => setTimeout(resolve, 30));
    const record2 = registry.verify(invocationId, callbackToken);
    assert.ok(record2 !== null, 'sliding window should have extended TTL');
  });

  test('first callback after long delay succeeds with 2h TTL', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    // Simulate: cat runs for 30 min before first callback
    // We can't wait 30 min, so use default TTL and verify it's 2h
    const registry = new InvocationRegistry();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    // Verify the record's expiresAt is ~2h from now (not 10 min)
    const record = registry.verify(invocationId, callbackToken);
    assert.ok(record !== null);
    const remainingMs = record.expiresAt - Date.now();
    // Should be close to 2h (allow 5s tolerance for test execution)
    assert.ok(remainingMs > 2 * 60 * 60 * 1000 - 5000, `TTL should be ~2h, got ${Math.round(remainingMs / 1000)}s`);
  });

  // --- F108 fix: parentInvocationId propagation ---

  test('create() stores parentInvocationId in record when provided', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', 'thread-1', 'parent-inv-123');

    const record = registry.verify(invocationId, callbackToken);
    assert.ok(record !== null);
    assert.equal(record.parentInvocationId, 'parent-inv-123');
  });

  test('create() omits parentInvocationId from record when not provided', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', 'thread-1');

    const record = registry.verify(invocationId, callbackToken);
    assert.ok(record !== null);
    assert.equal(record.parentInvocationId, undefined);
  });

  test('stale invocation still rejected despite sliding window', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    const old = registry.create('user-1', 'opus', 'thread-1');
    // Supersede with a new invocation
    registry.create('user-1', 'opus', 'thread-1');

    // Old invocation can still verify() (token is valid)...
    const record = registry.verify(old.invocationId, old.callbackToken);
    assert.ok(record !== null, 'old token still valid');
    // ...but isLatest() correctly rejects it
    assert.equal(
      registry.isLatest(old.invocationId),
      false,
      'stale invocation must be rejected by isLatest even if verify succeeds',
    );
  });
});
