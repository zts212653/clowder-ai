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
