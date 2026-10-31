/**
 * F247 AC-B1c-9: singleflight — concurrent dispatches to one (threadId, catId) reach the Host one
 * at a time, in call order; dispatches to different threads are not serialized.
 *
 * The self-heal (AC-B1c-6) and fresh-chat cases this file used to hold belonged to the legacy
 * PinchTab bridge, which could open a new chat. That bridge was removed (issue #1538);
 * the Host adapter only appends to a bound conversation. Per-thread routing is covered in
 * b1c-2-cloud-invoke-bridge.test.js.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { CloudInvokeBridge } = await import('../dist/domains/cats/services/cloud-bridge/cloud-invoke-bridge.js');

const bindings = {
  'thread-1': { 'gpt-pro': 'https://chatgpt.com/c/conversation-1' },
  'thread-2': { 'gpt-pro': 'https://chatgpt.com/c/conversation-2' },
};

function threadStore() {
  return {
    get: async (threadId) => ({ id: threadId, title: threadId, participants: ['gpt-pro'] }),
    getCloudCatBindings: async (threadId) => ({ ...(bindings[threadId] ?? {}) }),
    updateCloudCatBinding: async () => {},
  };
}

/** A Host adapter that records call order and how many appends are in flight at once. */
function trackingHost({ delayMs = 20, reject = () => false } = {}) {
  const state = { inFlight: 0, maxInFlight: 0, order: [] };
  return {
    state,
    adapter: {
      async append_message(_conversationId, _text, idempotencyKey) {
        state.inFlight += 1;
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
        state.order.push(idempotencyKey);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        state.inFlight -= 1;
        if (reject(idempotencyKey)) throw new Error('host rejected append');
        return { hostMessageId: `host-${idempotencyKey}` };
      },
    },
  };
}

function bridgeFor(adapter) {
  return new CloudInvokeBridge({ hostAdapter: adapter, emitFallback: async () => {}, threadStore: threadStore() });
}

function params(overrides = {}) {
  return {
    catId: 'gpt-pro',
    threadId: 'thread-1',
    userId: 'user-1',
    threadTitle: 'Test Thread',
    participants: [],
    calledBy: 'opus',
    intent: 'hello',
    sourceMessageId: 'source-1',
    ...overrides,
  };
}

describe('F247 AC-B1c-9: singleflight per (threadId, catId)', () => {
  it('sends concurrent dispatches to one conversation one at a time, in call order', async () => {
    const host = trackingHost();
    const bridge = bridgeFor(host.adapter);

    const outcomes = await Promise.all(
      ['a', 'b', 'c', 'd'].map((sourceMessageId) => bridge.dispatchInternal(params({ sourceMessageId }))),
    );

    assert.deepEqual(
      outcomes.map((outcome) => outcome.hostMessageId),
      ['host-a', 'host-b', 'host-c', 'host-d'],
    );
    assert.equal(host.state.maxInFlight, 1, 'never two appends to one conversation at once');
    assert.deepEqual(host.state.order, ['a', 'b', 'c', 'd']);
  });

  it('does not serialize dispatches to different threads', async () => {
    const host = trackingHost({ delayMs: 30 });
    const bridge = bridgeFor(host.adapter);

    const outcomes = await Promise.all([
      bridge.dispatchInternal(params({ threadId: 'thread-1', sourceMessageId: 'x' })),
      bridge.dispatchInternal(params({ threadId: 'thread-2', sourceMessageId: 'y' })),
    ]);

    assert.deepEqual(
      outcomes.map((outcome) => outcome.kind),
      ['sent', 'sent'],
    );
    assert.equal(host.state.maxInFlight, 2, 'different conversations are appended concurrently');
  });

  it('releases the lock after a failed send, so the next one still goes out', async () => {
    const host = trackingHost({ reject: (key) => key === 'first' });
    const bridge = bridgeFor(host.adapter);

    const [first, second] = await Promise.all([
      bridge.dispatchInternal(params({ sourceMessageId: 'first' })),
      bridge.dispatchInternal(params({ sourceMessageId: 'second' })),
    ]);

    assert.equal(first.kind, 'error');
    assert.equal(first.reason, 'host-append-failed');
    assert.equal(second.kind, 'sent');
    assert.deepEqual(host.state.order, ['first', 'second']);
  });
});
