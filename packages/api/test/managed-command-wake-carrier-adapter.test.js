import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createManagedCommandWakeCarrierAdapter } from '../dist/domains/ball-custody/managed-command-wake-carrier-adapter.js';

const threadId = 'thread-managed-adapter';
const userId = 'user-owner';
const catId = 'codex-sol';
const sourceId = 'message-managed-wake';
const responseId = 'response-managed-wake';

function source(overrides = {}) {
  return {
    id: sourceId,
    threadId,
    userId,
    deliveryStatus: 'delivered',
    lifecycle: {
      kind: 'input',
      orderKey: sourceId,
      dispatchRefs: [{ targetId: catId, phase: 'settled', statusMessageId: responseId, dispatchedAt: 200 }],
    },
    ...overrides,
  };
}

function response(overrides = {}) {
  return {
    id: responseId,
    threadId,
    userId,
    lifecycle: {
      kind: 'response',
      orderKey: responseId,
      invocationId: 'invocation-failed',
      targetId: catId,
      inputEntryIds: ['queue:managed-wake'],
      inputMessageIds: [sourceId],
      status: 'failed',
      startedAt: 200,
      completedAt: 300,
      reason: 'provider_execution_failed',
    },
    ...overrides,
  };
}

describe('managed command wake History carrier adapter', () => {
  for (const acceptance of ['pending', 'written']) {
    it(`does not settle a ${acceptance} appended input from its parent's completed response`, async () => {
      const input = source();
      input.lifecycle.dispatchRefs[0].appendAcceptance = acceptance;
      input.lifecycle.dispatchRefs[0].appendDelivery = { requiresCompletion: true };
      const parent = response();
      parent.lifecycle.status = 'completed';
      const adapter = createManagedCommandWakeCarrierAdapter({
        messageStore: { getById: async (id) => (id === sourceId ? input : parent) },
        invocationRecordStore: { get: async () => null },
        invocationQueue: { getDurableEntriesForMessages: async () => new Map() },
      });
      const carrier = await adapter.getEventCarrier({ threadId, userId, catId, messageId: sourceId });
      assert.equal(carrier.state, 'pending', 'only this appended input can acknowledge its completion');
    });
  }

  it('settles only the explicitly accepted appended input', async () => {
    const input = source();
    input.lifecycle.dispatchRefs[0].appendAcceptance = 'accepted';
    input.lifecycle.dispatchRefs[0].appendDelivery = { requiresCompletion: true };
    const parent = response();
    parent.lifecycle.status = 'processing';
    const adapter = createManagedCommandWakeCarrierAdapter({
      messageStore: { getById: async (id) => (id === sourceId ? input : parent) },
      invocationRecordStore: { get: async () => null },
      invocationQueue: { getDurableEntriesForMessages: async () => new Map() },
    });
    assert.equal((await adapter.getEventCarrier({ threadId, userId, catId, messageId: sourceId })).state, 'handled');
  });
  it('settles a Host delivery failure only for its exact source and target', async () => {
    const input = source();
    const failure = response({
      userId: 'system',
      from: { kind: 'system', service: 'message_delivery' },
      lifecycle: {
        kind: 'delivery_failure',
        inputMessageId: sourceId,
        requestedTargets: [catId],
        status: 'failed',
        reason: 'admission_failed',
      },
    });
    const adapter = createManagedCommandWakeCarrierAdapter({
      messageStore: { getById: async (id) => (id === sourceId ? input : failure) },
      invocationRecordStore: { get: async () => null },
      invocationQueue: { getDurableEntriesForMessages: async () => new Map() },
    });
    assert.equal((await adapter.getEventCarrier({ threadId, userId, catId, messageId: sourceId })).state, 'failed');
    failure.lifecycle.inputMessageId = 'different-source';
    assert.equal((await adapter.getEventCarrier({ threadId, userId, catId, messageId: sourceId })).state, 'orphaned');
  });
  it('projects one exact failed response with provider evidence', async () => {
    const messages = new Map([
      [sourceId, source()],
      [responseId, response()],
    ]);
    const adapter = createManagedCommandWakeCarrierAdapter({
      messageStore: { getById: async (id) => messages.get(id) ?? null },
      invocationRecordStore: {
        get: async (id) =>
          id === 'invocation-failed' ? { id, status: 'failed', error: 'provider_execution_failed' } : null,
      },
      invocationQueue: { getDurableEntriesForMessages: async () => new Map() },
    });

    assert.deepEqual(await adapter.getEventCarrier({ threadId, userId, catId, messageId: sourceId }), {
      state: 'failed',
      attemptId: `${sourceId}:${catId}:invocation-failed`,
      attemptSequence: 1,
      invocationId: 'invocation-failed',
      errorCode: 'provider_execution_failed',
    });
  });

  it('uses Queue only to prove that an undispatched target is still pending', async () => {
    const pendingSource = source({
      deliveryStatus: 'queued',
      lifecycle: { kind: 'input', orderKey: sourceId, dispatchRefs: [] },
    });
    const adapter = createManagedCommandWakeCarrierAdapter({
      messageStore: { getById: async (id) => (id === sourceId ? pendingSource : null) },
      invocationRecordStore: { get: async () => null },
      invocationQueue: {
        getDurableEntriesForMessages: async () =>
          new Map([[sourceId, [{ threadId, owner: { kind: 'user', userId }, targets: [catId] }]]]),
      },
    });

    assert.deepEqual(await adapter.getEventCarrier({ threadId, userId, catId, messageId: sourceId }), {
      state: 'pending',
    });
  });

  it('does not expose a carrier across its durable owner boundary', async () => {
    const adapter = createManagedCommandWakeCarrierAdapter({
      messageStore: { getById: async (id) => (id === sourceId ? source() : response()) },
      invocationRecordStore: { get: async () => null },
      invocationQueue: { getDurableEntriesForMessages: async () => new Map() },
    });

    assert.deepEqual(await adapter.getEventCarrier({ threadId, userId: 'user-foreign', catId, messageId: sourceId }), {
      state: 'missing',
    });
  });
});
