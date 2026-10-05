import assert from 'node:assert/strict';
import { InvocationQueue } from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import {
  createInitialQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { createA2ADispositionHarness } from './a2a-dispatch-disposition-harness.js';

export async function createLiveDispatchReceiptFixture({
  failReceipt = false,
  coalesced = false,
  detached = false,
  beforeDispositionRecord,
  gate,
  targetCats = ['codex-sol', 'opus'],
  onSettled,
  withLiveCarrierOperation,
  isLiveCarrierInvocation = async () => true,
} = {}) {
  let receipt;
  let attempts = 0;
  const h = await createA2ADispositionHarness({
    deliveryStatus: 'queued',
    registry: { isLatest: async () => true },
    beforeDispositionRecord,
    ...(gate ? { withLiveCarrierOperation: (query, action) => gate.runForCarrier(query, action) } : {}),
    ...(withLiveCarrierOperation ? { withLiveCarrierOperation } : {}),
    isLiveCarrierInvocation,
    getReadEvidenceForMessage: async ({ messageId }) => ({
      messageId,
      seenAt: 1_500,
      evidenceKind: 'full_contiguous_thread_context',
    }),
    projectAdoptedDisposition: async (input) => {
      attempts++;
      if (failReceipt && attempts === 1) throw new Error('fixture receipt unavailable after event commit');
      if (!receipt) {
        const { DispatchReceiptService } = await import('../../dist/domains/ball-custody/DispatchReceiptService.js');
        receipt = new DispatchReceiptService({
          messageStore: h.messageStore,
          queue,
          coordinator,
          eventLog: h.eventLog,
          onSettled,
        });
      }
      await receipt.repair(input);
    },
  });
  const queue = new InvocationQueue();
  const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: h.messageStore });
  const admitted = queue.enqueue({
    threadId: 'thread-1',
    userId: 'user-1',
    content: h.source.content,
    messageId: h.source.id,
    source: 'agent',
    targetCats,
    intent: 'execute',
    ownerAuthProvenance: 'strict',
  });
  assert.equal(admitted.outcome, 'enqueued');
  let entry = admitted.entry;
  let sibling;
  if (coalesced) {
    sibling = h.messageStore.append({
      userId: 'user-1',
      catId: 'fable5',
      threadId: 'thread-1',
      content: 'another request',
      mentions: targetCats,
      timestamp: 1_100,
      deliveryStatus: 'queued',
    });
    const next = { ...entry, mergedMessageIds: [sibling.id], content: `${entry.content}\n${sibling.content}` };
    assert.equal(queue.restoreEntrySnapshotIfUnchanged(entry, next), true);
    entry = next;
    h.messageStore.initializeQueueCustody(sibling.id, createInitialQueuedMessageCustody(entry));
  }
  h.messageStore.initializeQueueCustody(h.source.id, createInitialQueuedMessageCustody(entry));
  queue.markQueuedSeen('thread-1', 'user-1', entry.id, 'codex-sol', 'inv-1', 1_200);
  await coordinator.persistEntry(queue.getEntrySnapshot('thread-1', 'user-1', entry.id));
  if (detached)
    assert.equal(queue.removeEntrySnapshotIfUnchanged(queue.getEntrySnapshot('thread-1', 'user-1', entry.id)), true);
  return { ...h, queue, coordinator, entry, sibling, attempts: () => attempts };
}
