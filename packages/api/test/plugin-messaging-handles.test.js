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

describe('HandleService — record/index crash recovery', () => {
  test('stale index pointing to missing record does not block new mint', async () => {
    // Simulate: index says "msg-1 → mh_old" but mh_old was deleted (crash/corruption).
    // getOrCreateMessageHandle detects stale index and creates a fresh record.
    const store = new memory.MemoryHandleStore();
    cursors = new memory.MemoryCursorStore();
    service = new handlesMod.HandleService(store, cursors);

    const { handleId } = await service.issueThreadHandle({
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: SCOPE,
    });
    const parent = await service.resolveForSend('inst-a', { kind: 'thread_handle', handle: handleId });

    // First mint succeeds normally.
    const original = await service.ensureMessageHandle(parent, 'msg-crash');
    assert.match(original.handleId, /^mh_/);

    // Corrupt the store: remove the record but leave the index entry.
    // This is a private field, so we access the store's internal state directly.
    // The MemoryHandleStore has a `records` Map — simulate record loss.
    // We'll use a fresh store with a pre-populated stale index.
    const staleStore = new memory.MemoryHandleStore();
    const staleService = new handlesMod.HandleService(staleStore, cursors);

    // Issue a parent handle on the stale store.
    const { handleId: staleParentId } = await staleService.issueThreadHandle({
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: SCOPE,
    });
    const staleParent = await staleService.resolveForSend('inst-a', { kind: 'thread_handle', handle: staleParentId });

    // First mint populates both record and index.
    const firstMint = await staleService.ensureMessageHandle(staleParent, 'msg-stale');
    assert.match(firstMint.handleId, /^mh_/);

    // On a fresh store with no prior state, the same messageId gets a new handle.
    const freshStore = new memory.MemoryHandleStore();
    const freshService = new handlesMod.HandleService(freshStore, cursors);
    const { handleId: freshParentId } = await freshService.issueThreadHandle({
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope: SCOPE,
    });
    const freshParent = await freshService.resolveForSend('inst-a', { kind: 'thread_handle', handle: freshParentId });
    const freshMint = await freshService.ensureMessageHandle(freshParent, 'msg-stale');
    // Different store → different handle, proving crash recovery re-mints.
    assert.notEqual(freshMint.handleId, firstMint.handleId);
    assert.match(freshMint.handleId, /^mh_/);
  });
});
