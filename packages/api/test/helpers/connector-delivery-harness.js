/**
 * RFC §5.1/§5.2 test harness for external connector / notification inputs.
 *
 * Producers do not own a delivery mechanism: they hand an envelope to the one component that makes
 * it durable through atomic Message + Queue admission. Tests therefore observe the same boundary
 * production does — the Queue row — instead of a History projection that only exists after dispatch.
 */
const { InvocationQueue } = await import('../../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { PersistedQueueDelivery } = await import(
  '../../dist/domains/cats/services/agents/invocation/PersistedQueueDelivery.js'
);
const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');

/**
 * `messageStore`/`ledgerStore` exist so the same wiring — and the same assertions — can be run
 * against either backend. A private admission receipt lives in the ledger store, so a Redis
 * regression has to replace both halves together or it would observe an in-memory verdict.
 *
 * @param {{
 *   progress?: 'started' | 'owned_deferred_busy',
 *   messageStore?: unknown,
 *   ledgerStore?: unknown,
 * }} [options]
 */
export function connectorDeliveryHarness(options = {}) {
  const messageStore = options.messageStore ?? new MessageStore();
  const queue = options.ledgerStore ? new InvocationQueue(options.ledgerStore) : new InvocationQueue();
  const progressed = [];
  /** Queue drain owes the owner wake, so an admitted entry reaching progress IS the wake. */
  const wakes = [];
  const delivery = new PersistedQueueDelivery({
    messages: messageStore,
    queue,
    progress: async (entry, targetCatId) => {
      progressed.push(entry.id);
      wakes.push({
        entryId: entry.id,
        messageId: entry.payload?.messageId,
        content: entry.payload?.content,
        catId: targetCatId,
        threadId: entry.threadId,
      });
      return options.progress ?? 'started';
    },
  });
  // Fault injection at the real failure point: Queue admission, not a bare store append.
  const rawDeliver = delivery.deliver.bind(delivery);
  let pendingFailures = 0;
  delivery.deliver = async (input) => {
    if (pendingFailures > 0) {
      pendingFailures -= 1;
      throw new Error('queue admission unavailable');
    }
    return rawDeliver(input);
  };

  return {
    failNextDeliveries: (count) => {
      pendingFailures = count;
    },
    messageStore,
    queue,
    delivery,
    progressed,
    wakes,
    /** What production settles on: the envelopes durably admitted to the Queue for this thread. */
    admitted: (threadId, userId = 'user_1') => queue.list(threadId, userId),
    /**
     * Admitted envelopes projected as {id, content} — the durable fact an owner will receive,
     * observed at Queue commit rather than at a History projection that dispatch has not created yet.
     */
    deliveries: (threadId, userId = 'user_1') =>
      queue.list(threadId, userId).map((entry) => {
        const stored = entry.payload?.messageId ? messageStore.getById(entry.payload.messageId) : null;
        return stored ?? { id: entry.payload?.messageId, content: entry.payload?.content ?? '' };
      }),
    /** The queued source bodies behind those admissions, in admission order. */
    contents: (threadId, userId = 'user_1') =>
      queue.list(threadId, userId).map((entry) => entry.payload?.content ?? entry.delivery?.content ?? ''),
    deliveryDeps: { delivery },
  };
}
