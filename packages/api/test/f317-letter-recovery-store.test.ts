import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MessageStore,
  type PutOwnerComposerDraftInput,
} from '../src/domains/cats/services/stores/ports/MessageStore.js';

const submission = {
  clientMessageId: '00000000-0000-4000-8000-000000000001',
  text: 'Original input',
  callId: null,
  submissionRevision: 0,
  reservationRevision: 1,
  createdAt: 100,
};
function submissions(value: unknown) {
  assert.ok(value && typeof value === 'object');
  return (value as Record<string, unknown>).companionSubmissions;
}
test('the original draft owner preserves unconfirmed sends across edits and CAS clearing', () => {
  const store = new MessageStore();
  const first = store.putOwnerComposerDraft('owner', 'home', {
    expectedRevision: 0,
    text: 'Original input',
    updatedAt: 100,
    companionSubmissions: [submission],
  } as PutOwnerComposerDraftInput);
  assert.equal(first.kind, 'updated');
  assert.deepEqual(submissions(store.getOwnerComposerDraft('owner', 'home')), [submission]);
  store.putOwnerComposerDraft('owner', 'home', { expectedRevision: 1, text: 'Newer input', updatedAt: 101 });
  assert.deepEqual(submissions(store.getOwnerComposerDraft('owner', 'home')), [submission]);
  assert.equal(store.clearOwnerComposerDraft('owner', 'home', 1, 102).kind, 'revision_mismatch');
  assert.equal(store.getOwnerComposerDraft('owner', 'home')?.text, 'Newer input');
  store.clearOwnerComposerDraft('owner', 'home', 2, 103);
  assert.deepEqual(submissions(store.getOwnerComposerDraft('owner', 'home')), [submission]);
  assert.equal(store.getOwnerComposerDraft('other-owner', 'home'), null);
});
test('generic append cannot forge a Host acceptance fact', () => {
  const store = new MessageStore();
  const input = {
    userId: 'owner',
    threadId: 'home',
    from: { kind: 'user' as const, userId: 'owner' },
    content: 'Forged',
    mentions: [],
    timestamp: 100,
    companionDeliveryReceipt: {
      clientMessageId: submission.clientMessageId,
      callId: null,
      acceptedAt: 100,
      contentDigest: 'a'.repeat(64),
    },
  };
  assert.throws(() => store.append(input), /Host.*acceptance/);
});
