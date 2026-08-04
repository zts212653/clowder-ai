/**
 * K-1 / F288 — host-issued handles (plan Task 3, §4c)
 * AC-2 addressing: no bare threadId; INV-8 cross-instance/revoked rejection;
 * revoke cascades to subscriptions.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

/** @type {typeof import('../dist/domains/messaging/handles.js')} */
let handlesMod;
/** @type {typeof import('../dist/domains/messaging/stores/memory.js')} */
let memory;

let service;
let cursors;

beforeEach(async () => {
  handlesMod = await import('../dist/domains/messaging/handles.js');
  memory = await import('../dist/domains/messaging/stores/memory.js');
  cursors = new memory.MemoryCursorStore();
  service = new handlesMod.HandleService(new memory.MemoryHandleStore(), cursors);
});

const SCOPE = { canSend: true, canSubscribe: true };

async function expectCode(promise, code) {
  try {
    await promise;
  } catch (err) {
    assert.equal(err.name, 'MessagingError', `expected MessagingError, got ${err.name}: ${err.message}`);
    assert.equal(err.code, code);
    return;
  }
  assert.fail(`expected MessagingError(${code}), but call succeeded`);
}

describe('HandleService — issuance & resolution', () => {
  test('issueThreadHandle returns a resolvable th_ handle bound to instance/thread/user', async () => {
    const { handleId } = await service.issueThreadHandle({
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: SCOPE,
    });
    assert.match(handleId, /^th_/);
    const record = await service.resolveForSend('inst-a', { kind: 'thread_handle', handle: handleId });
    assert.equal(record.threadId, 'thread-1');
    assert.equal(record.userId, 'user-1');
    assert.equal(record.pluginInstanceId, 'inst-a');
  });

  test('issueConnectorBindingHandle carries binding coordinates', async () => {
    const { handleId } = await service.issueConnectorBindingHandle({
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: SCOPE,
      connectorId: 'telegram',
      externalChatId: 'chat-9',
    });
    assert.match(handleId, /^cb_/);
    const record = await service.resolveForSend('inst-a', { kind: 'connector_binding', handle: handleId });
    assert.deepEqual(record.connectorBinding, { connectorId: 'telegram', externalChatId: 'chat-9' });
  });

  test('unknown handle → NOT_FOUND', async () => {
    await expectCode(service.resolveForSend('inst-a', { kind: 'thread_handle', handle: 'th_missing' }), 'NOT_FOUND');
  });

  test('INV-8: handle of instance A used by instance B → PERMISSION', async () => {
    const { handleId } = await service.issueThreadHandle({
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: SCOPE,
    });
    await expectCode(service.resolveForSend('inst-b', { kind: 'thread_handle', handle: handleId }), 'PERMISSION');
  });

  test('address kind must match handle kind', async () => {
    const { handleId } = await service.issueThreadHandle({
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: SCOPE,
    });
    await expectCode(service.resolveForSend('inst-a', { kind: 'connector_binding', handle: handleId }), 'VALIDATION');
  });

  test('scope gates: canSend=false blocks send path, canSubscribe=false blocks subscribe path', async () => {
    const sendOnly = await service.issueThreadHandle({
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: { canSend: true, canSubscribe: false },
    });
    const subOnly = await service.issueThreadHandle({
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: { canSend: false, canSubscribe: true },
    });
    await service.resolveForSend('inst-a', { kind: 'thread_handle', handle: sendOnly.handleId });
    await expectCode(
      service.resolveForSend('inst-a', { kind: 'thread_handle', handle: subOnly.handleId }),
      'PERMISSION',
    );
    await service.resolveForSubscribe('inst-a', subOnly.handleId);
    await expectCode(service.resolveForSubscribe('inst-a', sendOnly.handleId), 'PERMISSION');
  });

  test('INV-13: a message minted from a send-only parent cannot authorize append', async () => {
    const { handleId } = await service.issueThreadHandle({
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: { canSend: true, canSubscribe: false },
    });
    const parent = await service.resolveForSend('inst-a', { kind: 'thread_handle', handle: handleId });
    const msgHandle = await service.ensureMessageHandle(parent, 'msg-send-only');

    await expectCode(service.resolveForAppend('inst-a', { kind: 'message', token: msgHandle.handleId }), 'PERMISSION');
  });
});

describe('HandleService — revocation (§4c)', () => {
  test('INV-8: revoked handle rejected on send and subscribe paths', async () => {
    const { handleId } = await service.issueThreadHandle({
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: SCOPE,
    });
    await service.revoke(handleId);
    await expectCode(service.resolveForSend('inst-a', { kind: 'thread_handle', handle: handleId }), 'PERMISSION');
    await expectCode(service.resolveForSubscribe('inst-a', handleId), 'PERMISSION');
  });

  test('revoke is idempotent and unknown-handle tolerant', async () => {
    const { handleId } = await service.issueThreadHandle({
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: SCOPE,
    });
    await service.revoke(handleId);
    await service.revoke(handleId);
    await service.revoke('th_never_existed');
  });

  test('revoke cascades: subscriptions bound to the handle are revoked', async () => {
    const { handleId } = await service.issueThreadHandle({
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: SCOPE,
    });
    await cursors.put({
      subscriptionId: 'sub-1',
      pluginInstanceId: 'inst-a',
      handleId,
      threadId: 'thread-1',
      ackedSequence: 0,
      lastDeliveredSequence: 0,
    });
    await service.revoke(handleId);
    const sub = await cursors.get('inst-a', 'sub-1');
    assert.ok(sub.revokedAt, 'subscription should carry revokedAt after handle revoke');
  });
});

describe('HandleService — concurrent mint convergence', () => {
  test('Promise.all of two ensureMessageHandle calls for the same messageId converges on one handle', async () => {
    const { handleId } = await service.issueThreadHandle({
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: SCOPE,
    });
    const parent = await service.resolveForSend('inst-a', { kind: 'thread_handle', handle: handleId });

    // Concurrent mint: both callers generate distinct mh_ candidates, but
    // getOrCreateMessageHandle's atomic check-then-write means exactly one
    // wins and the other gets back the winner's record.
    const [h1, h2] = await Promise.all([
      service.ensureMessageHandle(parent, 'msg-race'),
      service.ensureMessageHandle(parent, 'msg-race'),
    ]);

    assert.equal(h1.handleId, h2.handleId, 'both callers must converge on the same handleId');
    assert.equal(h1.messageId, 'msg-race');
    assert.match(h1.handleId, /^mh_/);
  });

  test('concurrent mint from different parents of the same instance → CONFLICT (authority is per-parent)', async () => {
    // Two separate address handles, same instance — both try to mint for the same messageId.
    // The message handle is bound to its specific parent authority, so a different parent
    // (even from the same instance) is a cross-authority conflict.
    const p1 = await service.issueThreadHandle({
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: SCOPE,
    });
    const p2 = await service.issueThreadHandle({
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: SCOPE,
    });
    const parent1 = await service.resolveForSend('inst-a', { kind: 'thread_handle', handle: p1.handleId });
    const parent2 = await service.resolveForSend('inst-a', { kind: 'thread_handle', handle: p2.handleId });

    await service.ensureMessageHandle(parent1, 'msg-shared');
    await expectCode(service.ensureMessageHandle(parent2, 'msg-shared'), 'CONFLICT');
  });

  test('concurrent mint from different instances → CONFLICT (cross-instance authority violation)', async () => {
    const h1 = await service.issueThreadHandle({
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: SCOPE,
    });
    const h2 = await service.issueThreadHandle({
      pluginInstanceId: 'inst-b',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: SCOPE,
    });
    const parent1 = await service.resolveForSend('inst-a', { kind: 'thread_handle', handle: h1.handleId });
    const parent2 = await service.resolveForSend('inst-b', { kind: 'thread_handle', handle: h2.handleId });

    await service.ensureMessageHandle(parent1, 'msg-contested');
    await expectCode(service.ensureMessageHandle(parent2, 'msg-contested'), 'CONFLICT');
  });
});

describe('HandleService — index corruption fail-closed (record/index validation)', () => {
  test('missing record at indexed key falls through to create (record loss recovery)', async () => {
    const store = new memory.MemoryHandleStore();
    const candidate1 = {
      handleId: 'mh_first',
      kind: 'message_handle',
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: SCOPE,
      messageId: 'msg-orphan',
      parentHandleId: 'th_parent',
      issuedAt: 1,
    };
    const first = await store.getOrCreateMessageHandle(candidate1);
    assert.equal(first.created, true);
    // Simulate record loss: index still maps msg-orphan → mh_first,
    // but the record at mh_first no longer exists.
    store.records.delete('mh_first');
    const recovery = await store.getOrCreateMessageHandle({
      ...candidate1,
      handleId: 'mh_recovery',
      issuedAt: 2,
    });
    assert.equal(recovery.created, true);
    assert.equal(recovery.record.handleId, 'mh_recovery');
    assert.equal(recovery.record.messageId, 'msg-orphan');
  });

  test('index points to record with wrong messageId → fail-closed error', async () => {
    // Reproduce the maintainer's exact probe: corrupt the index so msg-a's
    // index entry points to msg-b's handle record. getOrCreateMessageHandle
    // must throw, not silently return the wrong capability.
    const store = new memory.MemoryHandleStore();
    const parentId = 'th_parent-a';

    // Mint handle for msg-b first (creates index and record).
    const candidateB = {
      handleId: 'mh_for_b',
      kind: 'message_handle',
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: SCOPE,
      messageId: 'msg-b',
      parentHandleId: parentId,
      issuedAt: 1,
    };
    await store.getOrCreateMessageHandle(candidateB);

    // Corrupt: msg-a's index → mh_for_b (which has messageId=msg-b).
    // We do this by putting mh_for_b at the msg-a index position via direct
    // store manipulation. Since the MemoryHandleStore does not expose the
    // messageIndex, we use a wrapper store that intercepts getOrCreateMessageHandle.
    // Instead, we test at the HandleService level by exercising the mismatch
    // detection directly through the store interface.

    // Cleanest approach: use a subclass or direct test of the validation.
    // Since getOrCreateMessageHandle already validates, we can trigger the
    // mismatch by having the index return an existing record for a different
    // messageId. We achieve this by first creating msg-a → mh_for_a, then
    // replacing mh_for_a's record data with msg-b's data in the records Map.

    // Mint handle for msg-a.
    const candidateA = {
      handleId: 'mh_for_a',
      kind: 'message_handle',
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: SCOPE,
      messageId: 'msg-a',
      parentHandleId: parentId,
      issuedAt: 1,
    };
    const created = await store.getOrCreateMessageHandle(candidateA);
    assert.equal(created.created, true);

    // Corrupt: overwrite the record at mh_for_a to have messageId=msg-b.
    // The index still maps msg-a → mh_for_a, but the record says msg-b.
    await store.put({
      handleId: 'mh_for_a',
      kind: 'message_handle',
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: SCOPE,
      messageId: 'msg-b',
      parentHandleId: parentId,
      issuedAt: 1,
    });

    // Now try to getOrCreateMessageHandle for msg-a — index hits mh_for_a
    // which has messageId=msg-b → must throw, not return the wrong record.
    const candidateA2 = {
      handleId: 'mh_for_a2',
      kind: 'message_handle',
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: SCOPE,
      messageId: 'msg-a',
      parentHandleId: parentId,
      issuedAt: 2,
    };
    await assert.rejects(store.getOrCreateMessageHandle(candidateA2), /handle index corruption/);
  });

  test('cross-authority mint (different pluginInstanceId) → CONFLICT via HandleService', async () => {
    // Authority check (pluginInstanceId, parentHandleId) is at HandleService level,
    // not the store level. The store returns the existing record (messageId matches),
    // and HandleService detects the authority mismatch.
    const h1 = await service.issueThreadHandle({
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: SCOPE,
    });
    const h2 = await service.issueThreadHandle({
      pluginInstanceId: 'inst-b',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: SCOPE,
    });
    const parent1 = await service.resolveForSend('inst-a', { kind: 'thread_handle', handle: h1.handleId });
    const parent2 = await service.resolveForSend('inst-b', { kind: 'thread_handle', handle: h2.handleId });

    await service.ensureMessageHandle(parent1, 'msg-authority');
    await expectCode(service.ensureMessageHandle(parent2, 'msg-authority'), 'CONFLICT');
  });

  test('valid indexed record with matching bindings returns existing (no false positive)', async () => {
    const store = new memory.MemoryHandleStore();
    const candidate = {
      handleId: 'mh_valid',
      kind: 'message_handle',
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: SCOPE,
      messageId: 'msg-ok',
      parentHandleId: 'th_parent',
      issuedAt: 1,
    };
    const first = await store.getOrCreateMessageHandle(candidate);
    assert.equal(first.created, true);

    // Second call with same bindings must return existing, not throw.
    const second = await store.getOrCreateMessageHandle({
      ...candidate,
      handleId: 'mh_different_candidate',
      issuedAt: 2,
    });
    assert.equal(second.created, false);
    assert.equal(second.record.handleId, 'mh_valid');
  });
});
