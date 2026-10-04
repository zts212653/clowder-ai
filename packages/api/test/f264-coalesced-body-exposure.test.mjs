import assert from 'node:assert/strict';
import { test } from 'node:test';

import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import {
  createCrossThreadQueueEntryFromCustody,
  createInitialCrossThreadQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

function requireEntry(queue, entryId) {
  const entry = queue.getEntrySnapshot('thread-1', 'user-1', entryId);
  assert.ok(entry, `missing Queue entry ${entryId}`);
  return entry;
}

function appendSource(messages, content, timestamp) {
  return messages.append({
    userId: 'user-1',
    catId: 'codex-sol',
    content,
    mentions: ['codex-astra'],
    timestamp,
    threadId: 'thread-1',
    deliveryStatus: 'queued',
    extra: {
      crossPost: {
        sourceThreadId: 'thread-source',
        sourceInvocationId: 'parent-1',
        effectClass: 'fyi',
      },
    },
  });
}

test('coalescing requires a fresh per-source body exposure from the same invocation', async () => {
  const targetCatId = 'codex-astra';
  const invocationId = 'inv-existing';
  const queue = new InvocationQueue();
  const messages = new MessageStore();
  let now = 150;
  const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: messages, now: () => now });

  const first = appendSource(messages, 'first source', 100);
  const admitted = queue.enqueue({
    ownerAuthProvenance: 'unknown',
    threadId: 'thread-1',
    userId: 'user-1',
    content: first.content,
    source: 'agent',
    sourceCategory: 'a2a',
    targetCats: [targetCatId],
    intent: 'execute',
    autoExecute: true,
    callerCatId: 'codex-sol',
    a2aParentInvocationId: 'parent-1',
    a2aTriggerMessageId: first.id,
  }).entry;
  queue.backfillMessageId('thread-1', 'user-1', admitted.id, first.id);
  let carrier = requireEntry(queue, admitted.id);
  assert.equal(
    messages.initializeQueueCustody(
      first.id,
      createInitialCrossThreadQueuedMessageCustody(first.id, [carrier], {
        requestedTargetCats: [targetCatId],
        createdAt: first.timestamp,
      }),
    ).kind,
    'initialized',
  );

  queue.markQueuedSeen('thread-1', 'user-1', admitted.id, targetCatId, invocationId, now);
  carrier = requireEntry(queue, admitted.id);
  await coordinator.persistEntry(carrier);
  assert.deepEqual(messages.getById(first.id).queueCustody.bodyExposures, [{ targetCatId, invocationId, seenAt: 150 }]);

  const second = appendSource(messages, 'second source', 200);
  assert.equal(
    queue.coalesceContentIntoQueuedAgent(
      'thread-1',
      'user-1',
      admitted.id,
      second.content,
      second.id,
      'codex-sol',
      'parent-1',
      'unknown',
      targetCatId,
    ),
    true,
  );
  carrier = requireEntry(queue, admitted.id);
  assert.equal(
    messages.initializeQueueCustody(
      second.id,
      createInitialCrossThreadQueuedMessageCustody(second.id, [carrier], {
        requestedTargetCats: [targetCatId],
        createdAt: second.timestamp,
      }),
    ).kind,
    'initialized',
  );
  const recoveredBeforeReread = createCrossThreadQueueEntryFromCustody(
    [messages.getById(first.id), messages.getById(second.id)],
    admitted.id,
  );
  assert.deepEqual(
    recoveredBeforeReread.queuedBodyExposures,
    [],
    'an old source exposure cannot cover content appended after that read',
  );

  now = 250;
  queue.markQueuedSeen('thread-1', 'user-1', admitted.id, targetCatId, invocationId, now);
  carrier = requireEntry(queue, admitted.id);
  await coordinator.persistEntry(carrier);

  assert.deepEqual(
    messages.getById(first.id).queueCustody.bodyExposures,
    [{ targetCatId, invocationId, seenAt: 150 }],
    'the first source keeps its append-only first exposure',
  );
  assert.deepEqual(
    messages.getById(second.id).queueCustody.bodyExposures,
    [{ targetCatId, invocationId, seenAt: 250 }],
    'the appended source must receive evidence from a read after it existed',
  );
  assert.deepEqual(carrier.queuedBodyExposures, [{ targetCatId, invocationId, seenAt: 250 }]);

  now = 300;
  assert.equal(
    queue.markQueuedSeen('thread-1', 'user-1', admitted.id, targetCatId, invocationId, now),
    false,
    'a repeat read remains idempotent',
  );
  await coordinator.persistEntry(requireEntry(queue, admitted.id));
  assert.deepEqual(messages.getById(second.id).queueCustody.bodyExposures, [
    { targetCatId, invocationId, seenAt: 250 },
  ]);

  const recovered = createCrossThreadQueueEntryFromCustody(
    [messages.getById(first.id), messages.getById(second.id)],
    admitted.id,
  );
  assert.deepEqual(
    recovered.queuedBodyExposures,
    [{ targetCatId, invocationId, seenAt: 250 }],
    'restart must recover only an exposure that covers every coalesced source',
  );
});
