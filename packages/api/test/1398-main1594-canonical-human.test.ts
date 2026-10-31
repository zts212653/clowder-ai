import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveActionSuccessorHumanReassignmentEvidence } from '../src/domains/ball-custody/ActionSuccessorHumanReassignmentEvidence.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';

const senders = [
  { kind: 'agent' as const, catId: 'codex' },
  { kind: 'system' as const, service: 'notice' },
  { kind: 'user' as const, userId: 'owner' },
];
test('human window uses canonical sender and preserves the raw cap', () => {
  const store = new MessageStore();
  for (const [index, from] of senders.entries())
    store.append({ userId: 'owner', threadId: 'child', from, content: 'source', timestamp: index + 1 });
  assert.deepEqual(store.listOwnerMessageWindowSlice('owner', 0, 10, 2, { humanOnly: true }), {
    messages: [],
    hasMore: true,
  });
  const all = store.listOwnerMessagesInWindow('owner', 0, 10, { humanOnly: true });
  assert.equal(all.length, 1);
  assert.equal(all[0].from.kind, 'user');
});
test('human replacement grounding accepts the actual human source only', async () => {
  const store = new MessageStore();
  for (const from of senders) {
    const message = store.append({ userId: 'owner', threadId: 'child', from, content: 'correction', timestamp: 10 });
    const evidence = await resolveActionSuccessorHumanReassignmentEvidence({
      messageStore: store,
      groundingEvidenceRef: `message:${message.id}`,
      userId: 'owner',
      childThreadId: 'child',
      now: 20,
    });
    assert.equal(Boolean(evidence), from.kind === 'user');
  }
});
