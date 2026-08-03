/** In-memory delivery CAS parity for PR #1193. */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

// ── In-memory MessageStore: markCanceled guard (deterministic RED) ──

describe('in-memory MessageStore markCanceled guard (PR #1193)', () => {
  let MessageStore;

  before(async () => {
    const mod = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    MessageStore = mod.MessageStore;
  });

  it('markCanceled on delivered message is no-op (guard parity with Redis)', async () => {
    const memStore = new MessageStore();
    const base = Date.now();
    const msg = await memStore.append({
      userId: 'u1',
      catId: null,
      content: 'test',
      mentions: [],
      timestamp: base,
      threadId: 'thread-mem-guard',
      deliveryStatus: 'queued',
    });

    memStore.markDelivered(msg.id, base + 100);

    // Cancel should be a CAS no-op → applied=false.
    const result = memStore.markCanceled(msg.id);
    assert.equal(result?.deliveryTransitioned, false, 'in-memory CAS no-op must report applied=false');
    assert.equal(memStore.getById(msg.id).deliveryStatus, 'delivered', 'delivered status must survive cancel attempt');
  });

  it('markCanceled on immediate/no-status message is no-op', async () => {
    const memStore = new MessageStore();
    const msg = await memStore.append({
      userId: 'u1',
      catId: null,
      content: 'immediate',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread-mem-imm',
    });

    const result = memStore.markCanceled(msg.id);
    assert.equal(result?.deliveryTransitioned, false, 'in-memory CAS no-op must report applied=false');
    assert.notEqual(memStore.getById(msg.id).deliveryStatus, 'canceled', 'immediate message must not become canceled');
  });

  it('markCanceled on already-canceled message reports applied=false (CAS idempotency parity)', async () => {
    const memStore = new MessageStore();
    const msg = await memStore.append({
      userId: 'u1',
      catId: null,
      content: 'test',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread-mem-idem',
      deliveryStatus: 'queued',
    });

    const first = memStore.markCanceled(msg.id);
    assert.ok(first, 'first cancel must succeed');
    assert.equal(first.deliveryStatus, 'canceled');

    const second = memStore.markCanceled(msg.id);
    assert.equal(second?.deliveryTransitioned, false, 'second cancel must report applied=false');
  });
});
