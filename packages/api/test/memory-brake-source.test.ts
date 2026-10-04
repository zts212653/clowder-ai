import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type BrakeSourceReaders, readBrakeSource } from '../src/routes/memory-brake-source.js';

function readers(
  overrides: {
    owner?: string;
    createdBy?: string;
    deletedAt?: number;
    listed?: boolean;
    missingMessage?: boolean;
    messageThread?: string;
    messageOwner?: string;
    deliveryStatus?: string;
    trigger?: string;
    confidence?: string;
    messageDeletedAt?: number;
  } = {},
): BrakeSourceReaders {
  // Minimal persistence fixtures: the read projection only accesses these coordinates and access fields.
  return {
    eventMemoryStore: {
      getEvent: () => ({
        ownerUserId: overrides.owner ?? 'owner',
        trigger: overrides.trigger ?? 'human_brake',
        confidence: overrides.confidence ?? 'high',
        threadId: 'thread-a',
        messageId: 'message-a',
      }),
    },
    threadStore: {
      get: () => ({
        id: 'thread-a',
        title: '真实对话标题',
        createdBy: overrides.createdBy ?? 'owner',
        deletedAt: overrides.deletedAt,
      }),
      list: () => (overrides.listed ? [{ id: 'thread-a' }] : []),
    },
    messageStore: {
      getById: () =>
        overrides.missingMessage
          ? null
          : {
              id: 'message-a',
              threadId: overrides.messageThread ?? 'thread-a',
              userId: overrides.messageOwner ?? 'owner',
              catId: null,
              deliveryStatus: overrides.deliveryStatus,
              deletedAt: overrides.messageDeletedAt,
            },
    },
  } as unknown as BrakeSourceReaders;
}
test('exact accessible message yields title and verified navigation coordinates', async () => {
  assert.deepEqual(await readBrakeSource('event-a', 'owner', readers()), {
    title: '真实对话标题',
    canOpen: true,
    threadId: 'thread-a',
    messageId: 'message-a',
  });
});
for (const [label, overrides] of Object.entries({
  foreignEvent: { owner: 'other' },
  foreignThread: { createdBy: 'other' },
  deletedThread: { deletedAt: 100 },
  unlistedSystem: { createdBy: 'system' },
  missingMessage: { missingMessage: true },
  wrongMessageThread: { messageThread: 'thread-b' },
  foreignMessageOwner: { messageOwner: 'other' },
  unpublishedMessage: { deliveryStatus: 'canceled' },
  catIntervention: { trigger: 'cat_brake' },
  lowConfidenceMention: { confidence: 'low' },
  deletedMessage: { messageDeletedAt: 100 },
})) {
  test(`${label} withholds title and open action`, async () =>
    assert.deepEqual(await readBrakeSource('event-a', 'owner', readers(overrides)), { title: null, canOpen: false }));
}
test('system source needs owner list visibility', async () => {
  assert.equal(
    (await readBrakeSource('event-a', 'owner', readers({ createdBy: 'system', listed: true }))).canOpen,
    true,
  );
});
