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
    assert.equal(result.record.ownerAuthProvenance, 'unknown');
  });

  test('strict owner authentication provenance survives registry round-trip', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    const { invocationId, callbackToken } = await registry.create(
      'user-1',
      'opus',
      'thread-1',
      undefined,
      undefined,
      undefined,
      'msg-user-1',
      'strict',
    );

    const result = await registry.verify(invocationId, callbackToken);
    assert.equal(result.ok, true);
    assert.equal(result.record.ownerAuthProvenance, 'strict');
  });

  test('server-resolved managed-work binding survives registry round-trip', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    const binding = { workId: 'wrk_test', attemptId: 'wat_test' };
    const { invocationId, callbackToken } = await registry.create(
      'user-1',
      'opus',
      'thread-1',
      undefined,
      undefined,
      undefined,
      'msg-user-1',
      'strict',
      binding,
    );

    const result = await registry.verify(invocationId, callbackToken);
    assert.equal(result.ok, true);
    assert.deepEqual(result.record.managedWorkBinding, binding);
  });

  test('managed-work binding requires strict owner authentication provenance', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    await assert.rejects(
      () =>
        registry.create(
          'user-1',
          'opus',
          'thread-1',
          undefined,
          undefined,
          undefined,
          'msg-user-1',
          'compatibility_fallback',
          { workId: 'wrk_spoof', attemptId: 'wat_spoof' },
        ),
      /requires strict owner authentication/,
    );
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

  test('active invocation remains valid after the legacy TTL window', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry({ ttlMs: 1 });
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus');
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await registry.verify(invocationId, callbackToken);
    assert.equal(result.ok, true);
    assert.equal(result.record.expiresAt, null);
  });

  test('memory capacity rejects new admission without evicting active invocations', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry({ maxRecords: 3 });

    const first = await registry.create('user-1', 'opus', 'thread-1');
    await registry.create('user-2', 'codex');
    await registry.create('user-3', 'gemini');

    await assert.rejects(
      () => registry.create('user-4', 'opus', 'thread-4'),
      (error) => error?.code === 'callback_auth_capacity_exceeded',
    );
    assert.equal((await registry.verify(first.invocationId, first.callbackToken)).ok, true);
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
    const first = await registry.create('user-1', 'opus', 'thread-1');
    const second = await registry.create('user-1', 'opus', 'thread-2');

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

  test('latestByThreadCat remains durable while invocation is active', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry({ ttlMs: 1 });
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');
    assert.equal(await registry.isLatest(invocationId), true);

    await new Promise((resolve) => setTimeout(resolve, 10));
    const result = await registry.verify(invocationId, callbackToken);
    assert.equal(result.ok, true);
    assert.equal(await registry.isLatest(invocationId), true);
  });

  test('verify() never creates an active expiry deadline', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const originalDateNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;

    try {
      const registry = new InvocationRegistry({ ttlMs: 1 });
      const { invocationId, callbackToken } = await registry.create('user-1', 'opus');
      now += 24 * 60 * 60 * 1000;
      const result = await registry.verify(invocationId, callbackToken);
      assert.equal(result.ok, true);
      assert.equal(result.record.expiresAt, null);
    } finally {
      Date.now = originalDateNow;
    }
  });

  test('first callback after long delay succeeds without a wall-clock TTL', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus');

    const result = await registry.verify(invocationId, callbackToken);
    assert.equal(result.ok, true);
    assert.equal(result.record.expiresAt, null);
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

  test('superseded invocation returns its authoritative terminal disposition', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    const registry = new InvocationRegistry();
    const old = await registry.create('user-1', 'opus', 'thread-1');
    // Supersede with a new invocation
    await registry.create('user-1', 'opus', 'thread-1');

    const result = await registry.verify(old.invocationId, old.callbackToken);
    assert.deepEqual(result, { ok: false, reason: 'replaced' });
    assert.equal(await registry.isLatest(old.invocationId), false);
  });
});
