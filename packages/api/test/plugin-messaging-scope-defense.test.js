/**
 * K-1 / F288 — MemoryHandleStore scope defensive copy (INV-22 parity)
 *
 * Memory must snapshot scope on write, matching Redis's serialization
 * behavior. Without this, a caller holding the original scope reference
 * can mutate it post-mint, silently changing the stored record's
 * authorization — an authorization-escalation bug that Redis is immune to.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

/** @type {typeof import('../dist/domains/messaging/stores/memory.js')} */
let memory;

beforeEach(async () => {
  memory = await import('../dist/domains/messaging/stores/memory.js');
});

describe('MemoryHandleStore — scope defensive copy (INV-22)', () => {
  test('put() snapshots scope — caller mutation does not corrupt store', async () => {
    const store = new memory.MemoryHandleStore();
    const scope = { canSend: false, canSubscribe: true };
    await store.put({
      handleId: 'th_scope',
      kind: 'thread_handle',
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope,
      issuedAt: 1,
    });
    // Mutate caller's scope AFTER put
    scope.canSend = true;
    const stored = await store.get('th_scope');
    assert.equal(stored.scope.canSend, false, 'stored scope must not reflect caller mutation');
  });

  test('getOrCreateMessageHandle snapshots scope on create path', async () => {
    const store = new memory.MemoryHandleStore();
    const scope = { canSend: true, canSubscribe: true };
    await store.getOrCreateMessageHandle({
      handleId: 'mh_scope',
      kind: 'message_handle',
      pluginInstanceId: 'inst-a',
      threadId: 'thread-1',
      userId: 'user-1',
      scope,
      messageId: 'msg-scope',
      parentHandleId: 'th_parent',
      issuedAt: 1,
    });
    // Mutate CALLER's scope object after the store call
    scope.canSend = false;
    const stored = await store.get('mh_scope');
    assert.equal(stored.scope.canSend, true, 'stored scope must not reflect caller mutation');
  });
});
