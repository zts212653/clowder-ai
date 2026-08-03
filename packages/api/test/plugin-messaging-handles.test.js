/**
 * K-1 / F258 — host-issued handles (plan Task 3, §4c)
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
    await service.ensureMessageHandle(parent, 'msg-send-only');

    await expectCode(service.resolveForAppend('inst-a', { kind: 'message', token: 'msg-send-only' }), 'PERMISSION');
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
