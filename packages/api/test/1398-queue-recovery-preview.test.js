import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQueueLedgerAdmission } from '../dist/domains/cats/services/agents/invocation/queue-ledger/QueueLedgerAdmission.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { enrichQueueEntries } from '../dist/utils/queue-enrichment.js';

test('Queue offers retry only for a held, undelivered source target; the exact request is executable', async () => {
  const messages = new MessageStore();
  const from = { kind: 'user', userId: 'owner' };
  const source = messages.append({
    from,
    userId: 'owner',
    threadId: 'thread',
    content: 'original',
    mentions: [],
    timestamp: 100,
    deliveryStatus: 'queued',
  });
  const [entry] = createQueueLedgerAdmission({
    sourceId: source.id,
    messageId: source.id,
    threadId: 'thread',
    owner: { kind: 'user', userId: 'owner' },
    from,
    kind: 'conversation_input',
    targetCatIds: ['opus', 'codex', 'gemini'],
    content: source.content,
    intent: 'execute',
    ownerAuthProvenance: 'strict',
    enqueuedAt: 101,
  });
  entry.delivery.routingHeldTargetIds = ['opus', 'codex'];
  // A stale held target that already has an exact dispatch must never be offered again.
  source.lifecycle = {
    kind: 'input',
    orderKey: '100:input',
    dispatchRefs: [{ targetId: 'codex', phase: 'settled', statusMessageId: 'reply-codex', dispatchedAt: 110 }],
  };
  const [projected] = await enrichQueueEntries([entry], messages);
  assert.equal(projected.messagePreview?.timestamp, 100);
  assert.deepEqual(
    projected.recoveryActions?.map((action) => (action.kind === 'retry_target' ? action.targetCatId : null)),
    ['opus'],
  );
  assert.deepEqual(projected.recoveryActions?.[0].request, {
    method: 'POST',
    path: `/api/threads/thread/messages/${source.id}/routing-targets/opus/retry`,
  });
  source.visibility = 'whisper';
  source.whisperTo = ['opus'];
  const [privatePreview] = await enrichQueueEntries([entry], messages);
  assert.deepEqual(privatePreview.messagePreview?.whisperTo, ['opus']);
  assert.equal(privatePreview.recoveryActions?.length ?? 0, 0);
});
