import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PersonMemoryOwnerSourceReader } from '../dist/domains/memory/people/PersonMemoryOwnerSourceReader.js';
import { digestPersonMemorySourceMaterial } from '../dist/domains/memory/people/PersonMemorySourceBundleResolver.js';

const ref = { kind: 'message', threadId: 'synthetic-thread', messageId: 'synthetic-message' };
const message = {
  id: ref.messageId,
  threadId: ref.threadId,
  userId: 'owner',
  catId: null,
  content: 'private synthetic fact',
  timestamp: 1,
};
const item = { ownerUserId: 'owner', sourceRefs: [ref] };

for (const [name, source, expected] of [
  ['deleted message', { ...message, deletedAt: 2 }, 'message_deleted'],
  ['foreign message', { ...message, userId: 'another-owner' }, 'message_owner_mismatch'],
  ['missing message', null, 'message_missing'],
]) {
  test(`source rejection diagnoses ${name} without exporting source text`, async () => {
    const reasons = [];
    const reader = new PersonMemoryOwnerSourceReader({
      messageStore: { getById: async () => source },
      threadStore: { get: async () => ({ id: ref.threadId, createdBy: 'owner' }), list: async () => [] },
    });
    assert.deepEqual(await reader.read('owner', item, (reason) => reasons.push(reason)), { status: 'unavailable' });
    assert.deepEqual(reasons, [expected]);
  });
}

test('typed digest rejection is observable and stays unavailable', async () => {
  const reasons = [];
  const reader = new PersonMemoryOwnerSourceReader({
    messageStore: { getById: async () => message },
    threadStore: { get: async () => ({ id: ref.threadId, createdBy: 'owner' }), list: async () => [] },
  });
  const typedProvenance = {
    sources: [
      {
        sourceId: 'source',
        kind: 'message_text',
        sourceRef: ref,
        ownerUserId: 'owner',
        excerpt: 'synthetic fact',
        resolvedDigest: digestPersonMemorySourceMaterial('old body'),
      },
    ],
    assertionBindings: [
      { sourceId: 'source', target: { kind: 'claim', draftId: 'person_draft_synthetic' }, role: 'reported_fact' },
    ],
  };
  assert.deepEqual(await reader.read('owner', { ...item, typedProvenance }, (reason) => reasons.push(reason)), {
    status: 'unavailable',
  });
  assert.deepEqual(reasons, ['source_digest_mismatch']);
});
