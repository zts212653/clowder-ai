/**
 * InvocationRegistry Tests
 * 测试 MCP 回传鉴权的 invocation 注册和验证
 *
 * F174 Phase B — registry methods are async (backend swappable to Redis).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('InvocationRegistry', () => {
  test('create() returns invocationId and callbackToken', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    const result = await registry.create('user-1', 'opus');

    assert.ok(typeof result.invocationId === 'string');
    assert.ok(typeof result.callbackToken === 'string');
    assert.ok(result.invocationId.length > 0);
    assert.ok(result.callbackToken.length > 0);
  });

  test('verify() returns ok:true with record for valid credentials', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus');

    const result = await registry.verify(invocationId, callbackToken);
    assert.equal(result.ok, true);
    assert.equal(result.record.userId, 'user-1');
    assert.equal(result.record.catId, 'opus');
    assert.equal(result.record.invocationId, invocationId);
    assert.equal(result.record.callbackToken, callbackToken);
  });

  // F174 Phase A — Structured failure reasons (KD-4)
  test('verify() returns reason:invalid_token when token mismatches', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    const { invocationId } = await registry.create('user-1', 'opus');

    const result = await registry.verify(invocationId, 'wrong-token');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_token');
  });

  test('verify() returns reason:unknown_invocation for unknown invocationId', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    await registry.create('user-1', 'opus');

    const result = await registry.verify('unknown-id', 'any-token');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unknown_invocation');
  });

  test('verify() returns reason:expired for expired invocation', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    // Use very short TTL
    const registry = new InvocationRegistry({ ttlMs: 1 });
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus');

    // Wait for expiry
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await registry.verify(invocationId, callbackToken);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'expired');
  });

  test('LRU eviction removes oldest unused when at capacity', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry({ maxRecords: 3 });

    const first = await registry.create('user-1', 'opus');
    await registry.create('user-2', 'codex');
    await registry.create('user-3', 'gemini');

    // Adding a 4th should evict first (oldest, never verified/refreshed)
    await registry.create('user-4', 'opus');
    assert.equal((await registry.verify(first.invocationId, first.callbackToken)).ok, false);
  });

  test('verify() refreshes recency (true LRU)', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry({ maxRecords: 3 });

    const first = await registry.create('user-1', 'opus');
    const second = await registry.create('user-2', 'codex');
    const _third = await registry.create('user-3', 'gemini');

    // Access first — refreshes its recency, making second the oldest
    assert.equal((await registry.verify(first.invocationId, first.callbackToken)).ok, true);

    // Adding a 4th should evict second (oldest unused), not first (recently verified)
    await registry.create('user-4', 'opus');
    assert.equal(
      (await registry.verify(first.invocationId, first.callbackToken)).ok,
      true,
      'first should survive (recently used)',
    );
    const evicted = await registry.verify(second.invocationId, second.callbackToken);
    assert.equal(evicted.ok, false, 'second should be evicted (oldest unused)');
    assert.equal(evicted.reason, 'unknown_invocation');
  });

  test('multiple creates produce unique IDs', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    const r1 = await registry.create('user-1', 'opus');
    const r2 = await registry.create('user-1', 'opus');

    assert.notEqual(r1.invocationId, r2.invocationId);
    assert.notEqual(r1.callbackToken, r2.callbackToken);
  });

  test('claimClientMessageId() deduplicates per invocation', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    const { invocationId } = await registry.create('user-1', 'opus');

    assert.equal(await registry.claimClientMessageId(invocationId, 'msg-1'), true);
    assert.equal(await registry.claimClientMessageId(invocationId, 'msg-1'), false);
    assert.equal(await registry.claimClientMessageId(invocationId, 'msg-2'), true);
  });

  test('claimClientMessageId() scopes ids to each invocation', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    const first = await registry.create('user-1', 'opus');
    const second = await registry.create('user-1', 'opus');

    assert.equal(await registry.claimClientMessageId(first.invocationId, 'same-id'), true);
    assert.equal(await registry.claimClientMessageId(second.invocationId, 'same-id'), true);
  });

  // --- isLatest() freshness guard (cloud Codex P1 + 缅因猫 R3) ---

  test('isLatest() returns true for the most recent invocation per thread+cat', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    const { invocationId } = await registry.create('user-1', 'opus', 'thread-1');
    assert.equal(await registry.isLatest(invocationId), true);
  });

  test('isLatest() returns false for a superseded invocation (same thread+cat)', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    const { invocationId: oldId } = await registry.create('user-1', 'opus', 'thread-1');
    const { invocationId: newId } = await registry.create('user-1', 'opus', 'thread-1');

    assert.equal(await registry.isLatest(oldId), false, 'old invocation should be stale');
    assert.equal(await registry.isLatest(newId), true, 'new invocation should be latest');
  });

  test('isLatest() tracks different cats independently on same thread', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    const { invocationId: opusId } = await registry.create('user-1', 'opus', 'thread-1');
    const { invocationId: codexId } = await registry.create('user-1', 'codex', 'thread-1');

    assert.equal(await registry.isLatest(opusId), true, 'opus should be latest');
    assert.equal(await registry.isLatest(codexId), true, 'codex should be latest');

    // Supersede opus only
    const { invocationId: opusId2 } = await registry.create('user-1', 'opus', 'thread-1');
    assert.equal(await registry.isLatest(opusId), false, 'old opus should be stale');
    assert.equal(await registry.isLatest(opusId2), true, 'new opus should be latest');
    assert.equal(await registry.isLatest(codexId), true, 'codex should be unaffected');
  });

  test('isLatest() tracks different threads independently for same cat', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    const { invocationId: t1Id } = await registry.create('user-1', 'opus', 'thread-1');
    const { invocationId: t2Id } = await registry.create('user-1', 'opus', 'thread-2');

    assert.equal(await registry.isLatest(t1Id), true);
    assert.equal(await registry.isLatest(t2Id), true);
  });

  test('isLatest() returns false for unknown invocationId', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    assert.equal(await registry.isLatest('nonexistent-id'), false);
  });

  // --- latestByThreadCat cleanup (缅因猫 P2) ---

  test('latestByThreadCat cleans up on TTL expiry', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry({ ttlMs: 1 });
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');
    assert.equal(await registry.isLatest(invocationId), true);

    // Wait for TTL expiry
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Trigger TTL cleanup via verify() with correct token (reaches TTL check)
    const result = await registry.verify(invocationId, callbackToken);
    assert.equal(result.ok, false, 'expired record should fail verify');
    assert.equal(result.reason, 'expired');

    // isLatest should now return false (record gone + pointer cleaned)
    assert.equal(await registry.isLatest(invocationId), false);
  });

  test('latestByThreadCat cleans up on LRU eviction', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry({ maxRecords: 2 });
    const { invocationId: firstId } = await registry.create('user-1', 'opus', 'thread-1');
    await registry.create('user-2', 'codex', 'thread-2');

    assert.equal(await registry.isLatest(firstId), true);

    // Adding a 3rd evicts the oldest (firstId)
    await registry.create('user-3', 'gemini', 'thread-3');

    // firstId should no longer be latest (evicted)
    assert.equal(await registry.isLatest(firstId), false);
  });

  test('latestByThreadCat cleanup does not remove superseded pointer', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry({ maxRecords: 3 });

    // Create old opus invocation, then new opus invocation (supersedes old)
    const { invocationId: oldId } = await registry.create('user-1', 'opus', 'thread-1');
    const { invocationId: newId } = await registry.create('user-1', 'opus', 'thread-1');

    assert.equal(await registry.isLatest(oldId), false);
    assert.equal(await registry.isLatest(newId), true);

    // Fill capacity to evict oldId (it's the oldest)
    await registry.create('user-2', 'codex', 'thread-2');
    await registry.create('user-3', 'gemini', 'thread-3');

    // newId's latest pointer should NOT have been cleaned up by oldId's eviction
    assert.equal(
      await registry.isLatest(newId),
      true,
      'latest pointer must survive when evicted record was already superseded',
    );
  });

  // --- Sliding window TTL renewal (F-Ground-1 pre: TTL 止血) ---

  test('verify() extends expiresAt (sliding window)', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const originalDateNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;

    try {
      const registry = new InvocationRegistry({ ttlMs: 50 });
      const { invocationId, callbackToken } = await registry.create('user-1', 'opus');

      // Advance 30ms (past 60% of TTL), then verify to renew.
      now += 30;
      const result = await registry.verify(invocationId, callbackToken);
      assert.equal(result.ok, true, 'should still be valid at +30ms');

      // Advance another 30ms (+60ms from create, but only +30ms since renewal).
      now += 30;
      const result2 = await registry.verify(invocationId, callbackToken);
      assert.equal(result2.ok, true, 'sliding window should have extended TTL');
    } finally {
      Date.now = originalDateNow;
    }
  });

  test('first callback after long delay succeeds with 2h TTL', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    // Simulate: cat runs for 30 min before first callback
    // We can't wait 30 min, so use default TTL and verify it's 2h
    const registry = new InvocationRegistry();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus');

    // Verify the record's expiresAt is ~2h from now (not 10 min)
    const result = await registry.verify(invocationId, callbackToken);
    assert.equal(result.ok, true);
    const remainingMs = result.record.expiresAt - Date.now();
    // Should be close to 2h (allow 5s tolerance for test execution)
    assert.ok(remainingMs > 2 * 60 * 60 * 1000 - 5000, `TTL should be ~2h, got ${Math.round(remainingMs / 1000)}s`);
  });

  // --- F108 fix: parentInvocationId propagation ---

  test('create() stores parentInvocationId in record when provided', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1', 'parent-inv-123');

    const result = await registry.verify(invocationId, callbackToken);
    assert.equal(result.ok, true);
    assert.equal(result.record.parentInvocationId, 'parent-inv-123');
  });

  test('create() omits parentInvocationId from record when not provided', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');

    const result = await registry.verify(invocationId, callbackToken);
    assert.equal(result.ok, true);
    assert.equal(result.record.parentInvocationId, undefined);
  });

  test('stale invocation still rejected despite sliding window', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    const old = await registry.create('user-1', 'opus', 'thread-1');
    // Supersede with a new invocation
    await registry.create('user-1', 'opus', 'thread-1');

    // Old invocation can still verify() (token is valid)...
    const result = await registry.verify(old.invocationId, old.callbackToken);
    assert.equal(result.ok, true, 'old token still valid');
    // ...but isLatest() correctly rejects it
    assert.equal(
      await registry.isLatest(old.invocationId),
      false,
      'stale invocation must be rejected by isLatest even if verify succeeds',
    );
  });
});
