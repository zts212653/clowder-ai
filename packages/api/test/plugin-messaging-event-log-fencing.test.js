/**
 * K-1 / F288 — append-event lease fencing substrate.
 * INV-14: lease validation and event insertion are one atomic store action.
 */
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

let memory;

before(async () => {
  memory = await import('../dist/domains/messaging/stores/memory.js');
});

function appendEvent(operationId, revision) {
  return {
    eventId: `ev-${operationId}`,
    type: 'message.elements.append',
    messageId: 'msg-1',
    threadId: 'thread-1',
    operationId,
    revision,
    elements: [{ elementId: `el-${revision}`, kind: 'text', payload: { text: operationId } }],
  };
}

describe('Memory append emission fencing', () => {
  test('AppendLock issues an opaque lease capability', async () => {
    const lock = new memory.MemoryAppendLock();
    const lease = await lock.acquire('msg-1', 60_000);
    assert.equal(lease.messageId, 'msg-1');
    assert.equal(typeof lease.token, 'string');
    assert.equal(typeof lease.isCurrent, 'function');
  });

  test('a stale lease is fenced without consuming a thread sequence', async () => {
    const log = new memory.MemoryEventLogStore();
    const lease = { messageId: 'msg-1', token: 'stale', isCurrent: () => false };

    const result = await log.append('thread-1', 'append:msg-1:op-1', appendEvent('op-1', 2), 1, lease);

    assert.equal(result.fencedOut, true);
    assert.equal(result.sequence, undefined);
    assert.equal(await log.headSequence('thread-1'), 0);
    assert.deepEqual(await log.readAfter('thread-1', 0, 10), []);
  });

  test('a current lease can insert the append event', async () => {
    const log = new memory.MemoryEventLogStore();
    const lease = { messageId: 'msg-1', token: 'live', isCurrent: () => true };

    const result = await log.append('thread-1', 'append:msg-1:op-1', appendEvent('op-1', 2), 1, lease);

    assert.equal(result.fencedOut, false);
    assert.equal(result.sequence, 1);
  });
});
